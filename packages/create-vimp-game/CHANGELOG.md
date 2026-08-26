# Changelog

All notable changes to `create-vimp-game` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- The template's `build-game-manifest.js` no longer writes `packageVersion`
  into `dist/manifest.json`: the engine now reads the game package's
  `package.json` on the master instead, which also works for games published
  before the field existed (see `vimp-engine`'s own changelog).

## [0.2.0] — 2026-08-26

### Added

- The template's `build-game-manifest.js` writes `packageVersion` into
  `dist/manifest.json` — the `version` of the game's own `package.json`. The
  engine shows it in the `#auth` footer, since the manifest's `version` is a
  bundle hash and means nothing to a player (see `vimp-engine`'s own
  changelog).

## [0.1.14] — 2026-08-25

### Changed

- The template's `build-game-manifest.js` now also writes `min`/`max` on the
  generated `maxPlayers`/`roundTime`/`mapTime` `roomForm` fields, alongside
  the existing generated `regExp` — the engine uses them to show a range
  hint next to the field's label and to validate without a native browser
  popup (see `vimp-engine`'s own changelog).

## [0.1.13] — 2026-08-21

Covers `0.1.5` … `0.1.13`, which this journal skipped at the time: version
bumps only, one per engine release. Each moved the
`vimp-engine`/`vimp-engine-core` versions the generator writes into a
scaffolded game (`src/versions.generated.json`, now `0.14.4`/`0.8.3`);
nothing in the CLI, the generator or the template changed.

## [0.1.4] — 2026-08-19

### Fixed

- `bin` path in `package.json` no longer starts with `./`: npm rewrote it on
  every publish and warned «script name … was invalid and removed».

## [0.1.0] — 2026-08-18

### Added

- Package skeleton: `create-vimp-game` CLI (`--id`, `--title`, `--package`,
  `--author`, `--yes`, `--force`, `--no-git`, `--engine-path`, `--core-path`),
  the template generator with `{{TOKEN}}` substitution, `_`-prefix and `.tpl`
  renames, and preflight checks for `cargo`/`wasm-pack`.
- `vimp-engine` and `vimp-engine-core` pins are resolved from the engine
  repository (or from `src/versions.generated.json`, written by the `prepack`
  hook) instead of being hardcoded in the template.
- Template build infrastructure: `package.json` with the standard script set,
  `vite.config.js` (dev harness + the two `--mode client|host` builds),
  `vitest.config.js` (`unit` + `integration` projects), `eslint.config.js`,
  the Cargo workspace with `core/`, and the build scripts
  (`build-game-manifest.js`, `export-maps.js`, `copy-game-sounds.js`,
  `copy-game-images.js`, `process-audio.js`, `lib/rangeToPattern.js`).
- Template dev harness: `index.html` + `dev/main.js` (`startStandaloneGame`
  with live plugins, bots and `devMode`), plus the generated `CLAUDE.md`
  stating the thread boundaries, the contract constants and the check
  commands.
- Template Rust core: `GameDef`/`GameSim` (actors, bots, hitscan, snapshot
  blocks) and `GameClientDef` (prediction, local tracer, drift reporting)
  behind `export_game_core_abi!` / `export_client_core_abi!`, with the
  movement math kept in a single `motion.rs` shared by both halves, a
  `mod parity` cargo test guarding that sharing, and `core/tests/sim.rs`
  covering respawns, walls, damage, friendly fire, save/restore and seed
  determinism.
- Template JS layer: `src/config/` (snapshot schema, `gameConfig`, client
  config, auth schema, sound registry), `src/data/` (one model, one hitscan
  weapon, the procedural `arena` map), `src/host/` (plugin entry, WASM loader
  for both runtimes, bot manager, `/spawn`, system messages) and
  `src/client/` (plugin entry, `Map`/`Actor`/`ShotEffect` parts, the
  `actorTexture` baker, HUD styles) — a playable two-team deathmatch with
  bots, shipping no images at all.
- Template tests: `tests/config/contract.test.js`,
  `tests/host/hostPlugin.test.js`, `tests/client/parts.test.js` (unit) and
  `tests/core/nodeCore.test.js` (integration, skipped until
  `npm run core:build:node`).
- Placeholder sounds (`shot`, `death`) as `webm` + `mp3` pairs, so the first
  build of a scaffolded game is green without ffmpeg; `assets/audio-raw/*.wav`
  keeps the full `npm run audio:process` pipeline demonstrable.

[0.2.0]: https://github.com/lgick/vimp/releases/tag/create-vimp-game%400.2.0
[0.1.14]: https://github.com/lgick/vimp/releases/tag/create-vimp-game%400.1.14
[0.1.13]: https://github.com/lgick/vimp/releases/tag/create-vimp-game%400.1.13
[0.1.4]: https://github.com/lgick/vimp/releases/tag/create-vimp-game%400.1.4
[0.1.0]: https://github.com/lgick/vimp/releases/tag/create-vimp-game%400.1.0
