# CLAUDE.md

## Overview

VIMP — a P2P multiplayer engine: the authoritative match runs in a Web
Worker in the room creator's tab, PixiJS clients connect over WebRTC, a
Node.js master serves lobby, signaling and catalogs. Game rules live in
runtime-loaded plugin packages (`@vimp-games/tanks`, repo `vimp-tanks`) —
this repo never imports game code by path.

## Documentation

`docs/en/` is canonical, `docs/ru/` mirrors it exactly (ToC in each
`README.md`). **Rule**: any functional change updates both matching pages in
the same change. Area → page (paths under `packages/engine/`):

| Change | Page |
| --- | --- |
| ports, frame format, opcodes | `network.md` |
| `src/config/*`, env vars | `configuration.md` |
| `src/master/` | `master.md` |
| `packages/auth/` | `auth.md` |
| `src/host/` (Worker, adapter, meta) | `host.md` |
| crate `core/` | `core.md` |
| `src/client/`, ClientCore | `client.md` |
| `src/standalone/` (browser SDK) | `standalone.md` |
| `src/dedicated/` (Node game server) | `dedicated.md` |
| plugin contract, Wasm ABI | `plugin-api.md` |
| `src/devtools/`, `bin/vimp-*.js` | `debugging.md` |
| `packages/create-vimp-game/` (scaffolder, template) | `scaffolding.md` |
| deploy scripts, workflows, npm scripts | `deployment.md`, `getting-started.md` |
| release flow, `files`, versions, plugin pin | `publishing.md` |

`docs/ai/` is an English-only plugin spec for LLMs — outside the bilingual
rule, but plugin-contract changes land there too. Gameplay/extending docs
live in the plugin's own repo; root `README.md` is a showcase, keep details
out.

## Changelogs

Two journals (English, Keep a Changelog), updated unasked in the same change
as the code: `packages/engine/CHANGELOG.md` (npm `vimp-engine`: plugin
contract, `ENGINE_API_VERSION`, `vimp-sim`/scenarios, master endpoints,
exports) and `packages/engine/core/CHANGELOG.md` (crate `vimp-engine-core`).
Unreleased work under `## [Unreleased]`, dated at release. Tests, refactors
and `docs/` are not entries.

**The sub-heading sets the release level** — the only place it is recorded,
so pick it deliberately: `### ⚠️ Breaking` (minor in `0.x`, major from `1.0`)
· `### Added` (minor) · `Changed`/`Deprecated`/`Removed`/`Fixed`/`Security`
(patch) · `### Migration` (companion of `⚠️ Breaking`, never alone). The list
is closed; `npm run release` stops on anything else. Anything that can reject
a plugin or config which loaded before is `⚠️ Breaking` + `Migration` even
with `ENGINE_API_VERSION` unchanged; a new public export is `Added`, not
`Changed`. Details: `docs/en/publishing.md` → "Changelog headings set the
version".

## Release impact

Published code: `packages/engine/core/` (crate) and the `files` paths of
`packages/engine/package.json` (npm). A change touching either **must be
flagged when reporting the work**, unasked: which artifact, which bump (read
it off the `[Unreleased]` sub-heading), whether the game repo must follow (a
crate bump or a new `ENGINE_API_VERSION` means it does), and which
pre-publish checks ran. Never edit a `version`, never publish — the developer
does both, `npm run release` drives it. Details: `docs/en/publishing.md`.

## Commands

```bash
npm run dev / npm start      # master (dev needs mkcert certs, see getting-started)
npm run build:app            # Vite bundle (engine app only)
npx eslint . && npm test     # lint + Vitest (see Testing)
npm run core:test            # cargo test --workspace
npm run sim / sim:check / sim:replay <file>   # headless match, verdict, replay
node packages/engine/bin/vimp-contract.js --game <dir>   # contract check
npm run create:game <dir> / test:scaffold    # scaffold a game, its E2E
npm run dedicated            # Node game server (needs VIMP_DEDICATED_GAME)
npm run dev:auth / start:auth / auth:db:migrate
```

A local match also needs a plugin package installed or linked into
`node_modules`.

## Architecture

Under `packages/engine/`: `src/master/` (entry point `main.js` forks on
`VIMP_DEDICATED_GAME` into `lobby.js` — rooms, catalogs, signaling, no game
logic — or `src/dedicated/` — one match of one game in the Node process) ·
`src/host/` (the match in a Worker) · `core/` (the Rust crate) ·
`src/client/` (WebRTC transport, MVC triplets) · `src/devtools/` +
`bin/vimp-sim.js` (headless runner). `packages/auth/` is a separate workspace
package with its own deploy artifact. Boundaries nothing will catch for you:
`host/meta/` stays Worker-safe (isomorphic APIs only, no Node globals),
`src/devtools/` never reaches the app bundle, plugins load only via
`GameManifest`/`GameCatalog` (ESLint enforces the last one). Layout:
`docs/en/architecture.md`.

## Conventions

- ESM; `camelCase` / `PascalCase` / `UPPER_SNAKE_CASE`; no two consecutive
  capitals in camelCase (ESLint; exceptions `VX`, `VY`, `RTT`)
- `===`, `let`/`const`, braces on every block; imports: Node built-ins → npm
  → internal → relative
- Comments explain *why*, briefly; a new module follows the closest existing
  pattern
- `_`-prefixed files are scratch, never committed — don't read or touch them
  unless told

## Testing

**Rule**: any functional change adds or updates the tests covering it in the
same change (a fix starts with a test reproducing the bug); `npx eslint .`
and `npm test` end every change green.

Vitest (+ happy-dom); tests live in `tests/`, mirroring `packages/engine/src/`
(plus `tests/auth/` for `packages/auth/src/`, its own vitest project), never
colocated. Rust: per-module units plus the
`client::predictor::parity` suite — run `npm run core:test` after any
core-movement change. Plugin tests live in the game's repo.

## Deployment

A push to `main` deploys the master, and the auth service if
`AUTH_SERVER_IP` is set (`.github/`, production, no staging). Details:
`docs/en/deployment.md`.
