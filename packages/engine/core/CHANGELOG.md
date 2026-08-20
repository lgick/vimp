# Changelog

All notable changes to the `vimp-engine-core` **crate** are documented here.
The npm package `vimp-engine` has its own journal:
[../CHANGELOG.md](../CHANGELOG.md). The format is based on
[Keep a Changelog](https://keepachangelog.com/); this crate uses
[Semantic Versioning](https://semver.org/) (in `0.x`, a breaking change bumps
the minor version).

A bump here has to be repeated by hand in every game crate that depends on
it (e.g. `vimp-tanks/core/Cargo.toml` → `vimp-engine-core = "X.Y.Z"`), since
the dependency is by version, not by path.

## [Unreleased]

### Added

- `client::collision` and `client::rigid_body` — the contact primitives a
  client needs to predict the geometry the host resolves. `collision`
  brings `box_center_from_origin` (a map body's origin corner → the box
  centre), `obb_vs_obb` (SAT, returning the minimum translation vector,
  the depth and a blended contact point) and `collect_tile_contacts` (an
  OBB against the solid cells of the tile grid); it reads the map through
  the same `Box2` and the same grid triple as `client::raycast`, so a ray
  and a contact can never disagree about a wall. `rigid_body` brings the
  `Body`/`Surface`/`MassProperties` types, `integrate`, `separate_bodies`
  and `apply_contact_impulse` (a sequential-impulse solver with
  restitution and a Coulomb friction cone), `box_mass_properties` and
  `combine_surfaces` (Rapier's `CoefficientCombineRule::Average`). Its
  `MAP_SURFACE` is built from `map::DEFAULT_FRICTION` /
  `DEFAULT_RESTITUTION`, now public, so the replica and the host cannot
  drift apart on surface values. `client::raycast::Box2` is now `Copy`.

### Fixed

- Dynamic map objects no longer sink into geometry on impact. Rapier's
  default contact prediction distance is 0.002 units, a figure meant for a
  metre-scale world, while a body in a match covers orders of magnitude more
  per `1/120` step — so the contact was born only once the shapes already
  overlapped deeply. `GameMap::create_dynamic` now builds the body with
  `soft_ccd_prediction(width.min(height))`, the object's own thickness.
  Static walls are unchanged.

## [0.4.0] — 2026-08-19

### Added

- `GameSim::apply_aim(game_id, seq, x, y, flags)` and
  `GameClientDef::apply_aim(x, y, flags, local_now)` — the pointer input
  channel (mouse, finger, stylus), carrying a value the discrete
  `apply_input(action, key_name)` string cannot: a **world** point plus a bit
  mask (bit 0 «pressed», bit 1 «double tap»). Both are declared with a
  **default empty body**, so a game crate that ignores the pointer compiles
  unchanged; `export_game_core_abi!` and `export_client_core_abi!` expose
  them as `apply_aim(...)` on the respective WASM cores. The engine converts
  screen coordinates to world coordinates before the call, so the game half
  gets a point in the same space as `actor_position`.

## [0.3.0] — 2026-08-09

### Added

- `ClientState::resync()` — clears the network half only (interpolation
  buffer, outgoing frame queue), leaving prediction and the local identity
  intact. For a tab returning from a long pause: the clock offset is
  reseeded from the next frame instead of being chased by the EMA for dozens
  of frames, while entities on the canvas stay alive. Exposed as `resync()`
  by `export_client_core_abi!`.

### ⚠️ Breaking — `reset()` also clears `my_game_id`

`ClientState::reset()` (the `CLEAR` port) means "the world is gone", so it
now drops the local player's identity as well. Previously the identity
survived a clear, and the game half kept rendering a predicted entity for a
player the host no longer had — a ghost on an otherwise empty canvas after a
map change. The identity is restored from the first player block that
follows; a spectator has none, so no predicted entity is drawn.

### Migration

A game crate that reads `my_game_id()` right after a `CLEAR` now gets
`None`; wait for the first frame carrying a player block. A `GameClientDef`
that keeps its own copy of the local actor's identity should clear it in its
`reset()` too (this is what `TanksClient` does with `my_tank_meta`).

### ⚠️ Breaking — `GameClientDef::set_server_offset` removed

The method handed the interpolator's offset to the game half once per render
tick, documented as "a latency estimate for RTT compensation of visual
effects". That description was wrong and the API existed only to serve it:
the offset is `serverTime − localNow`, where `serverTime` is the host's
`Date.now()` and `localNow` is the client's `performance.now()` — a clock
difference on the order of 1e12 ms, not a network delay. A game that took it
for a latency and extrapolated a spawn position by `velocity × offset` threw
the entity out of the world (visible only while moving; standing still the
term is zero). Nothing else needed the hook: reconciliation already receives
the offset as an argument of `on_server_state`, and `ClientState::offset()`
(ABI `offset()`) still exposes it for diagnostics, now documented as a clock
difference.

### Migration

Delete `set_server_offset` from every `impl GameClientDef` — no replacement
call is needed. A game that used it to compensate a locally spawned entity's
position should spawn at the predicted position and let the authoritative
row correct it once on confirmation (rename it to the local id instead of
dropping it, so the entity is updated rather than recreated).

## [0.2.1] — 2026-08-05

### Fixed

- `DivergenceTracker` with `capacity: 0` reported one eviction more than it
  performed: the buffer always keeps one record, but the counter assumed an
  empty buffer, so a report claimed "N dropped" after N−1 evictions. The
  configured capacity is now clamped to at least 1 (`client/divergence.rs`).

## [0.2.0] — 2026-08-05

### Added

- `debug.rs` — a curated world dump behind `debug_json`: bodies, map, nav
  and RNG state in one JSON slice, so "the core has a body, the canvas is
  empty" is visible from a single file.
- `client/divergence.rs` — a prediction-drift tracker behind
  `take_divergence`: the predicted state is captured before reconciliation
  and compared with the frame's player block, matched by frame time rather
  than by input `seq`.
- `GameClientDef::predicted_state` — drift detection level 1. A game that
  implements it gets a component-wise comparison of its own predicted state;
  a game that does not falls back to level 0 (the overlay camera).
- Config section for the detector (`config.rs`) and the corresponding ABI
  entries (`abi.rs`), so a game implements nothing to get either feature.

## [0.1.0] — 2026-07-26

### Added

- First published release. The simulation framework extracted from the game
  core into a reusable rlib: `rapier2d` physics, map model, snapshot frame
  codec, interpolation/prediction/raycast primitives, navigation and spatial
  utilities, RNG, and the `macro_rules!` ABI generators. Deliberately without
  `wasm-bindgen` — the WASM ABI wrappers are built by each game's own crate.

[0.4.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.4.0
[0.3.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.3.0
[0.2.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.2.1
[0.2.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.2.0
[0.1.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.1.0
