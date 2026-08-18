//! The authoritative simulation on top of the engine frame (`EngineSim`):
//! actors, bots, hitscan and the snapshot blocks. The engine owns the physics
//! world, the map, navigation, the RNG and the destroy queue and calls into
//! this file through `SimCtx` — see `docs/ai/05-wasm-core.md`.

use indexmap::IndexMap;
use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use vimp_engine_core::config::{EngineConfig, FieldValue, PLAYER_STATE_LEN};
use vimp_engine_core::events::CoreEvent;
use vimp_engine_core::nav::spatial::{SpatialEntity, SpatialGrid};
use vimp_engine_core::physics::{round1, round2};
use vimp_engine_core::rng::Rng;
use vimp_engine_core::sim::{GameDef, GameSim, SimCtx};
use vimp_engine_core::snapshot::Block;

use crate::actor::{Actor, PlayerKeyBits, ShotCommand};
use crate::body_tag::BodyTag;
use crate::config::{ActorConfig, ArenaConfig, KeyConfig, PanelValue, WeaponConfig};

/// Marker type binding the config and the simulation together.
pub struct ArenaGame;

impl GameDef for ArenaGame {
    type Config = ArenaConfig;
    type Sim = ArenaSim;
}

/// The engine frame parametrised by this game — the type the ABI macro and
/// the tests work with.
pub type GameState = vimp_engine_core::game::EngineSim<ArenaGame>;

/// Row of the actor block (`Indexed8`): x, y, angle, vx, vy + health + team.
/// The order is positional — it must match the `fields` of the actor key in
/// `src/config/snapshot.js`.
#[derive(Clone, Copy)]
struct ActorRow {
    floats: [f32; 5],
    health: u8,
    team: u8,
}

impl ActorRow {
    fn fields(&self) -> Vec<FieldValue> {
        let mut fields: Vec<FieldValue> =
            self.floats.iter().copied().map(FieldValue::F32).collect();

        fields.push(FieldValue::U8(self.health));
        fields.push(FieldValue::U8(self.team));
        fields
    }
}

/// Row of the tracer block (`List16`): the ray plus whether it hit. The LAST
/// field is the author's game id — the client drops its own rows by it, so a
/// locally predicted shot is not drawn twice.
struct TracerRow {
    floats: [f32; 4],
    was_hit: bool,
    shooter: u8,
}

impl TracerRow {
    fn fields(&self) -> Vec<FieldValue> {
        let mut fields: Vec<FieldValue> =
            self.floats.iter().copied().map(FieldValue::F32).collect();

        fields.push(FieldValue::U8(self.was_hit as u8));
        fields.push(FieldValue::U8(self.shooter));
        fields
    }
}

/// Scripted actor: the whole AI of the template. It holds one key mask for a
/// while, then rolls a new one — enough to make a match with bots watchable
/// and to prove the `spawn_scripted_actor` / `on_ai_tick` path works.
#[derive(Serialize, Deserialize)]
struct Bot {
    keys: u32,
    /// Seconds left before the next decision.
    timer: f32,
}

pub struct ArenaSim {
    key_bits: PlayerKeyBits,
    player_keys: IndexMap<String, KeyConfig>,
    friendly_fire: bool,
    models: IndexMap<String, ActorConfig>,
    weapons: IndexMap<String, WeaponConfig>,
    panel: IndexMap<String, PanelValue>,

    actors: IndexMap<u32, Actor>,
    bots: IndexMap<u32, Bot>,

    // snapshot accumulators, drained by build_snapshot_blocks
    new_tracers: IndexMap<usize, Vec<TracerRow>>,
    pending_null_actors: Vec<(String, u32)>,
    cached_actors: IndexMap<u32, (String, ActorRow)>,
}

impl GameSim<ArenaGame> for ArenaSim {
    fn new(cfg: &ArenaConfig, _engine_cfg: &EngineConfig) -> Self {
        Self {
            key_bits: PlayerKeyBits::from_config(&cfg.player_keys),
            player_keys: cfg.player_keys.clone(),
            friendly_fire: cfg.friendly_fire,
            models: cfg.models.clone(),
            weapons: cfg.weapons.clone(),
            panel: cfg.panel.clone(),
            actors: IndexMap::new(),
            bots: IndexMap::new(),
            new_tracers: IndexMap::new(),
            pending_null_actors: Vec::new(),
            cached_actors: IndexMap::new(),
        }
    }

    fn spawn_actor(
        &mut self,
        world: &mut PhysicsWorld,
        events: &mut Vec<CoreEvent>,
        game_id: u32,
        model_name: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), String> {
        let model = self
            .models
            .get(model_name)
            .ok_or_else(|| format!("unknown model '{model_name}'"))?
            .clone();

        let actor = Actor::new(
            world,
            &self.weapons,
            &self.panel,
            model_name,
            &model,
            game_id,
            team_id,
            x,
            y,
            angle_deg,
        );

        events.push(CoreEvent::PanelActive {
            id: game_id,
            field: self
                .weapons
                .get_index(actor.current_weapon)
                .map(|(name, _)| name.clone())
                .unwrap_or_default(),
        });
        events.push(CoreEvent::PanelSet {
            id: game_id,
            field: "health".to_string(),
            value: actor.health,
        });

        self.actors.insert(game_id, actor);

        Ok(())
    }

    fn remove_actor(&mut self, world: &mut PhysicsWorld, game_id: u32) {
        if let Some(actor) = self.actors.shift_remove(&game_id) {
            world.remove_body(actor.body);
            self.cached_actors.shift_remove(&game_id);
            self.pending_null_actors.push((actor.model, game_id));
        }
    }

    fn reset_actor(
        &mut self,
        world: &mut PhysicsWorld,
        game_id: u32,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) {
        let Some(actor) = self.actors.get_mut(&game_id) else {
            return;
        };
        let Some(body) = world.bodies.get_mut(actor.body) else {
            return;
        };

        actor.change_player_data(team_id, x, y, angle_deg, body);
    }

    fn reset_all_vitals(&mut self, events: &mut Vec<CoreEvent>) {
        for actor in self.actors.values_mut() {
            actor.reset_vitals(&self.panel, &self.weapons, events);
        }
    }

    fn spawn_scripted_actor(
        &mut self,
        world: &mut PhysicsWorld,
        rng: &mut Rng,
        events: &mut Vec<CoreEvent>,
        game_id: u32,
        model_name: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), String> {
        self.spawn_actor(world, events, game_id, model_name, team_id, x, y, angle_deg)?;

        self.bots.entry(game_id).or_insert(Bot {
            keys: self.key_bits.forward,
            timer: rng.range(0.2, 1.0),
        });

        Ok(())
    }

    fn remove_scripted_actor(&mut self, world: &mut PhysicsWorld, game_id: u32) {
        self.bots.shift_remove(&game_id);
        self.remove_actor(world, game_id);
    }

    fn apply_input(&mut self, game_id: u32, seq: u32, action: &str, key_name: &str) {
        let bit = self.player_keys.get(key_name).map(|k| k.key).unwrap_or(0);

        if let Some(actor) = self.actors.get_mut(&game_id) {
            actor.last_input_seq = seq;
            actor.update_keys(action, bit, &self.key_bits);
        }
    }

    fn last_input_seq(&self, game_id: u32) -> u32 {
        self.actors
            .get(&game_id)
            .map(|actor| actor.last_input_seq)
            .unwrap_or(0)
    }

    fn is_alive(&self, game_id: u32) -> bool {
        self.actors
            .get(&game_id)
            .is_some_and(|actor| actor.is_alive())
    }

    fn actor_position(&self, world: &PhysicsWorld, game_id: u32) -> Option<[f32; 2]> {
        let actor = self.actors.get(&game_id)?;
        let body = world.bodies.get(actor.body)?;
        let pos = body.translation();

        Some([round2(pos.x), round2(pos.y)])
    }

    fn prediction_state(
        &self,
        world: &PhysicsWorld,
        game_id: u32,
    ) -> Option<([f32; PLAYER_STATE_LEN], bool)> {
        let actor = self.actors.get(&game_id)?;
        let body = world.bodies.get(actor.body)?;

        Some(actor.prediction_state(body))
    }

    fn alive_players_flat(&self, world: &PhysicsWorld) -> Vec<f32> {
        let mut out = Vec::new();

        for (id, actor) in &self.actors {
            if !actor.is_alive() {
                continue;
            }

            let Some(body) = world.bodies.get(actor.body) else {
                continue;
            };
            let pos = body.translation();

            out.push(*id as f32);
            out.push(actor.team_id as f32);
            out.push(round2(pos.x));
            out.push(round2(pos.y));
        }

        out
    }

    fn players_json(&self) -> String {
        use serde_json::{Map, Value};

        let mut by_model: Map<String, Value> = Map::new();

        for (game_id, (model, row)) in &self.cached_actors {
            let mut arr: Vec<Value> = Vec::with_capacity(7);

            for value in row.floats {
                arr.push(Value::from(value as f64));
            }

            arr.push(Value::from(row.health));
            arr.push(Value::from(row.team));

            by_model
                .entry(model.clone())
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .unwrap()
                .insert(game_id.to_string(), Value::Array(arr));
        }

        Value::Object(by_model).to_string()
    }

    fn on_fixed_step(&mut self, ctx: &mut SimCtx, dt: f32) {
        let ids: Vec<u32> = self.actors.keys().copied().collect();

        for id in ids {
            let shot;

            {
                let Some(actor) = self.actors.get_mut(&id) else {
                    continue;
                };

                if !actor.is_alive() {
                    continue;
                }

                let Some(body) = ctx.world.bodies.get_mut(actor.body) else {
                    continue;
                };
                let Some(model) = self.models.get(&actor.model) else {
                    continue;
                };

                shot = actor.update(
                    dt,
                    body,
                    model,
                    &self.weapons,
                    &self.key_bits,
                    ctx.rng,
                    ctx.events,
                );
            }

            if let Some(shot) = shot {
                let weapon_index = self.actors[&id].current_weapon;
                let tracer = self.process_hitscan(ctx, id, weapon_index, &shot);

                self.new_tracers
                    .entry(weapon_index)
                    .or_default()
                    .push(tracer);
            }
        }
    }

    /// The one weapon of the template is hitscan, so nothing of this game
    /// reaches the world through contacts. A projectile weapon would decode
    /// the body tags of the pair here and apply its damage.
    fn on_contacts(&mut self, _ctx: &mut SimCtx, _pairs: &[(ColliderHandle, ColliderHandle)]) {}

    /// Same: no game body is ever queued for destruction by this game.
    fn on_before_destroy(&mut self, _world: &PhysicsWorld, _handle: RigidBodyHandle) {}

    fn on_ai_tick(&mut self, ctx: &mut SimCtx, dt: f32) {
        if self.bots.is_empty() {
            return;
        }

        let ids: Vec<u32> = self.bots.keys().copied().collect();

        for id in ids {
            let alive = self.is_alive(id);
            let Some(bot) = self.bots.get_mut(&id) else {
                continue;
            };

            bot.timer -= dt;

            if bot.timer > 0.0 {
                continue;
            }

            // every decision goes through the engine Rng: two runs with one
            // seed must produce the very same match
            bot.timer = ctx.rng.range(0.4, 1.2);

            let turn = ctx.rng.next_f32();
            let mut keys = self.key_bits.forward;

            if turn < 0.35 {
                keys |= self.key_bits.left;
            } else if turn < 0.7 {
                keys |= self.key_bits.right;
            }

            bot.keys = keys;

            let shoots = ctx.rng.next_f32() < 0.5;

            if !alive {
                continue;
            }

            if let Some(actor) = self.actors.get_mut(&id) {
                actor.set_held_keys(keys);

                if shoots {
                    actor.press_once(self.key_bits.fire);
                }
            }
        }

        self.rebuild_spatial_grid(ctx.world, ctx.spatial);
    }

    fn refresh_cached(&mut self, world: &PhysicsWorld) {
        for (game_id, actor) in &self.actors {
            let Some(body) = world.bodies.get(actor.body) else {
                continue;
            };

            if !actor.is_alive() {
                // a dead actor leaves the canvas: the null row below removes
                // it on every client until the engine respawns it
                if self.cached_actors.shift_remove(game_id).is_some() {
                    self.pending_null_actors
                        .push((actor.model.clone(), *game_id));
                }

                continue;
            }

            let (floats, health, team) = actor.snapshot_row(body);

            self.cached_actors.insert(
                *game_id,
                (actor.model.clone(), ActorRow { floats, health, team }),
            );
        }
    }

    fn build_snapshot_blocks(&mut self) -> (Vec<(String, Block)>, bool) {
        let mut blocks: Vec<(String, Block)> = Vec::new();
        // a removal row is an event: the frame carrying it must go over the
        // reliable channel, or a client can miss the removal forever
        let mut had_events = !self.pending_null_actors.is_empty();

        // Indexed8 addresses rows by a single byte, so `as u8` here truncates
        // silently. The invariant that makes it safe: the engine's
        // ParticipantManager hands out the lowest free game id, so ids stay
        // below the participant count — assert it instead of trusting it.
        let mut by_model: IndexMap<String, Vec<(u8, Option<ActorRow>)>> = IndexMap::new();

        for (game_id, (model, row)) in &self.cached_actors {
            debug_assert!(*game_id < 256, "Indexed8 block: game_id must fit in u8");
            by_model
                .entry(model.clone())
                .or_default()
                .push((*game_id as u8, Some(*row)));
        }

        for (model, game_id) in self.pending_null_actors.drain(..) {
            debug_assert!(game_id < 256, "Indexed8 block: game_id must fit in u8");
            by_model
                .entry(model)
                .or_default()
                .push((game_id as u8, None));
        }

        for (model, rows) in by_model {
            let rows = rows
                .into_iter()
                .map(|(id, row)| (id, row.map(|r| r.fields())))
                .collect();

            blocks.push((model, Block::Indexed8(rows)));
        }

        for (weapon_index, tracers) in self.new_tracers.drain(..) {
            if tracers.is_empty() {
                continue;
            }

            had_events = true;

            let name = self.weapons.get_index(weapon_index).unwrap().0.clone();
            let rows = tracers.iter().map(TracerRow::fields).collect();

            blocks.push((name, Block::List16(rows)));
        }

        (blocks, had_events)
    }

    fn remove_players_and_shots(&mut self, world: &mut PhysicsWorld) -> Vec<String> {
        let actors: Vec<Actor> = self.actors.drain(..).map(|(_, actor)| actor).collect();

        for actor in actors {
            world.remove_body(actor.body);
        }

        self.cached_actors.clear();
        self.pending_null_actors.clear();
        self.new_tracers.clear();

        // every configured key, not only the ones in use: right after a map
        // change nobody is alive, and a partial CLEAR would leave stale
        // sprites on the clients
        let mut names: Vec<String> = self.models.keys().cloned().collect();

        for name in self.weapons.keys() {
            names.push(name.clone());
        }

        names
    }

    fn clear(&mut self) {
        self.actors.clear();
        self.bots.clear();
        self.new_tracers.clear();
        self.pending_null_actors.clear();
        self.cached_actors.clear();
    }

    fn serialize(&self) -> serde_json::Value {
        let dump = ArenaDump {
            actors: &self.actors,
            bots: &self.bots,
        };

        serde_json::to_value(dump).unwrap_or(serde_json::Value::Null)
    }

    fn deserialize(&mut self, value: serde_json::Value) -> Result<(), String> {
        let dump: ArenaDumpOwned = serde_json::from_value(value).map_err(|e| e.to_string())?;

        self.actors = dump.actors;
        self.bots = dump.bots;

        self.new_tracers.clear();
        self.pending_null_actors.clear();
        self.cached_actors.clear();

        Ok(())
    }

    fn rebuild_spatial_grid(&self, world: &PhysicsWorld, spatial: &mut SpatialGrid) {
        spatial.clear();

        for (game_id, actor) in &self.actors {
            if !actor.is_alive() {
                continue;
            }

            if let Some(body) = world.bodies.get(actor.body) {
                let pos = body.translation();

                spatial.insert(SpatialEntity {
                    game_id: *game_id,
                    team_id: actor.team_id,
                    x: round2(pos.x),
                    y: round2(pos.y),
                });
            }
        }
    }
}

impl ArenaSim {
    /// Instant ray shot: cast, damage, tracer row for the clients.
    fn process_hitscan(
        &mut self,
        ctx: &mut SimCtx,
        shooter_id: u32,
        weapon_index: usize,
        shot: &ShotCommand,
    ) -> TracerRow {
        let range = self.weapons[weapon_index].range;
        let ray_vector = shot.direction * range;
        let ray = Ray::new(shot.start, ray_vector);
        let shooter_body = self.actors[&shooter_id].body;

        let hit = ctx.world.cast_ray(
            &ray,
            1.0,
            true,
            QueryFilter::new()
                .exclude_sensors()
                .exclude_rigid_body(shooter_body),
        );

        let end = shot.start + ray_vector;
        let mut end_x = round1(end.x);
        let mut end_y = round1(end.y);

        if let Some((collider_handle, toi)) = hit {
            let impact = ray.point_at(toi);

            end_x = round1(impact.x);
            end_y = round1(impact.y);

            let target = ctx
                .world
                .colliders
                .get(collider_handle)
                .and_then(|collider| collider.parent())
                .and_then(|handle| ctx.world.bodies.get(handle))
                .and_then(|body| BodyTag::decode(body.user_data));

            if let Some(BodyTag::Player { game_id, .. }) = target {
                self.apply_damage(ctx, game_id, shooter_id, weapon_index);
            }
        }

        TracerRow {
            floats: [round2(shot.start.x), round2(shot.start.y), end_x, end_y],
            was_hit: hit.is_some(),
            shooter: shooter_id as u8,
        }
    }

    /// Damage with friendly fire, camera shake and the kill event that feeds
    /// the engine scoring (`RoundManager.reportKill`).
    fn apply_damage(
        &mut self,
        ctx: &mut SimCtx,
        target_id: u32,
        shooter_id: u32,
        weapon_index: usize,
    ) {
        if !self.is_alive(target_id) {
            return;
        }

        let target_team = self.actors[&target_id].team_id;
        let shooter_team = self.actors.get(&shooter_id).map(|actor| actor.team_id);

        if !self.friendly_fire && shooter_team == Some(target_team) {
            return;
        }

        let weapon = &self.weapons[weapon_index];

        if let Some(shake) = &weapon.camera_shake {
            ctx.events.push(CoreEvent::Shake {
                id: target_id,
                intensity: shake.intensity,
                duration: shake.duration,
            });
        }

        let damage = weapon.damage;

        let destroyed = {
            let actor = self.actors.get_mut(&target_id).unwrap();
            let Some(body) = ctx.world.bodies.get_mut(actor.body) else {
                return;
            };

            actor.take_damage(damage, body, ctx.events)
        };

        if destroyed {
            // CoreEvent::Custom is the extension point for anything outside
            // this vocabulary — the engine routes it to HostPlugin.onCoreEvent
            // and does not interpret it (see docs/ai/03-host-plugin.md)
            ctx.events.push(CoreEvent::Death {
                victim: target_id,
                killer: shooter_id,
            });
        }
    }
}

#[derive(Serialize)]
struct ArenaDump<'a> {
    actors: &'a IndexMap<u32, Actor>,
    bots: &'a IndexMap<u32, Bot>,
}

#[derive(Deserialize)]
struct ArenaDumpOwned {
    actors: IndexMap<u32, Actor>,
    bots: IndexMap<u32, Bot>,
}
