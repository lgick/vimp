# 10 — Pitfalls and invariants

Verify a generated plugin against this list before declaring it done. Almost
every item here fails **silently** or with an error far from its cause.

## Version and identity

- [ ] `engineApi` appears in three places (manifest, `HostPlugin`,
      `ClientPlugin`) and all three import `ENGINE_API_VERSION` rather than
      hardcoding a number.
- [ ] `manifest.id` === the id in the master's game list === the URL segment
      `/games/<id>/`. A mismatch makes the master skip the game with a
      `console.warn` — it simply never appears in the lobby.
- [ ] A game that fails any gate is skipped, not reported to the user. When a
      game is missing from the lobby, read the master's console first.

## Host plugin

- [ ] `chatCommands` is present and is an **array** — the engine iterates it
      unguarded. Use `[]` for none.
- [ ] `createModules` is present and its result has a `scripted` key.
- [ ] `buildClientGameConfig` is present — it is called unconditionally.
- [ ] All seven `REQUIRED_GAME_CONFIG_PATHS` exist:
      `roomDefaults.maxPlayers`, `snapshot`, `parts.models`, `parts.weapons`,
      `parts.friendlyFire`, `panel.fields`, `playerKeys`.
- [ ] The `createModules` context has **no** `timerManager` and **no**
      `voteCoordinator` (a comment in the tanks source says otherwise — it is
      wrong). Only chat-command handlers get those.
- [ ] `gameConfig` is merged **shallowly** over engine defaults: overriding
      `timers`, `rtt` or `idleKickTimeout` replaces the whole object. Restate
      every key you still need.
- [ ] The core's `timeStep` comes from the engine's `hostDefaults`, **not**
      from your merged `gameConfig.timers.timeStep`. Overriding it desyncs the
      Worker loop from the physics step.
- [ ] Room form fields outside the whitelist (`maps`, `maxPlayers`, `map`,
      `roundTime`, `mapTime`, `friendlyFire`) are accepted by the form and
      dropped by the host without a word. Do not design rules around a custom
      room setting.
- [ ] Engine meta modules (`Panel`, `Stat`, `Chat`, `Vote`, `TimerManager`)
      are **singletons**. Constructing a second one returns the first — a
      "fresh" instance silently shares state.

## System messages and votes

- [ ] Message groups `s`, `v`, `m`, `c`, `n` are reserved by the engine.
      Registration is a blind `Object.assign`: a collision overwrites an
      engine message with no warning.
- [ ] Every code you register has a matching text at the same index in the
      client's `modules.chat.params.messages[group]`. A missing text renders
      as nothing.
- [ ] Vote names `mapChange` and `teamChange`, and the template `values`
      strings `'teams'` / `'maps'`, are reserved.
- [ ] A vote category is on cooldown for `timers.timeBlockedVote` (30 s);
      always call `canCreateVote` first.
- [ ] Vote ties are broken **randomly** — do not rely on a deterministic
      outcome.

## Snapshot protocol

- [ ] Every snapshot `id` is unique. **Uniqueness is the only thing
      validated**; nothing checks that fields match the Rust rows.
- [ ] Field order and `interp` are positionally bound to the Rust row
      construction. Reordering on one side only produces garbage, not an
      error.
- [ ] The hot buffer carries **only** `indexed8` and `indexedNoNull8` blocks.
      Anything rendered smoothly at frame rate must use one of those kinds;
      `indexed32` / `list16` arrive through `take_frames()`.
- [ ] Only `f32` fields interpolate, and only in `class: 'hot'` blocks.
- [ ] Transmitted `f32` values are rounded to 2 decimals (the player block is
      exempt).
- [ ] Weapon event blocks put the **author id last** — client-side duplicate
      suppression depends on it.
- [ ] Events must live in `class: 'event'` keys, otherwise the frame is not
      classified as reliable and can be dropped by the unreliable channel.

## WASM core

- [ ] `PLAYER_STATE_LEN = 8` — the predicted local state is exactly eight
      `f32`s. Anything else must be derived client-side or left unpredicted.
- [ ] Host init JSON uses `timeStep` in **seconds**; client init JSON uses
      `timeStepMs` in **milliseconds**.
- [ ] The ABI macro requires the struct fields to be named exactly `state`
      and `packer` (host) / `state` (client), with the exact engine types.
- [ ] `new()` is hand-written; the macro never generates it.
- [ ] Game-specific client methods (`set_model`, `sync_panel`, `try_fire`,
      `cycle_weapon`) are hand-written and are only ever called from
      `ClientPlugin.hooks`.
- [ ] Body tag low byte `1` is the engine's map-object tag; game kinds start
      at `2`.
- [ ] All randomness goes through the engine `Rng` (SplitMix64) seeded from
      the config. `rand`, `Math.random` or clock-seeded values break
      determinism and therefore prediction.
- [ ] `rapier2d` has the `enhanced-determinism` feature enabled.
- [ ] Movement math is shared between the authoritative sim and the
      predictor, and a `cargo` parity test asserts they agree. Re-run it after
      **any** movement change.
- [ ] The core is **not** rebuilt by `npm run build` — run `npm run
      core:build` after Rust changes or you will ship a stale `.wasm`.

## Client plugin

- [ ] A part class is registered only if it appears in `entitiesOnCanvas`.
      Listing it in `parts` and `gameSets` is not enough — you get
      `Constructor for X not found.`
- [ ] Every snapshot key (and every map `setId`) has a `gameSets` entry, or
      the first frame throws.
- [ ] `createClientCore` returns `{ core, memory }`. Returning the core alone
      breaks the zero-copy hot-buffer read.
- [ ] All three hooks (`onAuth`, `onPanel`, `onLocalAction`) exist; no-op
      bodies are fine, missing ones crash.
- [ ] Draw order: set **`zIndex`** on part instances. The engine passes a
      `layer`-based comparator to `sortChildren()`, but PixiJS v8's
      `sortChildren()` takes no arguments and sorts by `zIndex` — the
      comparator is dead code.
- [ ] The available dependency services are exactly `renderer` and
      `soundManager`.
- [ ] Baker names in `bakedAssets` must exist in `bakers`; unknown names are
      skipped silently.
- [ ] The panel key `t` is hardcoded by the engine (round time in seconds).
      Declare a `type: 'time'` field for it on the client and do **not** use
      `t` in your host panel schema.
- [ ] `panel.fields[*].value` on the host is both the HUD starting value and
      the core's starting resource amount — they cannot diverge.
- [ ] The engine writes exactly five stat names: `name`, `status`, `score`,
      `deaths`, `latency`. Invented columns are never populated.
- [ ] Stat sorting is numeric (`~~textContent`); a text column sorts as `0`.
- [ ] The engine's CSS assumes five stat columns and the `.line1`–`.line3`
      classes — deviating means shipping your own CSS in `styles`.
- [ ] `keySetList[0]` is the spectator set and must contain `nextPlayer` and
      `prevPlayer`; `keySetList[1]` is the player set.
- [ ] Key codes `67` (chat), `77` (vote), `9` (stat), `27` (escape), `13`
      (enter) belong to the engine.
- [ ] `keySetList` (code → name) and `playerKeys` (name → bit) must list the
      same action names.
- [ ] `type: 1` (one-shot) semantics are implemented by **your core**, not
      the engine — the engine only forwards `playerKeys` and the raw
      `down`/`up` events. Implement the mask pattern (`down` sets a pending
      bit, one fixed step consumes it, `up` ignored) in the sim **and** the
      predictor, or a `type: 1` fire key autofires.
- [ ] The auth schema element key is **`fieldsId`**, not `formId`. (The
      engine's own test fixture has this wrong; it passes only because the
      tests never build the DOM.)
- [ ] There is no nickname field — identity comes from the lobby JWT.
- [ ] `authSchema.validators` are functions, are not serialised, and run on
      the host.
- [ ] Only `text`, `select`, `checkbox`, `radio` controls exist in v3. An
      unknown `control` skips the field with a `console.error`.
      `min`/`max`/`step` no longer exist — use `regExp`.

## Assets and maps

- [ ] Tile sheets and dynamic-object images load from the **engine's**
      `public/img/` (`/img/<name>`), not from your `assetsBase`. Sounds come
      from `${assetsBase}sounds/`.
- [ ] Every sound exists as a **`webm` + `mp3` pair**; a missing `.mp3`
      breaks Safari.
- [ ] Do not set `sounds.path` — the engine overwrites it.
- [ ] `respawns[team].length` is the hard capacity of that team on that map.
      Too few points silently caps the room below `maxPlayers`.
- [ ] Maps are scaled by the host (`step`, dynamic positions/sizes,
      respawns); do not scale again in a part.
- [ ] At most 30 simultaneous world voices; ranking is
      `priority² / max(distance², 1)`.

## Build and packaging

- [ ] Client and host are built by **two separate Vite runs**
      (`--mode client`, `--mode host`), never one multi-entry graph — a shared
      chunk drags DOM code into the Worker bundle.
- [ ] `emptyOutDir: false`, `assetsInlineLimit: 0`,
      `preserveEntrySignatures: 'strict'`, `inlineDynamicImports: true` are
      all required. Without `preserveEntrySignatures` the plugin's default
      export is tree-shaken away.
- [ ] Do not use Vite's `build.lib` — it always inlines assets.
- [ ] `pixi.js` is external and a peer dependency. Bundling it creates a
      second PixiJS instance with its own extension registry; cross-instance
      objects fail at runtime.
- [ ] Entry paths must be exactly `src/client/index.js` and
      `src/host/index.js` — dev mode hardcodes them.
- [ ] `core/pkg-web/` must exist for dev mode (the master resolves the
      `.wasm` from there).
- [ ] The plugin must be built at least once **before the master starts**,
      even in dev: dev mode still reads `maps`, `assetsBase`, `roomDefaults`
      and `version` from the built `dist/manifest.json`.
- [ ] `files: ["dist"]` — only `dist/` is published.
- [ ] `npm link` must be done **in both directions** for local development.

## Host code hygiene

- [ ] Host-side code is Worker-safe: no `window`, no `document`, no DOM, no
      PixiJS, no Node globals.
- [ ] Host module state does not survive a handoff — the physics world is not
      serialised and your JS module state is not carried over.

## Things that do not exist

- No kick vote, no `/ban` endpoint (social moderation is `/like` · `/unlike`
  on the master, outside the plugin).
- No `views: { Panel, Stat }` field on `ClientPlugin`.
- No `GameClientDef::motion_step`, `render_from_state`, or `STATE_LEN`.
- No `spawn_scripted` / `build_blocks` (the real names are
  `spawn_scripted_actor` / `build_snapshot_blocks`).
- No generic `SimCtx<'a, G>` and no `game_cfg` field on it.
- No `gameConfig.models` / `gameConfig.weapons` at the top level — they live
  under `parts`.
- No invulnerability window, no pickups, no destructible-terrain system, and
  no per-player progression rules: model them inside your core and snapshot
  schema if you need them.
- No runtime localisation: one language per config.
- No debug mode.
