# Local Setup

## Requirements

- **Node.js 24** (CI uses Node 24), npm;
- **mkcert** — local HTTPS certificates are required for development (the signaling WebSocket runs over `wss://`, and WebRTC requires a secure context);
- **PostgreSQL** — the central auth service needs one, and the lobby is behind a login gate, so playing locally needs it too (see [Central auth service](#central-auth-service-needed-to-reach-the-lobby));
- **Rust toolchain** (`rustup`) — only if you're changing `packages/engine/core/` itself (the engine crate has no WASM target of its own; see [core.md](core.md)). Playing a match does **not** need it here — the WASM binary comes from the game plugin's own build (its own repo).

## Install

```bash
git clone https://github.com/lgick/vimp.git
cd vimp
npm install
```

The repository uses npm workspaces: `packages/engine` (`vimp-engine`, the
engine application) and `packages/auth` (`@vimp/auth`, the central auth
service). Root scripts (`npm run dev`, `npm run build`) proxy into
`vimp-engine`.

**A game plugin package is required to actually play a match** — this repo
no longer builds one. Install/link a game (e.g. `@vimp-games/tanks`, built and
published from the separate `vimp-tanks` repository) into `node_modules`.
The engine never imports the game statically — it's loaded dynamically at
runtime via `GameManifest` (see [plugin-api.md](plugin-api.md)), enforced
by an ESLint rule.

For day-to-day development link a local checkout of the game instead of
installing it from the registry — see the next section.

## Linking a local game plugin

A registry install is not enough to develop against: the published tarball
ships only `dist/` (`files: ["dist"]`), while in dev `GameCatalog` rewrites
the manifest's `entries` to Vite `/@fs/` URLs pointing at the package's
`src/` and `core/pkg-web/*.wasm` (so plugin sources get HMR like the rest of
the engine). With a registry copy those entries point at files that don't
exist. Link both packages into each other:

```bash
cd vimp-tanks && npm link              # registers @vimp-games/tanks globally
cd vimp/packages/engine && npm link    # registers vimp-engine globally

cd vimp && npm link @vimp-games/tanks  # engine ← plugin
cd vimp-tanks && npm link vimp-engine  # plugin ← engine
```

`npm run link:games` does the same four steps for you, for one or more
games at once: it discovers game checkouts (`node_modules/@vimp-games/*`
symlinks, the global `npm link` registry, and sibling directories next to
this repo whose `package.json` name is in the `@vimp-games` scope — e.g.
`../vimp-tanks`), asks per game whether to link it, and links both
directions. Non-interactive: `npm run link:games -- --yes --game
../vimp-tanks --game ../vimp-snakes` (repeat `--game`). It is the same
`scripts/release.js --relink` used to restore links after a release run —
see [publishing.md](publishing.md).

Both directions matter:

- **engine ← plugin** — the dev `/@fs/` entries resolve into the checkout, so
  editing the plugin's client/host code needs no rebuild at all;
- **plugin ← engine** — the plugin's `vimp-engine/*` imports (e.g.
  `vimp-engine/lib/math.js`) resolve to the engine's own sources, which Vite
  rewrites to `/src/lib/math.js`. Both halves then share one module instance
  and one `ENGINE_API_VERSION`; a registry copy inside the plugin's
  `node_modules` would be a second, silently version-skewed one.

`pixi.js` needs no extra care here: Vite resolves the plugin's bare `pixi.js`
to the same optimized dependency as the engine's own
(`node_modules/.vite/deps/pixi__js.js`), so the single-instance requirement
(see [client.md](client.md)) holds in dev as well.

`npm install` in either repository replaces the symlinks with registry
copies — re-run the two `npm link <name>` commands afterwards (or `npm run
link:games`). Verify with:

```bash
readlink node_modules/@vimp-games/tanks   # in the engine → ../../../vimp-tanks
readlink node_modules/vimp-engine          # in the plugin → ../../vimp/packages/engine
```

The plugin must also be built at least once before the first start
(`npm run core:build && npm run build` in its repository): even in dev the
master reads `dist/manifest.json` and `dist/maps/*.json` and serves
`dist/sounds/**` under `/games/<id>/`.

## HTTPS certificates (one-time)

```bash
brew install mkcert nss
mkcert -install
mkdir .certs && cd .certs
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
```

Certificate paths are set in `packages/engine/src/config/master.js` (`httpsOptions`). Certificates aren't needed in production — the master runs over plain HTTP behind Nginx (see [deployment.md](deployment.md)).

## Central auth service (needed to reach the lobby)

The lobby sits behind the **LobbyAuth** login gate — there's no anonymous
entry, so a local match needs `packages/auth` running with a database, an
RS256 key pair and a GitHub OAuth App:

```bash
brew services start postgresql@16   # or any local PostgreSQL
createdb vimp_auth

mkdir -p .keys
openssl genrsa -out .keys/jwt.pem 2048
openssl rsa -in .keys/jwt.pem -pubout -out .keys/jwt.pub.pem

npm run auth:db:migrate
```

Register a GitHub OAuth App (Homepage `https://localhost:3002`, callback
`http://localhost:3010/oauth/github/callback`) and put its credentials into
`.env` at the repository root — git-ignored, and read by `npm run dev:auth`:

```
VIMP_AUTH_DATABASE_URL=postgres://localhost:5432/vimp_auth
VIMP_AUTH_STATE_SECRET=<openssl rand -hex 32>
VIMP_AUTH_GITHUB_CLIENT_ID=...
VIMP_AUTH_GITHUB_CLIENT_SECRET=...
```

Everything else the service needs has a dev default (`port: 3010`,
`allowedOrigins: ['https://localhost:3002']`) — see [auth.md](auth.md).

### Logging in without OAuth (dev only)

Outside production the service also exposes `GET /dev/login`, which mints an
identity token for any nick and redirects into the lobby with it — the same
`?token=` handoff the OAuth callback performs, so nothing on the client
differs:

```
http://localhost:3010/dev/login?nick=Player1&returnUrl=https://localhost:3002/
```

Keep one such URL bookmarked per browser profile (the identity token lives in
`localStorage`, which is per-profile) — that's the quickest way to have
several real players on one machine. Repeating a nick reuses the same user
row, so rank and state accumulate as they would for a real account.

The route is registered only when `NODE_ENV !== 'production'` (`404` in
production), and the URL is printed in the service's startup banner. It is a
shortcut, not a replacement: walk the real GitHub flow at least once before
shipping anything that touches login.

## Running

```bash
npm run dev:auth   # terminal 1 — auth service, http://localhost:3010
npm run dev        # terminal 2 — master server, https://localhost:3002
```

`npm run dev` starts the **master server** (lobby + signaling, [master.md](master.md)); ViteExpress serves the client alongside the Express server, and nodemon watches `packages/engine/src/master`, `packages/engine/src/lib`, `packages/engine/src/config`.

The startup banner must list the game:

```
-> Games loaded: tanks
```

`none` means the plugin isn't linked, isn't built, or its
`manifest.engineApi` doesn't match this build's `ENGINE_API_VERSION` —
`GameCatalog` skips such a game with a `console.warn` and the lobby ends up
with no games to pick.

Matches run through the **browser host** ([host.md](host.md)): "Create server" in the lobby spins up a Web Worker with the active game plugin's Rust core in the current tab; other tabs/machines join the room from the server list.

### The other two local runs

The lobby above is one of three ways to get a match on this machine:

| Run | Command | What you get |
| --- | --- | --- |
| lobby master | `npm run dev` | rooms, catalogs, WebRTC signaling, OAuth — production behaviour |
| dedicated server | `VIMP_DEDICATED_GAME=tanks npm run dedicated` | one match inside the Node process, `http://localhost:3002`, no lobby and no OAuth — [dedicated.md](dedicated.md) |
| standalone SDK | `npm run dev` **in the game's repository** | the whole match in one tab, no server of ours at all — [standalone.md](standalone.md) |

The last two need no auth service. Both the dedicated server and the
headless runner load the game's **node** core (`dist/core-node/`), so the
linked game checkout must be built with `npm run core:build:node`, not only
the web core.

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

## Development loop

Engine-side edits need nothing: nodemon restarts the master for
`src/master`/`src/lib`/`src/config`, Vite HMR handles the client. What a
**game plugin** edit costs depends on what you touched — the master reads the
manifest, maps and sounds from the plugin's `dist/` once at startup, hence the
restarts:

| Edited in the plugin | What to run |
| --- | --- |
| client/host JS (`src/**`) | nothing — HMR / reload the tab |
| its Rust core | `npm run core:build:web` (plus `:node` before running its tests), reload the tab |
| maps | `npm run build:assets`, restart the master |
| `roomForm`/`roomDefaults`/manifest fields | `npm run build:manifest`, restart the master |
| sounds | `npm run audio:process` (needs ffmpeg), then `npm run build:assets` |

Definition of done, in **each** repository: green `npx eslint .` and
`npm test`; core movement changes additionally require `npm run core:test`
(the cargo predictor-replica parity suite). A change to the engine's public
`exports` surface (`lib/*`, `config/*`, `host/*`) breaks plugins, whose CI
installs `vimp-engine` from the registry — such changes go out through a
version bump and a publish, not through the local link.

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
- The identity token lives in `localStorage`, so every tab of one browser profile is the **same** player (same nick). For genuinely different players use separate browser profiles/windows; to just fill a room, bots are simpler.
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
