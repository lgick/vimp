# 10 — Pitfalls and invariants

Verify a generated plugin against this list before declaring it done. Almost
every item here fails **silently** or with an error far from its cause.

Items marked ⚙ are checked by machine: run `npx vimp-contract` in your
package and the rule id in the marker (`A1` … `E3`) is the one that will
name the violation. Do not verify those by eye — run the tool
(`13-debugging.md` → *Step zero*). The rest of the list is still yours.

## Version and identity

- [ ] ⚙ `B2` `engineApi` appears in three places (manifest, `HostPlugin`,
      `ClientPlugin`) and all three import `ENGINE_API_VERSION` rather than
      hardcoding a number.
- [ ] ⚙ `A6` `manifest.id` === the id in the master's game list === the URL segment
      `/games/<id>/`. A mismatch makes the master skip the game with a
      `console.warn` — it simply never appears in the lobby.
- [ ] A game that fails any gate is skipped, not reported to the user. When a
      game is missing from the lobby, read the master's console first.

## Host plugin

- [ ] ⚙ `B1` `chatCommands` is present and is an **array** — the engine iterates it
      unguarded. Use `[]` for none.
- [ ] ⚙ `B1` `createModules` is present and its result has a `scripted` key.
- [ ] ⚙ `B1` `buildClientGameConfig` is present — it is called unconditionally.
- [ ] ⚙ `B3` All nine `REQUIRED_GAME_CONFIG_PATHS` exist:
      `roomDefaults.maxPlayers`, `snapshot`, `parts.models`, `parts.weapons`,
      `parts.friendlyFire`, `panel.fields`, `playerKeys`, `teams`,
      `spectatorTeam` — and `spectatorTeam` is spelled exactly as one of the
      `teams` keys (the gate checks that too).
- [ ] The `createModules` context has **no** `timerManager` and **no**
      `voteCoordinator` (a comment in the tanks source says otherwise — it is
      wrong). Only chat-command handlers get those.
- [ ] `gameConfig` is merged **shallowly** over engine defaults: overriding
      `timers`, `rtt` or `idleKickTimeout` replaces the whole object. Restate
      every key you still need.
- [ ] The core's `timeStep` comes from the engine's `hostDefaults`, **not**
      from your merged `gameConfig.timers.timeStep`. Overriding it desyncs the
      Worker loop from the physics step.
- [ ] ⚙ `B5` Room form fields outside the whitelist (`maps`, `maxPlayers`, `map`,
      `roundTime`, `mapTime`, `friendlyFire`) are accepted by the form and
      dropped by the host without a word. Do not design rules around a custom
      room setting.
- [ ] Engine meta modules (`Panel`, `Stat`, `Chat`, `Vote`, `TimerManager`)
      are **singletons**. Constructing a second one returns the first — a
      "fresh" instance silently shares state.

## System messages and votes

- [ ] ⚙ `B8` Message groups `s`, `v`, `m`, `c`, `n` are reserved by the engine.
      Registration is a blind `Object.assign`: a collision overwrites an
      engine message with no warning.
- [ ] ⚙ `C9` Every code you register has a matching text at the same index in the
      client's `modules.chat.params.messages[group]`. A missing text renders
      as nothing.
- [ ] ⚙ `B9` Vote names `mapChange` and `teamChange`, and the template `values`
      strings `'teams'` / `'maps'`, are reserved.
- [ ] A vote category is on cooldown for `timers.timeBlockedVote` (30 s);
      always call `canCreateVote` first.
- [ ] Vote ties are broken **randomly** — do not rely on a deterministic
      outcome.

## Snapshot protocol

- [ ] ⚙ `D1` Every snapshot `id` is unique. **Uniqueness is the only thing
      validated**; nothing checks that fields match the Rust rows.
- [ ] Field order and `interp` are positionally bound to the Rust row
      construction. Reordering on one side only produces garbage, not an
      error.
- [ ] ⚙ `D2` The hot buffer carries **only** `indexed8` and `indexedNoNull8` blocks.
      Anything rendered smoothly at frame rate must use one of those kinds;
      `indexed32` / `list16` arrive through `take_frames()`.
- [ ] ⚙ `D3` Only `f32` fields interpolate, and only in `class: 'hot'` blocks.
- [ ] Your core calls `vimp_engine_core::physics::round2` on the `f32`s it
      packs. The packer does **not** round; the decoder does, so an unrounded
      value silently differs between host and client. The player block is
      exempt (packed and decoded raw).
- [ ] Weapon event blocks put the **author id last** — client-side duplicate
      suppression depends on it.
- [ ] ⚙ `D2` Events must live in `class: 'event'` keys, otherwise the frame is not
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
- [ ] ⚙ `A5` `rapier2d` has the `enhanced-determinism` feature enabled.
- [ ] Movement math is shared between the authoritative sim and the
      predictor, and a `cargo` parity test asserts they agree. Re-run it after
      **any** movement change.
- [ ] The core is **not** rebuilt by `npm run build` — run `npm run
      core:build` after Rust changes or you will ship a stale `.wasm`.

## Client plugin

- [ ] ⚙ `C2` A part class is registered only if it appears in `entitiesOnCanvas`.
      Listing it in `parts` and `gameSets` is not enough — you get
      `Constructor for X not found.`
- [ ] ⚙ `C3` Every snapshot key (and every map `setId`) has a `gameSets` entry, or
      the first frame throws.
- [ ] `createClientCore` returns `{ core, memory }`. Returning the core alone
      breaks the zero-copy hot-buffer read.
- [ ] ⚙ `C1` All three hooks (`onAuth`, `onPanel`, `onLocalAction`) exist; no-op
      bodies are fine, missing ones crash.
- [ ] Draw order: set **`zIndex`** on part instances. The engine passes a
      `layer`-based comparator to `sortChildren()`, but PixiJS v8's
      `sortChildren()` takes no arguments and sorts by `zIndex` — the
      comparator is dead code.
- [ ] ⚙ `C4` The available dependency services are exactly `renderer`,
      `soundManager` and `assetsBase`. Any other name in
      `componentDependencies` resolves to `undefined`.
- [ ] ⚙ `C8` Baker names in `bakedAssets` must exist in `bakers`; unknown names are
      skipped silently.
- [ ] ⚙ `B6, C5` The panel key `t` is hardcoded by the engine (round time in seconds).
      Declare a `type: 'time'` field for it on the client and do **not** use
      `t` in your host panel schema.
- [ ] `panel.fields[*].value` on the host is both the HUD starting value and
      the core's starting resource amount — they cannot diverge.
- [ ] ⚙ `C6` The engine writes exactly five stat names: `name`, `status`, `score`,
      `deaths`, `latency`. Invented columns are never populated.
- [ ] Stat sorting is numeric (`~~textContent`); a text column sorts as `0`.
- [ ] ⚙ `C6` The engine's CSS assumes five stat columns and the `.line1`–`.line3`
      classes — deviating means shipping your own CSS in `styles`.
- [ ] ⚙ `C7` `keySetList[0]` is the spectator set and must contain `nextPlayer` and
      `prevPlayer`; `keySetList[1]` is the player set.
- [ ] ⚙ `C7` Key codes `67` (chat), `77` (vote), `9` (stat), `27` (escape), `13`
      (enter) belong to the engine.
- [ ] ⚙ `C7` `keySetList` (code → name) and `playerKeys` (name → bit) must list the
      same action names.
- [ ] `type: 1` (one-shot) semantics are implemented by **your core**, not
      the engine — the engine only forwards `playerKeys` and the raw
      `down`/`up` events. Implement the mask pattern (`down` sets a pending
      bit, one fixed step consumes it, `up` ignored) in the sim **and** the
      predictor, or a `type: 1` fire key autofires.
- [ ] ⚙ `C10` The auth schema element key is **`fieldsId`**, not `formId` — it names
      the container the engine fills with the form's fields. A wrong key
      resolves to `null` and the auth screen dies with a `TypeError` on the
      first render.
- [ ] ⚙ `C10` There is no nickname field — identity comes from the lobby JWT.
- [ ] `authSchema.validators` are functions, are not serialised, and run on
      the host.
- [ ] ⚙ `B5` Only `text`, `select`, `checkbox`, `radio` controls exist in v3. An
      unknown `control` skips the field with a `console.error`.
      `min`/`max`/`step` no longer exist — use `regExp`.

## Assets and maps

- [ ] ⚙ `E2` Tile sheets and dynamic-object images ship in **your** package
      (`dist/img/`) and load from `${assetsBase}img/`, exactly like sounds
      load from `${assetsBase}sounds/`. The engine serves no game images.
- [ ] ⚙ `C4` The part that loads images must declare `assetsBase` in
      `componentDependencies` — an undeclared service is silently `undefined`,
      and the map renders as a blank canvas with nothing in the console.
- [ ] ⚙ `E2` A map naming an image that is not in `dist/img/` fails silently at
      runtime. Catch it in the manifest build instead.
- [ ] ⚙ `E1` Every sound exists as a **`webm` + `mp3` pair**; a missing `.mp3`
      breaks Safari.
- [ ] Do not set `sounds.path` — the engine overwrites it.
- [ ] ⚙ `B10` `respawns[team].length` is the hard capacity of that team on that map.
      Too few points silently caps the room below `maxPlayers`.
- [ ] Maps are scaled by the host (`step`, dynamic positions/sizes,
      respawns); do not scale again in a part.
- [ ] At most 30 simultaneous world voices; ranking is
      `priority² / max(distance², 1)`.

## Build and packaging

- [ ] Client and host are built by **two separate Vite runs**
      (`--mode client`, `--mode host`), never one multi-entry graph — a shared
      chunk drags DOM code into the Worker bundle.
- [ ] ⚙ `A4` `emptyOutDir: false`, `assetsInlineLimit: 0`,
      `preserveEntrySignatures: 'strict'`, `inlineDynamicImports: true` are
      all required. Without `preserveEntrySignatures` the plugin's default
      export is tree-shaken away.
- [ ] ⚙ `A4` Do not use Vite's `build.lib` — it always inlines assets.
- [ ] ⚙ `A1, A4` `pixi.js` is external and a peer dependency. Bundling it creates a
      second PixiJS instance with its own extension registry; cross-instance
      objects fail at runtime.
- [ ] ⚙ `A3` Entry paths must be exactly `src/client/index.js` and
      `src/host/index.js` — dev mode hardcodes them.
- [ ] `core/pkg-web/` must exist for dev mode (the master resolves the
      `.wasm` from there).
- [ ] The plugin must be built at least once **before the master starts**,
      even in dev: dev mode still reads `maps`, `assetsBase`, `roomDefaults`
      and `version` from the built `dist/manifest.json`.
- [ ] ⚙ `A1` `files: ["dist"]` — only `dist/` is published.
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
- No in-game debug overlay or debug HUD. What does exist is out-of-band: the
  engine's headless runner (`npm run sim`), which replays a scenario without
  a browser and reports every broken contract on this page by name, plus
  `debug_json()` world dumps and a prediction-drift detector — all of it free
  to your plugin. See `13-debugging.md`; verifying this checklist with the
  runner beats verifying it by eye.
