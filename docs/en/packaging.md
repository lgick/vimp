# Packaging and build of a game plugin

A plugin is a normal npm package whose **only published content is `dist/`**.
The engine never sees your sources; it sees `dist/manifest.json` and the files
it points at. The shape of that manifest is in
[plugin-api.md](plugin-api.md#gamemanifest); this page is about everything that
produces it: the repository layout, `package.json`, the two Vite builds, the
Rust core build, the asset scripts and the documentation a finished plugin
ships.

## Repository layout

```
my-game/
├─ package.json
├─ vite.config.js            # three modes: serve (dev harness) | client | host
├─ vitest.config.js          # two projects: unit (node) and integration (happy-dom)
├─ eslint.config.js
├─ Cargo.toml                # workspace root for the Rust core
├─ core/                     # the Rust crate (cdylib + rlib)
│  ├─ Cargo.toml
│  ├─ src/lib.rs
│  ├─ pkg-web/               # wasm-pack --target web    (generated, gitignored)
│  └─ pkg-node/              # wasm-pack --target nodejs (generated, gitignored)
├─ src/
│  ├─ host/index.js          # default export: HostPlugin
│  ├─ client/index.js        # default export: ClientPlugin
│  ├─ config/                # game.js, client.js, auth.js, snapshot.js, sounds.js
│  ├─ data/                  # models.js, weapons.js, maps/
│  └─ client/parts|bakers/   # PixiJS render classes and texture bakers
├─ scripts/                  # build-game-manifest.js, export-maps.js, …
├─ dev/main.js, index.html   # dev harness: a standalone match against bots
├─ assets/                   # authored inputs: audio-raw/ (pre-processing)
│                            # and img/ (tile sheets, dynamic-body sprites)
├─ build/                    # intermediate (processed sounds, staged images)
│                            # — gitignored
└─ dist/                     # published output — gitignored in the repo
```

`npm create vimp-game <directory>` writes exactly this layout, filled in and
green: the scaffolder's template
(`packages/create-vimp-game/templates/default/`) is the executable form of this
page — see [scaffolding.md](scaffolding.md). Where the prose below leaves a
choice, the template shows the one that is known to build. Two finished games
to read next to it: [vimp-tanks](https://github.com/lgick/vimp-tanks) and
[vimp-snakes](https://github.com/lgick/vimp-snakes).

## `package.json`

```json
{
  "name": "@my-scope/my-game",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "files": ["dist"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "rm -rf dist && npm run build:client && npm run build:host && npm run build:assets && npm run build:manifest",
    "build:client": "vite build --mode client",
    "build:host": "vite build --mode host",
    "build:assets": "node ./scripts/export-maps.js && node ./scripts/copy-game-sounds.js && node ./scripts/copy-game-images.js",
    "build:manifest": "node ./scripts/build-game-manifest.js",
    "audio:process": "node ./scripts/process-audio.js",
    "core:build": "npm run core:build:web && npm run core:build:node",
    "core:build:web": "wasm-pack build core --release --target web --out-dir pkg-web",
    "core:build:node": "wasm-pack build core --release --target nodejs --out-dir pkg-node",
    "core:test": "cargo test --workspace",
    "check:contract": "vimp-contract --game .",
    "sim": "vimp-sim --game . --checkpoint-every 500",
    "test": "vitest run",
    "predev": "node ./scripts/copy-game-images.js && node ./scripts/copy-game-sounds.js",
    "dev": "vite"
  },
  "peerDependencies": { "pixi.js": "^8.14.0" },
  "devDependencies": {
    "vimp-engine": "<the engine version you build against>",
    "pixi.js": "^8.14.0",
    "vite": "^7.1.11",
    "vitest": "^4.1.9",
    "happy-dom": "^20.10.6",
    "eslint": "^9.37.0"
  }
}
```

Rules:

- `"type": "module"` — ESM only, everywhere.
- `pixi.js` is a **peer dependency and a dev dependency**, never a runtime
  dependency: at runtime the engine supplies the single shared PixiJS
  instance through an import map. Bundling your own copy gives the engine and
  the plugin two independent PixiJS registries; cross-instance objects
  (a baker handing a `Texture` to the engine's renderer) then fail at runtime.
- `vimp-engine` is a **dev** dependency: everything you import from it
  (`config/opcodes.js`, `lib/math.js`, …) is bundled into your `dist/`, and
  the engine that loads you is the one already running. It also brings the
  `vimp-sim` and `vimp-contract` bins — pin it to the engine
  you build against.
- `files: ["dist"]` — sources are not published. `dist/` is usually
  gitignored, and npm applies ignore rules inside directories listed in
  `files` too: check the tarball with `npm pack --dry-run` before publishing
  (every image, sound, map and the `core-node/` directory must be listed).
- The scripts `build`, `build:client`, `build:host`, `build:assets`,
  `build:manifest`, `core:build:web`, `core:build:node`, `core:test` and
  `test` must exist — contract rule `A2` checks them by name.

### What the engine package exports to a plugin

```json
"exports": {
  "./lib/*":      "./src/lib/*",
  "./config/*":   "./src/config/*",
  "./host/*":     "./src/host/*",
  "./client/*":   "./src/client/*",
  "./devtools/*": "./src/devtools/*",
  "./standalone": "./src/standalone/index.js",
  "./style.css":  "./src/client/style.css"
}
```

So a plugin may import e.g.:

```js
import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import hostDefaults from 'vimp-engine/config/hostDefaults.js';
import wsports from 'vimp-engine/config/wsports.js';
```

`src/master/**` is **not** exported: a plugin cannot import master code.
`client/*`, `devtools/*`, `standalone` and `style.css` serve the dev harness
and the standalone SDK ([standalone.md](standalone.md)); the plugin halves
themselves talk to the engine through the contract of
[plugin-api.md](plugin-api.md).

## Manifest generation

`scripts/build-game-manifest.js` runs after the bundles exist and writes
`dist/manifest.json` (field-by-field rules: [plugin-api.md](plugin-api.md#gamemanifest)).
What the generator does that the manifest page does not spell out:

- `version` is `sha256(sha256(client) ‖ sha256(host) ‖ sha256(wasm))`, first 16
  hex characters — clients compare it to detect a stale bundle;
- `maps.version` is a sha256 over the sorted `name + file bytes` pairs, 16 hex
  characters; `maps.list` is the file basenames of `dist/maps/` (spaces
  allowed);
- `engineApi` is always the imported `ENGINE_API_VERSION`, never a literal;
- numeric room fields get their `regExp` from `rangeToPattern(min, max)` and
  their own `min`/`max` numbers from the same bounds;
- every image a map names is **verified to exist in `dist/img/`** — the engine
  cannot diagnose a missing one;
- `core/pkg-node/` is copied into `dist/core-node/` (if built), dropping the
  `.gitignore` that `wasm-pack` leaves in it and keeping its `package.json`;
  `entries.wasmNode` must point there, **inside `dist/`**.

## The two Vite builds

Client and host are built by **two independent runs**, never one multi-entry
Rollup graph — a shared chunk would drag DOM code (PixiJS) into the
Worker-safe host bundle. The same `vite.config.js` also serves the dev harness
(`vite`, no `--mode`): there PixiJS is deduped instead of external and the
engine is excluded from pre-bundling, because it ships ESM sources.

```js
import { defineConfig } from 'vite';
import path from 'node:path';

const entries = {
  client: path.resolve(import.meta.dirname, 'src/client/index.js'),
  host: path.resolve(import.meta.dirname, 'src/host/index.js'),
};

export default defineConfig(({ mode }) => {
  const entry = entries[mode];

  if (!entry) {
    throw new Error(`build: unknown --mode "${mode}" (expected "client" or "host")`);
  }

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: false, // both runs write into the same dist/
      assetsInlineLimit: 0, // .wasm must stay a separate asset with a URL
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: 'strict', // keep the default export alive
        external: [/^pixi\.js(\/.*)?$/], // PixiJS stays external
        output: {
          format: 'es',
          entryFileNames: `${mode}-[hash].js`,
          assetFileNames: 'assets/[name]-[hash][extname]',
          inlineDynamicImports: true,
        },
      },
    },
  };
});
```

Why each non-obvious option is mandatory (contract rule `A4` checks them):

- **`emptyOutDir: false`** — the second run would otherwise erase the first
  run's output.
- **`assetsInlineLimit: 0`** — the `.wasm` is ~2 MB; base64-inlining costs
  +33 %, breaks `instantiateStreaming`, and duplicates the binary in both
  bundles instead of sharing one HTTP cache entry.
- **Do not use `build.lib`** — Vite's lib mode always inlines assets and
  ignores `assetsInlineLimit`.
- **`preserveEntrySignatures: 'strict'`** — without it Vite treats the entry
  module's `default` export (your `HostPlugin` / `ClientPlugin`) as unused and
  drops it.
- **`inlineDynamicImports: true`** — one file per entry; the engine imports a
  single URL.
- **`external: pixi.js`** — see the PixiJS singleton rule above.

Both runs emit the same hashed `.wasm` filename because the wasm-pack glue
module references it via `new URL('*.wasm', import.meta.url)` and Vite hashes
by content.

## Rust core build

```bash
wasm-pack build core --release --target web    --out-dir pkg-web   # runtime
wasm-pack build core --release --target nodejs --out-dir pkg-node  # Node: tests, sim
```

- `pkg-web` is what the bundles import (browser + Worker).
- `pkg-node` is what Vitest, the headless runner (`npm run sim`) and the
  [dedicated server](dedicated.md) load through `entries.wasmNode`.
- The core is **not** rebuilt by `npm run build`; build it explicitly
  (`npm run core:build`) whenever Rust changes, or you ship a stale `.wasm`.
- Rule `A5` checks `core/Cargo.toml`: `crate-type = ["cdylib", "rlib"]`,
  `rapier2d` with the `enhanced-determinism` feature, and a current pin of the
  `vimp-engine-core` crate ([core.md](core.md)).

## Asset scripts

| Script                   | Does                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export-maps.js`         | serialises `src/data/maps/*.js` into `dist/maps/<name>.json` (the file name is the map name; spaces are allowed and URL-decoded on write)                                                                                                   |
| `process-audio.js`       | ffmpeg pipeline: normalises loudness (EBU R128) and emits **both** `.webm` and `.mp3` for every sound into `build/sounds/`                                                                                                                  |
| `copy-game-sounds.js`    | wipes and copies `build/sounds/` → `dist/sounds/`                                                                                                                                                                                           |
| `copy-game-images.js`    | copies `assets/img/` → `build/img/` (dev root) and → `dist/img/` (packaged asset); images need no processing step, so there is no ffmpeg-like stage between them                                                                            |
| `build-game-manifest.js` | hashes the bundles, collects map names, **verifies every image a map names exists in `dist/img/`**, applies `rangeToPattern` to numeric room fields, copies `core/pkg-node/` → `dist/core-node/` (if built) and writes `dist/manifest.json` |

Sound files must exist as **`webm` + `mp3` pairs** — the client's codec list
is `['webm', 'mp3']` and it picks per browser support. Run the copy scripts
from `predev` as well as from `build:assets`: the standalone launch reads
images and sounds from `build/`, and a developer without ffmpeg must still see
the map. The pipelines themselves are in [maps-and-assets.md](maps-and-assets.md).

## `dist/` layout

```
dist/
├─ manifest.json
├─ client-<hash>.js
├─ host-<hash>.js
├─ assets/
│  └─ <crate>_bg-<hash>.wasm
├─ core-node/                 # optional: copy of core/pkg-node (entries.wasmNode)
│  ├─ <crate>.js              # CommonJS glue for Node — the headless runner
│  ├─ <crate>_bg.wasm
│  └─ package.json            # written by wasm-pack; without it Node reads the glue as ESM
├─ maps/
│  ├─ canopy.json
│  └─ pool mini.json
├─ img/                       # tile sheets and dynamic-body sprites
│  ├─ tiles.png               # named by spriteSheet.img / physicsDynamic[].img
│  └─ crate.png
└─ sounds/
   ├─ shot.webm
   └─ shot.mp3
```

## How the master serves it

The master reads only the built `manifest.json` and `dist/maps/*.json`, and
validates the package **structurally, without ever importing or executing
plugin code**. Where the package comes from (the auth service's game registry
and the npm registry in production, `node_modules/<package>/dist` locally and
on a self-hosted master), the routes and the versioned URL space are described
in [master.md](master.md) (REST API → `GET /games/…`);
the URL rewriting of the manifest in
[plugin-api.md](plugin-api.md#gamemanifest).

A game the master cannot read (missing `manifest.json`, `manifest.id` ≠ the
configured id) is skipped with a `console.warn`, not an exception — it is
**invisible in the lobby**, so check the master's console first when a game
does not appear. `engineApi` is not a reason: a game built against an older
engine is served as is. A game whose `requires` names a capability the engine
does not have stays in the catalog, shown in the lobby as unavailable with
the reason.

## Dev mode

In dev the master rewrites `entries` to Vite `/@fs/` source paths so the
plugin gets HMR:

```
entries.client → /@fs/<gameDir>/src/client/index.js
entries.host   → /@fs/<gameDir>/src/host/index.js
entries.wasm   → /@fs/<gameDir>/core/pkg-web/<crate>_bg.wasm
```

These paths are **hardcoded** — a plugin must use exactly `src/client/index.js`
and `src/host/index.js` as entries (rule `A3`), and must have `core/pkg-web/`
built. `maps`, `assetsBase`, `roomDefaults` and `version` still come from the
built `dist/manifest.json`, so:

> **The plugin must be fully built at least once (`npm run core:build && npm run build`) before the master is started for the first time, even in dev.**

Linking the plugin and the engine checkout to each other (`npm link` in
**both** directions) is in [getting-started.md](getting-started.md).

## Documentation the plugin must ship

The engine's docs describe the **contract**. A finished plugin must document
**itself** — the rules, numbers and decisions that are its own — because
nothing in the engine's docs can: they describe every game and therefore none.

Write it as the shipped plugins do ([vimp-tanks](https://github.com/lgick/vimp-tanks),
[vimp-snakes](https://github.com/lgick/vimp-snakes)): two mirrored trees,
`docs/en/` (canonical) and `docs/ru/` (identical structure), each with a
`README.md` table of contents and these pages:

| Page                 | Contents                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getting-started.md` | Requirements, install, the Rust toolchain, the build scripts, the fastest local match, linking against a local engine checkout, tests, the static contract check, the headless scenarios                      |
| `architecture.md`    | Repository layout, how the plugin plugs into the engine (host/client/master), where the core's boundary runs, the client-side smoothing this game uses, the decisions the code depends on, the key invariants |
| `gameplay.md`        | The rules a player experiences: the player journey, controls, scoring, chat commands, bots, kicks — and, explicitly, the engine features this game does **not** use                                           |
| `core.md`            | The Rust crate: layout, build, the ABI it fills in (commands, events, frames, state queries), the simulation model, determinism, tests                                                                        |
| `configuration.md`   | Every file under `src/config/` and `src/data/`, parameter by parameter, with the traps each one hides                                                                                                         |
| `extending.md`       | Recipes for adding content — one numbered procedure per artifact, each ending in the checks to run                                                                                                            |

Rules for that documentation:

- **Do not duplicate the engine.** Transport, the master, Worker
  infrastructure, generic core traits and the plugin contract itself belong to
  the engine's own `docs/en|ru` tree — link out to
  `https://github.com/lgick/vimp-engine/blob/main/docs/en/...` instead of
  restating them.
- **Document the decisions, not just the fields.** The value of these pages is
  in the "why": why a config key exists, what breaks silently without it, what
  the alternative was and why it was rejected. A table of defaults that the
  code already states is worth little.
- **State what is deliberately absent.** Rounds, teams, votes, weapons,
  spectators — an engine feature a game does not use is a decision, and a
  reader who cannot tell it from an oversight will "fix" it.
- **Record the rule in the plugin's `CLAUDE.md`**: any functional change
  updates the matching `docs/en/` and `docs/ru/` pages in the same change,
  with an area → page table so there is no doubt which page that is.
- **Link the docs from the plugin's `README.md`** (a short list plus a pointer
  to the other language). The README stays a landing page; the depth lives in
  `docs/`.

---

[← Previous: Plugin API](plugin-api.md) · [Next: Maps and Assets →](maps-and-assets.md)
