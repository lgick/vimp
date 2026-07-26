//! Граница движковый-цикл ↔ игровая симуляция (Этап 4a.1 плана распила
//! движка/игры, PLAN.md §3.6). `EngineSim<G>` (core/src/game.rs) владеет
//! физическим миром, картой, нав-графом/сеткой ботов, PRNG и очередью
//! удаления тел; конкретная игра (`TanksSim` и т.п.) реализует `GameSim<G>`
//! и получает доступ к движковому через `SimCtx` только там, где нужен
//! шаг тика (`on_fixed_step`/`on_contacts`/`on_before_destroy`/`on_ai_tick`).
//! Один wasm-бандл — одна игра: мономорфизация `EngineSim<TanksGame>` без
//! динамической диспетчеризации.

use rapier2d::prelude::*;

use crate::nav::navigation::NavigationSystem;
use crate::nav::spatial::SpatialGrid;
use crate::config::{EngineConfig, PLAYER_STATE_LEN};
use crate::events::CoreEvent;
use crate::map::GameMap;
use crate::rng::Rng;
use crate::snapshot::Block;

/// Связывает конкретную игру с её типом симуляции и конфигом. `Config` —
/// игровая половина init-JSON (модели/оружие/панель и т.п.); движковая
/// половина — `crate::config::EngineConfig`, общая для любой игры.
pub trait GameDef: Sized {
    type Config: serde::de::DeserializeOwned;
    type Sim: GameSim<Self>;
}

/// Контекст движкового тика, передаваемый игровым callback'ам.
pub struct SimCtx<'a> {
    pub world: &'a mut PhysicsWorld,
    pub cfg: &'a EngineConfig,
    pub map: &'a Option<GameMap>,
    pub nav: &'a Option<NavigationSystem>,
    pub spatial: &'a mut SpatialGrid,
    pub rng: &'a mut Rng,
    pub events: &'a mut Vec<CoreEvent>,
    pub bodies_to_destroy: &'a mut Vec<RigidBodyHandle>,
}

/// Игровая симуляция поверх движкового каркаса: участники, оружие,
/// снапшот-блоки. Игровой конфиг (`G::Config`) передаётся только в `new` —
/// реализация хранит нужные ей куски сама (модели/оружие не меняются в
/// течение комнаты), поэтому остальные методы им не параметризованы.
/// Методы вне тика получают только то, что им реально нужно (не весь
/// `SimCtx`), тиковые callback'ы — `SimCtx`, т.к. в них нужен произвольный
/// набор движковых ресурсов одновременно.
#[allow(clippy::too_many_arguments)]
pub trait GameSim<G: GameDef>: Sized {
    /// `engine_cfg` — доступен только на конструкторе (напр. `time_step` для
    /// расчёта размера кольцевых буферов по времени жизни снарядов);
    /// остальные методы движковый конфиг не получают — см. `SimCtx::cfg`.
    fn new(cfg: &G::Config, engine_cfg: &EngineConfig) -> Self;

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
    ) -> Result<(), String>;
    fn remove_actor(&mut self, world: &mut PhysicsWorld, game_id: u32);
    fn reset_actor(&mut self, world: &mut PhysicsWorld, game_id: u32, team_id: u8, x: f32, y: f32, angle_deg: f32);
    fn reset_all_vitals(&mut self, events: &mut Vec<CoreEvent>);
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
    ) -> Result<(), String>;
    fn remove_scripted_actor(&mut self, world: &mut PhysicsWorld, game_id: u32);

    fn apply_input(&mut self, game_id: u32, seq: u32, action: &str, key_name: &str);
    fn last_input_seq(&self, game_id: u32) -> u32;
    fn is_alive(&self, game_id: u32) -> bool;
    fn actor_position(&self, world: &PhysicsWorld, game_id: u32) -> Option<[f32; 2]>;
    fn prediction_state(&self, world: &PhysicsWorld, game_id: u32) -> Option<([f32; PLAYER_STATE_LEN], bool)>;
    fn alive_players_flat(&self, world: &PhysicsWorld) -> Vec<f32>;
    fn players_json(&self) -> String;

    /// Игровая логика фиксированного шага (движение, спавн снарядов,
    /// детонация по истечению времени) — до шага физики.
    fn on_fixed_step(&mut self, ctx: &mut SimCtx, dt: f32);
    /// Контакты, начавшиеся на этом шаге физики (после `world.step`).
    fn on_contacts(&mut self, ctx: &mut SimCtx, pairs: &[(ColliderHandle, ColliderHandle)]);
    /// Движок зовёт перед удалением тела из очереди уничтожения —
    /// возможность прочитать тег и обновить свою бухгалтерию.
    fn on_before_destroy(&mut self, world: &PhysicsWorld, handle: RigidBodyHandle);
    /// ИИ скриптовых участников; сама решает, есть ли для неё работа.
    fn on_ai_tick(&mut self, ctx: &mut SimCtx, dt: f32);

    fn refresh_cached(&mut self, world: &PhysicsWorld);
    /// Собирает игровые блоки снапшота (без динамики карты — её строит
    /// движок) и признак "были события" (для классификации канала WebRTC).
    fn build_snapshot_blocks(&mut self) -> (Vec<(String, Block)>, bool);

    fn remove_players_and_shots(&mut self, world: &mut PhysicsWorld) -> Vec<String>;
    fn clear(&mut self);

    fn serialize(&self) -> serde_json::Value;
    fn deserialize(&mut self, value: serde_json::Value) -> Result<(), String>;
    fn rebuild_spatial_grid(&self, world: &PhysicsWorld, spatial: &mut SpatialGrid);
}
