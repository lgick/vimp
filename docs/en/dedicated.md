# Dedicated Server (Node.js)

A dedicated server is a single Node.js process that holds one authoritative
match of one game 24/7. The simulation runs **in the process itself** (no
Worker, no host tab), browsers connect straight to it over WebSocket, and
there is no lobby, no OAuth and no WebRTC anywhere in the picture.

It is the third contour of the engine, next to the P2P lobby
([master.md](master.md)) and the browser SDK
([standalone.md](standalone.md)).

```
  browser tab                      Node.js process
  ┌──────────────────┐             ┌──────────────────────────────────┐
  │ engine client    │  WebSocket  │ WebSocketServer  (path /game)    │
  │ (mode=dedicated) │ ──────────► │   └─ PortMachine (handshake)     │
  │                  │  ws://…/game│        └─ HostGame + game core   │
  └──────────────────┘             │ express: /config, /games/*, SPA  │
                                   └──────────────────────────────────┘
```

Code: `packages/engine/src/dedicated/main.js`.

## Entry point

`packages/engine/src/master/main.js` is a dispatcher:

```js
if (process.env.VIMP_DEDICATED_GAME) {
  await import('../dedicated/main.js');   // dedicated server
} else {
  await import('./lobby.js');             // lobby master
}
```

Both roles therefore share `CMD ["node", "src/master/main.js"]`, `npm start`,
`npm run dev` and the nodemon watch lists — the role is chosen by the
environment alone.

## Running

```bash
VIMP_DEDICATED_GAME=tanks npm run dedicated  # development (HTTP, nodemon)
VIMP_DEDICATED_GAME=tanks npm start          # production (HTTP behind Nginx)
```

`npm run dedicated` is `npm run dev` plus `src/host` in the nodemon watch
list — here the host runs in this very process, so a change to it must
restart the server.

On a VPS the box is set up by its own wizard,
`.github/deployment/add-dedicated.sh` — it asks for the game, the room
settings and an **optional** auth-service URL, and writes the `.env.prod`
and `docker-compose.yml` this server needs; see
[deployment.md](deployment.md#step-3b-adding-a-dedicated-server).

### Resolving the game

`VIMP_DEDICATED_GAME` names the game either by its **registry id** (`tanks`)
or by its **npm package name** (`@vimp-games/tanks`), with an optional
`@<version>` pin on either form — an exact version is a pin, without one the
server takes the version npm (or, for an id, the registry) serves. Both forms exist because the
deploy fills this in from `SERVERS_MATRIX`, where the package name is often
the only name known before the registry has answered; the scope's leading `@`
is never mistaken for a pin. The resolution order is:

1. **`master:games`** — by id first, then by package name. Outside production
   that array is filled in from `node_modules`, so a linked game (an ordinary
   dependency or `npm link`) resolves here. This is the development path and
   the one that keeps HMR of the game itself working.
2. **A package name in `node_modules`** — the id is read from the package's
   own `dist/manifest.json`. This is the path of a production box that has
   the game installed but no registry, and it works for any package name,
   scoped or not (`@acme/arena`, `vimp-tanks`).
3. **A scoped package name** (`@vimp-games/tanks`) — downloaded straight from
   the npm registry into the server's own store (`VIMP_GAMES_DIR`,
   `GameStore`), validated structurally without executing its code, exactly
   as a lobby master does; the id is read from the downloaded
   `dist/manifest.json`. **The platform registry is not asked at all**, so
   `VIMP_AUTH_SERVICE_URL` is not needed and the game's catalog status is
   irrelevant: approval is admission to the platform catalog — the right to
   be served to every player by the lobby masters — not a permission to run
   a public npm package on your own box. **A production dedicated box needs
   the store volume mounted**, see
   [deployment.md](deployment.md#dedicated-game-box-dedicatedgame).
4. **A game id** (`tanks`), with `VIMP_AUTH_SERVICE_URL` set — an id alone
   does not say which package to download, and only the registry knows: the
   server asks it (`GET /games`) for the row matching that id **or** package
   name and then downloads exactly as in step 3. This is the one path that
   does need the registry, and hence a game listed in its catalog.
5. **None of them** — the process exits with a named error. Named by id with
   no registry (or with no such row in it), it points at the way out:

   ```
   dedicated: game "<ref>" is not resolved — name the game by its npm
   package (@scope/name) and no registry is needed, or set
   VIMP_AUTH_SERVICE_URL and get the game approved in the catalog
   ```

The scope is what separates step 3 from step 4: a bare `tanks` is
indistinguishable in shape from an unscoped package of the same name, and
taking it for one would download a stranger's package from npm.

Steps 1 and 2 serve whatever is installed, so **a pin they cannot satisfy
sends the game on to the download path** rather than quietly serving another
build: if the ref carries `@<version>` and the installed package's
`package.json` says something else, the local match is dropped. With no way
left to fetch the pinned version — the game named by id and no registry —
the process exits naming the version it found.

Whichever form named the game, the **id** is what reaches the catalog and the
serving URLs (`/games/<id>/<version>/…`): it comes from the resolved package
or registry row, never from the string in the variable.

Whichever path supplied it, the package must be **built** with its node core:
the process imports the host plugin as a normal ES module and loads
`entries.wasmNode` (`core/pkg-node`, `npm run core:build:node` in the game
repository). Without it the server refuses to start with a named error
instead of a raw resolver failure.

The **client half is never imported in Node**: the server only ever reads
`hostPlugin`, and the browser gets the client build as static files (where
`pixi.js` is resolved by the import map). That is what lets a game fetched
from the registry live outside the engine's `node_modules` at all — its
client build leaves `pixi.js` external by contract rule A1, and Node could
not resolve it from `${VIMP_GAMES_DIR}`. The host half and `entries.wasmNode`
are held to the opposite standard: they are loaded in Node and must be
self-contained, and an unresolvable import there is reported as a named
error naming the entry and the missing package.

| Variable | Meaning |
| --- | --- |
| `VIMP_DEDICATED_GAME` | the game: a game id (`tanks`) or an npm package name (`@vimp-games/tanks`), either with a `@<version>` pin; also the switch that selects this role |
| `VIMP_MASTER_PORT` | HTTP + WebSocket port (default `3002`) |
| `VIMP_DOMAIN` | production domain — used for `Origin` validation |
| `VIMP_AUTH_SERVICE_URL` | the central auth service — only needed to resolve a game named by **id**; a game named by package name is fetched from npm without it |
| `VIMP_GAMES_DIR` | root of the downloaded-package store (a mounted volume in production) |
| `VIMP_DEDICATED_ROOM` | JSON room overrides: `map`, `maxPlayers`, `roundTime`, `mapTime`, `friendlyFire`, `seed` |

Unlike the lobby master, the dedicated server reads these **in development
too** (`packages/engine/src/config/env.js`): the game, the port and the room
settings have no other source. Malformed `VIMP_DEDICATED_ROOM` is a named
startup failure, not a silent default.

In production `VIMP_DEDICATED_ROOM` is filled from the `settings` field of
`SERVERS_MATRIX` — the deploy regenerates `.env.prod` in full, see
[deployment.md](deployment.md#dedicated-game-box-dedicatedgame).

Everything else comes from `packages/engine/src/config/master.js` — see
[configuration.md](configuration.md#packagesenginesrcconfigmasterjs).

## HTTP

Security headers are the same middleware the master uses
(`packages/engine/src/master/httpSecurity.js`).

### GET /config

```json
{ "mode": "dedicated", "gameId": "tanks", "gameVersion": "0.6.0", "wsPath": "/game" }
```

The engine client probes this endpoint on startup and switches to the
direct-WebSocket boot path; the lobby master answers `{ "mode": "lobby" }` at
the same URL — see [client.md](client.md#boot-modes-bootjs).

### Game catalog

The same URLs the master serves, but always for exactly one game:

- `GET /games/manifest.json` → an array with the single manifest;
- `GET /games/:id/manifest.json`;
- `GET /games/:id/maps/manifest.json`, `GET /games/:id/maps/:name`;
- `/games/:id/*` → static files from the package's `dist/`.

A game fetched from the registry is additionally served under its versioned
addresses — `/games/:id/:version/manifest.json`, `…/maps/*` and `…/*` — the
same space the lobby master uses, because those are exactly the URLs the
rebased manifest points at (see
[master.md](master.md#versioned-url-space)). On the `node_modules` path there
is no version segment and only the unversioned aliases exist.

The client half of the game and its `.wasm` are loaded by the browser from
those URLs exactly as in the lobby contour, so `GameCatalog` is reused
verbatim (including the dev variant of the manifest that points at Vite
`/@fs/` sources). The engine client itself is served by ViteExpress: from
source in development, from `packages/engine/dist` in production.

## Game WebSocket

`ws://<host>:<port>/game` (`wss://` behind Nginx). The frame format is the
same as everywhere else in the engine — `JSON.stringify([port, data])` for
protocol frames and a binary snapshot frame for the world state (see
[network.md](network.md)), so the client cannot tell the transports apart.

- each connection gets a `crypto.randomUUID()` socket id and its own
  `PortMachine` state (the handshake automaton is shared with the Worker host
  and the standalone SDK — [host.md](host.md));
- `Origin` is validated as in the signaling server; a connection with no
  `Origin` header is terminated;
- the player limit is enforced by the port machine itself (`roomFull`, close
  code `4006`);
- backpressure: when `bufferedAmount` exceeds 256 KB, unreliable frames
  (positional snapshots) are dropped for that client — reliable frames are
  never dropped. WebSocket has no meta/state split, so PING/PONG travels the
  reliable path and RTT effectively measures the TCP path;
- a disconnect removes the participant, and nothing else: the match keeps
  running with no players in the room.

Because the process is public, long-lived and has neither a lobby gate nor
OAuth in front of it, the adapter (not the isomorphic `PortMachine`) enforces
four limits:

| Limit | Value | Why |
| --- | --- | --- |
| `maxPayload` | 64 KB | a legitimate client frame is a chat line, keys or a vote — kilobytes; the `ws` default is 100 MiB, i.e. memory on request |
| message rate | 300 frames/s per socket | a client peaks at ~60 frames/s (keys + pong); frames over the limit are dropped silently |
| connection rate | 30 per minute per address | every connection costs a `CONFIG_DATA` payload *before* any authentication, so without a cap the socket is an amplifier. Rejected with close code 4009 |
| handshake timeout | 120 s | a connection that never became a participant takes no room slot but holds a socket — a trivial slowloris. Closed with code 4008 |

The connection rate keys on the client address from `clientIp()`
(`src/lib/clientIp.js`, shared with the master): the socket address, or
`X-Real-IP` in production, where the deploy's Nginx overwrites that header with
`$remote_addr`. `X-Forwarded-For` is deliberately not used — Nginx sets it with
`$proxy_add_x_forwarded_for`, which *appends* the real address to whatever the
client sent, so its first hop is client-controlled: keying on it would let one
header per connection lift the limit entirely, and let an attacker fill a
chosen player's bucket to keep them out. A connection whose address cannot be
determined at all (an already-broken socket) is terminated rather than sharing
one bucket with every other such connection.

The handshake timeout is deliberately generous: a participant appears only
after `AUTH_RESPONSE`, so the window covers the client's WebGL init and asset
baking (`CONFIG_READY` is sent after them) **plus the player typing a
nickname**.

Every refusal closes the socket with a code the client understands
(`client/network/policyClose.js`; the full list of codes is the table in
[network.md](network.md#connection-lifecycle)). On all four policy codes —
`invalidOrigin`, `roomFull` (sent by the port machine), `handshakeTimeout` and
`tooManyConnections` — the client **stays put** instead of reloading after 3 s the way it does on an ordinary
disconnect: reloading would spend another connection against the same limit,
restart the same handshake timer, leave the page's origin exactly as it was,
or fail to free a room slot. An abandoned tab would reload forever, and a
player waiting for a slot would spend 30 reloads walking into the connection
limit — and see its message instead of their own reason. The reason text comes
from `POLICY_CLOSE_INFORMS`, which holds a fallback for each of the four
codes: the client writes one only when the server sent no reason of its own.
The port machine, for instance, delivers `roomFull` itself with a
`TECH_INFORM` frame right before the close, and that text always wins — the
4006 entry is there for the case where the frame never arrives.

## Identity and profiles

Guest entry only: the nick is a form field validated by the engine's own
`isValidName` (`createGuestIdentity`, `packages/engine/src/host/identity.js`),
and profile requests answer with offline defaults
(`packages/engine/src/lib/offlinePlayerData.js`). There is no central auth
service in this contour, therefore **guest nicks are neither unique nor
verified**, and `rank`/`state` are not persisted. A central JWT for dedicated
servers is a possible follow-up, not part of this contour today.

## Shutdown

`SIGTERM`/`SIGINT` close the client connections, then `host.destroy()` (stops
the timers and flushes profiles), then the HTTP server, then the process
exits.

## Differences from the P2P host and limitations

- **One room per process.** The engine's meta modules (`TimerManager`,
  `Panel`, `Stat`, `Vote`, `Chat`) are module singletons — several rooms mean
  several processes/containers.
- **No Worker handoff.** A browser host swaps its Worker on a round boundary
  and keeps the match alive; deploying a dedicated server is a process
  restart, and the match is lost.
- **No bots on startup.** Scripted participants are a *game* concept spawned
  by a player's chat command (`/bot 4` in tanks), not something the engine
  starts on its own.
- **An empty room keeps ticking.** `RoundManager.createMap()` starts the game
  timers from the `HostGame` constructor, so the simulation runs at the
  configured tick rate (120 Hz by default) even with nobody connected —
  around the clock. Measured on the `miniGame` fixture with an empty room:
  ~3% of one core; a real Wasm core costs more, in proportion to an empty
  world. Pausing on an empty room (`stopGameTimers()` when the last socket
  leaves, `resumeGameTimers(mapTimeLeft)` plus `initiateNewRound()` on the
  first entry) is a follow-up: round/map timer semantics need their own pass.
- **No server rating and no `GET /servers`.** A dedicated server does not
  register in the lobby catalog and is not discoverable through it — players
  reach it by its URL.

## Tests

`tests/dedicated/dedicatedServer.test.js` (project `engine-node`) starts the
real server on a free port over the `miniGame` fixture, walks a real `ws`
client through the whole handshake up to a binary snapshot frame, checks
`GET /config` and the catalog routes, and proves that a client disconnect
does not stop the simulation (a second client joins and receives frames).
