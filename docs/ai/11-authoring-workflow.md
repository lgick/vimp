# 11 — Authoring workflow

The order in which to build a game plugin, and what each step depends on.
Follow it top to bottom; skipping ahead produces work you will redo.

## Step 0 — read the contract

Read `01`–`10` of this directory in full. The questionnaire assumes you know
what the engine already provides, so that you can tell the user "the engine
does that" instead of designing it again.

## Step 1 — interview

Run `12-questionnaire.md`. Rules:

- Conduct it in the **user's language**, whatever the file's language.
- Ask block by block, not all 14 blocks at once.
- Offer a "same as tanks" default for every question and let the user accept
  it with one word.
- When an answer conflicts with the engine (a custom room setting, a kick
  vote, runtime localisation), say so immediately and offer the nearest
  workable alternative.
- Stop asking about anything the user has already settled implicitly.

## Step 2 — design document

Write a short design doc and get explicit confirmation before generating code.
It must pin down:

| Decision | Feeds |
| --- | --- |
| Package name, `id`, title | `package.json`, `manifest`, both plugins |
| Teams and spectator team | `gameConfig.teams`, stat schema, maps |
| Entity types and their fields | snapshot schema, Rust rows, parts |
| Actions and keys | `playerKeys`, `keySetList`, core input handling |
| Resources shown in the HUD | `panel.fields` (host) + panel schema (client) |
| Weapons/abilities | `parts.weapons`, core weapon logic, event snapshot keys |
| What is predicted locally | the 8 × f32 player state, predictor, parity test |
| Canvases and camera | `canvasManager.canvases` |
| Maps and team capacity | `data/maps/*`, `respawns` |
| Sounds and cues | sound config, `soundCues` |
| Progression | `playerState.defaultState`, `onCoreEvent` |

## Step 3 — scaffold

Create the repository layout from `02-packaging.md`: `package.json`,
`vite.config.js`, `vitest.config.js`, `eslint.config.js`, `Cargo.toml`,
`core/`, `src/`, `scripts/`, `assets/`.

Copy the four build scripts (`export-maps.js`, `process-audio.js`,
`copy-game-sounds.js`, `build-game-manifest.js`) and adapt the id and paths.

## Step 4 — configuration

Write the config layer first; it is the contract everything else implements.

1. `src/config/snapshot.js` — the wire schema.
2. `src/data/models.js`, `src/data/weapons.js` — the catalogs.
3. `src/config/game.js` — `HostPlugin.gameConfig` (imports the above).
4. `src/config/client.js` — the client half.
5. `src/config/auth.js` — the auth screen.
6. `src/data/maps/*.js` — at least one map with full `respawns`.
7. `src/config/sounds.js` — the sound registry.

Cross-check as you go: panel keys match on both halves; `playerKeys` names
match `keySetList` names; every snapshot key has a `gameSets` entry; every
`gameSets` class is in `entitiesOnCanvas`.

## Step 5 — Rust core

1. `core/src/config.rs` — deserialise the `game` half of the init JSON.
2. `core/src/<actor>.rs` — actor spawn/damage/vitals.
3. `core/src/motion.rs` — movement math, **shared** with the predictor.
4. `core/src/<game>.rs` — `impl GameSim`, including
   `build_snapshot_blocks` producing rows in the exact schema order.
5. `core/src/client/predictor.rs` — local prediction using `motion.rs`.
6. `core/src/client/mod.rs` — `impl GameClientDef`.
7. `core/src/lib.rs` — the two structs plus `export_game_core_abi!` /
   `export_client_core_abi!` and hand-written `new` + game-specific client
   methods.

Build: `npm run core:build`.

## Step 6 — client rendering

1. `src/client/parts/*` — one class per entity projection.
2. `src/client/bakers/*` — procedural textures.
3. `src/client/<game>.css` — styles for your panel cells and teams.
4. `src/client/index.js` — the `ClientPlugin` with the three hooks.
5. `src/host/index.js`, `createModules.js`, `systemMessages.js`, chat
   commands, and the `scripted` (bot) manager.

## Step 7 — tests

Two suites:

**JavaScript (Vitest)** — mirror the tanks arrangement, two projects:

```js
projects: [
  { test: { name: 'game', environment: 'happy-dom',
            include: ['tests/host/**', 'tests/client/**', 'tests/config/**'] } },
  { test: { name: 'integration', environment: 'node',
            include: ['tests/core/**'] } },   // drives core/pkg-node
]
```

Cover at minimum:

- the host plugin exposes every required field and the config passes the
  engine's required-paths check;
- the client config and host config agree on panel keys, key names, snapshot
  keys, `gameSets` ↔ `entitiesOnCanvas`;
- chat commands and the bot manager behave;
- the manifest script produces a well-formed manifest.

**Rust (`cargo test --workspace`)** — unit tests per module plus a **motion
parity suite**: step the authoritative sim and the predictor with the same
inputs and assert identical state. Run it after every movement change.

## Step 8 — build and link

```bash
npm run core:build     # wasm-pack web + nodejs
npm run build          # client → host → assets → manifest
npm link               # publish the game link
# in the engine checkout:
npm link @my-scope/my-game
```

Then start the master (`npm run dev` in the engine) and open the lobby.

The lobby is not the only way in: `vimp-engine/standalone` runs the whole
match inside one tab of the *game* repository — no master, no OAuth, no lobby
screen. `startStandaloneGame({ hostPlugin, clientPlugin, wasmUrl, … })` takes
the live plugin objects, so it is the fastest loop while the plugin is still
taking shape:

```js
// dev/main.js in the game repository, loaded by its own index.html
import { startStandaloneGame } from 'vimp-engine/standalone';
import hostPlugin from '../src/host/index.js';
import clientPlugin from '../src/client/index.js';
import wasmUrl from '../core/pkg/my_game_bg.wasm?url';

await startStandaloneGame({
  hostPlugin,
  clientPlugin,
  wasmUrl,
  container: document.getElementById('game'), // full-screen, position: relative
  assetsBase: '/assets/',
  playerName: 'dev',
  startupVotes: [['teamChange', 'team1']], // leave the spectators first…
  startupCommands: ['/bot 4'], // …only then your own chat commands
});
```

The engine has no notion of a bot: scripted participants are spawned by
*your* chat command, and the command is rejected while the player is still a
spectator — hence the strict order of the last two options. Reference: engine
`docs/en/standalone.md`.

## Step 9 — headless simulation (do this before the browser)

Two browser tabs are the slowest and least informative way to find a broken
contract. Run the engine's headless runner first — it closes the whole loop
(host → binary frame → client core → scene) in one Node process and names
every violated contract in text. Full reference: `13-debugging.md`.

```bash
# in the engine checkout, with your package linked
npm run sim -- --game <path to your package> --scenario <scenario.json>
```

- [ ] `entries.wasmNode` points at the copy of the Node core **inside**
      `dist/` (`./core-node/<crate>.js`) — otherwise pass `--core <path>`.
- [ ] Your own scenarios, not just the built-in one: without `--scenario` the
      runner drives a one-key smoke built from your `gameConfig` and skips
      invariants 2 and 9, which cannot be meaningful for a game it does not
      know.
- [ ] One scenario per major mechanic: movement, firing, death/respawn,
      round end, map change, a vote.
- [ ] Every invariant green — in particular `snapshotKeysUsed`,
      `fieldWidths`, `renderCoverage`, `panelContract`, `keyBindings`: these
      are the silent failures from `10-pitfalls.md`, mechanised.
- [ ] `--determinism` green once the match is stable.
- [ ] Prediction drift within threshold (implement
      `GameClientDef::predicted_state` for a component-wise report).

Fix everything the runner reports before opening a browser. Anything the
browser later catches can be recorded with `window.__vimpDebug` and replayed
here via `npm run sim:replay`.

## Step 10 — smoke test

Open two browser tabs against the local master:

- [ ] The game appears in the lobby's game selector.
- [ ] The create-server form shows every `roomForm` field with sane defaults.
- [ ] Tab 1 creates a room; tab 2 sees it in the list and joins.
- [ ] The auth screen shows your title, texts and fields; entering works.
- [ ] The map renders on every canvas; the radar (if any) matches.
- [ ] Movement is responsive in the local tab and smooth in the remote tab.
- [ ] Firing produces exactly **one** effect locally (no duplicate from the
      authoritative event).
- [ ] The panel updates: resource bar, ammo, active weapon, round timer.
- [ ] The stat table (Tab) lists both tabs with correct teams and updates
      score/deaths/latency.
- [ ] Chat works; a game system message renders with its text.
- [ ] A vote can be started, voted on and resolved.
- [ ] Sounds play in both tabs, spatially in the remote one.
- [ ] Killing ends the round; scores and the winner message are correct.
- [ ] A map change vote rotates the map and rebuilds everything.
- [ ] The master console shows no `GameCatalog: skip` warning.

## Rebuild matrix

| Change | Required commands |
| --- | --- |
| `src/config/*`, `src/data/*` (JS) | dev: nothing (HMR); prod: `npm run build` |
| `src/client/**`, `src/host/**` (JS) | dev: nothing (HMR); prod: `npm run build` |
| Maps (`src/data/maps/*`) | `npm run build:assets && npm run build:manifest` (the master reads `dist/maps/`) |
| Sounds (raw assets) | `npm run audio:process && npm run build:assets && npm run build:manifest` |
| Rust core | `npm run core:build` (+ reload; prod also `npm run build`) |
| `roomForm` / `roomDefaults` | `npm run build:manifest` |
| Anything, before the **first** master start | full `npm run core:build && npm run build` |

Two rules behind the table: the master always reads `dist/manifest.json` and
`dist/maps/` even in dev, and `npm run build` never rebuilds the WASM core.

## Definition of done

- [ ] `npx eslint .` clean.
- [ ] `npm test` green (both Vitest projects).
- [ ] `npm run core:test` green, including motion parity.
- [ ] `npm run core:build && npm run build` succeeds from a clean `dist/`.
- [ ] `npm run sim -- --game <package>` exits `0` on every scenario you
      wrote (see `13-debugging.md`).
- [ ] The smoke checklist above passes on two tabs.
- [ ] Every box in `10-pitfalls.md` is verified.
