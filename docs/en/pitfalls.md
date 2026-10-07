# Pitfalls and invariants

Verify a plugin against this list before declaring it done. Almost every item
here fails **silently** or with an error far from its cause.

Items marked ⚙ are checked by machine: run `npx vimp-contract` in your
package and the rule id in the marker (`A1` … `E7`) is the one that will name
the violation. Do not verify those by eye — run the tool
([debugging.md](debugging.md#contract-check-vimp-contract)). The rest of the
list is still yours: the headless runner (`npm run sim`) covers part of it at
run time, the rest is review.

## Contract rules at a glance

Source of truth: `packages/engine/src/devtools/contract/rules/` (one file per
rule). `error` fails the check, `warn` fails it only under `--strict`. Rules
`B2`, `B3`, `B5`, `C4` and `C10` may downgrade a particular violation to `warn`
on a given run (`verdict(..., WARN)` in `contract/result.js`), so the level in
the report can be lower than the Level column. Rules not named in the checklist
below are visible only in this table and in the `vimp-contract` report.

| Rule  | Level | Checks                                                                                                |
| ----- | ----- | ----------------------------------------------------------------------------------------------------- |
| `A1`  | error | `package.json`: `type`, `files`, `pixi.js`, `vimp-engine`, `publishConfig`                            |
| `A2`  | error | the standard build/test scripts exist                                                                 |
| `A3`  | error | entries live at `src/client/index.js` and `src/host/index.js`                                         |
| `A4`  | error | `vite.config.js` carries the required rollup options                                                  |
| `A5`  | error | `core/Cargo.toml`: `crate-type`, `rapier2d` determinism, engine crate pin                             |
| `A6`  | error | `dist/manifest.json`: `id`, entries on disk, `roomDefaults` coverage                                  |
| `A7`  | warn  | `package.json` declares `repository`                                                                  |
| `B1`  | error | `HostPlugin` exports every field the engine dereferences                                              |
| `B2`  | error | `engineApi` consistent; `requires` names existing capabilities and agrees across manifest and halves  |
| `B3`  | error | `gameConfig` has the paths the engine reads before any logic                                          |
| `B4`  | error | `spectatorTeam` is a `teams` key and at least one playing team exists                                 |
| `B5`  | error | `roomForm` uses honoured field names and existing controls                                            |
| `B6`  | error | host `panel.fields` does not use the engine key `t`                                                   |
| `B7`  | error | chat commands are well-formed and unique                                                              |
| `B8`  | error | system message codes stay out of the engine ranges                                                    |
| `B9`  | error | custom votes do not reuse the reserved vote names or the `@` prefix                                   |
| `B10` | error | every playing team has respawns and they cover `maxPlayers`                                           |
| `C1`  | error | `ClientPlugin` exports parts, bakers, styles and all three hooks                                      |
| `C2`  | error | every `gameSets` class is in `entitiesOnCanvas` and exported in `parts`                               |
| `C3`  | error | every snapshot key and map `setId` has a `gameSets` entry                                             |
| `C4`  | error | `componentDependencies` name only existing services                                                   |
| `C5`  | error | the client panel maps key `t` to a `type: 'time'` field                                               |
| `C6`  | warn  | stat columns past the engine layout are styled by the plugin                                          |
| `C7`  | error | `keySetList`: spectator actions, engine key codes, `playerKeys` parity                                |
| `C8`  | error | `bakedAssets` names exist in `ClientPlugin.bakers`                                                    |
| `C9`  | error | every system message code has a client text                                                           |
| `C10` | error | `authSchema`: `fieldsId`, no nickname field, the `model` field, inline options, resolvable validators |
| `C11` | error | `gameConfig.statMode` and `modules.stat.params.mode` agree                                            |
| `D1`  | error | snapshot block ids are unique                                                                         |
| `D2`  | error | class `hot` only on `indexed8`/`indexedNoNull8`; `list16`/`indexed32` are `class: 'event'`            |
| `D3`  | error | `interp` only on `f32` fields of `hot` blocks; `role: 'state'` is a `u8` right after the row head     |
| `E1`  | error | every declared sound ships as a `webm` + `mp3` pair                                                   |
| `E2`  | error | map images exist in `dist/img/`                                                                       |
| `E3`  | warn  | the sound registry is not empty                                                                       |
| `E4`  | error | layered (2.5D) maps are structurally sound                                                            |
| `E5`  | error | solid tiles are named by a render layer                                                               |
| `E6`  | warn  | the spatial sound block is well-formed                                                                |
| `E7`  | error | a map's `game` field is a plain object                                                                |

## Version and identity

- [ ] ⚙ `B2` `engineApi` appears in three places (manifest, `HostPlugin`,
      `ClientPlugin`) and all three import `ENGINE_API_VERSION` rather than
      hardcoding a number.
- [ ] ⚙ `A6` `manifest.id` equals the `id` of both the host and the client
      plugin.
- [ ] `manifest.id` also equals the id in the master's game list and the URL
      segment `/games/<id>/` (manual check). A mismatch makes the master skip
      the game with a `console.warn` — it simply never appears in the lobby.
- [ ] A game the master cannot read (missing manifest, id mismatch) is
      skipped, not reported to the user. When a game is missing from the
      lobby, read the master's console first. Age is not a reason any more: a
      game built against an older engine is served as is, and a game whose
      `requires` names an unknown capability is shown in the lobby as
      unavailable with the reason.

## Host plugin

- [ ] ⚙ `B1` `chatCommands` is present and is an **array** — the engine iterates it
      unguarded. Use `[]` for none.
- [ ] ⚙ `B1` `createModules` is present and its result has a `scripted` key.
- [ ] ⚙ `B1` `buildClientGameConfig` is present — it is called unconditionally.
- [ ] ⚙ `B3` All four `REQUIRED_GAME_CONFIG_PATHS` exist: `parts.models`,
      `playerKeys`, `snapshot`, `teams`. Everything else the engine reads has
      a default (`createGameConfigView`) — `B3` only _warns_ about it. If you
      do declare `spectatorTeam`, spell it exactly as one of the `teams` keys
      (the gate checks that too); omitted, it resolves to the `spectators`
      key, or `null` with a `console.warn` if there is none.
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

- [ ] ⚙ `B8` The groups `s`, `v`, `m`, `c`, `n` already hold engine messages
      (indexes `s:0..11`, `v:0..15`, `m:0`, `c:0`, `n:0`). Registration is a
      blind `Object.assign`: a code of yours at a reserved index overwrites an
      engine message with no warning. Start your own codes above them.
- [ ] ⚙ `C9` Every code you register has a matching text at the same index in the
      client's `modules.chat.params.messages[group]`. A missing text renders
      as nothing.
- [ ] ⚙ `B9` Vote names `mapChange` and `teamChange`, and the template `values`
      strings `'teams'` / `'maps'`, are reserved.
- [ ] ⚙ `B9` Vote names starting with `@` (templates and menu entries) and
      the chat command `/changehost` are reserved by the engine (the master's
      "Change host" vote, lobby mode).
      Engine codes have English defaults on the client; `''` at the same index silences one.
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
- [ ] ⚙ `D3` `role: 'state'` is a `u8` right after the dynamics row head
      (index 5 layered, 3 flat) and before `optionalFrom`.
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
      at `2`. Map dynamic bodies carry their index in the higher bits — use
      `is_map_object`, not `== MAP_OBJECT_TAG`.
- [ ] Never remove a map body from the world: `EngineSim` removes them on the
      next map load and a double removal panics. Disable it
      (`set_enabled(false)`) and flip its `map_body_state` byte.
- [ ] At most 255 map dynamic bodies — the row index is a `u8`. Debris and
      wrecks are drawn, not spawned as new bodies.
- [ ] `on_map_loaded` is not called on `deserialize_state`; anything derived
      from the map must survive in your own dump.
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
- [ ] Draw order: set **`zIndex`** on part instances — nothing else affects it.
      The engine marks the stage `sortableChildren` and calls
      `sortChildren()` after every `addChild`; PixiJS v8 sorts by `zIndex`
      there. A `layer` property on the instance does nothing.
- [ ] ⚙ `C4` The engine provides exactly six dependency services:
      `renderer`, `soundManager`, `assetsBase`, `localPlayer`, `accolades`,
      `diagnostics`.
      Your game adds
      its own by returning them from `ClientPlugin.hooks.services(core)` —
      the engine merges that map into the pool. A name that neither side
      provides resolves to `undefined` in the part, silently. `C4` reports it
      as an error when the plugin declares no `hooks.services()`, and as a
      warning when it does (the checker cannot call the hook without a live
      core — run with `--strict` to fail on those too).
- [ ] Never list `diagnostics` in `requires`: the service is optional, an
      older engine hands the part `undefined`, and a `requires` entry would
      reject the game there for nothing. Call it as `diagnostics?.warn(…)`.
- [ ] Do not reuse an engine service name in `hooks.services()`: the engine
      merges your map _first_ (`{ ...gameServices, renderer, … }`), so a
      `renderer` of yours is silently overwritten by the engine's and no rule
      can see it.
- [ ] ⚙ `C8` Baker names in `bakedAssets` must exist in `bakers`; unknown names are
      skipped silently.
- [ ] ⚙ `B6, C5` The panel key `t` is hardcoded by the engine (round time in seconds).
      Declare a `type: 'time'` field for it on the client and do **not** use
      `t` in your host panel schema.
- [ ] `panel.fields[*].value` on the host is both the HUD starting value and
      the core's starting resource amount — they cannot diverge.
- [ ] The engine writes five stat names of its own: `name`, `status`, `score`,
      `deaths`, `latency`, and only into columns your schema declares — a
      write to an undeclared one is dropped. Any further column is yours to
      declare _and_ to populate from your host code; the engine never fills
      it for you.
- [ ] Stat sorting is numeric (`~~textContent`); a text column sorts as `0`.
- [ ] ⚙ `C6` The engine's CSS lays out five stat columns
      (`#stat …:nth-child(1)…(5)`) and the `.line1`–`.line3` row classes. A
      sixth column is fine, but it gets no width of its own until you restate
      the layout in `ClientPlugin.styles` — `C6` warns for every declared
      column your styles leave unaddressed. It looks for a width declaration
      (`width`/`min-width`/`flex`/…) on a `#stat` selector naming a cell, so
      a rule that only sets a colour does not count as laying the column out.
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
- [ ] ⚙ `C10` No param uses `options.source` — the auth form is built without
      the engine's catalogs, so such a field resolves to an empty list, shows
      `no options available` and nobody can log in. Inline the options.
      (`source` is fine in `roomForm`, where the engine does pass the maps.)
- [ ] `authSchema.validators` are functions, are not serialised, and run on
      the host.
- [ ] ⚙ `C10` A param's `validator` names a function `authSchema.validators`
      actually provides — a typo (or a non-function value) leaves the field
      checked by nobody: the host skips an unresolved validator silently and
      writes a `console.error` when the port machine is built.
- [ ] The host also applies the auth descriptor's own declarative rules
      (`validateAuth`), so a client that bypasses the form is bound by them
      too: length, membership in a `select`/`radio` field's declared
      `options` (`not an option`; an empty or absent list accepts nothing,
      as in the form), then `maxlength`/`regExp` on text fields.
      `required` and `min`/`max` are the exceptions — an empty value is left
      to your validator, and a numeric auth field cannot work at all (the
      value must be a string).
- [ ] A field with no `maxlength` is capped at 256 characters on the host:
      your `regExp` runs there against whatever the client sent, and a
      catastrophic pattern would freeze the match, not just a tab.
- [ ] ⚙ `B5` Declare one of the four native controls — `text`, `select`,
      `checkbox`, `radio`. The four retired in v3 (`range`, `number`,
      `toggle`, `segmented`) still work forever, as permanent aliases of
      `text`+`numeric`, `text`+`numeric`, `checkbox` and `radio`, so an older
      game keeps rendering — but B5 (and C10 for `authSchema`) warns on them,
      so write the native name. The alias applies to the host's authoritative
      validation too, not just to rendering: a `segmented` field is checked
      against its options list exactly like `radio`, and a `number`/`range`
      field is checked against `min`/`max` in the declared display unit.
      A `control` the engine's registry does not know at all skips the field
      with a `console.error`. Native
      `min`/`max`/`step` attributes are never emitted (these fields are
      `type=text`): the descriptor's own `min`/`max` numbers drive the label
      hint and the check instead, alongside `regExp`.
- [ ] ⚙ `B5` A `regExp` that does not compile is no constraint at all — the
      engine drops the check with a `console.error` and the field passes.
      The engine anchors it as `^(?:…)$`, the way a browser applies
      `pattern`, so write it unanchored.
- [ ] Keep that `regExp` linear. The form re-checks itself on every
      keystroke, so a pattern that backtracks catastrophically freezes the
      tab while the player types, not just on submit.

## Assets and maps

- [ ] ⚙ `E2` Tile sheets and dynamic-object images ship in **your** package
      (`dist/img/`) and load from `${assetsBase}img/`, exactly like sounds
      load from `${assetsBase}sounds/`. The engine serves no game images.
- [ ] The part that loads images must declare `assetsBase` in
      `componentDependencies` — an undeclared service is silently `undefined`,
      and the map renders as a blank canvas with nothing in the console
      (`C4` only checks that a declared service name exists).
- [ ] ⚙ `E2` A map naming an image that is not in `dist/img/` fails silently at
      runtime. Catch it in the manifest build instead.
- [ ] ⚙ `E1` Every sound exists as a **`webm` + `mp3` pair**; a missing `.mp3`
      breaks Safari.
- [ ] Do not set `sounds.path` — the engine overwrites it.
- [ ] ⚙ `B10` `respawns[team].length` is the hard capacity of that team on that map.
      Too few points silently caps the room below `maxPlayers`.
- [ ] Maps are scaled by the host (`step`, dynamic positions/sizes,
      respawns); do not scale again in a part.
- [ ] ⚙ `E7` The map's `game` field is **not** scaled by anyone: put grid
      cells (or unscaled units you multiply by `scale` yourself) in it. It is
      an object or absent — an array fails the map load.
- [ ] At most 30 simultaneous world voices; ranking is
      `priority² / max(distance², 1)`.
- [ ] ⚙ `E6` A typo in a `parts.sounds.spatial` key, or a `mode` the engine
      does not know, gives neither an error nor an audible hint: the engine
      falls back to the default in silence. Statically only rule `E6`
      (`npx vimp-contract`) catches it.
- [ ] A `levels.<n>.map` grid whose dimensions differ from `map` is silent at
      runtime: the actor drives into nothing and nothing reaches the console.
      `MapConfig::validate` is the only place that catches it — do not skip it
      by building `GameMap` directly.
- [ ] A railing tile listed in `levels.<n>.walls` but not in `.floor` hangs in
      the air: it blocks movement on that level yet does not shield the slab
      edge from a shot fired below. Every railing has to be part of `floor`.

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
      serialised and your JS module state is not carried over (unless the
      game opts into `migration.midRound`, below).
- [ ] `gameConfig.migration.midRound: true` — then **all** state must be in
      `GameSim::serialize` (core) or in `serializeState`/`restoreState`
      (each stateful host module); anything else resets at a host change.
      Check with `vimp-sim --checkpoint-every <ms>` (`checkpointRestore`):
      the report's `## Host checkpoints` must say `midRound`.

## Things that do not exist

- No kick vote, no `/ban` endpoint, no `/like` · `/unlike` server rating
  (removed).
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
  to your plugin. See [debugging.md](debugging.md); verifying this checklist with the
  runner beats verifying it by eye.

---

[← Previous: Maps and Assets](maps-and-assets.md) · [Back to docs index](README.md)
