# Changelog

All notable changes to the `vimp-engine` package are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/);
this project uses [Semantic Versioning](https://semver.org/) (in `0.x`, a
breaking change bumps the minor version).

## [0.6.0] — 2026-08-05

### ⚠️ Breaking — stricter `gameConfig` gate

The plugin API itself is unchanged: `ENGINE_API_VERSION` stays **3**, no
manifest restamp and no plugin rebuild are required. What changed is that
configs the engine used to accept and then fail on later — or silently
degrade on — are now rejected at load, naming the field:

- `teams` and `spectatorTeam` are **required** (`REQUIRED_GAME_CONFIG_PATHS`
  grew from seven paths to nine). They always were, de facto: without them
  `HostGame` dereferenced `undefined` and the game died in three different
  places with three unrelated messages.
- `spectatorTeam` must be a **key of `teams`**. A typo used to leave the
  spectator team id `undefined`, and the first participant to join crashed in
  `ParticipantManager.createHuman` on a team counter that does not exist.
- `null` in any required path now counts as **missing**. Previously only
  `undefined` did, so `snapshot: null` or `weapons: null` passed the gate and
  failed later, somewhere else.

**Migration.** If the host now refuses to start with
`gameConfig is missing required field(s): …` or
`spectatorTeam '…' is not a key of teams (…)`, the named field was already
broken — declare it (or spell it as one of the `teams` keys) and the plugin
loads as before. A plugin that passes today needs no change.

### Added

- `vimp-sim`: the built-in smoke scenario is now built from the game's own
  `gameConfig` — model from `parts.models`, playable team from `teams` minus
  `spectatorTeam`, and the first `playerKeys` entry that is not a `type: 1`
  trigger. It used to hardcode the engine fixture's `m1`/`team1`/`forward`,
  which crashed or failed a perfectly good third-party plugin.
- Scenario field `unusedSnapshotKeys: "*"` — "this scenario does not audit key
  coverage at all", which makes invariant 2 **skip** instead of reporting the
  game's keys as never spawning.
- `vimp-sim --core` without `--game` prints a notice: the run falls back to
  the fixture, whose core is plain JS, so the flag does nothing.

### Changed

- The `gameConfig` gate now runs inside `devtools/pluginLoader.js`, not only
  in `createHostRuntime` — the built-in scenario reads `gameConfig` before the
  run starts, so a plugin without one answered with a raw `TypeError`. The
  fixture goes through the same gate as a third-party plugin.
- Invariant 9 (`predictionDrift`) skipped by a scenario that sets
  `divergence: null` now says so, instead of blaming the client core for
  reporting no divergence data.
- `vimp-sim` usage errors (unknown option, missing option value) print the
  message and `USAGE` without a Node stack; `--scenario`/`--game`/`--core`/
  `--out` reject a missing value instead of silently falling back to the
  fixture.

### Fixed

- `vimp-sim --game <plugin>` no longer reports a false red verdict on a
  healthy game: the two invariants the built-in scenario cannot judge (2 —
  key coverage, 9 — prediction drift, whose thresholds are per-game) are
  skipped with a notice on stderr instead of being judged by the fixture's
  values.

## [0.2.0] — 2026-07-28

### ⚠️ Breaking — plugin API v2 (`ENGINE_API_VERSION` 1 → 2)

Game plugins built against v1 are **rejected**: `GameCatalog` (master),
the host Worker, and the client all gate on `manifest.engineApi ===
ENGINE_API_VERSION`. A v1 plugin is silently dropped from the catalog, so a
server whose only game is a stale plugin reports **"master has no games in
its catalog"**. Every game plugin must be rebuilt against `vimp-engine@^0.2.0`
and republished so its manifest stamps `engineApi: 2`.

### Added

- **Explicit form-schema contract** for both in-app forms, rendered by the new
  shared module `src/client/lib/formBuilder.js`
  (`buildField`/`buildForm`/`mergeRoomDefaults`):
  - `GameManifest.roomForm` — the ordered field-descriptor array the
    "Create server" form is built from.
  - `authSchema.params[].options` — the same field-descriptor contract for the
    per-room player (auth) form, delivered over the wire in `PS_AUTH_DATA`.
  - Supported controls: `select`, `range` (with numeric readout), `number`,
    `toggle`, `segmented`, `text`. Numeric `min`/`max`/`step` are expressed in
    stored units (ms for `unit:'s'`); the engine converts them for display.
  - See [`docs/en/plugin-api.md` → Form schema](../../docs/en/plugin-api.md).
- Tokenized, theme-consistent styling for all form controls (design tokens in
  `:root`, shared `.panel`/`.btn`/`.form-row`, styled toggle/segmented/range/
  select) — same palette as before.

### Changed

- The engine no longer **infers** a control from a value's type. A manifest
  without `roomForm` renders an empty room form (with a console warning); an
  `authSchema` param without `options.control` is skipped (with a console
  error) instead of silently guessed.
- `roomDefaults` remains the single source of default values — the room form is
  seeded from it via `mergeRoomDefaults` (an explicit `descriptor.default`
  wins).
- `authSchema.elems`: **`formId` removed** (no longer used), **`fieldsId` added**
  (the `#auth-fields` container the engine renders player-setting controls into).

### Migration (game plugins, e.g. `vimp-tanks`)

1. Bump the `vimp-engine` dependency to `^0.2.0`, reinstall, and confirm the
   installed `ENGINE_API_VERSION` is `2` (the manifest's `engineApi` is stamped
   from it at build time).
2. Add `roomForm` to the manifest (one descriptor per `roomDefaults` key).
3. Give every `authSchema.params[].options` a `control`; drop `formId` and add
   `fieldsId: 'auth-fields'` in `authSchema.elems`.
4. Rebuild and verify `dist/manifest.json` shows `"engineApi": 2`, then
   republish. On the master, install the new plugin version and redeploy —
   startup should log `-> Games loaded: <id>`.

[0.6.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.6.0
[0.2.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.2.0
