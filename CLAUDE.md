# CLAUDE.md

Guidance for Claude Code when working in this repository.

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
| client modules / parts / ClientCore | `client.md` |
| plugin contract, `GameManifest`/`GameCatalog`, Wasm ABI | `plugin-api.md` |
| `src/devtools/`, `bin/vimp-sim.js`, scenarios, invariants | `debugging.md` |
| deploy scripts, workflows, npm scripts | `deployment.md`, `getting-started.md` |
| release flow, package `files`/versions, plugin pin | `publishing.md` |

`docs/ai/` is an English-only plugin spec for LLMs — outside the bilingual
rule, but plugin-contract changes land there too. Gameplay/extending docs
live in the plugin's own repo; root `README.md` is a showcase, keep details
out.

## Changelogs

Two journals (English, Keep a Changelog), updated unasked in the same change
as the code: `packages/engine/CHANGELOG.md` (npm `vimp-engine`: plugin
contract, `ENGINE_API_VERSION`, `vimp-sim`/scenarios, master endpoints,
exports) and `packages/engine/core/CHANGELOG.md` (crate `vimp-engine-core`).
Unreleased work under `## [Unreleased]`, dated at release. Anything that can
reject a plugin or config which loaded before needs `### ⚠️ Breaking` +
`### Migration`, even with `ENGINE_API_VERSION` unchanged. Tests, refactors
and `docs/` are not entries.

## Release impact

Published code: `packages/engine/core/` (crate) and the `files` paths of
`packages/engine/package.json` (npm). A change touching either **must be
flagged when reporting the work**, unasked — which artifact, which bump
(patch/minor/major; `0.x` breaking = minor), whether the game repo must
follow (crate bump → `vimp-tanks/core/Cargo.toml`; `ENGINE_API_VERSION` →
plugin rebuild + republish), and which pre-publish checks are needed vs.
actually run. Never edit a `version`, never publish — the developer does
both. Procedure: `docs/en/publishing.md`.

## Commands

```bash
npm run dev / npm start      # master (dev needs mkcert certs, see getting-started)
npm run build:app            # Vite bundle (engine app only)
npx eslint . && npm test     # lint + Vitest (see Testing)
npm run core:test            # cargo test --workspace
npm run sim / sim:check / sim:replay <file>   # headless match, verdict, replay
npm run dev:auth / start:auth / auth:db:migrate
```

A local match also needs a plugin package installed or linked into
`node_modules`.

## Architecture

Under `packages/engine/`: `src/master/` (rooms, catalogs, signaling — no game
logic) · `src/host/` (the match in a Worker: `HostGame`, `GameCoreAdapter`,
`meta/` — the latter must stay Worker-safe: isomorphic APIs only, no Node
globals) · `core/` (crate: `rapier2d`, frame codec, interpolation, ABI
macros, no wasm-bindgen) · `src/client/` (WebRTC transport, MVC triplets,
Publisher) · `src/devtools/` + `bin/vimp-sim.js` (headless runner,
Node-only, never in the app bundle). `packages/auth/` is a separate
workspace package: the central auth service (Postgres, JWKS), its own
deploy artifact. Plugins load only via `GameManifest`/`GameCatalog`; ESLint
`no-restricted-imports` enforces the boundary.

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
`AUTH_SERVER_IP` is set (`.github/`, production, no staging). `Dockerfile`
installs the plugin from npm instead of building its WASM core here;
`GameCatalog` rejects a manifest whose `engineApi` differs from this
build's. Details: `docs/en/deployment.md`.
