//! The authoritative actor: a Rapier body, health, ammo, cooldowns and the
//! key bookkeeping. All movement math comes from `crate::motion` — this file
//! only decides WHEN to call it and writes the result onto the body.

use indexmap::IndexMap;
use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use vimp_engine_core::config::PLAYER_STATE_LEN;
use vimp_engine_core::events::CoreEvent;
use vimp_engine_core::physics::{deg_to_rad, round2};
use vimp_engine_core::rng::Rng;

use crate::body_tag::BodyTag;
use crate::config::{ActorConfig, KeyConfig, PanelValue, WeaponConfig};
use crate::motion::{self, MoveInput};

/// Key bits resolved from `playerKeys` once, at construction: the engine
/// hands over the table but never interprets it — mapping names to bits and
/// honouring `type: 1` (one-shot) is the core's job.
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
pub struct PlayerKeyBits {
    pub forward: u32,
    pub back: u32,
    pub left: u32,
    pub right: u32,
    pub fire: u32,
    /// Bits of every `type: 1` key — consumed by exactly one fixed step.
    pub one_shot_mask: u32,
}

impl PlayerKeyBits {
    pub fn from_config(keys: &IndexMap<String, KeyConfig>) -> Self {
        let bit = |name: &str| keys.get(name).map(|k| k.key).unwrap_or(0);
        let one_shot_mask = keys
            .values()
            .filter(|k| k.kind == 1)
            .fold(0, |mask, k| mask | k.key);

        Self {
            forward: bit("forward"),
            back: bit("back"),
            left: bit("left"),
            right: bit("right"),
            fire: bit("fire"),
            one_shot_mask,
        }
    }
}

/// A shot taken off the actor on this step — the ray the game then casts.
pub struct ShotCommand {
    pub start: Vector,
    pub direction: Vector,
}

/// One participant of the match: player or bot (the bot only differs by who
/// presses its keys — see `on_ai_tick` in `game.rs`).
#[derive(Serialize, Deserialize)]
pub struct Actor {
    pub game_id: u32,
    pub team_id: u8,
    pub model: String,
    pub body: RigidBodyHandle,

    // input
    current_keys: u32,
    one_shot_events: u32,

    // movement state (the body carries position, these carry intent)
    pub angle: f32,
    pub speed: f32,

    pub health: f64,

    // per weapon index, in the order of `weapons` in the config
    pub ammo: Vec<f64>,
    cooldowns: Vec<f32>,
    pub current_weapon: usize,

    pub last_input_seq: u32,
}

impl Actor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        world: &mut PhysicsWorld,
        weapons: &IndexMap<String, WeaponConfig>,
        panel: &IndexMap<String, PanelValue>,
        model_name: &str,
        model: &ActorConfig,
        game_id: u32,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Self {
        let angle = deg_to_rad(angle_deg);
        let tag = BodyTag::Player { game_id, team_id };

        // lock_rotations: the facing angle is gameplay state written by
        // `update`, not something the physics solver may spin
        let body_handle = world.insert_body(
            RigidBodyBuilder::dynamic()
                .translation(Vector::new(x, y))
                .rotation(angle)
                .lock_rotations()
                .user_data(tag.encode()),
        );

        world.insert_collider(
            ColliderBuilder::ball(model.size / 2.0)
                .density(model.fixture.density)
                .friction(model.fixture.friction)
                .restitution(model.fixture.restitution),
            Some(body_handle),
        );

        let current_weapon = weapons.get_index_of(&model.current_weapon).unwrap_or(0);
        let health = panel.get("health").map(|p| p.value).unwrap_or(100.0);
        let ammo = weapons
            .keys()
            .map(|name| panel.get(name).map(|p| p.value).unwrap_or(0.0))
            .collect();

        Self {
            game_id,
            team_id,
            model: model_name.to_string(),
            body: body_handle,
            current_keys: 0,
            one_shot_events: 0,
            angle,
            speed: 0.0,
            health,
            ammo,
            cooldowns: vec![0.0; weapons.len()],
            current_weapon,
            last_input_seq: 0,
        }
    }

    pub fn is_alive(&self) -> bool {
        self.health > 0.0
    }

    /// Wire input: `down` sets the bit (one-shot keys go to their own mask),
    /// `up` clears it. The client predictor repeats this rule verbatim.
    pub fn update_keys(&mut self, action: &str, key_bit: u32, bits: &PlayerKeyBits) {
        if key_bit == 0 {
            return;
        }

        if action == "down" {
            if bits.one_shot_mask & key_bit != 0 {
                self.one_shot_events |= key_bit;
            } else {
                self.current_keys |= key_bit;
            }
        } else if action == "up" {
            self.current_keys &= !key_bit;
        }
    }

    /// Held keys of a bot, replacing the whole mask at once.
    pub fn set_held_keys(&mut self, keys: u32) {
        self.current_keys = keys;
    }

    /// One-shot press of a bot (fire).
    pub fn press_once(&mut self, key_bit: u32) {
        self.one_shot_events |= key_bit;
    }

    pub fn reset_keys(&mut self) {
        self.current_keys = 0;
        self.one_shot_events = 0;
    }

    fn keys_for_processing(&mut self) -> u32 {
        let keys = self.current_keys | self.one_shot_events;

        self.one_shot_events = 0;
        keys
    }

    /// Applies damage; `true` means this hit killed the actor.
    pub fn take_damage(
        &mut self,
        amount: f64,
        body: &mut RigidBody,
        events: &mut Vec<CoreEvent>,
    ) -> bool {
        if !self.is_alive() {
            return false;
        }

        self.health = (self.health - amount).max(0.0);

        events.push(CoreEvent::PanelSet {
            id: self.game_id,
            field: "health".to_string(),
            value: self.health,
        });

        if self.health <= 0.0 {
            self.speed = 0.0;
            body.set_linvel(Vector::ZERO, true);
            // a corpse leaves the world until the respawn: disabling the body
            // takes it out of the broad phase, so it neither blocks a ray nor
            // collides — it only waits for `change_player_data`
            body.set_enabled(false);
            self.reset_keys();

            return true;
        }

        false
    }

    /// Cooldown + ammo gate of a shot; spends the ammo on success.
    fn try_consume_ammo(
        &mut self,
        weapons: &IndexMap<String, WeaponConfig>,
        events: &mut Vec<CoreEvent>,
    ) -> bool {
        let (name, weapon) = weapons.get_index(self.current_weapon).unwrap();
        let consumption = weapon.consumption.unwrap_or(1.0);

        if self.cooldowns[self.current_weapon] > 0.0
            || self.ammo[self.current_weapon] < consumption
        {
            return false;
        }

        self.ammo[self.current_weapon] =
            (self.ammo[self.current_weapon] - consumption).max(0.0);
        self.cooldowns[self.current_weapon] = weapon.fire_rate;

        events.push(CoreEvent::PanelSet {
            id: self.game_id,
            field: name.clone(),
            value: self.ammo[self.current_weapon],
        });

        true
    }

    fn update_cooldowns(&mut self, dt: f32) {
        for cooldown in &mut self.cooldowns {
            *cooldown = (*cooldown - dt).max(0.0);
        }
    }

    /// One fixed step of the actor. The order — turn, drive, write the body,
    /// then fire — is what the client predictor replays, so it is a contract
    /// of `mod parity`, not a style choice.
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &mut self,
        dt: f32,
        body: &mut RigidBody,
        model: &ActorConfig,
        weapons: &IndexMap<String, WeaponConfig>,
        bits: &PlayerKeyBits,
        rng: &mut Rng,
        events: &mut Vec<CoreEvent>,
    ) -> Option<ShotCommand> {
        let keys = self.keys_for_processing();

        let input = MoveInput {
            forward: keys & bits.forward != 0,
            back: keys & bits.back != 0,
            left: keys & bits.left != 0,
            right: keys & bits.right != 0,
        };
        let fire = keys & bits.fire != 0;

        self.update_cooldowns(dt);

        self.angle = motion::step_angle(self.angle, input, model, dt);
        self.speed = motion::step_speed(self.speed, input, model, dt);

        body.set_rotation(Rotation::from_angle(self.angle), true);
        body.set_linvel(motion::velocity(self.angle, self.speed), true);

        if !fire || !self.try_consume_ammo(weapons, events) {
            return None;
        }

        let position = body.translation();
        let weapon = &weapons[self.current_weapon];
        let mut direction = self.angle;

        // spread goes through the engine Rng only — `rand` or a clock would
        // break the determinism the whole handoff/replay machinery rests on
        if weapon.spread > 0.0 {
            direction += rng.range(-weapon.spread, weapon.spread);
        }

        Some(ShotCommand {
            start: motion::muzzle(position.x, position.y, self.angle, model),
            direction: Vector::new(direction.cos(), direction.sin()),
        })
    }

    /// Respawn / team change; health and ammo are reset separately by
    /// `reset_vitals` (the engine drives both).
    pub fn change_player_data(
        &mut self,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
        body: &mut RigidBody,
    ) {
        self.team_id = team_id;
        body.user_data = BodyTag::Player {
            game_id: self.game_id,
            team_id,
        }
        .encode();

        self.angle = deg_to_rad(angle_deg);
        self.speed = 0.0;

        body.set_enabled(true);
        body.set_linvel(Vector::ZERO, true);
        body.set_translation(Vector::new(x, y), true);
        body.set_rotation(Rotation::from_angle(self.angle), true);

        self.reset_keys();
    }

    /// Health and ammo back to the panel defaults. The body of a corpse is
    /// woken up by `change_player_data` — the engine always respawns through
    /// it, so this method never needs the world.
    pub fn reset_vitals(
        &mut self,
        panel: &IndexMap<String, PanelValue>,
        weapons: &IndexMap<String, WeaponConfig>,
        events: &mut Vec<CoreEvent>,
    ) {
        self.health = panel.get("health").map(|p| p.value).unwrap_or(100.0);

        events.push(CoreEvent::PanelSet {
            id: self.game_id,
            field: "health".to_string(),
            value: self.health,
        });

        for (index, name) in weapons.keys().enumerate() {
            self.ammo[index] = panel.get(name).map(|p| p.value).unwrap_or(0.0);
            self.cooldowns[index] = 0.0;

            events.push(CoreEvent::PanelSet {
                id: self.game_id,
                field: name.clone(),
                value: self.ammo[index],
            });
        }
    }

    /// Snapshot row of the actor block: 5 floats + health + team. Floats are
    /// rounded to 2 decimals because the client decoder rounds them anyway —
    /// an unrounded value would come back as a different number.
    pub fn snapshot_row(&self, body: &RigidBody) -> ([f32; 5], u8, u8) {
        let pos = body.translation();
        let vel = body.linvel();

        (
            [
                round2(pos.x),
                round2(pos.y),
                round2(self.angle),
                round2(vel.x),
                round2(vel.y),
            ],
            self.health.round() as u8,
            self.team_id,
        )
    }

    /// The whole reconciliation channel: eight floats, unrounded (prediction
    /// needs the precision). Layout — `[x, y, angle, vx, vy, hp, ammo, 0]`;
    /// the client predictor and the `arena` client part read it by these
    /// indices. The flag is `centering` in the engine's vocabulary: this game
    /// has nothing to centre, so it is always `false`.
    pub fn prediction_state(&self, body: &RigidBody) -> ([f32; PLAYER_STATE_LEN], bool) {
        let pos = body.translation();
        let vel = body.linvel();

        (
            [
                pos.x,
                pos.y,
                self.angle,
                vel.x,
                vel.y,
                self.health as f32,
                self.ammo[self.current_weapon] as f32,
                0.0,
            ],
            false,
        )
    }
}
