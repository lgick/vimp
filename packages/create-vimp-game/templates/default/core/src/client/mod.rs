//! The game half of the client core: prediction of the local actor
//! (`Predictor`) plus the locally spawned tracer of its own shot. The network
//! buffer, the interpolation, the hot buffer and the frame queue are the
//! engine's (`vimp_engine_core::client::game::ClientState`).

pub mod predictor;

use std::collections::VecDeque;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use vimp_engine_core::client::game::{GameClientDef, RenderOverlay};
use vimp_engine_core::client::interpolator::{FrameData, InterpolatedGame};
use vimp_engine_core::client::raycast::ray_vs_grid;
use vimp_engine_core::client::unpack::{BlockData, DecodedSnapshot};
use vimp_engine_core::config::{EngineClientConfig, FieldValue, PLAYER_STATE_LEN};
use vimp_engine_core::rng::Rng;

use crate::config::{ActorConfig, ArenaClientConfig, WeaponConfig};
use crate::motion;
use predictor::Predictor;

/// Indices of the actor row (see `ActorRow` in `game.rs` and the actor key of
/// `src/config/snapshot.js`) — a positional contract with the schema.
const ACTOR_FIELD_HEALTH: usize = 5;
const ACTOR_FIELD_TEAM: usize = 6;

/// A locally drawn tracer is dropped from the frame that brings its
/// authoritative twin; anything older than this was never confirmed and stops
/// suppressing rows.
const PENDING_MAX_AGE: f64 = 2000.0;

fn field_u8(fields: &[FieldValue], index: usize) -> u8 {
    match fields.get(index) {
        Some(FieldValue::U8(v)) => *v,
        _ => 0,
    }
}

/// Wall grid of the current map, rebuilt on every MAP_DATA — the client half
/// of the hitscan: enough to stop the local tracer at a wall.
struct Grid {
    map: Vec<Vec<i32>>,
    solid_tiles: Vec<i32>,
    tile_size: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientMapConfig {
    step: f32,
    #[serde(default = "default_scale")]
    scale: f32,
    map: Vec<Vec<i32>>,
    #[serde(default)]
    physics_static: Vec<i32>,
}

fn default_scale() -> f32 {
    1.0
}

pub struct ArenaClient {
    models: IndexMap<String, ActorConfig>,
    weapons: IndexMap<String, WeaponConfig>,
    /// id of every snapshot key of the game — the predicted tail of the hot
    /// buffer starts with the key id of the actor block.
    key_ids: IndexMap<String, u8>,

    predictor: Predictor,
    rng: Rng,
    grid: Option<Grid>,

    model_name: Option<String>,
    model: Option<ActorConfig>,
    /// (health, team) of the local actor from the last discrete frame.
    my_meta: Option<(u8, u8)>,

    // local shot: presses waiting for try_action, own cooldown and the queue
    // of locally drawn tracers awaiting their authoritative twin
    pending_fire: usize,
    cooldown_until: f64,
    pending_tracers: VecDeque<f64>,
}

impl ArenaClient {
    fn alive_with_state(&self) -> bool {
        self.predictor.has_state() && self.my_meta.is_some_and(|(health, _)| health > 0)
    }

    /// The single weapon of the template. A game with an arsenal keeps the
    /// active index here and moves it in `cycle_item`.
    fn weapon(&self) -> Option<(&String, &WeaponConfig)> {
        self.weapons.get_index(0)
    }
}

impl GameClientDef for ArenaClient {
    type Config = ArenaClientConfig;

    fn new(cfg: &Self::Config, engine_cfg: &EngineClientConfig) -> Self {
        let key_ids = engine_cfg
            .snapshot
            .keys
            .iter()
            .map(|(key, schema)| (key.clone(), schema.id))
            .collect();

        Self {
            models: cfg.models.clone(),
            weapons: cfg.weapons.clone(),
            key_ids,
            predictor: Predictor::new(engine_cfg.time_step_ms, &cfg.player_keys, &cfg.models),
            rng: Rng::new(cfg.seed),
            grid: None,
            model_name: None,
            model: None,
            my_meta: None,
            pending_fire: 0,
            cooldown_until: 0.0,
            pending_tracers: VecDeque::new(),
        }
    }

    fn on_server_state(
        &mut self,
        state: [f32; PLAYER_STATE_LEN],
        _centering: bool,
        server_time: f64,
        offset: f64,
        local_now: f64,
    ) {
        self.predictor
            .on_server_state(state, server_time, offset, local_now);
    }

    fn update(&mut self, local_now: f64) {
        self.predictor.update(local_now);
    }

    fn track_frame(&mut self, my_game_id: Option<u32>, frame: &FrameData) {
        if frame.camera.as_ref().is_some_and(|camera| camera.force_reset) {
            self.predictor.reset();
        }

        let (Some(my_id), Some(key)) = (my_game_id, self.model_name.clone()) else {
            return;
        };

        let Some(BlockData::Indexed8(items)) = frame.snapshot.block_by_key(&key) else {
            return;
        };

        match items.get(&(my_id as u8)) {
            // a null row means the actor left the canvas (dead or removed)
            Some(None) => {
                self.my_meta = None;
                self.predictor.freeze(true);
            }
            Some(Some(row)) => {
                let health = field_u8(row, ACTOR_FIELD_HEALTH);

                self.my_meta = Some((health, field_u8(row, ACTOR_FIELD_TEAM)));
                self.predictor.freeze(health == 0);
            }
            None => {}
        }
    }

    /// Drops the authoritative twin of a tracer this client already drew:
    /// FIFO by the author id in the last field of the row.
    fn filter_frame_game(
        &mut self,
        game: &mut Map<String, Value>,
        my_game_id: Option<u32>,
        local_now: f64,
    ) {
        while self
            .pending_tracers
            .front()
            .is_some_and(|time| *time < local_now - PENDING_MAX_AGE)
        {
            self.pending_tracers.pop_front();
        }

        let (Some(my_id), Some((weapon_key, _))) = (my_game_id, self.weapon()) else {
            return;
        };
        let weapon_key = weapon_key.clone();

        let Some(Value::Array(rows)) = game.get_mut(&weapon_key) else {
            return;
        };

        rows.retain(|row| {
            let is_mine = row
                .as_array()
                .and_then(|fields| fields.last())
                .and_then(Value::as_u64)
                .is_some_and(|id| id == my_id as u64);

            if is_mine && !self.pending_tracers.is_empty() {
                self.pending_tracers.pop_front();

                return false;
            }

            true
        });
    }

    /// The local hitscan only needs the walls, and those come with the map —
    /// a game whose local effects depend on other actors updates its own
    /// world copy from these two callbacks instead.
    fn update_world(&mut self, _snapshot: &DecodedSnapshot) {}

    fn update_world_interpolated(&mut self, _game: &InterpolatedGame) {}

    /// The predicted tail of the hot buffer: key id, game id and then the
    /// fields of the actor row in schema order — the client part reads it
    /// exactly like an interpolated row.
    fn render_overlay(&self, my_game_id: Option<u32>) -> Option<RenderOverlay> {
        let my_game_id = my_game_id?;
        let key_id = *self.key_ids.get(self.model_name.as_ref()?)?;
        let (_, team) = self.my_meta?;
        let state = self.predictor.render_state()?;
        let velocity = motion::velocity(state.angle, state.speed);

        Some(RenderOverlay {
            camera: [state.x, state.y],
            tail: vec![
                key_id as f32,
                my_game_id as f32,
                state.x,
                state.y,
                state.angle,
                velocity.x,
                velocity.y,
                state.health.round(),
                team as f32,
            ],
        })
    }

    fn predicted_state(&self) -> Option<[f32; PLAYER_STATE_LEN]> {
        self.predictor
            .has_state()
            .then(|| self.predictor.state().to_array())
    }

    fn replayed_inputs(&self) -> Option<(f64, f64, usize)> {
        self.predictor.replayed_inputs()
    }

    fn apply_input(&mut self, action: &str, key_name: &str, local_now: f64) {
        self.predictor.apply_input(action, key_name, local_now);

        // `fire` is a one-shot key on the host too: the press is queued and
        // spent by exactly one try_action
        if action == "down" && key_name == "fire" {
            self.pending_fire += 1;
        }
    }

    fn set_model(&mut self, model_name: &str) {
        self.predictor.set_model(model_name);
        self.model = self.models.get(model_name).cloned();
        self.model_name = Some(model_name.to_string());
    }

    fn set_active(&mut self, active: bool) {
        self.predictor.set_active(active);
        self.pending_fire = 0;
        self.pending_tracers.clear();
    }

    fn set_map(&mut self, map_json: &str) -> Result<(), String> {
        let cfg: ClientMapConfig = serde_json::from_str(map_json).map_err(|e| e.to_string())?;

        self.grid = Some(Grid {
            map: cfg.map,
            solid_tiles: cfg.physics_static,
            tile_size: cfg.step * cfg.scale,
        });

        self.predictor.reset();
        self.pending_fire = 0;
        self.pending_tracers.clear();

        Ok(())
    }

    /// Health and ammo of the local actor arrive in the player block of every
    /// frame (see the layout in `actor.rs`), so the panel needs no separate
    /// synchronisation here.
    fn sync_panel(&mut self, _items: &[String]) {}

    fn reset(&mut self) {
        self.predictor.reset();
        self.my_meta = None;
        self.pending_fire = 0;
        self.pending_tracers.clear();
        self.cooldown_until = 0.0;
    }

    /// One weapon, nothing to cycle. A game with an arsenal moves its active
    /// index here — the authoritative confirmation still arrives by panel.
    fn cycle_item(&mut self, _back: bool) {}

    /// The locally predicted shot: the tracer is drawn at once instead of
    /// after the round trip, and `filter_frame_game` drops the authoritative
    /// copy of it. Gates (alive, cooldown, ammo) mirror the host — a local
    /// guess the host would refuse is worse than no guess.
    fn try_action(&mut self, my_game_id: Option<u32>, local_now: f64) -> Option<String> {
        if self.pending_fire == 0 {
            return None;
        }

        self.pending_fire -= 1;

        if !self.alive_with_state() || local_now < self.cooldown_until {
            return None;
        }

        let my_game_id = my_game_id?;
        let state = self.predictor.render_state()?;
        let model = self.model.clone()?;
        let (weapon_key, weapon) = self.weapon()?;
        let (weapon_key, weapon) = (weapon_key.clone(), weapon.clone());

        if state.ammo < weapon.consumption.unwrap_or(1.0) as f32 {
            return None;
        }

        self.cooldown_until = local_now + weapon.fire_rate as f64 * 1000.0;

        let mut angle = state.angle;

        if weapon.spread > 0.0 {
            angle += self.rng.range(-weapon.spread, weapon.spread);
        }

        let start = motion::muzzle(state.x, state.y, state.angle, &model);
        let direction = [angle.cos(), angle.sin()];

        let distance = self
            .grid
            .as_ref()
            .and_then(|grid| {
                ray_vs_grid(
                    [start.x, start.y],
                    direction,
                    weapon.range,
                    &grid.map,
                    &grid.solid_tiles,
                    grid.tile_size,
                )
            })
            .unwrap_or(weapon.range);

        let was_hit = distance < weapon.range;

        self.pending_tracers.push_back(local_now);

        // the row repeats the wire layout of the tracer block, author id last
        Some(
            json!({
                weapon_key: [[
                    start.x,
                    start.y,
                    start.x + direction[0] * distance,
                    start.y + direction[1] * distance,
                    was_hit as u8,
                    my_game_id,
                ]]
            })
            .to_string(),
        )
    }
}

/// The client core of the game: engine orchestration + the prediction above.
pub type ClientState = vimp_engine_core::client::game::ClientState<ArenaClient>;
