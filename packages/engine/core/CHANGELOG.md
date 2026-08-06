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

[0.2.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.2.1
[0.2.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.2.0
[0.1.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.1.0
