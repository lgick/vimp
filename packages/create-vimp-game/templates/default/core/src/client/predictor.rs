//! Client-side prediction of the local actor: a replica of `crate::motion`
//! (the very same functions the authoritative `Actor::update` calls) plus the
//! reconciliation against the player block of every incoming frame.
//!
//! Reconciliation works in TIME, not in `seq`: the authoritative state is
//! stamped with `serverTime`, the input history with `performance.now`, and
//! the two are bridged by the clock `offset` the engine keeps. That is why
//! `replayed_inputs` reports a time window — it localises a drift in the
//! movement formula far better than an input counter.

use std::collections::VecDeque;

use indexmap::IndexMap;

use vimp_engine_core::config::PLAYER_STATE_LEN;

use crate::config::{ActorConfig, KeyConfig};
use crate::motion::{self, MoveInput};

/// Input older than this is dropped: replaying more than two seconds after a
/// stall costs more than the accuracy it buys.
const HISTORY_MAX_AGE: f64 = 2000.0;
/// Visual error left by a correction decays over ~100 ms instead of snapping.
const ERROR_DECAY_RATE: f64 = 10.0;
/// Beyond this the correction is a teleport, not a drift — snap at once.
const ERROR_SNAP_DISTANCE: f32 = 100.0;
/// Cap of the render-tick accumulator (a backgrounded tab must not replay
/// minutes of movement in one frame).
const MAX_ACCUMULATED_TIME: f64 = 100.0;

/// Predicted state of the local actor, in the player-block layout
/// `[x, y, angle, vx, vy, hp, ammo, 0]`.
#[derive(Clone, Copy, Default)]
pub struct ActorState {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub speed: f32,
    pub health: f32,
    pub ammo: f32,
}

impl ActorState {
    pub fn from_array(s: [f32; PLAYER_STATE_LEN]) -> Self {
        let angle = s[2];

        Self {
            x: s[0],
            y: s[1],
            angle,
            // the authoritative half carries the velocity vector, the replica
            // works in signed speed along the facing — project it back
            speed: s[3] * angle.cos() + s[4] * angle.sin(),
            health: s[5],
            ammo: s[6],
        }
    }

    pub fn to_array(self) -> [f32; PLAYER_STATE_LEN] {
        let v = motion::velocity(self.angle, self.speed);

        [
            self.x,
            self.y,
            self.angle,
            v.x,
            v.y,
            self.health,
            self.ammo,
            0.0,
        ]
    }
}

/// What the renderer gets: the predicted state with the visual error of the
/// last correction blended into the position.
pub struct RenderState {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub speed: f32,
    pub health: f32,
    pub ammo: f32,
}

struct HistoryEntry {
    time: f64,
    keys: u32,
}

pub struct Predictor {
    step_ms: f64,
    models: IndexMap<String, ActorConfig>,
    model: Option<ActorConfig>,

    forward_bit: u32,
    back_bit: u32,
    left_bit: u32,
    right_bit: u32,

    active: bool,
    frozen: bool,
    has_state: bool,
    pending_reset: bool,

    state: ActorState,

    keys_mask: u32,
    history: VecDeque<HistoryEntry>,
    base_keys_mask: u32,

    visual_error: [f32; 2],

    accumulator: f64,
    last_update_time: Option<f64>,
    last_replay: Option<(f64, f64, usize)>,
}

impl Predictor {
    pub fn new(
        step_ms: f64,
        player_keys: &IndexMap<String, KeyConfig>,
        models: &IndexMap<String, ActorConfig>,
    ) -> Self {
        let bit = |name: &str| player_keys.get(name).map(|k| k.key).unwrap_or(0);

        Self {
            step_ms,
            models: models.clone(),
            model: None,
            forward_bit: bit("forward"),
            back_bit: bit("back"),
            left_bit: bit("left"),
            right_bit: bit("right"),
            active: false,
            frozen: false,
            has_state: false,
            pending_reset: true,
            state: ActorState::default(),
            keys_mask: 0,
            history: VecDeque::new(),
            base_keys_mask: 0,
            visual_error: [0.0; 2],
            accumulator: 0.0,
            last_update_time: None,
            last_replay: None,
        }
    }

    pub fn set_model(&mut self, model_name: &str) {
        self.model = self.models.get(model_name).cloned();
    }

    pub fn set_active(&mut self, active: bool) {
        if active && !self.active {
            self.pending_reset = true;
        }

        self.active = active;

        if !active {
            self.has_state = false;
        }
    }

    /// A dead actor stops predicting: the authoritative state stops moving
    /// too, and predicting a corpse only produces corrections.
    pub fn freeze(&mut self, frozen: bool) {
        self.frozen = frozen;
    }

    pub fn reset(&mut self) {
        self.pending_reset = true;
        self.history.clear();
        self.base_keys_mask = 0;
        self.keys_mask = 0;
        self.visual_error = [0.0; 2];
        self.accumulator = 0.0;
        self.last_replay = None;
    }

    pub fn has_state(&self) -> bool {
        self.active && self.has_state && self.model.is_some()
    }

    pub fn state(&self) -> ActorState {
        self.state
    }

    pub fn replayed_inputs(&self) -> Option<(f64, f64, usize)> {
        self.last_replay
    }

    /// Only the movement keys take part in the replica; `fire` changes no
    /// predicted position and is handled by the local shot instead.
    pub fn apply_input(&mut self, action: &str, key_name: &str, local_time: f64) {
        let bit = match key_name {
            "forward" => self.forward_bit,
            "back" => self.back_bit,
            "left" => self.left_bit,
            "right" => self.right_bit,
            _ => return,
        };

        if bit == 0 {
            return;
        }

        if action == "down" {
            self.keys_mask |= bit;
        } else if action == "up" {
            self.keys_mask &= !bit;
        }

        self.history.push_back(HistoryEntry {
            time: local_time,
            keys: self.keys_mask,
        });
        self.trim_history(local_time);
    }

    pub fn update(&mut self, local_now: f64) {
        let Some(last) = self.last_update_time else {
            self.last_update_time = Some(local_now);
            return;
        };

        let elapsed = local_now - last;

        self.last_update_time = Some(local_now);

        let decay = (1.0 - (elapsed / 1000.0) * ERROR_DECAY_RATE).max(0.0) as f32;

        for value in &mut self.visual_error {
            *value *= decay;
        }

        if !self.has_state() || self.frozen {
            self.accumulator = 0.0;
            return;
        }

        self.accumulator = (self.accumulator + elapsed).min(MAX_ACCUMULATED_TIME);

        while self.accumulator >= self.step_ms {
            self.step(self.keys_mask);
            self.accumulator -= self.step_ms;
        }
    }

    /// The authoritative state of the local actor: rewind to it, then replay
    /// every input newer than the frame.
    pub fn on_server_state(
        &mut self,
        state: [f32; PLAYER_STATE_LEN],
        server_time: f64,
        offset: f64,
        local_now: f64,
    ) {
        if !self.active || self.model.is_none() {
            return;
        }

        let old = self.has_state.then_some(self.state);

        self.state = ActorState::from_array(state);
        self.has_state = true;

        let server_now_est = local_now + offset;
        let mut history_index = 0;
        let mut replay_keys = self.base_keys_mask;
        let mut replayed = 0;
        let mut t = server_time;

        while history_index < self.history.len()
            && self.history[history_index].time + offset <= t
        {
            replay_keys = self.history[history_index].keys;
            history_index += 1;
        }

        while t + self.step_ms <= server_now_est {
            t += self.step_ms;

            while history_index < self.history.len()
                && self.history[history_index].time + offset <= t
            {
                replay_keys = self.history[history_index].keys;
                history_index += 1;
                replayed += 1;
            }

            self.step(replay_keys);
        }

        self.accumulator = server_now_est - t;
        self.last_replay = Some((server_time - offset, local_now, replayed));

        let Some(old) = old else {
            self.pending_reset = false;
            self.visual_error = [0.0; 2];
            return;
        };

        if self.pending_reset {
            self.pending_reset = false;
            self.visual_error = [0.0; 2];
            return;
        }

        self.visual_error[0] += old.x - self.state.x;
        self.visual_error[1] += old.y - self.state.y;

        if self.visual_error[0].hypot(self.visual_error[1]) > ERROR_SNAP_DISTANCE {
            self.visual_error = [0.0; 2];
        }
    }

    pub fn render_state(&self) -> Option<RenderState> {
        if !self.has_state() {
            return None;
        }

        Some(RenderState {
            x: self.state.x + self.visual_error[0],
            y: self.state.y + self.visual_error[1],
            angle: self.state.angle,
            speed: self.state.speed,
            health: self.state.health,
            ammo: self.state.ammo,
        })
    }

    fn trim_history(&mut self, local_now: f64) {
        let min_time = local_now - HISTORY_MAX_AGE;

        while let Some(entry) = self.history.front() {
            if entry.time >= min_time {
                break;
            }

            self.base_keys_mask = entry.keys;
            self.history.pop_front();
        }
    }

    /// One fixed step of the replica — the same order as `Actor::update`.
    fn step(&mut self, keys: u32) {
        let Some(model) = &self.model else {
            return;
        };

        let dt = (self.step_ms / 1000.0) as f32;

        let input = MoveInput {
            forward: keys & self.forward_bit != 0,
            back: keys & self.back_bit != 0,
            left: keys & self.left_bit != 0,
            right: keys & self.right_bit != 0,
        };

        self.state.angle = motion::step_angle(self.state.angle, input, model, dt);
        self.state.speed = motion::step_speed(self.state.speed, input, model, dt);

        let velocity = motion::velocity(self.state.angle, self.state.speed);

        self.state.x += velocity.x * dt;
        self.state.y += velocity.y * dt;
    }
}

/// Parity of the replica with the authoritative simulation. This is the ONE
/// test that catches `crate::motion` drifting apart between the two halves —
/// re-run it after every movement change (`npm run core:test`).
#[cfg(test)]
mod parity {
    use super::*;
    use crate::config::ArenaConfig;
    use crate::game::GameState;

    const DT: f32 = 1.0 / 120.0;
    const STEP_MS: f64 = 1000.0 / 120.0;

    fn config_json() -> serde_json::Value {
        serde_json::json!({
            "timeStep": 1.0 / 120.0,
            "snapshot": {
                "version": 3,
                "port": 5,
                "keys": {
                    "a1": { "id": 1, "kind": "indexed8", "class": "hot", "fields": [
                        { "name": "x", "ty": "f32", "interp": "lerp" },
                        { "name": "y", "ty": "f32", "interp": "lerp" },
                        { "name": "angle", "ty": "f32", "interp": "lerpAngle" },
                        { "name": "vx", "ty": "f32", "interp": "lerp" },
                        { "name": "vy", "ty": "f32", "interp": "lerp" },
                        { "name": "health", "ty": "u8" },
                        { "name": "team", "ty": "u8" }
                    ] },
                    "w1": { "id": 2, "kind": "list16", "class": "event", "fields": [
                        { "name": "startX", "ty": "f32" },
                        { "name": "startY", "ty": "f32" },
                        { "name": "endX", "ty": "f32" },
                        { "name": "endY", "ty": "f32" },
                        { "name": "wasHit", "ty": "u8" },
                        { "name": "shooterId", "ty": "u8" }
                    ] }
                }
            },
            "seed": 42,
            "friendlyFire": false,
            "models": {
                "a1": {
                    "currentWeapon": "w1",
                    "size": 32.0,
                    "maxSpeed": 200.0,
                    "maxReverseSpeed": 100.0,
                    "acceleration": 400.0,
                    "braking": 600.0,
                    "turnSpeed": 3.0,
                    "fixture": { "density": 1.0, "friction": 0.2, "restitution": 0.0 }
                }
            },
            "weapons": {
                "w1": { "damage": 25.0, "range": 600.0, "fireRate": 0.4 }
            },
            "playerKeys": {
                "forward": { "key": 1 },
                "back": { "key": 2 },
                "left": { "key": 4 },
                "right": { "key": 8 },
                "fire": { "key": 16, "type": 1 }
            },
            "panel": {
                "health": { "value": 100.0 },
                "w1": { "value": 30.0 }
            }
        })
    }

    fn game_config() -> ArenaConfig {
        serde_json::from_value(config_json()).unwrap()
    }

    fn engine_config() -> vimp_engine_core::config::EngineConfig {
        serde_json::from_value(config_json()).unwrap()
    }

    fn key_bit(name: &str) -> u32 {
        game_config().player_keys[name].key
    }

    // steps both halves through one schedule of key masks
    // ({ step index → new mask }) and returns their final positions
    fn simulate(steps: usize, schedule: &[(usize, u32)]) -> ([f32; 2], (f32, f32)) {
        let cfg = game_config();
        let mut game = GameState::new(engine_config(), &cfg);

        game.spawn_actor(1, "a1", 1, 0.0, 0.0, 0.0).unwrap();

        let mut predictor = Predictor::new(STEP_MS, &cfg.player_keys, &cfg.models);

        predictor.set_model("a1");
        predictor.set_active(true);
        predictor.on_server_state([0.0; PLAYER_STATE_LEN], 0.0, 0.0, 0.0);

        // step() directly instead of update(): parity compares the formulas
        // of one tick, not the render-tick accumulator
        let mut mask = 0u32;
        let mut seq = 0u32;

        for i in 0..steps {
            if let Some((_, new_mask)) = schedule.iter().find(|(step, _)| *step == i) {
                for (name, key) in &cfg.player_keys {
                    if !matches!(name.as_str(), "forward" | "back" | "left" | "right") {
                        continue;
                    }

                    let was = mask & key.key != 0;
                    let now = new_mask & key.key != 0;

                    if was != now {
                        seq += 1;
                        game.apply_input(1, seq, if now { "down" } else { "up" }, name);
                    }
                }

                mask = *new_mask;
            }

            game.step(DT);
            predictor.step(mask);
        }

        let authoritative = game.actor_position(1).unwrap();
        let render = predictor.render_state().unwrap();

        (authoritative, (render.x, render.y))
    }

    fn expect_close(authoritative: [f32; 2], replica: (f32, f32), tolerance: f32) {
        assert!(
            (replica.0 - authoritative[0]).abs() < tolerance,
            "x: replica {} vs core {}",
            replica.0,
            authoritative[0]
        );
        assert!(
            (replica.1 - authoritative[1]).abs() < tolerance,
            "y: replica {} vs core {}",
            replica.1,
            authoritative[1]
        );
    }

    #[test]
    fn drive_forward() {
        let (core, replica) = simulate(120, &[(0, key_bit("forward"))]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn drive_and_turn() {
        let mask = key_bit("forward") | key_bit("right");
        let (core, replica) = simulate(120, &[(0, mask)]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn release_and_brake() {
        let (core, replica) = simulate(180, &[(0, key_bit("forward")), (60, 0)]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn reverse_after_forward() {
        let (core, replica) =
            simulate(180, &[(0, key_bit("forward")), (60, key_bit("back"))]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn no_input_stays_put() {
        let (core, replica) = simulate(60, &[]);

        expect_close(core, replica, 0.001);
    }
}
