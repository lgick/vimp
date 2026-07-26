use std::sync::mpsc::channel;

use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::nav::navigation::NavigationSystem;
use crate::nav::spatial::SpatialGrid;
use crate::config::{EngineConfig, PLAYER_STATE_LEN};
use crate::events::CoreEvent;
use crate::map::{GameMap, MapConfig};
use crate::rng::Rng;
use crate::sim::{GameDef, GameSim, SimCtx};
use crate::snapshot::Block;

/// защита от «спирали смерти» (Game._maxAccumulatedTime)
const MAX_ACCUMULATED_TIME: f32 = 0.1;

/// Движковый каркас симуляции: физический мир, карта, нав-граф/сетка
/// ботов, PRNG, аккумулятор фиксированного шага, очередь удаления тел,
/// события. Игровая логика (участники/оружие/снапшот-блоки) вынесена в
/// `G::Sim` (см. core/src/sim.rs) — движок зовёт её только через
/// `on_fixed_step`/`on_contacts`/`on_before_destroy`/`on_ai_tick`, не зная
/// деталей конкретной игры. Конкретная игра (тип `G`, дефолт для
/// `GameState`-алиасов — забота game-crate) не импортируется движком.
pub struct EngineSim<G: GameDef> {
    pub cfg: EngineConfig,
    pub world: PhysicsWorld,
    pub map: Option<GameMap>,
    pub nav: Option<NavigationSystem>,
    pub spatial: SpatialGrid,
    pub rng: Rng,

    time_step: f32,
    accumulator: f32,

    // события для меты, дренируются в take_events
    pub events: Vec<CoreEvent>,

    // очередь тел на удаление после обработки контактов
    bodies_to_destroy: Vec<RigidBodyHandle>,

    // содержал ли последний собранный body событийные блоки — для
    // классификации канала WebRTC (meta reliable / state unreliable)
    last_body_has_events: bool,

    pub sim: G::Sim,
}

impl<G: GameDef> EngineSim<G> {
    pub fn new(cfg: EngineConfig, game_cfg: &G::Config) -> Self {
        let time_step = cfg.time_step;

        let mut world = PhysicsWorld::new();

        world.gravity = Vector::ZERO;
        world.integration_parameters.dt = time_step;

        let seed = cfg.seed;
        let sim = G::Sim::new(game_cfg, &cfg);

        Self {
            world,
            map: None,
            nav: None,
            spatial: SpatialGrid::new(600.0),
            rng: Rng::new(seed),
            time_step,
            accumulator: 0.0,
            events: Vec::new(),
            bodies_to_destroy: Vec::new(),
            last_body_has_events: false,
            sim,
            cfg,
        }
    }

    // ***** карта ***** //

    /// Создаёт карту из JSON (масштабирование внутри) и нав-граф ботов.
    pub fn load_map(&mut self, json: &str) -> Result<(), String> {
        let map_cfg: MapConfig = serde_json::from_str(json).map_err(|e| format!("bad map json: {e}"))?;

        if let Some(mut old) = self.map.take() {
            old.destroy(&mut self.world);
        }

        let map = GameMap::create(&mut self.world, &map_cfg, self.cfg.map_scale, &self.cfg.map_set_id);

        self.nav = Some(NavigationSystem::generate(&map.grid, &map.physics_static, map.step));
        self.map = Some(map);

        Ok(())
    }

    /// Информация о загруженной карте: setId, масштабированные респауны,
    /// размеры мира (JSON) — 'null', если карта не загружена.
    pub fn map_info_json(&self) -> String {
        let Some(map) = &self.map else {
            return "null".to_string();
        };

        let width = map.grid.first().map(|row| row.len()).unwrap_or(0) as f32 * map.step;
        let height = map.grid.len() as f32 * map.step;

        serde_json::json!({
            "setId": map.set_id,
            "step": map.step,
            "width": width,
            "height": height,
            "respawns": map.respawns,
        })
        .to_string()
    }

    // ***** участники ***** //

    pub fn spawn_actor(&mut self, game_id: u32, model_name: &str, team_id: u8, x: f32, y: f32, angle_deg: f32) -> Result<(), String> {
        self.sim
            .spawn_actor(&mut self.world, &mut self.events, game_id, model_name, team_id, x, y, angle_deg)
    }

    pub fn remove_actor(&mut self, game_id: u32) {
        self.sim.remove_actor(&mut self.world, game_id);
    }

    pub fn reset_actor(&mut self, game_id: u32, team_id: u8, x: f32, y: f32, angle_deg: f32) {
        self.sim.reset_actor(&mut self.world, game_id, team_id, x, y, angle_deg);
    }

    pub fn reset_all_vitals(&mut self) {
        self.sim.reset_all_vitals(&mut self.events);
    }

    pub fn spawn_scripted_actor(&mut self, game_id: u32, model_name: &str, team_id: u8, x: f32, y: f32, angle_deg: f32) -> Result<(), String> {
        self.sim.spawn_scripted_actor(
            &mut self.world,
            &mut self.rng,
            &mut self.events,
            game_id,
            model_name,
            team_id,
            x,
            y,
            angle_deg,
        )
    }

    pub fn remove_scripted_actor(&mut self, game_id: u32) {
        self.sim.remove_scripted_actor(&mut self.world, game_id);
    }

    // ***** ввод ***** //

    pub fn apply_input(&mut self, game_id: u32, seq: u32, action: &str, key_name: &str) {
        self.sim.apply_input(game_id, seq, action, key_name);
    }

    pub fn last_input_seq(&self, game_id: u32) -> u32 {
        self.sim.last_input_seq(game_id)
    }

    /// События за тик (kill/health/ammo/weapon/shake) одной JSON-строкой;
    /// буфер очищается.
    pub fn take_events_json(&mut self) -> String {
        let events: Vec<CoreEvent> = self.events.drain(..).collect();

        serde_json::to_string(&events).unwrap_or_else(|_| "[]".to_string())
    }

    // ***** запросы состояния ***** //

    pub fn is_alive(&self, game_id: u32) -> bool {
        self.sim.is_alive(game_id)
    }

    pub fn actor_position(&self, game_id: u32) -> Option<[f32; 2]> {
        self.sim.actor_position(&self.world, game_id)
    }

    pub fn prediction_state(&self, game_id: u32) -> Option<([f32; PLAYER_STATE_LEN], bool)> {
        self.sim.prediction_state(&self.world, game_id)
    }

    pub fn alive_players_flat(&self) -> Vec<f32> {
        self.sim.alive_players_flat(&self.world)
    }

    /// Полный снапшот игроков (Game.getPlayersData), не дренируя
    /// накопители событий — для первого кадра (FIRST_SHOT_DATA).
    pub fn players_json(&self) -> String {
        self.sim.players_json()
    }

    // ***** игровой тик ***** //

    /// Обновляет физику фиксированными шагами (Game.updateData),
    /// затем ИИ скриптовых участников (VIMP._onShotTick).
    pub fn step(&mut self, dt: f32) {
        self.accumulator = (self.accumulator + dt).min(MAX_ACCUMULATED_TIME);

        while self.accumulator >= self.time_step {
            self.step_fixed();
            self.accumulator -= self.time_step;
        }

        self.sim.refresh_cached(&self.world);

        let mut ctx = SimCtx {
            world: &mut self.world,
            cfg: &self.cfg,
            map: &self.map,
            nav: &self.nav,
            spatial: &mut self.spatial,
            rng: &mut self.rng,
            events: &mut self.events,
            bodies_to_destroy: &mut self.bodies_to_destroy,
        };

        self.sim.on_ai_tick(&mut ctx, dt);
    }

    /// Один фиксированный шаг физики.
    fn step_fixed(&mut self) {
        let mut ctx = SimCtx {
            world: &mut self.world,
            cfg: &self.cfg,
            map: &self.map,
            nav: &self.nav,
            spatial: &mut self.spatial,
            rng: &mut self.rng,
            events: &mut self.events,
            bodies_to_destroy: &mut self.bodies_to_destroy,
        };

        self.sim.on_fixed_step(&mut ctx, self.time_step);

        // шаг физического мира со сбором начавшихся контактов
        let (collision_send, collision_recv) = channel();
        let (force_send, _force_recv) = channel();
        let collector = ChannelEventCollector::new(collision_send, force_send);

        self.world.step_with_events(&(), &collector);

        let mut contacts = Vec::new();

        while let Ok(event) = collision_recv.try_recv() {
            if let CollisionEvent::Started(h1, h2, _) = event {
                contacts.push((h1, h2));
            }
        }

        let mut ctx = SimCtx {
            world: &mut self.world,
            cfg: &self.cfg,
            map: &self.map,
            nav: &self.nav,
            spatial: &mut self.spatial,
            rng: &mut self.rng,
            events: &mut self.events,
            bodies_to_destroy: &mut self.bodies_to_destroy,
        };

        self.sim.on_contacts(&mut ctx, &contacts);
        self.destroy_queued_bodies();
    }

    /// Уничтожает тела из очереди (Game._destroyQueuedBodies).
    fn destroy_queued_bodies(&mut self) {
        if self.bodies_to_destroy.is_empty() {
            return;
        }

        let handles: Vec<RigidBodyHandle> = self.bodies_to_destroy.drain(..).collect();

        for handle in handles {
            self.sim.on_before_destroy(&self.world, handle);
            self.world.remove_body(handle);
        }
    }

    // ***** снапшот ***** //

    /// Собирает блоки тела снапшота, дренируя накопители событий.
    /// Вызывается на каждый отправляемый кадр (throttle — забота JS).
    pub fn build_snapshot_blocks(&mut self) -> Vec<(String, Block)> {
        let (mut blocks, has_events) = self.sim.build_snapshot_blocks();

        // динамические элементы карты — каждый отправляемый кадр
        if let Some(map) = &self.map {
            blocks.push((
                map.set_id.clone(),
                Block::IndexedNoNull8(map.dynamic_map_data(&self.world)),
            ));
        }

        self.last_body_has_events = has_events;

        blocks
    }

    /// Содержал ли последний собранный body событийные блоки — для
    /// классификации канала WebRTC (meta reliable / state unreliable).
    pub fn body_has_events(&self) -> bool {
        self.last_body_has_events
    }

    // ***** очистка ***** //

    /// Удаляет всех игроков и снаряды, возвращает имена для очистки
    /// полотна клиентов (Game.removePlayersAndShots).
    pub fn remove_players_and_shots(&mut self) -> Vec<String> {
        self.sim.remove_players_and_shots(&mut self.world)
    }

    /// Полная очистка игрового мира (Game.clear + сброс ботов).
    pub fn clear(&mut self) {
        // карта удаляет свои тела первой: повторное удаление уже
        // удалённого тела в Rapier недопустимо
        if let Some(mut map) = self.map.take() {
            map.destroy(&mut self.world);
        }

        let handles: Vec<RigidBodyHandle> = self.world.rigid_bodies().map(|(handle, _)| handle).collect();

        for handle in handles {
            self.world.remove_body(handle);
        }

        self.sim.clear();
        self.nav = None;
        self.spatial.clear();
        self.bodies_to_destroy.clear();

        self.accumulator = 0.0;
    }

    // ***** handoff (Spike B / Этап 5.2) ***** //

    /// Сериализует состояние симуляции для эстафетной передачи между
    /// инстансами WASM. Накопители снапшота должны быть дренированы
    /// (pack_body) перед вызовом.
    pub fn serialize_state(&self) -> Result<Vec<u8>, String> {
        let dump = EngineDump {
            world: WorldDump {
                gravity: [self.world.gravity.x, self.world.gravity.y],
                integration_parameters: self.world.integration_parameters,
                islands: self.world.islands.clone(),
                broad_phase: self.world.broad_phase.clone(),
                narrow_phase: self.world.narrow_phase.clone(),
                bodies: self.world.bodies.clone(),
                colliders: self.world.colliders.clone(),
                impulse_joints: self.world.impulse_joints.clone(),
                multibody_joints: self.world.multibody_joints.clone(),
            },
            map: &self.map,
            rng: &self.rng,
            accumulator: self.accumulator,
            sim: self.sim.serialize(),
        };

        serde_json::to_vec(&dump).map_err(|e| e.to_string())
    }

    /// Восстанавливает состояние из дампа. Конфиг ядра должен совпадать
    /// с конфигом инстанса, создавшего дамп.
    pub fn deserialize_state(&mut self, data: &[u8]) -> Result<(), String> {
        let dump: EngineDumpOwned = serde_json::from_slice(data).map_err(|e| e.to_string())?;

        let mut world = PhysicsWorld::new();

        world.gravity = Vector::new(dump.world.gravity[0], dump.world.gravity[1]);
        world.integration_parameters = dump.world.integration_parameters;
        world.islands = dump.world.islands;
        world.broad_phase = dump.world.broad_phase;
        world.narrow_phase = dump.world.narrow_phase;
        world.bodies = dump.world.bodies;
        world.colliders = dump.world.colliders;
        world.impulse_joints = dump.world.impulse_joints;
        world.multibody_joints = dump.world.multibody_joints;

        self.world = world;
        self.map = dump.map;
        self.rng = dump.rng;
        self.accumulator = dump.accumulator;
        self.sim.deserialize(dump.sim)?;

        self.bodies_to_destroy.clear();
        self.events.clear();

        // производные структуры не входят в дамп: нав-граф регенерируется
        // из карты, пространственная сетка — из живых участников
        self.nav = self
            .map
            .as_ref()
            .map(|map| NavigationSystem::generate(&map.grid, &map.physics_static, map.step));

        self.sim.rebuild_spatial_grid(&self.world, &mut self.spatial);
        self.sim.refresh_cached(&self.world);

        Ok(())
    }
}

#[derive(Serialize)]
struct WorldDump {
    gravity: [f32; 2],
    integration_parameters: IntegrationParameters,
    islands: IslandManager,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
}

#[derive(Deserialize)]
struct WorldDumpOwned {
    gravity: [f32; 2],
    integration_parameters: IntegrationParameters,
    islands: IslandManager,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
}

#[derive(Serialize)]
struct EngineDump<'a> {
    world: WorldDump,
    map: &'a Option<GameMap>,
    rng: &'a Rng,
    accumulator: f32,
    sim: serde_json::Value,
}

#[derive(Deserialize)]
struct EngineDumpOwned {
    world: WorldDumpOwned,
    map: Option<GameMap>,
    rng: Rng,
    accumulator: f32,
    sim: serde_json::Value,
}

/// Фикстурная вторая игра (Этап 7 плана отделения движка, PLAN.md):
/// доказывает форму `GameDef`/`GameSim<G>` без физических тел (актёры —
/// плоские данные, не rapier-тела — `spawn_actor` и т.п. игнорируют `world`,
/// трейт этого не требует). Тот же принцип, что у клиентской фикстуры
/// `TestClient` (`crate::client::game`): форма ABI важнее физики. Используется
/// только тестами этого модуля, не влияет на `TanksGame`.
#[cfg(test)]
mod fixture {
    use super::*;
    use crate::config::FieldValue;
    use serde::Deserialize;
    use std::collections::{BTreeMap, BTreeSet};

    #[derive(Deserialize)]
    pub struct TestConfig {}

    pub struct TestGame;

    impl GameDef for TestGame {
        type Config = TestConfig;
        type Sim = TestSim;
    }

    #[derive(Clone, Copy)]
    struct TestActor {
        x: f32,
        y: f32,
        vx: f32,
        vy: f32,
        team: u8,
        alive: bool,
    }

    pub struct TestSim {
        actors: BTreeMap<u32, TestActor>,
        scripted: BTreeSet<u32>,
    }

    impl GameSim<TestGame> for TestSim {
        fn new(_cfg: &TestConfig, _engine_cfg: &EngineConfig) -> Self {
            Self {
                actors: BTreeMap::new(),
                scripted: BTreeSet::new(),
            }
        }

        fn spawn_actor(
            &mut self,
            _world: &mut PhysicsWorld,
            _events: &mut Vec<CoreEvent>,
            game_id: u32,
            _model_name: &str,
            team_id: u8,
            x: f32,
            y: f32,
            _angle_deg: f32,
        ) -> Result<(), String> {
            self.actors.insert(
                game_id,
                TestActor { x, y, vx: 0.0, vy: 0.0, team: team_id, alive: true },
            );

            Ok(())
        }

        fn remove_actor(&mut self, _world: &mut PhysicsWorld, game_id: u32) {
            self.actors.remove(&game_id);
            self.scripted.remove(&game_id);
        }

        fn reset_actor(&mut self, _world: &mut PhysicsWorld, game_id: u32, team_id: u8, x: f32, y: f32, _angle_deg: f32) {
            if let Some(actor) = self.actors.get_mut(&game_id) {
                actor.x = x;
                actor.y = y;
                actor.team = team_id;
                actor.alive = true;
            }
        }

        fn reset_all_vitals(&mut self, _events: &mut Vec<CoreEvent>) {
            for actor in self.actors.values_mut() {
                actor.alive = true;
            }
        }

        fn spawn_scripted_actor(
            &mut self,
            world: &mut PhysicsWorld,
            _rng: &mut Rng,
            events: &mut Vec<CoreEvent>,
            game_id: u32,
            model_name: &str,
            team_id: u8,
            x: f32,
            y: f32,
            angle_deg: f32,
        ) -> Result<(), String> {
            self.spawn_actor(world, events, game_id, model_name, team_id, x, y, angle_deg)?;
            self.scripted.insert(game_id);

            Ok(())
        }

        fn remove_scripted_actor(&mut self, world: &mut PhysicsWorld, game_id: u32) {
            self.remove_actor(world, game_id);
        }

        fn apply_input(&mut self, game_id: u32, _seq: u32, action: &str, key_name: &str) {
            let Some(actor) = self.actors.get_mut(&game_id) else {
                return;
            };

            let magnitude = if action == "down" { 40.0 } else { 0.0 };

            match key_name {
                "forward" => actor.vy = -magnitude,
                "back" => actor.vy = magnitude,
                _ => {}
            }
        }

        fn last_input_seq(&self, _game_id: u32) -> u32 {
            0
        }

        fn is_alive(&self, game_id: u32) -> bool {
            self.actors.get(&game_id).is_some_and(|a| a.alive)
        }

        fn actor_position(&self, _world: &PhysicsWorld, game_id: u32) -> Option<[f32; 2]> {
            self.actors.get(&game_id).map(|a| [a.x, a.y])
        }

        fn prediction_state(&self, _world: &PhysicsWorld, game_id: u32) -> Option<([f32; PLAYER_STATE_LEN], bool)> {
            self.actors
                .get(&game_id)
                .map(|a| ([a.x, a.y, 0.0, a.vx, a.vy, 0.0, 0.0, 0.0], false))
        }

        fn alive_players_flat(&self, _world: &PhysicsWorld) -> Vec<f32> {
            self.actors
                .iter()
                .filter(|(_, a)| a.alive)
                .flat_map(|(id, a)| [*id as f32, a.x, a.y])
                .collect()
        }

        fn players_json(&self) -> String {
            let rows: Vec<serde_json::Value> = self
                .actors
                .iter()
                .map(|(id, a)| serde_json::json!({ "id": id, "x": a.x, "y": a.y, "team": a.team }))
                .collect();

            serde_json::to_string(&rows).unwrap()
        }

        fn on_fixed_step(&mut self, _ctx: &mut SimCtx, dt: f32) {
            for actor in self.actors.values_mut() {
                actor.x += actor.vx * dt;
                actor.y += actor.vy * dt;
            }
        }

        fn on_contacts(&mut self, _ctx: &mut SimCtx, _pairs: &[(ColliderHandle, ColliderHandle)]) {}

        fn on_before_destroy(&mut self, _world: &PhysicsWorld, _handle: RigidBodyHandle) {}

        fn on_ai_tick(&mut self, _ctx: &mut SimCtx, _dt: f32) {
            // тривиальный ИИ фикстуры: скриптовый актёр всегда едет вправо
            for &id in &self.scripted {
                if let Some(actor) = self.actors.get_mut(&id) {
                    actor.vx = 1.0;
                }
            }
        }

        fn refresh_cached(&mut self, _world: &PhysicsWorld) {}

        fn build_snapshot_blocks(&mut self) -> (Vec<(String, Block)>, bool) {
            let rows: Vec<(u8, Option<Vec<FieldValue>>)> = self
                .actors
                .iter()
                .map(|(id, a)| (*id as u8, Some(vec![FieldValue::F32(a.x), FieldValue::F32(a.y)])))
                .collect();

            (vec![("actor".to_string(), Block::Indexed8(rows))], false)
        }

        fn remove_players_and_shots(&mut self, _world: &mut PhysicsWorld) -> Vec<String> {
            let names: Vec<String> = self.actors.keys().map(|id| id.to_string()).collect();

            self.actors.clear();
            self.scripted.clear();

            names
        }

        fn clear(&mut self) {
            self.actors.clear();
            self.scripted.clear();
        }

        fn serialize(&self) -> serde_json::Value {
            let rows: Vec<serde_json::Value> = self
                .actors
                .iter()
                .map(|(id, a)| serde_json::json!({ "id": id, "x": a.x, "y": a.y, "team": a.team }))
                .collect();

            serde_json::json!({ "actors": rows })
        }

        fn deserialize(&mut self, value: serde_json::Value) -> Result<(), String> {
            let rows = value["actors"].as_array().ok_or("missing actors")?;

            self.actors.clear();

            for row in rows {
                let id = row["id"].as_u64().ok_or("bad id")? as u32;
                let x = row["x"].as_f64().ok_or("bad x")? as f32;
                let y = row["y"].as_f64().ok_or("bad y")? as f32;
                let team = row["team"].as_u64().ok_or("bad team")? as u8;

                self.actors.insert(id, TestActor { x, y, vx: 0.0, vy: 0.0, team, alive: true });
            }

            Ok(())
        }

        fn rebuild_spatial_grid(&self, _world: &PhysicsWorld, _spatial: &mut SpatialGrid) {}
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::{TestConfig, TestGame};
    use super::*;
    use crate::snapshot::SnapshotPacker;

    fn engine_config() -> EngineConfig {
        serde_json::from_value(serde_json::json!({
            "timeStep": 1.0 / 120.0,
            "snapshot": {
                "version": 3,
                "port": 5,
                "keys": {
                    "actor": { "id": 1, "kind": "indexed8", "class": "hot", "fields": [
                        { "name": "x", "ty": "f32", "interp": "lerp" },
                        { "name": "y", "ty": "f32", "interp": "lerp" }
                    ] }
                }
            },
            "seed": 42
        }))
        .unwrap()
    }

    fn make_sim() -> EngineSim<TestGame> {
        EngineSim::new(engine_config(), &TestConfig {})
    }

    #[test]
    fn spawn_actor_and_fixed_step_moves_position() {
        let mut sim = make_sim();

        sim.spawn_actor(1, "m", 1, 0.0, 0.0, 0.0).unwrap();
        sim.apply_input(1, 1, "down", "forward");

        for _ in 0..60 {
            sim.step(1.0 / 120.0);
        }

        let pos = sim.actor_position(1).unwrap();

        assert!(pos[1] < 0.0); // forward = -vy
    }

    #[test]
    fn remove_actor_clears_state() {
        let mut sim = make_sim();

        sim.spawn_actor(1, "m", 1, 5.0, 5.0, 0.0).unwrap();
        assert!(sim.is_alive(1));

        sim.remove_actor(1);
        assert!(!sim.is_alive(1));
        assert!(sim.actor_position(1).is_none());
    }

    #[test]
    fn scripted_actor_runs_ai_tick() {
        let mut sim = make_sim();

        sim.spawn_scripted_actor(9, "m", 1, 0.0, 0.0, 0.0).unwrap();

        // on_ai_tick — после фикс-шага в том же step(); vx применяется к
        // позиции только следующим вызовом
        sim.step(1.0 / 120.0);
        sim.step(1.0 / 120.0);

        let after = sim.actor_position(9).unwrap();

        assert!(after[0] > 0.0); // фикстурный ИИ едет вправо (vx = 1.0)
    }

    #[test]
    fn build_snapshot_blocks_packs_through_generic_schema() {
        let mut sim = make_sim();

        sim.spawn_actor(1, "m", 1, 3.0, 4.0, 0.0).unwrap();
        sim.spawn_actor(2, "m", 1, 7.0, 8.0, 0.0).unwrap();

        let blocks = sim.build_snapshot_blocks();
        let mut packer = SnapshotPacker::new(engine_config().snapshot);

        assert!(packer.pack_body(&blocks).is_ok());
    }

    #[test]
    fn clear_removes_all_actors() {
        let mut sim = make_sim();

        sim.spawn_actor(1, "m", 1, 0.0, 0.0, 0.0).unwrap();
        sim.spawn_scripted_actor(2, "m", 1, 0.0, 0.0, 0.0).unwrap();

        sim.clear();

        assert!(!sim.is_alive(1));
        assert!(!sim.is_alive(2));
        assert_eq!(sim.alive_players_flat().len(), 0);
    }

    #[test]
    fn serialize_deserialize_round_trips_actors() {
        let mut sim = make_sim();

        sim.spawn_actor(1, "m", 3, 11.0, 22.0, 0.0).unwrap();

        let dump = sim.sim.serialize();
        let mut restored = make_sim();

        restored.sim.deserialize(dump).unwrap();

        assert_eq!(restored.actor_position(1), Some([11.0, 22.0]));
    }
}
