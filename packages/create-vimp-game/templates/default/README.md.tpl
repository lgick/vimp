# {{GAME_TITLE}}

A VIMP game plugin (`{{PACKAGE_NAME}}`), scaffolded with `npm create vimp-game`.

## Run it

```bash
npm install
npm run core:build   # REQUIRED before npm run dev
npm run dev
```

`npm run core:build` is not optional and not a later step: the dev harness
(`dev/main.js`) imports the wasm out of `core/pkg-web/`, so until the Rust core
has been built once Vite fails to resolve the import and `npm run dev` dies on
startup. The same holds before the master is started against this package,
even in dev mode — build the core and then `npm run build` at least once.

## Commands

```bash
npm run core:build      # wasm-pack -> core/pkg-web (runtime) + core/pkg-node (tests)
npm run core:test       # cargo test --workspace
npm run build           # dist/: both bundles, maps, sounds, manifest.json
npm run check:contract  # static engine<->game contract check (vimp-contract)
npm test                # vitest
npm run sim             # headless match on the real core
npm run dev             # a match against bots in the tab
npm run audio:process   # ffmpeg: assets/audio-raw/ -> build/sounds/ (optional)
```

## Layout

| Path | What |
| --- | --- |
| `core/` | the Rust crate `{{CRATE_NAME}}` — physics, damage, movement |
| `src/host/` | HostPlugin: runs in a Web Worker, no DOM and no PixiJS |
| `src/client/` | ClientPlugin: render parts and bakers, main thread |
| `src/config/` | game, client, auth, snapshot and sound configuration |
| `src/data/` | maps and balance data |
| `scripts/` | build steps: bundles -> `dist/` + `manifest.json` |
| `dev/` | the standalone dev harness — never published |

Only `dist/` is published (`files: ["dist"]`).

## Sounds without ffmpeg

The real pipeline is `assets/audio-raw/*.wav` → `npm run audio:process` →
`build/sounds/*.{webm,mp3}`. That needs ffmpeg, so the template also ships
ready-made placeholders in `assets/sounds/`: when `build/sounds/` is absent,
`scripts/copy-game-sounds.js` falls back to them and the first build stays
green on a bare machine. Process your own audio and the fallback stops being
used.

## Engine

- `vimp-engine` `{{ENGINE_VERSION}}`
- `vimp-engine-core` `{{CORE_VERSION}}`

Game id: `{{GAME_ID}}`. The plugin contract lives in the engine repository
under `docs/ai/`.
