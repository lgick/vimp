# Master Server (P2P lobby and signaling)

The master server (`packages/engine/src/master/`) is the central hub of the P2P architecture:
it holds the registry of active rooms (browser hosts), serves their list over
REST, and routes WebRTC coordination (SDP offers/answers, ICE candidates)
between clients and hosts. **It carries no game logic** — only connection
coordination.

`packages/engine/src/master/main.js` is the **project's entry point** (the legacy
authoritative game server has been fully removed). It is a dispatcher: with
`VIMP_DEDICATED_GAME` set it hands over to `src/dedicated/main.js` (a
single-game [dedicated server](dedicated.md)), otherwise to
`src/master/lobby.js` — the lobby master this page describes. The fork lives
in the entry point so that `CMD ["node", "src/master/main.js"]`, `npm start`,
`npm run dev` and the nodemon watch lists stay valid for both roles.
Filesystem paths (`node_modules/`, `dist/assets`) are anchored to the module's
location via `import.meta.url`, so the master can be started from any working
directory.

## Running

```bash
npm run dev       # dev: https://localhost:3002 (nodemon + ViteExpress)
npm start         # production: plain HTTP behind Nginx, reads .env
```

- dev: HTTPS with local certificates from `.certs/`, client static assets served by ViteExpress. Port `3002` (`3001` — Vite HMR).
- production: plain HTTP behind Nginx; `VIMP_DOMAIN` is required, the port comes from `VIMP_MASTER_PORT`.

Configuration — [packages/engine/src/config/master.js](../../packages/engine/src/config/master.js), described in [configuration.md](configuration.md#packagesenginesrcconfigmasterjs).

## Modules

| Module | Responsibility |
| --- | --- |
| `packages/engine/src/master/main.js` | entry point: the fork between the lobby master and the [dedicated server](dedicated.md) (`VIMP_DEDICATED_GAME`) |
| `packages/engine/src/master/lobby.js` | the lobby master itself: Express + REST, HTTPS/HTTP server, signaling `WebSocketServer`, periodic cleanup of stale rooms |
| `packages/engine/src/master/httpSecurity.js` | baseline security headers (`nosniff`, `Referrer-Policy`, `X-Frame-Options`, CSP in production), shared with the dedicated server |
| `packages/engine/src/config/env.js` | environment overrides of the server config (`VIMP_DOMAIN`, `VIMP_MASTER_PORT`, `VIMP_AUTH_SERVICE_URL`, `GAMES_MATRIX`) plus `VIMP_DEDICATED_ROOM` parsing; applied by the lobby and the dedicated server alike |
| `packages/engine/src/master/HostRegistry.js` | room registry `Map<hostId, HostSession>`: registration (max 1 room per IP), heartbeat/`lastSeen`, cached `rating`, selection for `GET /servers` |
| `packages/engine/src/master/SignalingServer.js` | signaling WebSocket: connection lifecycle, WebRTC message routing, ping rate limiting |
| `packages/engine/src/master/MapCatalog.js` | map catalog: an in-memory JSON representation of the game plugin's `src/data/maps` (e.g. `vimp-tanks`'s) plus a content version hash; served to hosts without a rebuild |
| `packages/engine/src/master/WorkerCatalog.js` | worker bundle catalog: a content version hash of `dist/assets/host.worker-*.js` plus its URL; hosts use it to detect a new code version and swap the Worker via a handoff |
| `packages/engine/src/master/GameCatalog.js` | game-plugin catalog: resolves the `master:games` config list (`{id, package}[]`) to packages under `node_modules/` and reads `<package>/dist/manifest.json` (built by `npm run build` in the game repository) plus a per-game `MapCatalog` from `<package>/dist/maps/*.json`; in dev, `entries.client/host/wasm` are swapped for Vite `/@fs/` source URLs (HMR) — see [plugin-api.md](plugin-api.md#gamemanifest) |
| `packages/engine/src/master/JwksProxy.js` | proxies `GET /jwks` of the central auth service under the master's own origin, cached (TTL) — see [GET /auth/jwks](#get-authjwks) |
| `packages/engine/src/master/PlayerDataProxy.js` | proxies per-user `GET`/`PUT /rank` and `/state` of the central auth service, **not cached** (Stage B4) — see [GET/PUT /auth/rank, GET/PUT /auth/state](#getput-authrank-getput-authstate); also the public `GET /leaderboard` and the per-user `GET /placement` (lobby page plan) — see [GET /auth/leaderboard, GET /auth/placement](#get-authleaderboard-get-authplacement) |
| `packages/engine/src/master/LeaderboardCache.js` | keyed TTL cache (`game:limit`) in front of `PlayerDataProxy.getLeaderboard` (code review L2) — see [GET /auth/leaderboard, GET /auth/placement](#get-authleaderboard-get-authplacement) |
| `packages/engine/src/master/HostRatingProxy.js` | proxies the central auth service's host-rating endpoints: `getRating` (own rating, Bearer) for the `register_host` block check, `vote` (Bearer) for `like_host`/`unlike_host`, `getPublic` (no token — `GET /host-rating/:hosterUserId` is unauthenticated, the value is public lobby data) for `refreshRatings`'s periodic poll |
| `packages/engine/src/lib/rateLimiter.js` | a shared fixed-window rate limiter (event limit per key per interval) |

`HostSession`: `hostId` (uuid), `name`, `maxPlayers` (clamped to `host.maxPlayersLimit`, the target room size — 8), `currentPlayers`, `mapName`, `region`, `ip`, `gameId`/`gameVersion` (which game plugin and manifest version the host declared at `register_host` — every host as of Stage 6.4), `hosterUserId` (the hoster's identity, from their Bearer token at `register_host` — server-rating stage 2), `secret` (per-room capability minted at registration, returned only to the registering session, proves room ownership for rank/state attribution — never in `GET /servers`), `rating` (cached hoster score, server-rating stage 3 — see below), `status` (`online`), `lastSeen`.

The region is determined from an Nginx/CDN header (`regionHeader`, `x-region` by default; e.g. `CF-IPCountry`) — chosen over `geoip-lite` for its low memory footprint. Without the header the region is `unknown`.

## REST API

### GET /config

The server mode, probed by the engine client on startup (standalone-sdk
stage 4):

- `GET /config` → `{ "mode": "lobby" }`.

The client uses one contract for both server roles: a `dedicated` answer
switches it to the direct-WebSocket boot path, anything else (including a
404 from an older master) means the lobby. See
[dedicated.md](dedicated.md#get-config) and
[client.md](client.md#boot-modes-bootjs).

### GET /servers

Query params: `offset`, `limit`, `region`, `search`. Logic (in priority order):

1. `search` — case-insensitive substring match; all other params are ignored.
   Plain text matches the room name. A `gameId/name` shape (lobby page plan —
   the same format the lobby's server card shows) splits on the first `/` and
   matches `gameId` against the game part **and** `name` against the rest; an
   empty name part (`"tanks/"`) matches on game alone.
2. If the total room count is ≤ `servers.regionThreshold` (15), the entire list is returned with no filters or pagination.
3. Otherwise — filter by `region` (if given) and slice `offset`/`limit` (`limit` defaults to 10, max 50).

Banned rooms (`status !== 'online'`) are excluded from the results. Response:

```json
{
  "total": 1,
  "servers": [
    {
      "hostId": "3b86e7a7-…",
      "name": "My Room",
      "mapName": "arena",
      "currentPlayers": 3,
      "maxPlayers": 8,
      "region": "DE",
      "gameId": "tanks",
      "rating": 7
    }
  ]
}
```

The host's IP and internal fields are never exposed. `gameId` is a
placeholder for a future multi-game lobby filter — every host now declares
its game at `register_host` (Stage 6.4), so it's `null` only for hosts still
running pre-6.4 client code. `rating` is the hoster's cached score
(server-rating stage 3, see [below](#server-rating-likeunlike)) — `0` for a
freshly registered room until the first `register_host`/vote/periodic-poll
round trip sets it; a blocked hoster can't register a room at all, so a
`blocked` flag isn't part of this response.

### GET /games/manifest.json, GET /games/:id/manifest.json, GET /games/:id/maps/\*

The `GameManifest` catalog (`GameCatalog`, Stage A2 — see
[plugin-api.md](plugin-api.md#gamemanifest)):
at master startup, resolves the `master:games` config list (`{id, package}[]`,
see [configuration.md](configuration.md#packagesenginesrcconfigmasterjs),
overridable via the `GAMES_MATRIX` env var, and outside production extended
with the built `@vimp-games/*` packages found in `node_modules`,
`src/master/localGames.js`) to packages under
`node_modules/` (a workspace symlink onto `games/<id>` until the repos split,
an ordinary dependency after) and reads `<package>/dist/manifest.json` (built
by `npm run build` in the game repository), one entry per game plugin. A game whose
`manifest.id` differs from its configured id is skipped with a warning (the
static mount builds paths from the id); a map file with broken JSON is
skipped with a warning instead of crashing the master.

Each served manifest is additionally given two fields the build does not
write: `packageVersion` and `packageUrl`, read off the resolved package's own
`package.json` (`repository`, else `homepage`) and normalised to https by
`resolveProjectUrl` (`src/lib/packageLink.js`). The client shows them in the
entry form's footer (see [client.md](client.md)). They are supplied here
rather than by the game's build because a new manifest field only reaches
players once every game repo patches its `build-game-manifest.js`, rebuilds
and republishes, whereas `package.json` sits next to the already-installed
package and is true by definition. A package with no readable `package.json`
— or one declaring no repository — keeps them `null` and stays in the catalog;
only the footer goes blank, and contract rule `A7` warns about the missing
field. The dedicated server reuses the same `GameCatalog`, so its `#auth`
footer is filled the same way.

- `GET /games/manifest.json` → a JSON array of every known game's manifest.
- `GET /games/:id/manifest.json` → one game's manifest; unknown id →
  `404 { "error": "unknownGame" }`.
- `GET /games/:id/maps/manifest.json` / `GET /games/:id/maps/:name` —
  `{ "version": "<content hash>", "maps": ["canopy", …] }` and a map's JSON
  respectively, scoped per game (built from the resolved package's
  `dist/maps/*.json`); an unknown game/map → `404`. `MapCatalog` (per game,
  inside `GameCatalog`) keeps the built `maps/*.json` in memory. How a host
  consumes the catalog — see [host.md](host.md#dynamic-maps).
- `GET /games/:id/*` — the game's built assets (`dist/`: hashed client/host
  bundles, the shared hashed `.wasm`, sounds) are served as static files
  under `assetsBase` (`/games/<id>/`), mounted from `GameCatalog.getDistDir(id)`.

In dev, `entries.client`/`entries.host`/`entries.wasm` are rewritten to Vite
`/@fs/` absolute source paths (the resolved package's `src/client/index.js`
etc. and the `.wasm` under its `core/pkg-web/`) so imports go through Vite's dev
transform/HMR instead of the built bundle; everything else in the manifest
(`maps`, `assetsBase`, `roomDefaults`, `version`) still comes from the built
`dist/manifest.json` — a game must be built once (`npm run build` in the game repository)
before its first dev run, same requirement as `npm run core:build` for the
WASM core.

### GET /worker/manifest.json

The manifest of the host worker bundle used for the Worker handoff:

- `GET /worker/manifest.json` → `{ "version": "<content hash>", "url": "/assets/host.worker-<hash>.js" }`.

`WorkerCatalog` locates the bundle in `dist/assets/` at master startup and
hashes its content (SHA-256, 16 chars — following `MapCatalog`'s pattern).
Vite hashes asset filenames, so an old build's page can't know the new
bundle's name — the host tab creates its Worker from the `url` in the
manifest and compares `version` against the engine half of the composite
`codeVersion` in `host_registered` (Stage 6.5 — see below). In dev the
catalog is empty (`{ "version": null, "url": null }`) — the Worker is served
by Vite from source, and code updates are disabled. How a host consumes the
manifest — see [host.md](host.md#worker-handoff).

### GET /auth/jwks

Proxies `GET /jwks` of the central auth service (`packages/auth`, see
[auth.md](auth.md)) under the master's own origin (Stage B3): `JwksProxy`
(`packages/engine/src/master/JwksProxy.js`) fetches
`{security.authServiceUrl}/jwks` and caches it in memory (10 minutes TTL by
default — the key only changes on rotation). The browser host's Worker
(`packages/engine/src/host/host.worker.js`) fetches this endpoint (same
origin as the Worker itself) to verify the signature of a client's identity
JWT before trusting the `nick` claim, instead of depending on CORS/direct
reachability of the auth service from an untrusted host. `502
authServiceUnavailable` if the upstream fetch fails.

### GET/PUT /auth/rank, GET/PUT /auth/state

Proxies the central auth service's per-user `GET`/`PUT /rank` and
`GET`/`PUT /state` (`packages/auth`, see [auth.md](auth.md)) under the
master's own origin (Stage B4): `PlayerDataProxy`
(`packages/engine/src/master/PlayerDataProxy.js`) forwards each call to
`{security.authServiceUrl}{/rank|/state}?game=<gameId>` with the caller's
own `Authorization: Bearer <token>` header — unlike `JwksProxy`, the
response is **not cached** (this is per-user data, not a shared public
key). A shared `forwardPlayerData(req, res, call)` helper in `main.js`
extracts the Bearer token and `?game=` query param from the incoming
request and passes the upstream status/JSON straight through:

- `400 badRequest` if the token or `game` param is missing.
- `404 unknownGame` if `game` isn't in `gameCatalog.ids` (code-review fix —
  otherwise any valid identity token could write rank/state into an
  arbitrary, un-curated `game_id` namespace, defeating the "only cataloged
  games write to the profile" trust model).
- `502 authServiceUnavailable` if the upstream fetch fails.

**Attribution is stamped by the master, not read from the host's request
body** (code-review fix): an untrusted host browser could otherwise misattribute
its own rank/state writes to itself (dodging stage-4 voiding) or to a
victim hoster (framing them for a later ban-triggered void). `PUT` bodies
carry a `hostId` **and its per-room `hostSecret`** (both known to the host
once `register_host` confirms — see below); `registry.verifiedAttribution(hostId,
hostSecret)` in `main.js` looks the room up in `HostRegistry` and returns the
room's already-JWT-verified `hosterUserId` plus `sessionId: hostId` **only if
the secret matches** — otherwise `{}`. The secret proves the caller owns the
room: `hostId`s are public (they appear in `GET /servers`), so without the
secret a cheating host could point attribution at any other active room's
`hostId`; the secret closes that. It is minted per room in `HostRegistry.add`,
returned **only to the registering session** in `host_registered`, never
exposed in `GET /servers` (`_toPublic` whitelists fields) and never forwarded
to the auth service (the master strips it — only `{ hosterUserId, sessionId }`
reach `PlayerDataProxy.putRank`/`putState`). An unknown `hostId` or a
missing/wrong secret (not yet registered, a swapped-out Worker, or a spoof
attempt) yields no attribution — not an error.

The browser host's `PlayerDataSync`
(`packages/engine/src/host/meta/modules/PlayerDataSync.js`) calls these
routes to load a participant's rank/state on join and flush them back at
round-end/map-change/leave boundaries — see
[host.md](host.md#player-rank-and-state-sync-stage-b4). It learns its
room's `hostId`/`hostSecret` from `host_registered`
(`HostController.setHostId`, relayed into the Worker as `set_host_id` and
carried across a Worker handoff via `room.hostId`/`room.hostSecret`) and
includes them in every `PUT` body from then on. `express.json()` is mounted
in `main.js` to parse the `PUT` bodies (`{ delta, hostId, hostSecret }`/
`{ state, hostId, hostSecret }` — `/rank` takes a match delta, not an absolute
value, since server-rating stage 1; see [auth.md](auth.md#rest-api)).

### GET /auth/leaderboard, GET /auth/placement

Proxies the central auth service's `GET /leaderboard` and `GET /placement`
(lobby page plan, see [auth.md](auth.md#rest-api)) under the master's own
origin:

- `GET /auth/leaderboard?game=&limit=` — public (no Bearer token), goes
  through `LeaderboardCache` (`packages/engine/src/master/LeaderboardCache.js`,
  code review L2) in front of `PlayerDataProxy.getLeaderboard(game, limit)`.
  `400 gameRequired` if `game` is missing, `404 unknownGame` if it isn't in
  `gameCatalog.ids`, `limit` is clamped to `1..leaderboard.maxLimit` (default
  `10`, `maxLimit` from config, default `100`) before it reaches the cache,
  `502 authServiceUnavailable` on upstream failure. The response carries
  `Cache-Control: public, max-age=15` (browser-side reinforcement of the
  server-side TTL).
- `GET /auth/placement` — goes through the same `forwardPlayerData` helper as
  `/auth/rank`/`/auth/state` (Bearer token + `?game=` required, same
  `400`/`404`/`502` cases), forwarding to `PlayerDataProxy.getPlacement(token, game)`.
  Per-user data, never cached — `forwardPlayerData` sends
  `Cache-Control: no-store` on every response.

`PlayerDataProxy._request` omits the `Authorization` header when called with
a `null` token (as `HostRatingProxy.getPublic` already does for
`GET /host-rating/:hosterUserId`) — `getLeaderboard` uses this to stay
unauthenticated while `getRank`/`getState`/`getPlacement` keep passing the
caller's Bearer token through unchanged.

`LeaderboardCache` wraps `PlayerDataProxy.getLeaderboard` with an in-memory,
keyed TTL cache (`` `${game}:${limit}` `` → `{ at, result }`, same pattern as
`JwksProxy`'s single-entry TTL cache): `/auth/leaderboard` is the lobby's
most frequent anonymous request (every open + game/tab switch), and the
underlying ranking changes slowly. Only `status === 200` responses are
cached — an upstream `5xx` would otherwise stick around for the whole TTL.
`placement` (per-user, Bearer token) never goes through this cache. TTL
(`leaderboard.cacheTtl`, default 15000 ms) and clock (`now`, injected for
deterministic tests) are configurable; the map isn't unbounded since `limit`
is clamped and the key space is effectively `O(number of games)`.

### Composite `codeVersion`

`host_registered.codeVersion` is `{ engine, game: { id, version } }` (Stage
6.5): `engine` is `WorkerCatalog.version` (the host worker bundle hash,
deploy-wide); `game.id`/`game.version` are the declared game's id and
`GameCatalog.getManifest(id).version` (falls back to the host's own
self-reported `gameVersion` only when the catalog doesn't know the game).
Either half changing — an engine deploy or a game-plugin deploy — is a code
mismatch: the host re-fetches `GET /worker/manifest.json` **and**
`GET /games/:id/manifest.json`, then swaps its Worker to the fresh bundle
*and* the fresh `entries.host`/`entries.wasm` in one handoff, so a game-only
redeploy triggers a relay exactly like an engine-only one. See
[host.md](host.md#worker-handoff) for the swap protocol and
`HANDOFF_VERSION`.

### POST /debug/report (dev only)

Receiver for the browser half of the debugging loop: a host tab uploads a
recorded scenario or a state dump here, and the file lands in the same
`.debug/` the headless runner writes to — see
[debugging.md](debugging.md#upload-post-debugreport).

The route is registered **only when `!isProduction`**: in production this
would be a disk write on request from an arbitrary client. It also carries
its own body parser (`express.json({ limit: '8mb' })`, mounted before the
global 100 kb one) because a recorded match is far larger than the default
limit.

```
POST /debug/report
{ "kind": "scenario" | "dump" | "divergence", "payload": {...}, "note": "tank stuck in a wall" }

→ 200 { "file": "scenario-<stamp>-1.json", "bytes": 24576 }
→ 400 { "error": "unknown kind 'x'" }   // kind is a closed list — the file name is built from request data
→ 413 { "error": "payload too large: ... > 8388608" }
```

`packages/engine/src/master/DebugReportStore.js` writes
`{ kind, note, receivedAt, payload }` and logs the result as
`[vimp:debug] report saved: …`.

## Signaling protocol (WebSocket)

Messages are JSON objects with a `type` field. On connect, the connection is
checked against an `Origin` allowlist (`security.createOriginValidator`; a
missing `Origin` terminates immediately, a foreign one closes with code
`4001`), then receives:

```json
{ "type": "welcome", "id": "<connection uuid>", "iceServers": [{ "urls": "stun:…" }] }
```

`iceServers` is the ICE configuration for `RTCPeerConnection` (STUN is required; TURN is an optional relay).

The client-side signaling counterpart — [packages/engine/src/client/network/SignalingClient.js](../../packages/engine/src/client/network/SignalingClient.js): connects to this WS, consumes `welcome`/`iceServers`, sends `webrtc_offer`/`ice_candidate`/`ping_host`/`like_host`/`unlike_host`, and relays incoming messages by `type`. Game traffic, once P2P is established, flows over WebRTC (`WebRtcManager`), bypassing the master — see [client.md](client.md#network-layer-packagesenginesrcclientnetwork) and [network.md](network.md#transport-webrtc).

### Host messages

| → to master | Response / effect |
| --- | --- |
| `register_host { name, maxPlayers, mapName, gameId, gameVersion, token }` | `host_registered { hostId, hostSecret, gameId, mapsVersion, codeVersion }` (`hostSecret` — per-room capability for rank/state attribution, see above); region — from the header, IP — from the connection; `token` — the hoster's Bearer identity-token (server-rating stage 2), verified against the central auth service's JWKS (`JwksProxy`) — its `sub` becomes `hosterUserId`, stored on the session for rating attribution; missing/invalid signature → error `invalidToken`. Before creating the room the master also asks the auth service for the hoster's own rating (`HostRatingProxy.getRating`) — `blocked: true` → error `blocked` (a hoster whose rating hit `rating.blockAt` can't open a room); a failed call (auth unreachable) sends `error authServiceUnavailable` instead of leaving the client waiting forever with no response (code-review fix); `gameId`/`gameVersion` — which game plugin/manifest version the host is running (stored on the session, echoed back; every host sends them as of Stage 6.4 — `connectAsHost` builds `room.game` from the active `GameManifest`); `mapsVersion` — the declared game's `GameManifest.maps.version` via `GameCatalog` (`null` if `gameId` is unknown to the catalog); `codeVersion` — composite `{ engine, game: { id, version } }` (Stage 6.5, see above; `engine` is the worker-bundle version) — on re-register after a disconnect (a deploy restarts the master) the host compares them to its own: a map mismatch triggers a catalog re-read, a mismatch in either `codeVersion` half triggers a Worker handoff. Errors: `alreadyRegistered`, `hostLimit` (a room from this IP already exists) |
| `update_host { currentPlayers, mapName }` | refreshes room data (also serves as a heartbeat) |
| `heartbeat {}` | updates `lastSeen` |
| `webrtc_answer { clientId, sdp }` | forwarded to the client as `webrtc_answer { hostId, sdp }` |
| `pong_host { clientId, pingId }` | forwarded to the client as `pong_host { hostId, pingId }` |

The host keeps its signaling WS open permanently. A room with no heartbeat for longer than `host.heartbeatTimeout` (30 s) is removed from the registry and its connection closes with code `4000` (checked every `host.sweepInterval`). The host's WS dropping also removes the room.

### Client messages

| → to master | Response / effect |
| --- | --- |
| `webrtc_offer { hostId, sdp }` | forwarded to the host as `webrtc_offer { clientId, sdp }`; error `unknownHost` |
| `ping_host { hostId, pingId }` | forwarded to the host; rate-limited per IP (`pingRateLimit`, error `rateLimited`). The measurement is **approximate** (client→master→host, not P2P RTT) |
| `like_host { hostId, reason, token }` / `unlike_host { hostId, reason, token }` | a server-rating vote (+1 / -1), replacing the old `/ban` report: accepted **only from a session that sent this room a `webrtc_offer`** (otherwise error `voteRejected`); `token` is the voter's Bearer identity-token, verified the same way as `register_host`'s (error `invalidToken` if missing/invalid); a reason is required (a vote without one isn't sent). The vote is proxied to the central auth service (`HostRatingProxy.vote`, target — the room's `hosterUserId`) — `voteHost` upserts one row per `(hoster, voter)` pair (an opinion can change, `like`↔`unlike`, not accumulate) and recomputes `score = clamp(SUM(value), rating.min, rating.max)`; `blocked: true` in the response evacuates the hoster (`_evacuateHoster`, see below). A failed upstream call (auth unreachable) sends `error authServiceUnavailable` instead of silently swallowing the vote (code-review fix) |

### Shared messages

| → to master | Effect |
| --- | --- |
| `ice_candidate { targetId, candidate }` | forwarded to the target (`targetId` — a `hostId` or `clientId`) as `ice_candidate { fromId, candidate }` |

Errors arrive as `{ "type": "error", "code": "<code>" }`. Invalid JSON and unknown `type` values are silently ignored.

## Server rating (`/like`·`/unlike`)

The project's only anti-cheat measure. The browser host physically runs the
simulation in its own process — WASM memory is reachable from its JS, and a
modified client can cheat by bypassing the core's logic. Technical defense
against this is impossible without moving authority back to a trusted server
(which would defeat the point of P2P), so the only measure is social.

The vote is intercepted **on the client** (`packages/engine/src/client/main.js`, the `/like <reason>`/`/unlike <reason>` commands) and goes **straight to the master** over the signaling WS, bypassing the host: its `CommandProcessor` could otherwise filter out a vote against itself. A reason is required (gated client-side) and is never shown publicly.

Rating logic (`SignalingServer` + the central auth service, [auth.md](auth.md#schema)):

- a vote is only accepted from a session that actually connected to the room (sent it a `webrtc_offer`) — membership is checked in `SignalingServer._vote` (`session.offeredHosts`); a reason is required — a vote with an empty `reason` isn't sent.
- both `register_host` and `like_host`/`unlike_host` carry a Bearer identity-token; `SignalingServer` verifies it against the auth service's JWKS (the same `verifyIdentityToken` the host Worker uses) to get a trustworthy `hosterUserId`/`voterUserId` — an IP can't be used for identity here, since the whole point is blocking a *hoster*, not an IP that's trivially changed by opening a new tab.
- the score/vote storage of record is centralized in the auth service's database (`host_ratings`/`host_votes`), not per-master memory: it needs to be global (a hoster blocked on one master stays blocked everywhere) and persistent (needed for rank/skills annulment, stage 4 of the plan). `HostRegistry` only caches the current `rating` per room (stage 3, so `GET /servers` doesn't hit the DB on every request) — it isn't the source of truth.
- `HostRatingProxy.vote` returns `{ score, blocked, counted }`; on `blocked: true` `SignalingServer` closes the host's signaling WS with code `4002` — new WebRTC offers no longer route to it (already established P2P peers aren't affected, there's no host migration: the cheater is left alone in the room). The returned `score` also updates `HostRegistry`'s cache for that room immediately (`registry.setRating`), so a vote is reflected in the lobby without waiting for the next periodic poll.
- on `register_host`, `HostRatingProxy.getRating` checks the hoster's own rating first — `blocked: true` rejects the room with error `blocked` before it's ever created; its `score` also seeds the new room's cached `rating`.
- `SignalingServer.refreshRatings()` (stage 3) periodically re-polls every active room's rating via `HostRatingProxy.getPublic` (`GET /host-rating/:hosterUserId`, unauthenticated — no per-hoster Bearer token is held between requests) and writes it into `HostRegistry` via `setRatingForHoster`, keyed by `hosterUserId` (not `hostId` — a hoster running several rooms gets all of them updated together). This is the only path that catches a score changed by a vote on a *different* master, or after this master restarted; `main.js` runs it on a self-rescheduling `setTimeout` loop rather than a plain `setInterval` (code-review fix — a slow auth service with many active hosters could otherwise pile up overlapping cycles), waiting `rating.refreshInterval` (30 s by default) after each cycle finishes. A single hoster's fetch failing is logged and doesn't block the rest of the sweep. If the poll reports `blocked: true`, `refreshRatings` calls the same `_evacuateHoster` helper as a vote crossing `blockAt` on this master (code-review fix): it closes every one of that hoster's active rooms' signaling WS with code `4002` and removes them from `HostRegistry` via `getHostIdsForHoster`. Without this, a hoster blocked on master A (or blocked before this master's last restart) kept a joinable room alive on master B until their next `register_host` attempt.

A deliberate limitation of the project's "minimal anti-cheat" model: basic
environment hygiene (see "Protection" below) filters out "street" attackers,
but not a host running the original WASM and editing its memory from JS —
heavier schemes (cross-validating host state through shadow validators,
server-side replay checks, cryptographic snapshot signatures) were considered
and rejected: they all ultimately trust a stream of input/state controlled by
the very host being checked.

**Observability**: a blocked hoster is logged to the master's console
(`[rating] hoster ... blocked (score ...)`) — this is the only place it's
visible from the master side (there's no admin UI; vote reasons are never
exposed, they only exist as an audit trail in the auth service's
`host_votes.reason` column).

## Protection

- **Origin allowlist** — the `packages/engine/src/lib/security.js` pattern (`createOriginValidator` with the master's parameters).
- **1 room per IP** — checked in `HostRegistry.add`; a hoster whose rating hit `blockAt` is rejected regardless of IP (`HostRatingProxy.getRating`, see above).
- **Ping rate limiting** — `RateLimiter` (fixed window, 10 requests/sec per IP by default).
- **The address behind both limits** comes from `clientIp()` (`src/lib/clientIp.js`): the socket address, or `X-Real-IP` when the master runs behind a proxy (`trustProxy`, passed as `isProduction` from `lobby.js`). `X-Forwarded-For` is deliberately not used: the deploy's Nginx sets it with `$proxy_add_x_forwarded_for`, which *appends* the real address to whatever the client sent, so its first hop is client-controlled — keying on it would let anyone lift both limits with one header, and claim someone else's bucket to keep them from hosting. `X-Real-IP` is set by the same Nginx with `$remote_addr`, overwriting anything the client sends. A proxy that fails to set it makes every client key on the proxy's own address — one shared bucket, so exactly one room could exist on the whole master; `clientIp()` logs a one-off warning when that happens, and [deployment.md](deployment.md#required-proxy-header-x-real-ip) lists the required `proxy_set_header`. A connection whose address cannot be determined at all (an already-broken socket) is terminated; the `error` listener is attached before that, so a late `ECONNRESET` on it cannot become an `uncaughtException`.
- **Security headers** (environment hygiene) — the master sets `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY` on every response; `Content-Security-Policy` only in production (it would break Vite HMR in dev). Production static assets and `.wasm` are served with CSP by Nginx — see [deployment.md](deployment.md); the policy's single source of truth is `packages/engine/src/config/master.js` (`security.csp`, a function of `authServiceUrl` — see [auth.md](auth.md#lobby-login-client) — so `connect-src` allows the lobby's `POST /nick` fetch to the central auth service; `security.authServiceUrl` is overridable via `VIMP_AUTH_SERVICE_URL` in production).
- Input string sanitization (`sanitizeMessage`), clamping numeric fields.

## Tests

`tests/master/` (a node Vitest project): `HostRegistry.test.js` (registration and `hosterUserId` attribution, per-IP limit, heartbeat/cleanup, all `GET /servers` selection logic including `gameId/name` search — lobby page plan, `gameId`/`gameVersion` storage, cached `rating`/`setRating`/`setRatingForHoster`/`getHosterUserIds` — stage 3), `SignalingServer.test.js` (connection lifecycle, routing of every signaling message on fake ws sockets, identity-token verification against a real RSA-signed JWKS, rate limiting, rating-vote membership checks and blocking, stale-host cleanup, `mapsVersion`/`codeVersion` in `host_registered`, per-game `mapsVersion` via a `gameCatalog` stub, `rating` cached on register/vote and `refreshRatings()`'s periodic poll — stage 3), `MapCatalog.test.js` (manifest, map serving, version stability), `WorkerCatalog.test.js` (bundle version hash and URL, empty catalog in dev, picking the newest of several), `GameCatalog.test.js` (resolving configured `{id, package}` entries to `node_modules/<package>/dist/manifest.json`, per-game map catalogs, unbuilt/unknown games, dev `/@fs/` entry rewriting), `JwksProxy.test.js` (proxying, TTL caching/expiry, upstream failure — injected `fetchImpl`), `PlayerDataProxy.test.js` (proxying GET/PUT `/rank`+`/state`, the public `getLeaderboard` (no `Authorization` header, `limit` in the query) and the per-user `getPlacement` — lobby page plan, no caching, upstream failure — injected `fetchImpl`), `LeaderboardCache.test.js` (miss calls the proxy, hit within TTL doesn't, refetch after TTL expiry, non-200 responses aren't cached, `game`/`limit` are separate cache keys — injected `now`, code review L2), `HostRatingProxy.test.js` (proxying GET `/host-rating` + PUT `/host-rating/:hosterUserId` with a Bearer token, `getPublic`'s unauthenticated `GET /host-rating/:hosterUserId`, no caching, upstream failure — injected `fetchImpl`). Rate limiter — `tests/lib/rateLimiter.test.js`.

---

[← Previous: Architecture](architecture.md) · [Next: Central Auth Service →](auth.md)
