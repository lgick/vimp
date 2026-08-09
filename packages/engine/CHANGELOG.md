# Changelog

All notable changes to the npm package `vimp-engine` are documented here.
The Rust crate `vimp-engine-core` is versioned and released separately and
has its own journal: [core/CHANGELOG.md](core/CHANGELOG.md). The format is
based on [Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/) (in `0.x`, a breaking change
bumps the minor version).

## [Unreleased]

## [0.7.0] — 2026-08-09

Items marked *(app shell)* live in `src/client/**`, which is outside the
package `files`: they change the engine app, not the published artifact.

### Added

- Wasm ABI: `ClientCore.resync()` (from `vimp-engine-core`) — a clock resync
  after a long tab pause, network half only. The engine shell calls it as
  `clientCore?.resync?.()` on `visibilitychange` → visible, so a plugin
  built against an older crate keeps working; a plugin rebuilt on the new
  crate gets the method for free. `ENGINE_API_VERSION` is unchanged (**3**).
- WebGL context-loss handling in the client shell *(app shell)*: rendering is
  paused on `webglcontextlost`, and on `webglcontextrestored` assets are
  re-baked and the map is rebuilt from the cached `MAP_DATA` (no repeat
  `MAP_READY`) — every visible pixel is a GPU-only `RenderTexture` with no
  CPU source. Loss is tracked **per canvas** (`lib/contextTracker.js`): the
  browser restores each context separately, and re-baking into a still-dead
  one yields empty textures with no second event to fix them, so the scene
  is rebuilt only once every context is alive again.
- `SoundManager.releaseSound(id)` *(app shell)* — unregisters while letting
  an already playing one-shot finish, for entities that disappear earlier
  than their sound (a detonated bomb and its "planted" sample). A looped
  sound is still stopped.

### Changed

- `SoundManager.reset()` *(app shell)* no longer clears looped registrations,
  only stops the playing instances and their active ids: registrations belong
  to entities, and after a partial clear a surviving loop is restarted by the
  next `processAudibility()` instead of going silent for the rest of the
  session. One-shot registrations **are** dropped — `Howler.stop()` emits no
  `end`, so a sample that already played would otherwise be started over.
  `destroy()` still clears the whole registry.
- `RoundManager.createMap()` sends every human the spectator `KEYSET_DATA`
  right before `CLEAR`, so client prediction is off by the time the canvas
  is cleared and can no longer recreate the local entity as a ghost.
- `CanvasManagerModel` *(app shell)* ignores a zero-sized resize (minimized
  tab/window), which used to drive the scale to `0` and the renderer to
  `0x0` with no recovery until the next real resize; emitted sizes are
  clamped to `1`. `fixSize` now parses both parts as numbers — the height
  used to leak out as a string.
- `clientCore.resync()` *(app shell)* is called only after a tab pause of at
  least 3 s. A short alt-tab used to throw away a perfectly valid frame
  buffer together with its event frames (entity create/delete), freezing the
  scene for the interpolation delay and dropping removals.
- `BakingProvider` *(app shell)* destroys each baked object once per re-bake
  even when a baker returned it under several keys, and logs a failed
  `destroy` instead of swallowing it. A baker owns what it returns: re-baking
  destroys the result together with its `TextureSource`, so returning a view
  onto a shared atlas is not allowed.

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

## [0.5.0] — 2026-08-05

Code-review pass over the 0.4.0 debugging loop. No API change:
`ENGINE_API_VERSION` stays **3**.

### Added

- `GameManifest.entries.wasmNode` is now verified to exist at load. A manifest
  advertising a Node core that the published package did not ship failed with
  a raw `ERR_MODULE_NOT_FOUND` from the resolver; it now names the manifest,
  the declared path and the fix. Both plugin halves are additionally
  re-checked against the manifest's `engineApi`, which catches a rebuilt
  manifest sitting next to a stale `dist/`.
- Prediction-drift level 1 (`vimp-engine-core` 0.2.0): with
  `GameClientDef::predicted_state` implemented, the detector compares the
  core's own predicted state component-wise instead of the overlay camera.
- Browser debug requests to the Worker got a 5 s timeout — debugging is needed
  exactly on a hung Worker, where a silent `await` in the console is the very
  failure being investigated.

### Changed

- `RecordingSocketManager` now **inherits** `SocketManager` instead of
  re-declaring its ports, so a port added to the engine can no longer be
  invisible to the headless runner. Frames are published in wire order
  (a composite sender before the payloads it nests), and a second payload
  from one sender throws with the violated contract named instead of being
  silently overwritten.
- `ScenarioRunner`: frame-stream hashes are collected only under
  `--determinism` (a long match no longer carries megabytes of unused hashes
  into the report); the scenario's `config.timers` is merged explicitly;
  a leaving participant's client core is destroyed.

## [0.4.0] — 2026-08-04

Two large tracks: the headless debugging loop and the lobby page.
`ENGINE_API_VERSION` unchanged (**3**) — no plugin rebuild required.

### Added

- **Headless match runner** — `vimp-sim` (`packages/engine/bin/vimp-sim.js`,
  exposed as the package's bin) plus `src/devtools/`: virtual clock,
  recording transport, a real `ClientCore` per participant, scene dumps, and
  **12 invariant checks** that turn a silent contract break (a snapshot key
  that never spawns, a field-width drift, an uncovered `gameSets` class) into
  a named line of text. Root scripts: `npm run sim`, `sim:check`,
  `sim:replay`. Docs: `docs/en/debugging.md`, `docs/ru/debugging.md`.
- **`src/lib/createHostRuntime.js`** — the production match initialisation,
  now shared by `host.worker.js` and the runner, so the headless run cannot
  drift from the real one.
- **`src/lib/clock.js`** — a single injectable source of `now`/monotonic/
  random/timers, which is what makes a match reproducible under a virtual
  clock.
- **Browser half of the loop**: `DebugRecorder` in the host and
  `window.__vimpDebug` in the tab record a live match into the runner's
  scenario format; `POST /debug/report` on the master (dev only, 404 in
  production) collects the uploads into the same `.debug/` tree.
- **Rust core** (`vimp-engine-core` 0.2.0): `debug.rs` — a curated world dump
  behind `debug_json`; `client/divergence.rs` — a prediction-drift tracker
  behind `take_divergence`. Both arrive through the ABI macros, so a game
  implements nothing.
- **Lobby leaderboard**: `GET /auth/leaderboard` (public, no token) and
  `GET /auth/placement`, proxied by the master under the same origin (no CSP
  change), with a keyed TTL cache in front of the leaderboard
  (`master.leaderboard.cacheTtl`, `maxLimit`). Lobby config gained
  `leaderboardUrl`, `placementUrl`, `leaderboardLimit`.
- **`docs/ai/`** — a self-contained English spec of the plugin contract for
  an LLM authoring a game plugin, including a questionnaire and an authoring
  workflow.

### Changed

- Lobby page reworked: game selector filling from the master catalog,
  servers/leaderboard tabs, new panel and animations.
- `PlayerDataSync` no longer blocks a participant's entry: rank/state load
  asynchronously and an auth-service failure leaves engine defaults.

## [0.3.0] — 2026-07-30

### ⚠️ Breaking — plugin API v3 (`ENGINE_API_VERSION` 2 → 3)

The form-control set is reduced to **native form elements**:
`select` | `text` | `checkbox` | `radio`. `range`, `number`, `toggle` and
`segmented` are gone. A plugin whose `roomForm` or `authSchema.params[]`
still uses a removed control renders nothing for that field, and a plugin
built against v2 is rejected outright by `GameCatalog`, the host Worker and
the client.

### Added

- Native constraint validation on `control: 'text'`: `regExp` → `pattern`,
  plus `required` and `maxlength`; the engine calls `reportValidity()` on
  every control before submit (room form and auth form alike).
- `numeric: true` — a text field whose value is parsed as a number and
  converted through the same `unit` as the stored value. Empty or invalid
  input falls back to `default` instead of becoming `0` on submit.
- `hidden: true` — the field is built and submitted, but no row is rendered.

### Changed

- Controls are plain native elements with no themed markup, so a plugin's
  form always matches the rest of the page (≈160 lines of custom control CSS
  dropped).
- Silent token restore no longer shows an error: an expired or invalid stored
  token is dropped and a clean sign-in screen appears. `login-error`
  (`tokenExpired`/`invalidToken`) is emitted only on the interactive path
  (OAuth redirect, nickname submission) — a stale token on a return visit is
  expected, not an error.

### Migration (game plugins)

1. Bump the `vimp-engine` dependency to `^0.3.0` and rebuild so the manifest
   stamps `engineApi: 3`.
2. Replace removed controls: `range`/`number` → `text` with `numeric: true`
   (and an exact-range `regExp` generated by your manifest builder),
   `toggle` → `checkbox`, `segmented` → `radio` or `select`.
3. Republish; on the master, install the new plugin version and redeploy.

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

[0.7.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.7.0
[0.6.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.6.0
[0.5.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.5.0
[0.4.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.4.0
[0.3.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.3.0
[0.2.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.2.0
