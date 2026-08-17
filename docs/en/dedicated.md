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

The game package must be installed (or `npm link`-ed) and **built**, its node
core included: the process imports the host plugin as a normal ES module and
loads `entries.wasmNode` (`core/pkg-node`, `npm run core:build:node` in the
game repository). Without it the server refuses to start with a named error
instead of a raw resolver failure.

| Variable | Meaning |
| --- | --- |
| `VIMP_DEDICATED_GAME` | game id from `master:games`; also the switch that selects this role |
| `VIMP_MASTER_PORT` | HTTP + WebSocket port (default `3002`) |
| `VIMP_DOMAIN` | production domain — used for `Origin` validation |
| `GAMES_MATRIX` | JSON `[{id, package, version}]`, the game catalog (same format as the master's) |
| `VIMP_DEDICATED_ROOM` | JSON room overrides: `map`, `maxPlayers`, `roundTime`, `mapTime`, `friendlyFire`, `seed` |

Unlike the lobby master, the dedicated server reads these **in development
too** (`packages/engine/src/config/env.js`): the game, the port and the room
settings have no other source. Malformed `VIMP_DEDICATED_ROOM` is a named
startup failure, not a silent default.

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

The connection rate keys on the client address, read the same way as in the
master's signaling server: the first hop of `X-Forwarded-For` behind Nginx
(which the deploy config sets), the socket address otherwise. The header is
client-controlled on a direct connection — the same trade-off the master and
the auth service already make.

The handshake timeout is deliberately generous: a participant appears only
after `AUTH_RESPONSE`, so the window covers the client's WebGL init and asset
baking (`CONFIG_READY` is sent after them) **plus the player typing a
nickname**, and the engine client reloads the page after a disconnect — a tight
timeout would put a slow player in a reload loop. The player sees the generic
"connection closed" message, not the reason.

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
