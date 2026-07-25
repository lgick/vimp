# Local Setup

## Requirements

- **Node.js 22** (CI uses Node 22), npm;
- **mkcert** — local HTTPS certificates are required for development (the signaling WebSocket runs over `wss://`, and WebRTC requires a secure context);
- **Rust toolchain** (`rustup`) — only if you're changing `packages/engine/core/` itself (the engine crate has no WASM target of its own; see [core.md](core.md)). Playing a match does **not** need it here — the WASM binary comes from the game plugin's own build (its own repo).

## Install

```bash
git clone https://github.com/lgick/vimp.git
cd vimp
npm install
```

The repository uses npm workspaces: `packages/engine` (`@vimp/engine`, the
engine application) and `packages/auth` (`@vimp/auth`, the central auth
service). Root scripts (`npm run dev`, `npm run build`) proxy into
`@vimp/engine`.

**A game plugin package is required to actually play a match** — this repo
no longer builds one. Install/link a game (e.g. `@vimp/tanks`, built and
published from the separate `vimp-tanks` repository) into `node_modules`;
see that repository's own getting-started docs for building it locally
(`npm link` or a local `file:`/`path:` dependency works for development).
The engine never imports the game statically — it's loaded dynamically at
runtime via `GameManifest` (see [plugin-api.md](plugin-api.md)), enforced
by an ESLint rule.

## HTTPS certificates (one-time)

```bash
brew install mkcert nss
mkcert -install
mkdir .certs && cd .certs
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
```

Certificate paths are set in `packages/engine/src/config/master.js` (`httpsOptions`). Certificates aren't needed in production — the master runs over plain HTTP behind Nginx (see [deployment.md](deployment.md)).

## Running

```bash
npm run dev
```

This starts the **master server** at `https://localhost:3002` (lobby + signaling, [master.md](master.md)); ViteExpress serves the client alongside the Express server, and nodemon watches `packages/engine/src/master`, `packages/engine/src/lib`, `packages/engine/src/config`.

Matches run through the **browser host** ([host.md](host.md)): "Create server" in the lobby spins up a Web Worker with the active game plugin's Rust core in the current tab; other tabs/machines join the room from the server list. This requires a game plugin to be installed/linked (see Install above).

Other commands:

```bash
npm start              # production run of the master (reads .env: VIMP_DOMAIN, etc.)
npm run build           # production build (engine Vite bundle; the game plugin ships its own dist/)
npm run build:app       # same as npm run build today (alias)
npm run core:test       # engine crate's Rust tests (cargo test --workspace, packages/engine/core only)
npx eslint .             # linter
npm test                 # tests (Vitest), single run
npm run test:watch       # tests in watch mode
npm run test:coverage    # coverage
```

Production `.env` variables are described in [configuration.md](configuration.md#environment-variables-env).

## Rust toolchain (packages/engine/core/)

Needed only when changing the engine's generic Rust crate itself
(`vimp-engine-core`, no WASM target — see [core.md](core.md)):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # rustc + cargo
npm run core:test             # Rust tests
```

Building and testing a game's own WASM core (`wasm-pack`, `wasm32-unknown-unknown`
target) is that game repository's concern — see its own getting-started
docs.

## Local multiplayer

- Open several browser tabs — each becomes a separate player: one creates the server, the rest join from the lobby.
- Bots and other in-match commands depend on the active game plugin (e.g. `/bot 5` for tanks — see that game's own gameplay docs).
- There's no debug mode; implement one separately if needed.

## Tests

Stack: **Vitest** + happy-dom (client tests) + coverage-v8. `vitest.config.js` splits the run into three projects:

- `engine-node` — `tests/master`, `tests/lib`, `tests/config`, `tests/host`, `packages/engine/tests/fixtures` (node environment);
- `engine-client` — `tests/client` (happy-dom environment);
- `auth` — `tests/auth` (the central auth service, `packages/auth/src`).

Tests live in `tests/` and mirror the `packages/engine/src/` layout.
Host-facade integration is exercised against a **fake-core fixture**
(`packages/engine/tests/fixtures/miniGame/` — a self-contained second
HostPlugin/ClientPlugin, no WASM) that proves the engine and its meta
modules (Panel/Stat/RoundManager/CommandProcessor/…) work with any game,
not just a specific one — so `npm test` here passes with zero Rust
artifacts built, and with no game plugin installed at all. Project rule:
**any code change must end with a green `npx eslint .` and `npm test`**.
A game repository (e.g. `vimp-tanks`) runs its own tests against the real
WASM core — see its own docs.

CI (`.github/workflows/test.yml`) runs jobs for linting, the engine crate's
Rust tests, and the Vitest projects above — no WASM build is needed to
test this repository.

---

[Next: Architecture →](architecture.md)
