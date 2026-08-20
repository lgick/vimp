//! Движковые клиентские примитивы: snapshot-интерполяция (schema-driven),
//! бинарный декодер кадра v3 (framing), 2D raycast, примитивы столкновений
//! (SAT-контакты + импульсный решатель) и generic-оркестрация
//! рендер-тика (`game::ClientState<G>`) поверх игровой предикт-логики
//! (`game::GameClientDef`, реализует конкретная игра — см.
//! games/tanks/core/src/client/mod.rs).

pub mod collision;
pub mod divergence;
pub mod game;
pub mod interpolator;
pub mod raycast;
pub mod rigid_body;
pub mod unpack;

// флаги hot-буфера ([0]); зеркалятся в src/config/opcodes.js (HOT_FLAGS)
pub const HOT_HAS_GAME: u32 = 1;
pub const HOT_HAS_CAMERA: u32 = 2;
pub const HOT_HAS_PREDICTED: u32 = 4;
pub const HOT_HAS_FRAMES: u32 = 8;
