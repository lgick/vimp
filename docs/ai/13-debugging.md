# 13 — Debugging your plugin

Silence is the failure mode of this engine (see `10-pitfalls.md`). A wrong
snapshot id, a field width off by one, a `gameSets` key you forgot — none of
them throw. They produce a black canvas, a frozen entity, or a panel cell
that never updates, in a Web Worker you cannot step through, behind a binary
frame, in another browser tab.

The engine ships a **headless runner** that closes the whole loop —
`host → binary frame → ClientCore → hot buffer → scene` — inside one Node
process, and checks 12 contracts on the result. Use it as your primary
verification tool. Two browser tabs are the last step, not the first.

**Requires nothing from your plugin.** Every debugging facility described
here arrives through the ABI macros (`export_game_core_abi!` /
`export_client_core_abi!`) and through trait methods with defaults. There is
no debug-mode API to implement, and `engineApi` is unaffected.

## Running it

From the **engine** checkout (where you linked your package):

```bash
npm run sim -- --game <path to your package> --scenario <scenario.json>
npm run sim -- --game <path to your package>          # built-in smoke scenario
npm run sim:replay <scenario.json>                    # shorthand for --scenario
npm run sim:check                                     # verdict to stdout, no files
```

| Option | Meaning |
| --- | --- |
| `--scenario <path>` | scenario JSON (see below); omitted → a built-in smoke scenario |
| `--game <path>` | your package directory, or its `dist/manifest.json` |
| `--core <path>` | Node build of your core, overriding `entries.wasmNode` |
| `--out <dir>` | report root (default `.debug`) |
| `--no-write` | print the report instead of writing files |
| `--determinism` | run the scenario twice and compare the frame streams |

The **exit code is the verdict**: `0` = every contract held, `1` = at least
one broke (names printed to stderr). That is what makes this loop usable
without a human: edit → run → read the text → repeat.

### Prerequisite: `entries.wasmNode`

The runner is Node, so it needs the `--target nodejs` build of your core —
the same `core/pkg-node/` you already build for your Rust-side integration
tests (`02-packaging.md`). Point the manifest at it:

```json
"entries": {
  "client": "/games/<id>/client-<hash>.js",
  "host": "/games/<id>/host-<hash>.js",
  "wasm": "/games/<id>/assets/<crate>_bg-<hash>.wasm",
  "wasmNode": "../core/pkg-node/<crate>.js"
}
```

`wasmNode` is optional and is a **path relative to the manifest**, not a
URL. Without it, pass `--core <path>` on every run.

Your `createCore`/`createClientCore` must accept it: it is a JS module, not
a `.wasm` asset — see `03-host-plugin.md` § *Two shapes of `wasmUrl`*.

For the runner to work from an **installed copy** of your game and not only
from a checkout, copy the Node glue **into the published `dist/`** at build
time (e.g. `dist/core-node/`) and point `wasmNode` there. Listing
`core/pkg-node` in `files` is not enough: npm applies ignore rules inside
directories from `files` too, and a `wasm-pack` output directory is usually
git-ignored (it also drops its own `.gitignore` with `*` — do not copy that
file). Keep the `package.json` that `wasm-pack` writes: without it Node
reads the CommonJS glue as ESM. Add a `prepack` check that the file is
really in the tarball — the engine now refuses a manifest whose `wasmNode`
does not exist, and both plugin halves are re-checked against the manifest's
`engineApi`, so a stale `dist/` fails loudly instead of producing a green
verdict about code you no longer ship.

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
    { "tick": 90, "op": "key",  "who": "p1", "action": "up",   "name": "forward" },
    { "tick": 30, "op": "chat", "who": "p1", "text": "/nr" }
  ],
  "unusedSnapshotKeys": ["explosion"],
  "ticks": 1200,
  "dumpTicks": [6, 1200]
}
```

| Field | Meaning |
| --- | --- |
| `version` | must be `1` |
| `seed` | uint32 PRNG seed of the match — the same seed reproduces the same world |
| `map` | starting map name (default: your `roomDefaults.map`) |
| `config` | patch merged into your assembled `gameConfig` before the core is created; **timers go only under `config.timers`** (`{ "timers": { "networkSendRate": 1 } }`) — a top-level key patches the game config and is never routed into timers |
| `room` | extra room overrides, as the lobby form would send them |
| `participants` | `[{ id, name, model }]`; `id` is a scenario-local handle referenced by `who` |
| `timeline` | ops (`join`, `leave`, `key`, `chat`, `vote`), sorted by `tick` |
| `unusedSnapshotKeys` | snapshot keys this scenario deliberately never produces |
| `divergence` | prediction-drift thresholds; `{}` = defaults, `null` = off |
| `ticks` | total ticks to run (default `600`) |
| `dumpTicks` | ticks at which a full scene slice is written out |

Ops:

| `op` | Fields |
| --- | --- |
| `join` | `who`, `team` — a real `ClientCore` is created for this participant |
| `leave` | `who` |
| `key` | `who`, `action` (`down`/`up`), `name` (a `playerKeys` name) |
| `chat` | `who`, `text` (chat commands included) |
| `vote` | `who`, `data` |

The tick step is **not** a scenario field: it comes from your
`gameConfig.timers.timeStep`, and the runner drives the engine's real game
loop one step at a time on a virtual clock — a ten-minute match runs in
seconds. `key` ops are applied to the host **and** mirrored into that
participant's client core, so local prediction is exercised too.

## The 12 invariants

Every run ends with these, each `pass` / `fail` / `skip` (`skip` = nothing
in this run to check; it never hides a violation). Most of them exist
because the matching mistake is otherwise silent.

| # | Name | Catches |
| --- | --- | --- |
| 1 | `finiteValues` | `NaN`/`Infinity` in a decoded field or the hot buffer |
| 2 | `snapshotKeysUsed` | a snapshot key that produced no rows — the entity never spawns, or its id disagrees between host and client (declare intentional cases in `unusedSnapshotKeys`) |
| 3 | `fieldWidths` | decoded field count ≠ schema field count — your `build_snapshot_blocks` row order or width drifted from the schema |
| 4 | `frameFormat` | wrong frame version byte, or `decode_frame` throwing |
| 5 | `hotLayout` | hot-buffer traversal not consuming exactly `len` floats |
| 6 | `panelContract` | a `panel.fields` entry that never reaches the client panel schema (the value arrives named `undefined`) |
| 7 | `renderCoverage` | a live snapshot key missing from `gameSets`/`entitiesOnCanvas` — the classic black canvas |
| 8 | `keyBindings` | `playerKeys` ↔ `keySetList` ↔ the key names your scenario uses |
| 9 | `predictionDrift` | client prediction drifting from the authoritative state beyond the threshold |
| 10 | `roundLifecycle` | the round never ends, no winner, no respawns, participants leaked |
| 11 | `actorLeak` | `players_data()` disagreeing with the engine's active participants |
| 12 | `determinism` | two identical runs producing different frames — compared by per-frame hash, collected only under `--determinism` |

Numbers 2, 3, 6, 7 and 8 are the checklist items from `10-pitfalls.md`,
mechanised. If your plugin passes them on a scenario that exercises every
entity type, most of the "nothing renders" class is already dead.

## Reading the report

`.debug/run-<timestamp>/`:

| File | Contents |
| --- | --- |
| `report.md` | the verdict — read this first |
| `report.json` | the same, machine-readable, plus `snapshotSchema` (the frame stream is not written — under `--determinism` it is compared in memory as hashes) |
| `scene-<tick>.json` | per dumped tick: every client's reconstructed scene, camera, panel, and a dump of the authoritative world |

`report.md` ends with `## Invariants` — one line per contract, and one
indented line per violation naming the client, the key and the value. Also
in it: outgoing frame counts per port, per-client entity counts and decode
errors, map changes, the world dump summary, and prediction drift.

## World dumps: `debug_json()`

Both cores expose a curated JSON dump, generated by the ABI macros — you
implement nothing.

- `GameCore.debug_json()` — bodies (`tag`, `userData`, `translation`,
  `rotation`, `linvel`, `angvel`, `mass`, `bodyType`, `ccd`), colliders
  (`shape` + `halfExtents`/`radius`, `isSensor`, collision/solver groups in
  hex, `parent`), map (`setId`, step, grid, static/dynamic counts,
  respawns), nav graph, spatial grid occupancy, `rng.state`, fixed-step
  accumulator.
- `ClientCore.debug_json()` — `myGameId`, `offset`, hot-buffer length,
  pending frames, and the interpolator (buffer depth, `seq` window, last
  frame `seq`/`serverTime`).

This is the tool for "my actor is inside a wall", "the tank spawned at
0,0", "why is this body still alive". Record order is deterministic, so two
dumps can be diffed. The runner embeds both into every `scene-<tick>.json`.

## Prediction drift

Prediction that silently diverges from the authoritative state shows up as
rubber-banding for players and as nothing at all in a single frame. The
engine compares the two exactly when an authoritative frame arrives, just
before it overwrites your prediction.

- **Level 0 — nothing to implement.** The engine compares the camera your
  `render_overlay()` returns against `state[0]`/`state[1]` of the
  authoritative player block. **This is a contract on your layout**: level 0
  assumes those two components are world x/y. If your player block starts
  with anything else, implement `predicted_state()` below — otherwise
  invariant 9 reports violations that mean nothing. Level-0 records name the
  components `x`/`y`; level-1 records address them by index.
- **Level 1 — two optional trait methods** on `GameClientDef`, both
  defaulting to `None`:

  ```rust
  fn predicted_state(&self) -> Option<[f32; PLAYER_STATE_LEN]> { … }
  fn replayed_inputs(&self) -> Option<(f64, f64, usize)> { … }
  ```

  The first is your predicted player state in the player-block layout,
  compared component-wise; the second reports the input-history window your
  last reconciliation replayed.

Thresholds come from the scenario's `divergence` field (`thresholds` is
**positional** over the player block, since its layout is yours;
`defaultThreshold` covers the rest; `capacity` sizes the ring buffer). A
record is stored only when a component exceeds its threshold. Matching is by
**time**, not by input `seq` — reconciliation replays input history from the
authoritative timestamp — so each record carries `serverTime`, `offset` and
the replayed window: those are what localise the formula that drifted.

Implementing level 1 is the single highest-value optional method for a game
with client-side prediction. It turns "movement feels wrong sometimes" into
a numbered component with a delta.

Calibrate the thresholds instead of leaving the default: a fixed-step
replica is compared when a frame arrives, so it is legitimately up to one
`timeStep` behind (at top speed, `speed × timeStep` units of position), and
whatever your replica does not simulate — collisions, explosion impulses,
teleports — produces one-off spikes the next reconciliation absorbs. Keep
those out of a drift-watching scenario, or set `"divergence": null` for it.
The failure you are hunting is drift that *grows*.

Two more things a scenario has to respect, both learned the hard way:

- do not press keys in the first `interpolation.delay` milliseconds after
  `join` — the spawn's `force_reset` reaches the client through the
  interpolation buffer and clears the predictor's held keys, so the host and
  the client would disagree for the rest of the run;
- a round only ends when a whole team dies (a round timeout just restarts
  it), so a scenario that wants invariant 10 green has to actually kill
  someone — bots (`/bot 1 team2`) or friendly fire plus a point-blank
  explosive are the reliable ways.

## Capturing a browser bug

If something only reproduces in a real browser (real WebRTC, real PixiJS,
real human input), record it and bring it back into the headless loop. In a
dev build of the engine the host tab exposes:

```js
await window.__vimpDebug.startRecording();   // start
// … reproduce the bug …
await window.__vimpDebug.stopRecording();    // stop + upload to .debug/
window.__vimpDebug.dump();                   // host meta + world dump, right now
window.__vimpDebug.divergence();             // this client's drift records
```

The recording **is** a scenario file in the format above: run it with
`npm run sim:replay .debug/scenario-<...>.json` and you are back in the
text-only loop. Host-side debug events also arrive in the tab's console
prefixed `[vimp:debug][host]`.

**The replay is a new match, not a resumed one.** The recorder starts at
tick 0 and stores entries and input only — not the world state at that
moment (positions, round phase, score, map rotation) — and it replays on a
fixed `timeStep` while the live match ran on a floating `dt`. Only bugs
reproducible **from the start of the match** come back this way, so start
recording before the situation you want to capture, not in the middle of
it.

## Where this sits in the workflow

1. Build `core/pkg-node`, declare `entries.wasmNode`.
2. Write one scenario per major mechanic (movement, firing, death/respawn,
   round end, map change, votes).
3. `npm run sim` until every invariant is green — including
   `--determinism`.
4. Only then do the two-tab smoke test from `11-authoring-workflow.md`.
5. Anything the browser catches, record and replay headlessly.
