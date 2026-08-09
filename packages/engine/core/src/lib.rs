//! VIMP — движковый каркас симуляции (Этап 4b распила движка/игры,
//! PLAN.md §2-3). Физика/карта/снапшот-фрейминг/интерполяция/предикт-примитивы/
//! raycast/нав-утилиты — общие для любой игры; `sim::{GameDef, GameSim,
//! SimCtx}` — граница, через которую конкретная игра (game-crate, cdylib с
//! wasm-bindgen-обёртками `GameCore`/`ClientCore`) подключает свою логику.
//! Эта библиотека — rlib без wasm-bindgen: игровой crate раскрывает
//! `#[wasm_bindgen]` рядом со своими типами (wasm-bindgen не умеет
//! экспортировать generics), engine-crate от wasm-bindgen не зависит вовсе.

// ПРОБА РЕЛИЗА — снять следующим релизом (release-probe).

pub mod abi;
pub mod client;
pub mod config;
pub mod debug;
pub mod events;
pub mod game;
pub mod map;
pub mod nav;
pub mod physics;
pub mod rng;
pub mod sim;
pub mod snapshot;
