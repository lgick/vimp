# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

VIMP — the P2P multiplayer engine: authoritative matches run in a Web
Worker in the room creator's browser tab, clients render via PixiJS and
connect over WebRTC, a lightweight Node.js master server provides the lobby,
WebRTC signaling and game/map catalog. Game rules themselves (e.g. the tanks
game) live in separately published, dynamically loaded plugin packages —
contract in `docs/en/plugin-api.md`. The reference game, formerly `games/tanks/` in
this repo, now lives at `vimp-tanks` (separate repository); the engine loads
it only through `@vimp-games/tanks` in `node_modules` (`GameManifest`), never by
path into this repo.

## Documentation

Bilingual user docs live in `docs/en/` (canonical, ToC at
`docs/en/README.md`) and `docs/ru/` (identical structure, ToC at
`docs/ru/README.md`). **Rule**: any functional change updates the matching
`docs/en/` and `docs/ru/` pages in the same change. Area → page:

| Change | Page |
| --- | --- |
| ports, binary frame format, opcodes | `network.md` |
| `packages/engine/src/config/*`, env vars | `configuration.md` |
| master server `packages/engine/src/master/` | `master.md` |
| central auth service `packages/auth/` | `auth.md` |
| browser host `packages/engine/src/host/` (Worker, core adapter, meta, transport) | `host.md` |
| Rust engine core `packages/engine/core/` (generic traits/macros, snapshot framing, build, tests) | `core.md` |
| client modules / parts / ClientCore | `client.md` |
| plugin contract, game-package loading (`GameManifest`, `GameCatalog`, Wasm ABI) | `plugin-api.md` |
| deploy scripts, workflows, npm scripts | `deployment.md`, `getting-started.md` |

Game rules (gameplay), content-authoring (extending), and the game-specific
halves of configuration/core live in the active game plugin's own repo docs
(e.g. `vimp-tanks`'s `docs/en/`), not here — this repo only documents the
engine.

Root `README.md` is a short showcase linking into `docs/en/`; keep details
out of it.

## Commands

```bash
npm run dev              # master: lobby + signaling, https://localhost:3002
npm start                # production master (reads .env)
npm run build             # alias for build:app
npm run build:app         # Vite bundle (engine app only)
npx eslint .              # lint
npm test                  # Vitest, single run
npm run test:watch
npm run test:coverage
npm run core:test         # Rust core tests (cargo test --workspace)
npm run dev:auth          # auth service: http://localhost:3010 (nodemon)
npm run start:auth        # production auth service (reads .env)
npm run auth:db:migrate   # apply packages/auth/src/db/migrations/*.sql
```

Dev requires local HTTPS certs (`mkcert`, see `docs/en/getting-started.md`).
Playing a match locally also needs a game plugin package (e.g. `@vimp-games/tanks`)
installed/linked into `node_modules` — this repo no longer builds one; see
`vimp-tanks` and `docs/en/extending.md`.

## Architecture

- **Master** (`packages/engine/src/master/`) — Node.js entry point: room
  registry, `GET /servers`, map/worker-bundle catalogs, WebRTC signaling,
  `/ban` moderation. No game logic. Details: `docs/en/master.md`.
- **Browser host** (`packages/engine/src/host/`) — the authoritative match,
  running in a Web Worker: `host.worker.js`, `HostGame.js` facade,
  `GameCoreAdapter.js`, Worker-safe `meta/` modules (participants, rounds,
  votes, timers). Details: `docs/en/host.md`.
- **Rust core** (`packages/engine/core/`, crate `vimp-engine-core`) — rlib:
  physics via `rapier2d`, frame codec, interpolation, ABI macros, no
  wasm-bindgen (that lives in each game crate's own wasm-bindgen ABI, e.g.
  `GameCore`/`ClientCore` in `vimp-tanks`). Details: `docs/en/core.md`.
- **Client** (`packages/engine/src/client/`) — WebRTC transport, MVC
  component triplets (model/view/controller, Publisher pattern); game-specific
  rendering parts live in the game plugin package. Details: `docs/en/client.md`.
- **Game plugins** — published packages (e.g. `@vimp-games/tanks`, developed in the
  separate `vimp-tanks` repository), loaded by the engine only dynamically at
  runtime via `GameManifest`/`GameCatalog` (never imported statically); the
  boundary is enforced by ESLint `no-restricted-imports` in
  `packages/engine/**`.

## Code Conventions

- ES modules throughout (`"type": "module"`)
- `camelCase` for variables/functions, `PascalCase` for classes,
  `UPPER_SNAKE_CASE` for constants
- No two consecutive uppercase letters in camelCase (ESLint-enforced;
  exceptions: `VX`, `VY`, `RTT`)
- `===` required, `let`/`const` only, curly braces required for all blocks
- Import order on edit: Node built-ins → npm packages → internal modules →
  relative paths
- Files/dirs prefixed with `_` are experimental scratch work, not committed
  to git — don't read, edit, or suggest changes to them unless the developer
  explicitly says otherwise
- `packages/engine/src/host/meta/` must stay Worker-safe: isomorphic APIs
  only (`Date`/`Math`/`performance`/`setTimeout`/`queueMicrotask`), no Node
  globals
- Comments explain *why*, not *what*; keep them short
- When adding a new entity/module with no existing template, follow the
  codebase's established style

## Testing

Vitest (+ happy-dom for client, `@vitest/coverage-v8`). Every change ends
with a green `npx eslint .` and `npm test`. Tests live under `tests/`,
mirroring `packages/engine/src/` (not colocated with source). Rust-side:
unit tests per module plus a cargo motion-parity suite
(`client::predictor::parity`) — run `npm run core:test` after any change to
core movement. Game-plugin tests (host-plugin behavior, JS↔WASM harness)
live in the game's own repository (e.g. `vimp-tanks`).

## Local Development

- Local multiplayer: open several browser tabs — one creates a room
  ("Create server" in the lobby), the rest join from the list
- Requires a game plugin package installed/linked (see Commands above) —
  its own build step (WASM core, assets, manifest) happens in that
  package's repository, not here
- No debug mode exists; implement one separately if needed

## Deployment

CI/CD is in `.github/`; only the master server is deployed. Production only,
no staging. `Dockerfile` installs the game plugin (`@vimp-games/tanks`) as a
regular npm dependency (`npm ci`) instead of building its WASM core here;
`GameCatalog` rejects a plugin manifest whose `engineApi` doesn't match this
engine build's `ENGINE_API_VERSION`. Details: `docs/en/deployment.md`.
