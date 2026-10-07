# CLAUDE.md

## Overview

VIMP — a P2P multiplayer engine: the authoritative match runs in a Web Worker
in the room creator's tab, PixiJS clients connect over WebRTC, a Node.js
master serves lobby, signaling and catalogs. Game rules live in runtime-loaded
plugins (`@vimp-games/tanks`, repo `vimp-tanks`); never import game code by path.

## Documentation

`docs/en/` is canonical, `docs/ru/` mirrors it 1:1: any functional change
updates both matching pages in the same change. Area → page (under
`packages/engine/`): `src/config/*`, env → configuration · `src/master/` →
master · `packages/auth/` → auth · `src/host/` → host · `core/` → core ·
`src/client/` → client · `src/standalone/` → standalone · `src/dedicated/` →
dedicated · ports, frames, opcodes → network · plugin contract, Wasm ABI →
plugin-api · `src/devtools/`, `bin/vimp-*.js` → debugging · contract rules,
silent contracts → pitfalls · `packages/create-vimp-game/` → scaffolding ·
layout, build, `dist/` → packaging · maps, images, sound → maps-and-assets ·
deploy, workflows, npm scripts → deployment, getting-started · release,
`files`, versions → publishing. Full table: `docs/en/README.md`. `docs/ai/` is
an English-only LLM meta-layer; gameplay docs live in the plugin's repo.

## Changelogs and releases

Three English Keep a Changelog journals, updated unasked with the code:
`packages/engine/CHANGELOG.md`, `packages/engine/core/CHANGELOG.md`,
`packages/create-vimp-game/CHANGELOG.md`. Work goes under `## [Unreleased]`; a
released section is history (a refinement is a new entry). Tests, refactors
and `docs/` are not entries. The sub-heading sets the release level:
`### ⚠️ Breaking` + `### Migration` (minor in `0.x`) · `Added` (minor) ·
`Changed`/`Deprecated`/`Removed`/`Fixed`/`Security` (patch); the list is
closed. Anything that can reject a plugin or config which loaded before is
Breaking (`docs/en/publishing.md`).

**`ENGINE_API_VERSION` is frozen at 4, never bumped.** A new capability goes
into `src/lib/capabilities.js`; a game that needs it names it in
`GameManifest.requires`. Breaking in the plugin contract only for a security
fix, and then the same commit deletes the line from `contract/surface.json`
(any deletion from it: stop and discuss).

Published code: crate `core/` and the `files` of `packages/engine` and
`packages/create-vimp-game`. A change touching it must be flagged in the
report, unasked: artifact, bump (from the `[Unreleased]` sub-heading), whether
the game repo must follow, pre-publish checks run. Never edit a `version`,
never publish — the developer runs `npm run release`.

## Commands

```bash
npm run dev / npm start      # master (dev needs mkcert certs)
npx prettier --write <file>  # format modified files
npx eslint . && npm test     # lint + Vitest
npm run core:test            # cargo test --workspace
npm run sim                  # headless match
node packages/engine/bin/vimp-contract.js --game <dir>   # contract check
npm run create:game <dir> / test:scaffold                # scaffold, its E2E
```

A local match needs a plugin package linked into `node_modules`.

## Architecture

Layout: `docs/en/architecture.md`. Not caught by tooling: `host/meta/` stays
Worker-safe (no Node globals), `src/devtools/` never reaches the app bundle,
plugins load only via `GameManifest`/`GameCatalog`.

## Conventions

- ESM; `camelCase` / `PascalCase` / `UPPER_SNAKE_CASE`; no two consecutive
  capitals in camelCase (exceptions `VX`, `VY`, `RTT`)
- `===`, `let`/`const`, braces on every block; imports: Node built-ins → npm
  → internal → relative
- Comments explain _why_, briefly; a new module follows the closest pattern
- `_`-prefixed files are scratch, never committed — don't read or touch them

## Testing

Any functional change adds or updates tests in `tests/` (mirrors
`packages/engine/src/`, `tests/auth/` for auth; never colocated); a fix starts
with a test reproducing the bug. Prettier, `npx eslint .` and `npm test` end
every change green; run `npm run core:test` after core-movement changes.

## Deployment

A push to `main` deploys to production (no staging): `docs/en/deployment.md`.
