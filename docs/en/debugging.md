# Debugging (headless runner and the browser half)

A VIMP match hides its state behind three walls at once: the authoritative
half runs in a Web Worker, the simulation itself is WASM, and everything
between host and client is a binary frame over WebRTC. The usual failure is
not an exception — it is a black canvas, a tank stuck in a wall, or a
snapshot key that silently never reaches the renderer. **Silence is the
failure mode.**

This page documents the debugging loop that turns that silence into text:

- a **headless runner** (`npm run sim`) closing
  `host → binary frame → ClientCore → hot buffer → scene JSON` inside one
  Node process, with no browser and no human;
- **invariant checks** that name the broken contract instead of failing
  quietly;
- **core dumps** (`debug_json`) for physics-shaped bugs;
- a **prediction divergence detector** (`take_divergence`);
- a **browser half** that records a live match into the very same scenario
  format, so a bug caught by a human replays headlessly.

Nothing here is required from a game plugin: everything arrives through the
ABI macros (`export_game_core_abi!`/`export_client_core_abi!`) and through
trait methods that have defaults, and production behaviour is unchanged
(`ENGINE_API_VERSION` is not bumped).

**Invariant**: `packages/engine/src/devtools/` and
`packages/engine/bin/vimp-sim.js` are Node-only — they use `node:` built-ins
freely and must never be reachable from the app bundle. Nothing under
`src/client/` or `src/host/` may import them; the browser half below talks to
the runner through recorded scenario files, not through imports.

## Contract check (`vimp-contract`)

The runner judges a game by running it. Half the silent failures do not need
a match to be visible: they are already there in the configs, the manifest
and the shape of the two plugin halves. `vimp-contract` reads exactly those,
in a second, without a build:

```bash
npx vimp-contract --game .          # from a game package
node packages/engine/bin/vimp-contract.js --game ../vimp-tanks
```

| Option | Meaning |
| --- | --- |
| `--game <path>` | game package directory (default `.`) |
| `--json` | machine-readable report instead of text |
| `--quiet` | only failures and the summary |
| `--strict` | warnings count as errors |

Exit code `0` means every rule is `pass` or `skip`, `1` means at least one
`error`-level failure (`--strict` adds the warnings). `skip` means the input
is missing — no `package.json`, no `dist/` — and never masks a violation, so
the check is useful from the first commit of a plugin, long before it builds.
A rule that finds the file but not the data it needs says so in the report's
notes rather than passing (the `vimp-engine-core` pin, for one). A run where
*no* rule found any input exits `1`: 32 skips are a mistyped path, not a
clean bill of health.

> **The check imports the game package.** Both plugin halves are loaded as
> ES modules, so `vimp-contract --game <dir>` executes that directory's code
> in your Node process — top-level statements included. Point it at your own
> games and at repositories you trust, the same care you would give
> `npm install` there.

Rules live one per file in `packages/engine/src/devtools/contract/rules/`,
each a pure `(ctx) => result`. The context (`loadContext.js`) mixes text
(`package.json`, `vite.config.js`, `core/Cargo.toml`) with the **live**
plugin objects: both halves are imported as modules, so `gameConfig`,
`authSchema` and the client config are the computed structures the engine
will actually see, not a parse of the source.

| Group | Catches |
| --- | --- |
| A1–A6 | packaging: `type`/`files`, `pixi.js` and `vimp-engine` in the wrong dependency section, the standard scripts, entry paths, the required Vite options, `crate-type`/`enhanced-determinism`/a stale `vimp-engine-core` pin, and the built manifest |
| B1–B10 | host: plugin shape, the `engineApi` triple, the nine `gameConfig` paths, teams and spectators, `roomForm` fields the host silently drops, the reserved panel key `t`, chat commands shadowing engine ones, system-message codes overwriting engine texts, reserved vote names, respawn capacity vs `maxPlayers` |
| C1–C10 | client: plugin shape and the three hooks, parts registered in `entitiesOnCanvas`, `gameSets` covering every snapshot key and map `setId`, known services, the `t`/`time` panel field, five stat columns (warning), spectator and player keysets, bakers, message texts, the auth schema (`fieldsId`, no nickname, the `model` field) |
| D1–D3 | snapshot schema: unique ids, `hot`/`event` classes vs block kinds, `interp` only on hot `f32` |
| E1–E3 | assets in `dist/`: the `webm` + `mp3` pair per sound, map images, an empty sound registry (warning) |

Run it before `npm run sim`: it is faster, needs no core build, and its
findings are the ones the runner would report as a black canvas ten minutes
later. Together they cover the checklist in `docs/ai/10-pitfalls.md` — the
static half here, the runtime half in the invariants below.

## The loop in one command

```bash
npm run sim                       # built-in smoke scenario on the miniGame fixture
npm run sim -- --scenario s.json  # run a scenario
npm run sim:replay s.json         # same, shorthand (`--scenario` is preset)
npm run sim:check                 # verdict to stdout only, no files written
```

CLI options (`packages/engine/bin/vimp-sim.js`, also installed as the
`vimp-sim` bin of the `vimp-engine` package):

| Option | Meaning |
| --- | --- |
| `--scenario <path>` | scenario JSON; without it a built-in smoke scenario runs (see the note below) |
| `--game <path>` | game package directory, or a `dist/manifest.json` directly |
| `--core <path>` | Node build of the game core, overriding `entries.wasmNode`; only meaningful with `--game` (the fixture's core is plain JS, so `--core` alone is a no-op and says so) |
| `--out <dir>` | report root (default `.debug`) |
| `--no-write` | print the report to stdout instead of writing files |
| `--determinism` | run the scenario twice and compare the frame streams (invariant 12) |
| `--help` | usage |

**The built-in scenario is a smoke test, not an audit.** One participant
joins, holds a key, releases it. The identifiers it drives — model, playable
team, key name — are read from your `gameConfig` (first of `parts.models`,
first `teams` entry that is not `spectatorTeam`, first `playerKeys` entry
that is not a `type: 1` trigger — `up` on a trigger is a no-op, so the smoke
would hold nothing), so it runs on any plugin; if a game declares none of them, the runner says so instead of
guessing. What it cannot infer is what your game *means*: invariant 2 (key
coverage — the scenario cannot know which keys it ought to spawn) and
invariant 9 (prediction drift — thresholds are per-game) are **skipped**,
with a notice on stderr. Both come back the moment you pass a `--scenario`
written for your game.

**Exit code is the verdict**: `0` when no invariant failed, `1` when at
least one did (the failing names are printed to stderr). That is what makes
the loop autonomous — edit, run, read the text, repeat.

### Which core it runs

Resolution order in `devtools/pluginLoader.js`, by decreasing precision:

1. `--game <path>` → the manifest is read, `engineApi` is checked against
   this engine build, `entries.host`/`entries.client` are imported, and the
   core comes from `entries.wasmNode` (a **Node** build of the WASM core,
   conventionally `dist/core-node/`);
2. `--core <path>` → overrides `entries.wasmNode`;
3. nothing → the `miniGame` fixture shipped with the engine
   (`packages/engine/tests/fixtures/miniGame/`), whose cores are plain JS.
   That fallback is why `packages/engine/package.json:files` publishes
   `tests/fixtures` — a "cleanup" of that list silently breaks `npm run sim`
   without `--game`.

`entries.wasmNode` is optional. A game without it simply cannot be run
headlessly on its real core — the runner then says so instead of guessing.
The declared file must actually exist: a manifest that points at a Node core
missing from the published package fails with that sentence, not with a raw
`ERR_MODULE_NOT_FOUND` from the module resolver. Ship the glue **inside the
published `dist/`** — ignore rules apply inside directories listed in
`files` too. Both halves of the plugin are also re-checked against the
manifest's `engineApi`, which catches a rebuilt manifest next to a stale
`dist/`. See [plugin-api.md](plugin-api.md#gamemanifest).

One more thing about `--game`: the runner imports the game's **client**
bundle, and its externals must resolve from where the package lies —
`pixi.js` above all (a peer dependency of the plugin). An installed copy
(`node_modules/<package>`) resolves it from the project; a tarball unpacked
into an arbitrary directory does not, and fails with
`Cannot find package 'pixi.js'`. Unpack inside a project that has the
dependencies, or install the package.

## Scenario format

```json
{
  "version": 1,
  "seed": 3812,
  "map": "arena",
  "config": { "timers": { "networkSendRate": 1 } },
  "participants": [{ "id": "p1", "name": "P1", "model": "m1" }],
  "timeline": [
    { "tick": 0,  "op": "join", "who": "p1", "team": "team1" },
    { "tick": 12, "op": "key",  "who": "p1", "action": "down", "name": "forward" },
    { "tick": 30, "op": "chat", "who": "p1", "text": "/nr" }
  ],
  "unusedSnapshotKeys": ["e1"],
  "divergence": { "thresholds": [0.5, 0.5], "capacity": 64 },
  "ticks": 1200,
  "dumpTicks": [6, 1200]
}
```

| Field | Meaning |
| --- | --- |
| `version` | must be `1` |
| `seed` | uint32, goes into `room.seed` — the same seed reproduces the same world (default `1`) |
| `map` | starting map name (default: the game's own default) |
| `game` | `{ version }` of the game package, as the lobby would send it |
| `room` | extra room overrides (`applyRoomOverrides`) |
| `config` | patch merged into the assembled game config before the core is created; **timers only under `config.timers`** — a top-level key is a game-config key and is never routed into timers |
| `participants` | `[{ id, name, model }]`, non-empty; `id` is the scenario-local handle used by `who` |
| `timeline` | ops, sorted by `tick` on parse |
| `unusedSnapshotKeys` | snapshot keys this scenario deliberately never spawns (see invariant 2); `"*"` means "this scenario does not audit key coverage at all" and makes invariant 2 skip — used by the built-in scenario when it runs on someone else's game |
| `divergence` | thresholds for the prediction detector; `{}` = core defaults, `null` = detector off, which makes invariant 9 skip |
| `ticks` | how many ticks to run (default `600`) |
| `dumpTicks` | ticks at which a scene slice is dumped (default: the last tick) |

Ops:

| `op` | Fields | Effect |
| --- | --- | --- |
| `join` | `who`, `team` | participant enters, a real `ClientCore` is created for them |
| `leave` | `who` | participant leaves |
| `key` | `who`, `action` (`down`/`up`), `name` | `HostGame.updateKeys`, and the same input is applied to that participant's client core |
| `chat` | `who`, `text` | `HostGame.pushMessage` (chat commands included) |
| `vote` | `who`, `data` | `HostGame.parseVote` |

Two properties are worth knowing before writing a scenario by hand:

- **The tick step is not a scenario field.** It comes from the game config
  (`timers.timeStep`); the virtual clock advances exactly one step and the
  real, self-correcting `TimerManager` loop makes exactly one tick. The
  runner drives the production loop instead of replacing it.
- **Input lands synchronously**, there is no queue — so a `tick` in the
  timeline is the tick boundary at which the input took effect. `op: key`
  is mirrored to the client core on purpose: without it the prediction
  detector would have nothing to compare against.
- **The virtual client is wired like the browser one.** `VirtualClient`
  repeats what `client/main.js` does with the core: the participant's
  `{ name, model }` goes through `hooks.onAuth` on creation, `MAP_DATA`
  through `set_map`, panel frames through `hooks.onPanel`, and `KEYSET_DATA`
  through `set_active`; `FIRST_SHOT_DATA` is applied immediately (the world
  snapshot of the first frame) and `CLEAR` removes entities and resets the
  core, exactly as the browser does on every round restart and map change.
  Without that the core would run in a state the game never produces — no
  model, prediction off, a scene carrying entities the browser already
  dropped. The order is the wire order too: the recording transport publishes
  a frame the moment the production code hands its payload to the socket, so
  a composite sender arrives before the calls nested inside it
  (`FIRST_SHOT_DATA` → `STAT` → `PANEL` → `KEYSET`). `sendPing` is answered
  immediately (`updateRTT`), otherwise the host would honestly kick every
  participant on the RTT timeout in the middle of a long run.
- **Spawn resets reach the client late.** A `force_reset` camera arrives
  through the interpolation buffer (`interpolation.delay`), and it clears
  the predictor's held keys. Pressing a key in the first ~`delay`
  milliseconds after `join` therefore gets dropped on the client while the
  host keeps it — start scenario input a few dozen ticks after the join.

## Invariants

After the run the runner evaluates 12 contracts
(`packages/engine/src/devtools/invariants.js`). Each is `pass`, `fail` or
`skip` — `skip` means "nothing in this run to check", it never masks a
violation. Every violation is a line naming the client, the key and the
value.

| # | Name | Catches |
| --- | --- | --- |
| 1 | `finiteValues` | `NaN`/`Infinity` in decoded fields or the hot buffer |
| 2 | `snapshotKeysUsed` | a snapshot key that produced no rows — "the entity never spawns", or a key-id mismatch (declare deliberate cases in `unusedSnapshotKeys`) |
| 3 | `fieldWidths` | decoded field count ≠ schema field count — the positional binding in `interpolator.rs` drifting |
| 4 | `frameFormat` | frame version byte ≠ `SNAPSHOT_FORMAT_VERSION`, or `decode_frame` throwing |
| 5 | `hotLayout` | hot-buffer traversal not consuming exactly `len` floats — record width or group order drifted |
| 6 | `panelContract` | a declared `panel` field that never reaches the client config (values arriving named `undefined`) |
| 7 | `renderCoverage` | a live snapshot key missing from `gameSets`/`entitiesOnCanvas` — the "black canvas" class |
| 8 | `keyBindings` | host `playerKeys` ↔ client keysets ↔ the key names used by the scenario |
| 9 | `predictionDrift` | prediction divergence above the threshold (see below) |
| 10 | `roundLifecycle` | round ended, winner announced, respawns happened, participants not leaked |
| 11 | `actorLeak` | `players_data()` disagreeing with the active participants |
| 12 | `determinism` | two runs of the same scenario producing an identical frame stream — frames are compared by hash, and the hashes are only collected under `--determinism` (on a long match the stream would be megabytes of report) |

Invariant 12 is the self-check of everything else: it holds only because
time, timers and randomness in the host all go through the injectable
`clock` (see [configuration.md](configuration.md#libclockjs)) and because
the seed is fixed by the scenario.

## The report

Written to `.debug/run-<timestamp>/` (`.debug/` is git-ignored):

| File | Contents |
| --- | --- |
| `report.md` | the human/LLM-readable verdict |
| `report.json` | the same run, machine-readable, plus `snapshotSchema` |
| `scene-<tick>.json` | one file per dumped tick: per-client scene, camera, panel, plus the core dump |

Scene slices live in their own files because they are by far the largest
part and are read pointwise; `report.json` keeps only their tick numbers in
`sceneTicks`.

`report.md` sections:

- header — game id and source, seed, step, duration, map, participants;
- `## Outgoing frames` — count per `SocketManager` method;
- `## Clients` — per client: entities on canvas, decode errors, received
  ports;
- `## Map changes`;
- `## World (core dump)` — bodies, colliders, map, nav nodes, spatial
  entities, rng state, fixed-step accumulator of the last dumped tick;
- `## Prediction drift` — reconciliations, violations, max |Δ| per
  component;
- `## Invariants` — the point of the whole exercise: `✅/❌/⏭️`, the check
  name, its title and every violation line.

## Core dumps: `debug_json()`

Both cores expose a curated dump (raw rapier serde output is unreadable):

- **game core** — `GameCore.debug_json()` (exported by
  `export_game_core_abi!`, so every plugin gets it for free): `bodies`
  (`tag`, `userData`, `translation`, `rotation`, `linvel`, `angvel`,
  `mass`, `bodyType`, `ccd`), `colliders` (`shape` +
  `halfExtents`/`radius`, `isSensor`, collision/solver groups in hex,
  `parent`), `map` (`setId`, `step`, grid size, static/dynamic body
  counts, respawns), `nav` (nodes/edges/grid step), `spatial` (cell size,
  per-cell counts), `rng.state`, `step.accumulator`;
- **client core** — `ClientCore.debug_json()`: `myGameId`, `offset`,
  `hotLen`, `framesOut`, and `interpolator` (buffer depth, `seqWindow`,
  last frame `seq`/`serverTime`, `offset`, `lastRenderTime`).

Record order is deterministic, so two dumps of two runs can be diffed.

In JS the dump is reached through `GameCoreAdapter.debugJson()`,
`HostGame.debugSnapshot()` (host meta + the core dump) and
`VirtualClient.debug()`. All of them return `null` if the game core was
built against an engine without the method — an older plugin build does not
break the run.

## Prediction divergence detector

Client-side prediction drifting away from the authoritative state is the
classic "rubber-banding" bug, and it is invisible in any single frame. The
detector compares the two **at the moment the authoritative frame arrives**,
just before `on_server_state` overwrites the prediction.

Two levels, so that a plugin needs to do nothing in the basic case:

- **level 0** — no plugin changes: the camera of `render_overlay()` (the
  predicted position for a predicting plugin) against `state[0]`/`state[1]`
  of the authoritative player block. **This is a contract**: level 0 assumes
  the first two components of your player block are world x/y. If your
  layout starts with something else, implement `predicted_state()` — level 0
  would otherwise report violations that mean nothing. Level-0 records name
  the components `x`/`y`; level-1 records address them by index, because
  their meaning is the game's;
- **level 1** — one optional trait method,
  `GameClientDef::predicted_state() -> Option<[f32; PLAYER_STATE_LEN]>`
  (default `None`), compared component-wise; the optional companion
  `replayed_inputs() -> Option<(f64, f64, usize)>` reports the input-history
  window the last reconciliation replayed.

Configuration is the optional `divergence` section of the engine client
config (absent in production, and then the frame path is not touched at
all):

```json
{ "thresholds": [0.5, 0.5], "defaultThreshold": 1.0, "capacity": 64 }
```

`thresholds` is **positional** over the player block (its layout is
game-specific); missing components fall back to `defaultThreshold`. Records
land in a ring buffer of `capacity` entries — evicted ones are counted as
`dropped`. A record is only stored if at least one component exceeded its
threshold, otherwise the report would drown in noise.

Calibrating the thresholds is part of writing the scenario. Two sources of
*expected* difference exist, and a threshold below them turns the check into
noise:

- **one fixed step of lag.** The comparison happens when a frame arrives,
  between render ticks, so the replica is up to one `timeStep` behind the
  authoritative state — at top speed that is `speed × timeStep` units of
  position and one step of acceleration in velocity.
- **what the replica does not simulate.** Collisions, explosion impulses and
  teleports are authoritative-only; each produces a single large spike that
  the next reconciliation absorbs. Keep them out of a scenario that watches
  drift, or turn the detector off for that scenario (`"divergence": null`).

What the check is actually for is divergence that **grows** — a formula that
differs between the core and the replica never converges back.

`ClientCore.take_divergence()` (exported by `export_client_core_abi!`)
drains the buffer and returns:

```json
{ "samples": 29, "violations": 0, "dropped": 0, "maxDelta": [0.0, 0.0],
  "records": [{
    "source": "predicted", "serverTime": 1234, "localNow": 5678,
    "offset": 12.5, "inputSeq": 41,
    "replayed": { "from": 5600, "to": 5678, "count": 7 },
    "predicted": [...], "authoritative": [...], "delta": [...],
    "thresholds": [...], "exceeded": [1]
  }] }
```

Note that reconciliation is matched **by time, not by `seq`** — the
predictor replays its input history from the authoritative timestamp — which
is why `serverTime`, `offset` and the replayed window are in the record:
they are what localises the formula that drifted.

## The browser half

The headless runner cannot reproduce real WebRTC, PixiJS or live human
input. The browser half captures those into the same scenario format.

Everything below exists only in dev: the recorder hangs off
`gameConfig.isDevMode` (set from `room.isDevMode`, which `client/main.js`
fills from `import.meta.env.DEV`), and the production bundle drops the
branch at build time.

### `window.__vimpDebug`

Available in a dev build; meant to be driven from DevTools or from Chrome
MCP (`javascript_tool`, `read_console_messages`) without a human reading the
output.

| Call | Does |
| --- | --- |
| `dump({ save, note })` | host meta + core dump (via the Worker) next to this client's scene; optionally uploads |
| `startRecording()` | starts recording the live match; `false` means the room was created without dev mode |
| `stopRecording({ save = true, note })` | stops and (by default) uploads the recorded scenario, returns `{ scenario, file }` |
| `divergence()` | drains this client core's divergence detector |
| `save(kind, payload, note)` | uploads an arbitrary payload (`scenario`/`dump`/`divergence`) |

The API never fails silently: a tab that is not hosting a room throws an
error saying so, rather than returning `null`.

### The recorder

`host/DebugRecorder.js` (Worker-safe — it only uses `clock`) writes the live
match in the scenario format above: the seed, the joins, and every
`updateKeys`/`pushMessage`/`parseVote` with its tick number, plus a `dt`
sequence. Participants who joined before recording started become `join` ops
at tick 0, otherwise the replay would begin in an empty room. Scenario ids
are its own (`p1`, `p2`, …), because `gameId` is reused after a player
leaves and would merge two different people into one recording. Caps
(`maxOps`/`maxDtSamples`) do not fail silently — an overflow is reported in
the scenario's `meta`.

On the host facade: `startRecording()`, `stopRecording()`, `isRecording`,
`debugSnapshot()`. The Worker exposes them through a request/response
message pair (`debug` → `debug_result` with a `requestId`), wrapped in
promises by `HostController` — see [host.md](host.md).

### Upload: `POST /debug/report`

The master registers the route **only outside production**; it writes into
the same `.debug/` the headless runner writes to, so both sources are read
the same way. Body: `{ kind, payload, note }` with `kind` in a closed list
(`scenario`, `dump`, `divergence`), 8 MB limit. Response:
`{ file, bytes }`. See [master.md](master.md#post-debugreport-dev-only).

### Host logs in the client console

The Worker is isolated from the tab's DevTools, so host-side debug events go
out over port 12 (`CONSOLE`, `SocketManager.sendConsole`) and the client
prints them as `[vimp:debug][host] …`. Everything the debug API logs carries
the same `[vimp:debug]` prefix, so Chrome MCP can filter the console by
pattern instead of reading the whole stream.

### From browser to headless

```
record in the browser → .debug/scenario-<ts>-N.json → npm run sim:replay <file>
```

The recorded file is accepted by `npm run sim:replay` without editing —
`tests/devtools/replayRecording.test.js` records a match with the fixture
host and immediately feeds the result to `runScenario`, so this is a tested
contract, not a declaration.

**Known limit: a replay is a new match, not a resumed one.** The recorder
starts at `tick = 0` and stores only entries and input — not the state of
the world at that moment (positions, round phase, score, map rotation) — and
the replay runs on a fixed `timeStep` while the live match ran on a floating
`dt`. So "a bug caught in the browser is reproduced by `sim:replay`" holds
for bugs reproducible **from the start of the match**. Start recording at
minute five and the replay will not contain the situation you saw. Lifting
this needs an `initialState` snapshot in the recording (the engine already
has `serialize_state()` for the Worker handoff) and is a separate task.

## Suggested workflow for a new plugin

1. Build a Node build of the core (`core/pkg-node/`) and point
   `entries.wasmNode` at it.
2. `npm run sim -- --game <package> --scenario <scenario>` — fix every
   invariant violation. Most "black canvas"/"nothing spawns" bugs die here,
   in text, without a browser.
3. Add `--determinism` once the match is stable.
4. Only then open two browser tabs for the manual smoke run; if something
   is wrong there, `startRecording()` → `stopRecording()` →
   `npm run sim:replay` brings it back into step 2.

## Tests

`tests/devtools/` (runner, invariants, virtual client/clock, report,
recording replay), `tests/lib/{clock,reconstructHot,createHostRuntime}.test.js`,
`tests/host/DebugRecorder.test.js`, `tests/client/debug.test.js`,
`tests/master/debugReport.test.js`; on the Rust side `game::tests::debug_json_*`
and `client::game::tests::divergence_*` (`npm run core:test`).

---

[← Back to docs index](README.md)
