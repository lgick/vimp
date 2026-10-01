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

| Module                                               | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine/src/master/main.js`                 | entry point: the fork between the lobby master and the [dedicated server](dedicated.md) (`VIMP_DEDICATED_GAME`)                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/engine/src/master/lobby.js`                | the lobby master itself: Express + REST, HTTPS/HTTP server, signaling `WebSocketServer`, periodic cleanup of stale rooms                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/engine/src/master/httpSecurity.js`         | baseline security headers (`nosniff`, `Referrer-Policy`, `X-Frame-Options`, CSP in production), shared with the dedicated server                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/engine/src/config/env.js`                  | environment overrides of the server config (`VIMP_DOMAIN`, `VIMP_MASTER_PORT`, `VIMP_AUTH_SERVICE_URL`, `VIMP_GAMES_DIR`) plus `VIMP_DEDICATED_ROOM` parsing; applied by the lobby and the dedicated server alike                                                                                                                                                                                                                                                                                        |
| `packages/engine/src/master/RoomRegistry.js`         | room registry `Map<roomId, Room>`: rooms with a stable `roomId`, the host's epoch and members (join/detach/leave with grace), max 1 hosted room per IP, heartbeat, `sweep` (lost host, expired members, empty rooms), selection for `GET /servers`, room-secret attribution                                                                                                                                                                                                                              |
| `packages/engine/src/master/roomSecret.js`           | `deriveRoomSecret`/`verifyRoomSecret`: `HMAC-SHA256(VIMP_ROOM_SECRET_KEY, roomId:epoch:hostUserId)` in base64url, constant-time comparison                                                                                                                                                                                                                                                                                                                                                               |
| `packages/engine/src/master/SignalingServer.js`      | signaling WebSocket: connection lifecycle, room registration/reclaim, room membership (`join_room`/`leave_room`), WebRTC message routing to a room's current host, `room_closed`, ping rate limiting                                                                                                                                                                                                                                                                                                     |
| `packages/engine/src/master/MigrationCoordinator.js` | emergency host migration (host-migration stage 7): the room state machine `online → migrating → online`, picking the promoted successor (`checkpoint`/`cold`), promotion deadlines, `host_unreachable` reports, the host probe and the quorum; called by `SignalingServer`, timers injectable                                                                                                                                                                                                            |
| `packages/engine/src/master/HostVoteManager.js`      | the "Change host" vote (host-migration stage 10): start checks and cooldowns, eligible members, counting, the outcome, `demotedUntil` and the forced host change when the host does not hand over; called by `SignalingServer`, timers injectable — see [Change host vote](#change-host-vote)                                                                                                                                                                                                            |
| `packages/engine/src/master/MapCatalog.js`           | map catalog: an in-memory JSON representation of the game plugin's `src/data/maps` (e.g. `vimp-tanks`'s) plus a content version hash; served to hosts without a rebuild                                                                                                                                                                                                                                                                                                                                  |
| `packages/engine/src/master/WorkerCatalog.js`        | worker bundle catalog: a content version hash of `dist/assets/host.worker-*.js` plus its URL; hosts use it to detect a new code version and swap the Worker via a handoff                                                                                                                                                                                                                                                                                                                                |
| `packages/engine/src/master/GameCatalog.js`          | game-plugin catalog, **mutable**: `upsert`/`setActive`/`remove` are the single entry point for both sources — the `master:games` config list (`{id, package}[]` resolved under `node_modules/`) and `GameSync`. An entry is addressed by `id` + npm version, so two versions of one game live in it at once (players on the approved one, an admin testing another); in dev, `entries.client/host/wasm` are swapped for Vite `/@fs/` source URLs (HMR) — see [plugin-api.md](plugin-api.md#gamemanifest) |
| `packages/engine/src/master/gameRefs.js`             | the shapes of a game reference — id, npm version, package name — plus the ids the registry routes reserve (`mine`, `submit`, `manifest`). Values duplicate `config.games` of the auth service on purpose: the two packages share no runtime dependency, and an id is both a URL segment and a directory name on disk                                                                                                                                                                                     |
| `packages/engine/src/master/GameRegistryProxy.js`    | client of the auth service's game registry (`/games`, `/games/mine`, `/admin/games`) — like `PlayerDataProxy` it caches nothing and interprets nothing, returning `{status, json}`                                                                                                                                                                                                                                                                                                                       |
| `packages/engine/src/master/GameStore.js`            | game package store on disk (`VIMP_GAMES_DIR`, `<dir>/<id>/<npmVersion>/`): downloads an approved version from the npm registry, verifies its `integrity`, unpacks `package/dist` and validates it structurally. `ensure`/`inspect` never throw — a network failure, a 404, a broken archive and a failed check all return `{ok: false, errors}`                                                                                                                                                          |
| `packages/engine/src/master/npmRegistry.js`          | the npm registry half of the store: packument fetch, version resolution, tarball download with an `integrity`/`shasum` check, `tar` extraction with size and file-count ceilings                                                                                                                                                                                                                                                                                                                         |
| `packages/engine/src/master/gamePackageCheck.js`     | structural validation of a downloaded package **without executing its code** (manifest shape, `id` match, entries under `assetsBase`, maps): the master never imports a plugin half — see [publishing.md](publishing.md) for the full `vimp-contract`, which is the developer's tool                                                                                                                                                                                                                     |
| `packages/engine/src/master/rebaseManifest.js`       | rewrites `assetsBase`/`entries` of a served manifest onto the versioned base `/games/<id>/<version>/` and adds `mapsBase`; `entries.wasmNode` is deliberately left alone (a filesystem path, not a URL)                                                                                                                                                                                                                                                                                                  |
| `packages/engine/src/master/GameSync.js`             | keeps the catalog in step with the registry: one pass asks the registry, downloads what is missing, updates the catalog and prunes the disk; polled on a timer (`master:gameStore:refreshInterval`). A registry outage never empties the catalog — a stale catalog beats an empty one                                                                                                                                                                                                                    |
| `packages/engine/src/master/adminAuth.js`            | authorization of the master's REST routes: the same JWKS signature and issuer policy as the signaling path, plus the `role` claim for `/admin/*`                                                                                                                                                                                                                                                                                                                                                         |
| `packages/engine/src/master/ClientReportsProxy.js`   | client of the auth service's client-error journal admin API (`GET`/`PATCH /admin/client-reports`) — passes the admin's Bearer through, caches nothing, returns `{status, json}`                                                                                                                                                                                                                                                                                                                          |
| `packages/engine/src/master/clientReportsRoutes.js`  | handlers of the journal's admin routes — see [GET/PATCH /admin/client-reports](#getpatch-adminclient-reports-client-error-journal)                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/engine/src/master/gameRoutes.js`           | handlers of the registry routes: a developer's submission and its status, the moderation panel, and staging (`Test`) a version into the catalog                                                                                                                                                                                                                                                                                                                                                          |
| `packages/engine/src/master/gameStatic.js`           | serves the games' `dist/` under `/games/<id>[/<version>]/…`: a cache of `express.static` instances keyed by the version directory (a version pruned off disk takes its mount with it, via `GameSync.onPruned`), `404` on a miss inside a versioned path and `next()` on a non-versioned one. Its own module because `lobby.js` starts the server and is never imported from tests                                                                                                                        |
| `packages/engine/src/master/JwksProxy.js`            | proxies `GET /jwks` of the central auth service under the master's own origin, cached (TTL) — see [GET /auth/jwks](#get-authjwks)                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/engine/src/master/PlayerDataProxy.js`      | proxies per-user `GET`/`PUT /rank` and `/state` of the central auth service, **not cached** (Stage B4) — see [GET/PUT /auth/rank, GET/PUT /auth/state](#getput-authrank-getput-authstate); also the public `GET /leaderboard` and the per-user `GET /placement` (lobby page plan) — see [GET /auth/leaderboard, GET /auth/placement](#get-authleaderboard-get-authplacement)                                                                                                                             |
| `packages/engine/src/master/LeaderboardCache.js`     | keyed TTL cache (`game:limit:period`) in front of `PlayerDataProxy.getLeaderboard` (code review L2) — see [GET /auth/leaderboard, GET /auth/placement](#get-authleaderboard-get-authplacement)                                                                                                                                                                                                                                                                                                           |
| `packages/engine/src/master/PlacementCache.js`       | keyed TTL cache (`master:placement:cacheTtl`, default 30s) in front of `PlayerDataProxy.getPlacement`, per-user — see [GET /auth/leaderboard, GET /auth/placement](#get-authleaderboard-get-authplacement)                                                                                                                                                                                                                                                                                               |
| `packages/engine/src/lib/rateLimiter.js`             | a shared fixed-window rate limiter (event limit per key per interval)                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`Room`: `roomId` (8 chars of lowercase crockford-base32, `packages/engine/src/lib/roomId.js`; stable for the room's whole life — survives a host signaling reconnect and a master restart), `epoch` (the host's reign number, from 1), `status` (`online`, `migrating` — host migration in progress, see [Host migration](#host-migration); `handing_off` — a planned handoff, see [Planned handoff](#planned-handoff)), `pendingEpoch`/`migration` (the epoch the successor will take and the current promotion attempt), `settings` (the room settings for a cold restart, `lib/roomSettings.js`; never public), `maxPlayers` (clamped to the game's `roomDefaults.maxPlayers`, or `host.maxPlayersLimit` — 8 — for an unknown game), `info` (the lobby card text the game sets — `gameConfig.lobbyInfo`; `null` when there is none, sanitized and capped at `room.maxInfoLength`), `region`, `gameId`/`gameVersion` (which game plugin and manifest version the host declared), `hidden` (a room on a staged game version), `createdAt`, `lastSeen` (the host's heartbeat), `host { sessionId, memberId, userId, ip, detachedAt }` (`userId` — the host's verified identity from its Bearer token), `members: Map<memberId, { memberId, userId, nick, sessionId, joinedAt, detachedAt, caps }>`. The room secret is **not stored**: it is derived from `roomId`, `epoch` and `host.userId` (see [Room lifecycle](#room-lifecycle)). A room has no name.

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

1. `search` — case-insensitive; all other params are ignored. Plain text
   matches a `roomId` prefix, a `gameId` substring or an `info` substring. A
   `gameId/<roomId prefix>` shape — the format the lobby's server card shows —
   splits on the first `/` and matches `gameId` against the game part **and**
   the `roomId` prefix against the rest; an empty rest (`"tanks/"`) matches on
   game alone.
2. If the total room count is ≤ `servers.regionThreshold` (15), the entire list is returned with no filters or pagination.
3. Otherwise — filter by `region` (if given) and slice `offset`/`limit` (`limit` defaults to 10, max 50).

Only rooms on a staged game version are hidden (an admin's token shows them).
A room that is not `online` (host migration) or whose host is detached is
left out: joining it would end in `unknownRoom`, and quick play would pick it
again and again. Response:

```json
{
  "total": 1,
  "servers": [
    {
      "roomId": "k3v9q2ma",
      "hostId": "k3v9q2ma",
      "gameId": "tanks",
      "info": "arena",
      "mapName": "arena",
      "currentPlayers": 3,
      "maxPlayers": 8,
      "region": "DE"
    }
  ]
}
```

`hostId` repeats `roomId` and `mapName` repeats `info` (`''` when it is
`null`) for lobby pages loaded before the deploy. `info` is the line the game
puts on its card — the current map for `gameConfig.lobbyInfo: 'map'`, any
text a module sets, or `null`: the master never substitutes a placeholder. The host's
IP, the members and internal fields are never exposed. `currentPlayers` is
counted by the master from the room's members (connected, or detached for less
than `room.memberGraceMs`) — the host no longer reports it. `gameId` is `null`
only for hosts still running pre-6.4 client code.

### GET /rooms/:roomId

The room behind a direct link `#/<gameId>/<roomId>` ([client.md](client.md)):
an invalid id is `400`, an unknown one `404 {"error": "unknownRoom"}`,
otherwise the public shape of `GET /servers` plus `status` (`online`,
`migrating`, …). Hidden rooms are returned too — joining one by id is
possible anyway. Rate-limited per IP (`room.lookupRateLimit`, `429` past it)
against `roomId` enumeration. Handler: `master/roomRoutes.js`
(`RoomRegistry.getPublic`).

### GET /games/manifest.json, GET /games/:id/…, GET /games/:id/:version/…

The `GameManifest` catalog (`GameCatalog` — see
[plugin-api.md](plugin-api.md#gamemanifest)). It has **two sources**, and the
regular one is the registry:

1. **The game registry of the central auth service** (`GameSync` +
   `GameStore`). Every `master:gameStore:refreshInterval` the master asks
   `GET /games` of the auth service for the approved games and the version to
   serve, downloads what it does not have yet from the npm registry into
   `VIMP_GAMES_DIR` (`<dir>/<id>/<npmVersion>/`), validates the package
   structurally **without executing its code** (`gamePackageCheck.js`) and
   upserts it into the catalog. Adding a game or raising its version needs
   neither an image rebuild nor a restart. A registry outage, a broken archive
   or a failed check leave what already works in place: a stale catalog beats
   an empty one, and the reason is kept per game (`GameSync.lastError`) for the
   moderation panel.
2. **`master:games`** (`{id, package, maxGameScore?}[]`, see
   [configuration.md](configuration.md#packagesenginesrcconfigmasterjs),
   with no env override, and outside production extended with the built
   `@vimp-games/*` packages found in `node_modules`,
   `src/master/localGames.js`) — resolved to packages under `node_modules/`
   and read from `<package>/dist/manifest.json`. This is the local
   development path (`npm link` plus HMR) and the dedicated server's own
   lookup. **A locally linked game always wins**: `GameSync` skips a
   registry entry whose id is linked, so nobody is quietly sent to edit files
   that go nowhere.

A game whose `manifest.id` differs from its configured id is skipped with a
warning (the static mount builds paths from the id); a map file with broken
JSON is skipped with a warning instead of crashing the master.

A game is **never** dropped for its `engineApi`: the version gate is gone
(`plan/plugin-forward-compat`). A game whose manifest asks — via
[`requires`](plugin-api.md#requires-and-engine-capabilities) — for a
capability this engine build does not have stays in `manifestList` too, with
an extra field:

```jsonc
"compat": { "ok": false, "reason": "engine-too-old",
            "missing": ["telemetry"], "text": "… — update the engine" }
```

The field is absent for every game that runs (an older client simply does not
see it); the lobby renders a game that carries it disabled, with `text` as the
tooltip, so an unavailable game reads as an error instead of an empty lobby.

Each served manifest is additionally given two fields the build does not
write: `packageVersion` and `packageUrl`. On the `node_modules` path they are
read off the resolved package's own `package.json` (`repository`, else
`homepage`) and normalised to https by `resolveProjectUrl`
(`src/lib/packageLink.js`); for a game from the registry they come from the
registry row instead, because a published tarball carries only `dist/`. The client shows them in the
entry form's footer (see [client.md](client.md)). They are supplied here
rather than by the game's build because a new manifest field only reaches
players once every game repo patches its `build-game-manifest.js`, rebuilds
and republishes, whereas `package.json` sits next to the already-installed
package and is true by definition. A package with no readable `package.json`
— or one declaring no repository — keeps them `null` and stays in the catalog;
only the footer goes blank, and contract rule `A7` warns about the missing
field. The dedicated server reuses the same `GameCatalog`, so its `#auth`
footer is filled the same way.

- `GET /games/manifest.json` → a JSON array of the manifests the catalog
  **serves** (the active version of each game), ordered by id.
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
  under `assetsBase`, mounted from `GameCatalog.getDistDir(id)`.

#### Versioned URL space

A game downloaded from the registry is addressed by **id + npm version**:
`/games/<id>/<version>/manifest.json`, `/games/<id>/<version>/maps/*` and
`/games/<id>/<version>/*` for its assets. That is what lets an admin play a
staged version while everybody else plays the approved one — the same master
serves both at once. The version segment must look like a version
(`1.2.3`, optionally with a `-`/`+` suffix), otherwise the path is handed on
to the static middleware, so `/games/tanks/assets/…` still resolves.

The master **rewrites the manifest it serves**: `rebaseManifest` moves
`assetsBase` and `entries.client/host/wasm` onto `/games/<id>/<version>/` and
adds `mapsBase` (`/games/<id>/<version>/maps`), which is where the lobby reads
map URLs from (`src/config/lobby.js`). `entries.wasmNode` is left untouched —
it is a filesystem path for the dedicated server, not a URL. This is the same
trick the catalog already uses in dev to point entries at Vite `/@fs/`
sources. An entry that does not sit under the manifest's own `assetsBase` is
left alone rather than "fixed".

The unversioned aliases above stay, and resolve to the version currently
served. Three consumers need them: tabs opened before a version change, the
dev / standalone / dedicated paths where a manifest carries no `mapsBase` at
all, and hosts running older builds.

A miss inside `/games/<id>/<version>/…` — unknown game, unknown version or a
missing file — answers `404 {"error": "unknownGame"}` or
`404 {"error": "notFound"}` (`gameStatic.js`). Such a path cannot fall through
to the html fallback by construction: it addresses the package store and
nothing else, and a `200 text/html` where a bundle should be turns "no such
file" into an opaque `import()` rejection. A non-`GET`/`HEAD` request is
handed on instead: `serve-static` never looks at it, so "the file is missing"
is not known about it. A non-versioned path (`/games/<id>/…`) still goes
`next()` — in dev that is the way out to the linked game's Vite sources.

#### Registry routes (submission and moderation)

Handlers live in `gameRoutes.js`, authorization in `adminAuth.js`; **every
write goes to the auth service**, which re-reads the caller's role from the
database — the master validates and serves packages, it never decides who may
publish.

| Route                                 | Access                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /games/lookup?package=&version=` | any logged-in user                     | parse a package for the submission form: the master downloads and checks it and answers `{id, title, version, versions, repoUrl, engineApi, compat, errors}`. Same rate limit as `submit` — the route fetches someone else's tarball                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /games/mine`                     | any logged-in user                     | the caller's own submissions with their status and the moderator's note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /games/submit`                  | any logged-in user                     | a new game submission: the package is downloaded and checked **before** the row is written, so the developer gets the list of problems at once and the registry does not fill up with unusable entries. The body carries only `{packageName, version}` — see below. Limited to 5 submissions per minute per user, ahead of the npm fetch                                                                                                                                                                                                                                                                                                                              |
| `POST /games/mine/:id/version`        | the game's owner (an admin — any game) | a new version of an already registered game, checked the same way                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DELETE /games/mine/:id`              | any logged-in user (auth decides)      | deletes the game. The right is checked by the auth service, not by the path — an admin may delete any game, an author only their own and only while it is not being served (`409 gamePublished` otherwise). In the registry the deletion is **soft** (the row and its ratings live on for 30 days), but that is the auth service's business: for the master the game has simply left `GET /games`. On a `200` the catalog entry is dropped **whole** (`catalog.remove(id)` without a version, so the admin's staged draft goes with it — nothing else would ever retire it) and a sync pass runs at once; the version's files are swept by the next `prune` inside it |
| `GET /admin/games`                    | `role=admin`                           | the whole moderation queue — soft-deleted games included, each with `deletedAt` and `purgeAt` — plus this master's local state per game (`downloaded`, `stagedVersion`, `lastError`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /admin/games/manifest.json`      | `role=admin`                           | manifests of the staged (not served) versions — the admin's tab puts them into its own catalog and opens a room on one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /admin/games/:id/stage`         | `role=admin`                           | "Test": download a version and put it into the catalog **inactive**. One draft per game — a new "Test" retires the previous one, and a draft the registry already serves is dropped on the next sync pass; nothing else would ever retire it, and its version stays pinned on disk for as long as it is in the catalog                                                                                                                                                                                                                                                                                                                                                |
| `PATCH /admin/games/:id`              | `role=admin`                           | the moderator's decision (status, served version, note, `maxGameScore`) and the game's author (`authorNick` — the panel's `Author` field; an empty field clears it). The master proxies the body as it is: the nick is resolved to a user by the auth service. Authorship is what puts a game into its author's "My games" and lets them request a new version, so the games seeded by the migration stay nobody's until an admin fills that field in. On success the master runs a sync pass at once, so the admin sees the result immediately while other masters pick it up within `refreshInterval`                                                               |
| `POST /admin/games/:id/restore`       | `role=admin`                           | brings a soft-deleted game back, together with its ratings and skills. The master downloads nothing itself: the restored game shows up in `GET /games` again, and the sync pass the route runs picks it up                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /admin/games/:id/versions`       | `role=admin`                           | what the npm registry has published for the package — the "there is a newer version" indicator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

The submission form asks for **two things: the npm package and the version**.
Everything else the master reads off the package itself: `id`, `title` and the
resolved version come from `dist/manifest.json` inside the tarball (which the
master unpacks anyway to check it), and the repository URL comes from the npm
packument — `repository` lives in the package's `package.json`, which never
reaches disk, since only `package/dist/**` is unpacked. Asking a human for
values the master is about to read and verify is what the form used to do.

Both routes therefore stage the package **without knowing its id in advance**
(`GameStore.inspectPackage`): the unpack goes to a root `<dir>/.staging/<rand>`
and the id is read from the manifest afterwards, then held to the same
`GAME_ID_PATTERN`/`RESERVED_GAME_IDS` rules as a submitted one — the manifest
is untrusted input, and the id becomes a URL segment and a directory name.
`submit` still accepts a body with `id`, `title` and `repoUrl` (an older client
or a direct call), but what the package says wins.

An auth-service failure is `502 { "error": "authServiceUnavailable" }` on
every one of them.

The moderation queue is split into **tabs** by the buttons above the list
(`lobby.games.statuses`). Four of them are registry statuses; the fifth,
`Deleted`, is not — a soft-deleted game keeps the status it had, and the tab
collects everything with a non-empty `deletedAt`. A game moves into it
_whole_: leaving it in `Pending` or `Published` as well would offer moderating
something the players no longer have. The card there carries no moderation
controls at all, only the date it will be removed for good and `Restore`.
Deleting therefore needs no confirmation click — it is reversible for 30 days.

"My games" and "Moderation" are **two pages of one panel**, not two cards on
one screen: exactly one of them is shown. The panel's head (the title, the page
switch and "Back to lobby") sits above the cards and survives switching, so the
way back to the lobby is there on both pages; the switch is shown to admins
only — for everybody else the panel is a single page.

A room opened on a staged version is **hidden**: `register_host` marks the
session `hidden` when `GameCatalog.isStaged(gameId, gameVersion)` holds, and
`GET /servers` never lists it — a test room is reachable only by its link, so
players do not walk into an unapproved build. The check is done on
`manifest.version` (the bundle hash the host reports), because the host knows
nothing of npm versions. A room on the approved version never counts as
staged, even when its bundle hash matches a staged one (a republish that
touched only `package.json` leaves the code untouched).

The per-game score ceiling (`maxGameScore`, clamped onto `PUT /auth/rank`)
comes from the **registry row an admin filled in**, not from the manifest —
otherwise a game would raise its own ceiling. `master:games` may carry it as
the fallback for the self-hosted path.

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
body** (code-review fix): an untrusted host browser could otherwise
attribute its rank/state writes to another room (and spend that room's
per-room write limit). `PUT` bodies carry a `roomId` **and the room secret
`roomSecret`** (both known to the host once `host_registered` arrives — see
below; a Worker older than host-migration stage 2 sends the same values as
`hostId`/`hostSecret`, which the master still accepts);
`registry.verifiedAttribution(roomId, roomSecret)` in `lobby.js` looks the
room up in `RoomRegistry` and returns `{ sessionId: roomId }` **only if the
secret is the current epoch's secret** — otherwise `{}`. The verified
`sessionId` keys the per-room write limit (`master:playerData:writesPerMinute`)
and becomes `session_id` in the auth ledger; an unattributed write is keyed by
IP. The secret proves the caller hosts the room: `roomId`s are public (they
appear in `GET /servers` and in links), so without the secret a cheating host
could point attribution at any other active room. The secret is
`HMAC-SHA256(VIMP_ROOM_SECRET_KEY, roomId:epoch:hostUserId)`, returned **only
to the host's session** in `host_registered`, never exposed in
`GET /servers` and never forwarded to the auth service (only `{ sessionId }`
reaches `PlayerDataProxy.putRank`/`putState`). An unknown `roomId` or a
missing/wrong secret (not yet registered, or a spoof attempt) yields no
attribution — not an error.

`PUT /auth/rank` also passes the host's `writeSeq` through to auth unchanged
(host-migration 7.7; a value that is not a positive safe integer is dropped,
not rejected): it is the number of the write, by which auth recognises a
repeat after a rollback to a checkpoint and answers it `{ ok: true,
duplicate: true }` without counting it again — see
[auth.md](auth.md) ("Idempotent writes"). A repeat carries the same body, so
the `maxGameScore` clamp gives the same result for it.

The browser host's `PlayerDataSync`
(`packages/engine/src/host/meta/modules/PlayerDataSync.js`) calls these
routes to load a participant's rank/state on join and flush them back at
round-end/map-change/leave boundaries — see
[host.md](host.md#player-rank-and-state-sync-stage-b4). It learns its
room's `roomId`/`roomSecret` from `host_registered`
(`HostController.setRoom`, relayed into the Worker as `set_room` and
carried across a Worker handoff via `room.roomId`/`room.roomSecret`) and
includes them in every `PUT` body from then on. `express.json()` is mounted
in `lobby.js` to parse the `PUT` bodies (`{ points, best, roomId, roomSecret }`/
`{ state, roomId, roomSecret }`; see [auth.md](auth.md#rest-api)).

### GET /auth/leaderboard, GET /auth/placement

Proxies the central auth service's `GET /leaderboard` and `GET /placement`
(lobby page plan, see [auth.md](auth.md#rest-api)) under the master's own
origin:

- `GET /auth/leaderboard?game=&limit=&period=` — public (no Bearer token), goes
  through `LeaderboardCache` (`packages/engine/src/master/LeaderboardCache.js`,
  code review L2) in front of `PlayerDataProxy.getLeaderboard(game, limit)`.
  `400 gameRequired` if `game` is missing, `404 unknownGame` if it isn't in
  `gameCatalog.ids`, `limit` is clamped to `1..leaderboard.maxLimit` (default
  `10`, `maxLimit` from config, default `100`) before it reaches the cache,
  `502 authServiceUnavailable` on upstream failure. The response carries
  `Cache-Control: public, max-age=15` (browser-side reinforcement of the
  server-side TTL). `period` (`day`/`month`/`all`, default `all` —
  rank-periods) is validated here rather than forwarded blindly: an unknown
  slice is `400 badPeriod` without a trip to the auth service. It is part of
  the cache key, so the three slices of one game never answer for each
  other.
- `GET /auth/placement?game=&period=` — Bearer token + `?game=` required, same
  `400`/`404`/`502` cases as `/auth/rank`/`/auth/state`, forwarding to
  `PlayerDataProxy.getPlacement(token, game)`. Per-user data, cached by
  `PlacementCache` (`packages/engine/src/master/PlacementCache.js`, keyed
  TTL, default 30s — `master:placement:cacheTtl`), same pattern as
  `LeaderboardCache` in front of the leaderboard. `period` is read and
  validated before the forward, exactly as for the leaderboard.
- `GET /auth/placements?game=` — aggregates all three rank periods
  (`day`/`month`/`all`) for the caller in one call, going through the same
  `PlacementCache` per period.

`PlayerDataProxy._request` omits the `Authorization` header when called with
a `null` token — `getLeaderboard` uses this to stay
unauthenticated while `getRank`/`getState`/`getPlacement` keep passing the
caller's Bearer token through unchanged.

`LeaderboardCache` wraps `PlayerDataProxy.getLeaderboard` with an in-memory,
keyed TTL cache (`` `${game}:${limit}:${period}` `` → `{ at, result }`, same pattern as
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
_and_ the fresh `entries.host`/`entries.wasm` in one handoff, so a game-only
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

### POST /client-reports (client error reports)

Every box — a lobby master and a [dedicated server](dedicated.md#http)
alike — accepts error reports from the browsers it serves and forwards them
in batches to the central auth service, where they land in one journal
(`client_reports`, see [auth.md](auth.md)). The browser posts to **its own
box** (same-origin), so neither CSP nor CORS nor Nginx needs a change. Code:
`packages/engine/src/master/clientReports/` (`index.js` assembles it for both
entry points).

```
POST /client-reports            Content-Type: application/json, body ≤ 16 KB
{
  "v": 1,
  "sessionId": "uuid v4, one per tab",
  "context": { "mode": "lobby|dedicated|solo", "role": "client|host",
               "gameId": "tanks|null", "gameVersion": "0.22.7|null",
               "page": "/ (pathname, ≤ 128)", "userAgent": "≤ 256" },
  "items": [{
    "kind": "error|rejection|worker|warn|csp",
    "source": "client|host-worker|plugin",
    "code": "tanks.camera.missing|null", "message": "≤ 500",
    "stack": "≤ 4000|null", "details": { "…": "plain object ≤ 2048 B JSON" },
    "count": 1, "firstAt": 1758900000000, "lastAt": 1758900000000
  }]
}

→ 204                                // accepted, also when some items were dropped
→ 400 { "error": "badRequest" }
→ 403 { "error": "forbiddenOrigin" } // Origin present and not the box's own
→ 400 { "error": "badRequest" }      // also a malformed JSON body
→ 413 { "error": "payloadTooLarge" } // body over bodyLimit (16 KB)
→ 429 { "error": "rateLimited" }
```

The route has its own body parser (16 KB), mounted before the global one;
a body the parser rejects is not written to the process log.
Checks, in order:

1. **Rate limit per address** — 30 requests a minute, _before_ the body is
   parsed. The key is `rateLimitKey(clientIp(req))`
   (`src/lib/clientIp.js`): an IPv4 address as is, an IPv6 address by its
   **/64** prefix — a subscriber owns a whole /64, so a per-address limit
   would be no limit at all.
2. **Origin** — when the header is present it must pass the same validator
   as signaling; a request without it is let through (the limit still
   applies).
3. **Shape** — `sanitize.js` cuts the body down to the schema above: `v` must
   be `1`, 1–10 items; an item with an unknown `kind`/`source` (including
   `source: 'box'`, reserved for the box itself) or an empty message is
   dropped; strings are truncated, `details` over 2048 B becomes
   `{ truncated: true }`, dates outside `[now − 1 day, now + 5 min]` become
   `now`. Anything else is ignored — including a client `engineVersion`: the
   box stamps its own (`packages/engine/package.json`), since it serves the
   client itself.
4. **Fingerprint** — `sha256` of `[source, kind, code ?? normalizedMessage,
rawTopFrame, engineVersion, gameId, gameVersion]` (`fingerprint.js`).
   The message is normalized (digits → `N`, hex ids of 8+ characters → `H`),
   the top frame is `<pathname>:<line>:<col>` of the first stack frame with a
   URL (V8 and Firefox/Safari formats). A frame is an `at …` or `fn@url`
   line; the V8 message line is never a frame, even when it ends with
   `url:line:col` — the same rule symbolication uses (`isFrameLine`).
   Versions are part of the key on purpose: a regression in a new release is
   a new row, the fixed row of the old release stays `fixed`.

**Aggregation and the budget of new fingerprints.** `ClientReportBuffer`
keeps one entry per fingerprint; a repeat adds to `count` and widens
`firstSeen`/`lastSeen`. A fingerprint is _known_ when it is in the buffer or
the process has already accepted it (it left with an earlier batch); a known
fingerprint never costs budget, is never symbolicated again and prints no
`new` line — it only needs room in the buffer when it is not there already
(a full buffer drops it as `bufferFull`). Only accepted entries become
known, so spam cannot grow that set faster than the budget. A new one costs
a unit of the box's budget — `newFingerprintsPerMinute` (60, a fixed minute
window) — and needs room in the buffer (`maxPending`, 500). Over the budget
or with a full buffer the new fingerprint is dropped (before any stack
symbolication, so spam burns no CPU) and counted; the sender still gets
`204`. A distributed spam campaign bypasses the per-address limit, and a new
row in auth is the resource to protect — hence the budget.

**Forwarding.** Every `flushIntervalMs` (30 s) `ClientReportForwarder` drains
the buffer oldest-first in batches of `forwardBatch` (50) to
`POST <authServiceUrl>/client-reports` with
`Authorization: Bearer <VIMP_CLIENT_REPORTS_TOKEN>` and a 5 s timeout. An
entry carries the item's fields, the fingerprint, the box's `engineVersion`,
`box` (domain) and `mode`, and from the context `gameId`, `gameVersion`,
`role`, `page` and `userAgent`; the context fields are "first sender wins" in
auth and are not part of the fingerprint. A
failure (status other than 2xx, or a network error) puts the batch back into
the buffer until the next tick; a `400` from auth is not retried (it would
loop forever). Auth may answer `200` with `throttled > 0` — its own budget
cut some new rows; that is auth's decision, not a failure, and the batch is
not returned. On `SIGTERM`/`SIGINT` the lobby makes a final flush of the
buffer (`stopClientReports`, capped at 3 s so an unreachable auth cannot hang
the stop) and exits.

**The `reports.dropped` entry.** Whatever the budget and the full buffer
dropped since the last tick becomes one service entry at the head of the
next batch: `source: 'box'`, `kind: 'warn'`, `code: 'reports.dropped'`,
`count` = number dropped, `details: { budget, bufferFull, windowMs }`. Its
fingerprint includes the box domain, so each box has one row per engine
version whose `count` accumulates everything it ever dropped. A growing
`reports.dropped` means either spam or a genuine storm of distinct errors —
look at the rest of the journal to tell which.

**Process log lines** (`docker logs … 2>&1 | grep vimp:client-report`):

```
[vimp:client-report] new 1a2b3c4d error/client Cannot read … (tanks@0.22.7, engine 0.34.8)
[vimp:client-report] dropped 12 new reports (budget: 12, bufferFull: 0)
[vimp:client-report] forward failed: 503        // once per failure streak
[vimp:client-report] auth throttled 40 new reports  // at most once an hour
[vimp:client-report] forwarding disabled (no VIMP_CLIENT_REPORTS_TOKEN) — logging only
```

The `new` line is printed once per fingerprint per process (up to
`logSeenMax` remembered fingerprints; overflow clears the set).

**Without a token** (or without an auth service URL) the box still accepts,
fingerprints and logs every new fingerprint; the forwarding tick only emits
the `dropped` line, resets the counters and empties the buffer (otherwise it
would fill up after `maxPending` fingerprints and silence the log).
Receiving never breaks the box: an unexpected error answers `500 { "error":
"internal" }` and is logged.

**Stack symbolication.** The engine build emits _hidden_ source maps
(`sourcemap: 'hidden'` in `vite.config.js`: `*.map` files sit next to the
bundles in `dist/`, the bundles carry no `sourceMappingURL`). In production
the box decodes the stack of a **new** fingerprint before buffering it
(`symbolicate.js`) — a repeat is never decoded again. Each frame's URL
pathname is resolved to a file on the box's own disk: `/games/<id>[/<version>]/…`
through the game catalog (`parseGamePath` in `gameStatic.js` +
`GameCatalog.getDistDir`), anything else inside `packages/engine/dist/`. A
file outside the allowed roots (engine `dist/`, `VIMP_GAMES_DIR`,
`node_modules`), a non-`.js`/`.mjs` file, a missing map or one over 20 MB
leaves the frame raw; so does any error on a frame — one broken map never
breaks the rest. Up to 12 frames are decoded, parsed maps are kept in an LRU
of 20, the result is capped at 8000 characters. Firefox/Safari stacks have
no message line, so their first line is decoded too (a V8 message ending in
`url:line:col` is kept verbatim). At most 20 maps a minute are read and
parsed — past that the frame stays raw. A missing or unusable map costs
nothing from that budget and pushes nothing out of the LRU: it is
remembered separately (up to 1000 paths). Concurrent loads of one map are
merged into one read. A decoded frame reads
`at <name> (src/client/…:L:C) [/assets/<bundle>.js:L:C]` — the raw place
stays in brackets in case the map does not match. Game frames stay raw until
the game ships its own hidden maps. `denySourceMaps` (`httpSecurity.js`,
mounted right after the security headers, before `/games` and ViteExpress)
answers `404` to every `*.map` in production: the maps are for the box, not
for the outside. It checks the decoded path, case-insensitively —
`express.static` decodes the pathname itself, so `/a.js.%6dap` or
`/a.js%2Emap` would otherwise slip through. In dev nothing is decoded and Vite
serves maps to DevTools.

Settings: `master:clientReports` in
[configuration.md](configuration.md#packagesenginesrcconfigmasterjs).
Deploying the secret: [deployment.md](deployment.md#client-error-reports-secret-client_reports_token).

### GET/PATCH /admin/client-reports (client error journal)

The lobby's "Errors" panel ([client.md](client.md#the-errors-panel-clientreports))
reads and triages the central journal through its own master: the page's CSP
does not let the browser reach the auth service for this, and the admin's
token is already the master's business. Both routes sit behind
`adminAuth.required` (`401` without a valid token, `403` without the `admin`
claim), and the auth service then re-reads the role from its database
(`requireAdmin`) — a demoted admin loses the journal at once, not when the
token expires.

| Route                                                      | What it does                                |
| ---------------------------------------------------------- | ------------------------------------------- |
| `GET /admin/client-reports?status=&gameId=&limit=&offset=` | a page of the journal: `{ reports, total }` |
| `PATCH /admin/client-reports/:id` (`{ status, note? }`)    | the admin's decision on a row: `{ report }` |

The master is only a transport (`clientReportsRoutes.js` +
`ClientReportsProxy.js`): only `status`, `gameId`, `limit`, `offset` of the
query (strings only) and `status`, `note` of the body are passed on, `:id` is
URL-encoded, and the auth service's answer comes back with its own status and
body — validation and its `400 badRequest` / `404 unknownReport` belong to
the auth service ([auth.md](auth.md#client-reports)). A network failure is
`502 { "error": "authServiceUnavailable" }`. Dedicated servers have no admin
panel (no OAuth); the journal is shared, so any lobby master shows it.

## Signaling protocol (WebSocket)

Messages are JSON objects with a `type` field. On connect, the connection is
checked against an `Origin` allowlist (`security.createOriginValidator`; a
missing `Origin` terminates immediately, a foreign one closes with code
`4001`), then receives:

```json
{ "type": "welcome", "id": "<connection uuid>", "iceServers": [{ "urls": "stun:…" }] }
```

`iceServers` is the ICE configuration for `RTCPeerConnection` (STUN is required; TURN is an optional relay).

The client-side signaling counterpart — [packages/engine/src/client/network/SignalingClient.js](../../packages/engine/src/client/network/SignalingClient.js): connects to this WS, consumes `welcome`/`iceServers`, sends `webrtc_offer`/`ice_candidate`/`ping_host`, and relays incoming messages by `type`. Game traffic, once P2P is established, flows over WebRTC (`WebRtcManager`), bypassing the master — see [client.md](client.md#network-layer-packagesenginesrcclientnetwork) and [network.md](network.md#transport-webrtc).

### Host messages

| → to master                                                                                                | Response / effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register_host { gameId, gameVersion, maxPlayers, info, token, memberId, caps, settings }`                 | creates a room: `host_registered { roomId, epoch, roomSecret, gameId, mapsVersion, codeVersion }`; `info` — the lobby card text (`gameConfig.lobbyInfo`), optional (`mapName` from older pages is taken as it) (plus `hostId`/`hostSecret` — the same values under their old names, for pages loaded before the deploy); a `name` from such pages is ignored. Region — from the header, IP — from the connection; `token` — the host's Bearer identity-token, verified against the central auth service's JWKS (`JwksProxy`): its `sub` becomes `host.userId`, its `nick` the member's nick; missing/invalid → error `invalidToken`. `memberId` — the tab's id; the host is a member of its own room (without `memberId` the connection id is used); `caps` — the tab's capabilities (see [Successor](#member-rtt-and-successor)). `mapsVersion` — the declared game's `GameManifest.maps.version` via `GameCatalog`; `codeVersion` — composite `{ engine, game: { id, version } }` (see above) — on a reclaim after a disconnect (a deploy restarts the master) the host compares them to its own: a map mismatch triggers a catalog re-read, a mismatch in either `codeVersion` half triggers a Worker handoff. `settings` — the room settings (`maxPlayers`, `map`, `roundTime`, `mapTime`, `friendlyFire`; sanitized by `lib/roomSettings.js`, ≤ 4 KB, never public) handed to a cold successor. Errors: `alreadyRegistered`, `gameUnavailable` (`compat.ok === false` in the catalog), `hostLimit` (this IP already hosts a room) |
| `register_host { roomId, epoch, promotionToken, memberId, token, gameVersion, caps, settings }`            | the promoted successor takes the room in migration (see [Host migration](#host-migration)): the token's user must be the candidate's, `epoch` the room's `pendingEpoch`, `promotionToken` the one from `promote`. Reply `host_registered` with the new epoch and its secret; the per-IP limit does not apply. Errors: `staleEpoch` (the room is not migrating to this epoch any more), `invalidPromotion` (wrong token, user or epoch), `unknownRoom`, `invalidToken`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `reclaim_host { roomId, epoch, roomSecret, memberId, token, gameId, gameVersion, maxPlayers, info, caps }` | the same room after a signaling reconnect or a master restart. The token is verified (`invalidToken`), then `verifyRoomSecret(roomSecret, roomId, epoch, userId-from-token)` — a wrong secret, including the right secret presented by another user, → `invalidRoomSecret` (this is the anti-hijack check: a visible `roomId` is not enough). The room exists with the same epoch → the host session is rebound, reply `host_registered` (same `roomId`/`epoch`/`roomSecret`). The room is missing (the master restarted — the registry is in memory) → it is created anew with this `roomId`/`epoch` from the room fields of the message. The room's epoch is newer → `staleEpoch` (the host was replaced). The room is migrating away from this epoch: a migration caused by the host's signaling closing is cancelled (the reclaim proceeds, see [Host migration](#host-migration)), any other (`timeout`, `unresponsive`, `unreachable`) → `staleEpoch`. `settings` refresh the stored ones. The id belongs to another room → `roomTaken` (the client registers anew with `register_host`). A host that comes back gets `successor_assigned` again if the room has a successor. Also `hostLimit`, `gameUnavailable`, `alreadyRegistered`                                                                                                                                                                                                                                                                                           |
| `update_host { info }`                                                                                     | refreshes the room's lobby card text (`info: null` clears it, a missing field leaves it as is; `mapName` from older pages is taken as `info`); also a heartbeat. Accepted only from the room's current host; a `currentPlayers` field is ignored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `heartbeat {}`                                                                                             | updates `lastSeen`; only from the room's current host                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `webrtc_answer { clientId, sdp }`                                                                          | forwarded to the client as `webrtc_answer { roomId, hostId, epoch, sdp }` (`hostId` — alias of `roomId`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pong_host { clientId, pingId }`                                                                           | forwarded to the client as `pong_host { roomId, hostId, pingId }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `probe_ack { nonce }`                                                                                      | the host's main thread answers `probe` at once; accepted only from the room's current host with the nonce of the probe in flight                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `handoff_begin { roomId, epoch, reason, stay }`                                                            | planned handoff (host-migration stage 8, see [Planned handoff](#planned-handoff)): only from the room's current host; reply `handoff_go { roomId, epoch }` (the pending epoch) or `handoff_unavailable { roomId, epoch, reason }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `host_leaving { roomId, epoch }`                                                                           | the host's tab is closing (`pagehide`): the migration starts at once (`reason: 'leaving'`), without waiting for the WS to close; only from the room's current host with its epoch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `host_health { roomId, epoch, tickRate, peerRttMedian, peerCount }`                                        | the host's match health (host-migration stage 9c, every ~2 s from the latest Worker `health` sample, nothing while the match is frozen): the master's network-lag rule, see [Host network lag](#host-network-lag); only from the room's current host with its epoch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

| ← from master                                                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `successor_assigned { roomId, epoch, successorMemberId, successorClientId }` | the room's successor changed (`null` — nobody can be one): open the `standby` channel to the peer with this `memberId` and stream checkpoints to it ([host.md](host.md#standby-successor))                                                                                                                                                                                                                                                                                                |
| `probe { roomId, nonce }`                                                    | guests report the host unreachable — answer `probe_ack { nonce }`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `host_revoked { roomId, epoch }`                                             | another member took the room with this epoch: stop hosting and rejoin as a guest                                                                                                                                                                                                                                                                                                                                                                                                          |
| `handoff_go { roomId, epoch }`                                               | the planned handoff started, the successor is promoted to `epoch`: freeze the match and send it the final checkpoint                                                                                                                                                                                                                                                                                                                                                                      |
| `handoff_unavailable { roomId, epoch, reason }`                              | the handoff cannot start: `noSuccessor` (no successor with a live checkpoint stream), `busy` (the room is not `online`), `staleEpoch`                                                                                                                                                                                                                                                                                                                                                     |
| `host_released { roomId, epoch }`                                            | the successor took the room after a planned handoff: stop hosting (the role was given away, not taken)                                                                                                                                                                                                                                                                                                                                                                                    |
| `handoff_aborted { roomId, epoch }`                                          | the planned handoff failed (the successor missed `room.handoffTimeoutMs`, refused or left); the room stays yours with the same `epoch` — unfreeze the match                                                                                                                                                                                                                                                                                                                               |
| `request_handoff { roomId, epoch, reason, defer }`                           | the master asks the host to give the role to its successor (`reason: 'network'`, `defer: true` — at the round boundary, see [Host network lag](#host-network-lag); `reason: 'vote'`, `defer: false` — the players voted the host out, see [Change host vote](#change-host-vote), the page hands over at once whatever its automatic-trigger settings): start a planned handoff with `stay: true`; a host with automatic triggers disabled (or an old page) ignores it and is not punished |

The host keeps its signaling WS open permanently; the room's life is in
[Room lifecycle](#room-lifecycle).

### Client messages

| → to master                                                 | Response / effect                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `join_room { roomId, memberId, token, caps }`               | the client entered the room's match (sent after `AUTH_RESULT`, repeated with the same `memberId` after a signaling reconnect): the member is added or rebound; reply `room_joined { roomId, epoch }` (plus `standby_assigned` again if this member is the successor). `caps` — the tab's capabilities; a page without them never becomes a successor. Errors `unknownRoom`, `invalidToken`. A tab is a member of one room — joining another leaves the previous one |
| `leave_room { roomId }`                                     | the member is removed at once (no grace); ignored from the room's host                                                                                                                                                                                                                                                                                                                                                                                              |
| `member_update { roomId, caps }`                            | the member's capabilities changed (tab hidden/shown, ICE candidate type); the successor is re-picked at once. Ignored outside the sender's room                                                                                                                                                                                                                                                                                                                     |
| `standby_status { roomId, epoch, checkpointId, createdAt }` | the successor has a full checkpoint (sent on the first one, then every `migration.standbyStatusIntervalMs`); accepted only from the current successor of the current epoch, stored as `room.standby` (stage 7 picks the promotion mode by it)                                                                                                                                                                                                                       |
| `webrtc_offer { roomId, sdp, memberId, resume? }`           | routed to the room's current host as `webrtc_offer { clientId, sdp, memberId, resume, epoch }`; `hostId` is accepted as an alias of `roomId`. Error `{ code: 'unknownRoom', alias: 'unknownHost' }` (the old code kept for the transition); during a planned handoff — `{ code: 'migrating' }`, the client retries in 1 s                                                                                                                                           |
| `host_unreachable { roomId, epoch }`                        | the member's WebRTC link to the host broke; accepted from a member of the room with its current epoch, at most once per 2 s per member (see [Host migration](#host-migration))                                                                                                                                                                                                                                                                                      |
| `promote_failed { roomId, epoch, promotionToken }`          | the promoted successor could not start the match; recognised by `memberId` or, after a cold reload, by the token — the next candidate is promoted                                                                                                                                                                                                                                                                                                                   |
| `host_vote_start { roomId }`                                | a member (not the host) starts a "Change host" vote — the `/changehost` chat command, lobby mode only (see [Change host vote](#change-host-vote)). Errors: `{ code: 'voteRejected', reason }` (`host`, `active`, `roomCooldown`, `userCooldown`, `migrating`), `{ code: 'noSuccessor' }` (nobody could take the room). Ignored outside the sender's room                                                                                                            |
| `host_vote_answer { roomId, voteId, value }`                | the member's answer, `value` — `yes`/`no`; only from a member eligible in that vote, a repeat changes the answer                                                                                                                                                                                                                                                                                                                                                    |
| `ping_host { roomId, pingId }`                              | forwarded to the room's host (`hostId` accepted as an alias); rate-limited per IP (`pingRateLimit`, error `rateLimited`). The measurement is **approximate** (client→master→host, not P2P RTT)                                                                                                                                                                                                                                                                      |

| ← from master                                                                     | Meaning                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `room_closed { roomId, reason }`                                                  | the room is closed (`reason: 'noHost'` — the host was lost and nobody could take over); sent to every connected member except the host                                                                                                                                                               |
| `host_migrating { roomId, epoch, reason }`                                        | the host was lost, the room is migrating to `epoch`; `reason` — `disconnected`, `timeout`, `unresponsive`, `unreachable`, `leaving` (the host's tab closed), `vote` (the host was voted out and did not hand over); a planned handoff — `leave`, `handover`, `overload`, `hidden`, `network`, `vote` |
| `promote { roomId, epoch, promotionToken, mode, reason, settings }`               | this member is promoted: `mode: 'checkpoint'` — restore from the last checkpoint, `'cold'` — start the match anew with `settings`, `'planned'` — wait for the host's final checkpoint (or take the last periodic one); take the room with `register_host { roomId, epoch, promotionToken, … }`       |
| `promote_cancelled { roomId, epoch }`                                             | the promotion is withdrawn (deadline missed, `promote_failed`, the old host came back)                                                                                                                                                                                                               |
| `host_changed { roomId, epoch, mode, reason }`                                    | the room has a host of `epoch`: `checkpoint`/`planned` — resume to it, `cold` — reload into the room, `reclaimed` — the old host came back (same epoch), resume to it; `reason` — the migration's reason (`disconnected`, `handover`, `overload`, …), informational                                  |
| `standby_assigned { roomId, epoch }`                                              | this member is now the room's successor: expect the `standby` channel from the host                                                                                                                                                                                                                  |
| `standby_released { roomId }`                                                     | this member is no longer the successor: drop the checkpoints and the pre-warmed Worker                                                                                                                                                                                                               |
| `host_vote { roomId, voteId, initiatorNick, endsAt, durationMs, eligibleCount }`  | a "Change host" vote started: show the "Change host?" window for `durationMs` (counted from arrival — the clocks differ); sent to the eligible members except the initiator, never to the host                                                                                                       |
| `host_vote_started { roomId, voteId, endsAt, durationMs, eligibleCount }`         | to the initiator only: its vote started — the chat shows "Voting has started" (`v:1`), as for a host vote                                                                                                                                                                                            |
| `host_vote_accepted { roomId, voteId }`                                           | to the member whose `host_vote_answer` counted (a changed answer too): the chat shows "Your vote has been accepted" (`v:2`), as for a host vote                                                                                                                                                      |
| `host_vote_result { roomId, voteId, passed, yes, no, eligibleCount, cancelled? }` | the vote ended (to every member, the host included): `no` counts silence as against; `cancelled: true` — the host started changing or every eligible member left                                                                                                                                     |

### Shared messages

| → to master                             | Effect                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ice_candidate { targetId, candidate }` | forwarded to the target — a `clientId`, or a `roomId` resolved to the room's current host — as `ice_candidate { fromId, epoch?, candidate }`; from the host `fromId` is the `roomId` and `epoch` is set |

Errors arrive as `{ "type": "error", "code": "<code>" }` (`voteRejected` also carries `reason`). Invalid JSON and unknown `type` values are silently ignored — including `like_host`/`unlike_host` from clients that predate the removal of the server rating.

### Room lifecycle

A room is not the host's tab: it lives while it has a member. The master
tracks members itself (`join_room`, the host via `register_host`); a member
whose signaling closes is detached and still counts for
`room.memberGraceMs` (15 s) — a reconnect with the same `memberId` rebinds
it. `RoomRegistry.sweep` (every `host.sweepInterval`, 10 s) drops expired
members and empty rooms — except a migrating one: its only candidate may be
reloading its page longer than `room.memberGraceMs`, and the promotion
deadline closes it instead.

**Host lost.** A host whose signaling closed is detached and the room goes
into migration at once; a host still connected but silent for longer than
`host.heartbeatTimeout` (30 s) is lost too. A room is closed only when no
people remain — see [Host migration](#host-migration). While the room has no
bound host, offers to it get `unknownRoom`. When there is nobody to promote,
a room whose host's signaling closed stays `online` with the host detached
for `room.hostReclaimGraceMs` (10 s) — the P2P match may be intact and the
host may `reclaim_host`; past that the sweep migrates it if a candidate has
appeared, or closes it with `room_closed { reason: 'noHost' }`.

**Room secret.** `roomSecret = HMAC-SHA256(VIMP_ROOM_SECRET_KEY,
roomId:epoch:hostUserId)` in base64url — never stored, recomputed on demand.
It survives a master restart (the key comes from the environment), so after a
restart the registry is empty yet `reclaim_host` can still tell the real host
from anyone who saw the `roomId`; it is bound to the host's user (taken from
the verified token) and changes by itself with the epoch. Without
`VIMP_ROOM_SECRET_KEY` in development a random key is generated per process
and rooms do not survive a dev master restart (the host gets
`invalidRoomSecret` and registers a new room).

### Member RTT and successor

Host migration (stages 6+) needs a **successor** ("beta") in every room
with two or more people: a member that keeps a fresh checkpoint of the match
and a pre-warmed host Worker.

**RTT.** Every `room.rttProbeIntervalMs` (5 s) the master calls `ws.ping()`
on every session; on `pong` it updates an EMA of the RTT (α = 0.2) and of
the jitter (`|rtt − ema|`). `score = rttEma + 2 × jitterEma` is a single
"how well is this member connected" ruler, the same for the host and the
candidates. A session that has not answered `pong` for
`room.wsDeadAfterMs` (12 s) is terminated — a silently dead host is found
sooner than by `host.heartbeatTimeout`.

**Capabilities** (`caps`, sanitized to known fields): `canHost` (module
Worker, WebRTC, WebAssembly, not mobile), `mobile`, `hidden` (the tab is in
the background), `iceType` — the type of the member's own local ICE
candidate in the selected pair with the current host (`host`, `srflx`,
`prflx`, `relay`, or `null` while unknown). `relay` means the member needed
a relay to reach the host; as a host it would not reach part of the players
directly (TURN is optional). `fps` — a guest's mean render FPS over the report interval (stage 9c, sent in
`member_update` every `migration.auto.fpsReportIntervalMs`, 10 s; rounded,
outside 0…1000 or not a number → `null`).

**Picking** (`master/successor.js`, a pure function). Candidates: every
member except the host with a live session, `caps.canHost`, not
`caps.hidden`, in the room for at least `room.minMemberAgeMs` (10 s), not
`demotedUntil > now` (voted out, stage 10 — a cold emergency promotion
waives it when nobody else is able, see [Change host vote](#change-host-vote)), and with `caps.fps` not below
`room.minSuccessorFps` (30; an unknown FPS — an old page — does not
exclude, an emergency promotion ignores the threshold like `hidden`). Order: the connectivity tier first —
`host`/`srflx`/`prflx`, then unknown, then `relay` (a `relayPenalty` from a
failed promotion, stage 7, counts as `relay`) — then `score` ascending, then
who joined earlier. A `relay` member becomes the successor only when there
is no one else. **Hysteresis:** the current successor is kept unless it
stopped being a candidate, or the best candidate has a better tier or
`score ≤ room.successorSwitchRatio (0.65) × score(current)` for longer than
`room.successorSwitchSustainMs` (30 s) — a new successor costs a new warm-up
and traffic.

The pick is re-run on `join_room`, `leave_room`, a member's signaling
closing, `member_update`, the host coming back, and every
`room.successorReviewMs` (15 s; the hysteresis runs on this timer). The
room keeps `successorMemberId`; a change sends `standby_released` to the
previous successor, `standby_assigned` to the new one and
`successor_assigned` to the host. While the host is detached the successor
stays assigned.

### Host migration

`master/MigrationCoordinator.js` (host-migration stage 7), driven by
`SignalingServer`:

```
online(N) ──host lost──► migrating(N → N+1) ──register_host ok──► online(N+1)
                              │ deadline / promote_failed → next candidate (cold)
                              └ no candidates / no people → room_closed, removed
online(N) ──handoff_begin──► handing_off(N → N+1) ──register_host ok──► online(N+1)
                              │ deadline / promote_failed / successor left → online(N)
                              └ host lost → migrating (same candidate)
```

**Host lost** is any of: the host's WS closed (`disconnected`, at once — no
grace), no heartbeat for `host.heartbeatTimeout` (`timeout`, from the sweep),
no answer to a probe (`unresponsive`), a quorum of guest reports
(`unreachable`). Then:

- no live people besides the host → the room is removed (a lone host that
  only lost signaling gets it back via `reclaim_host`, which recreates it);
- nobody can be promoted (the same pick as below, run before anything
  changes) → for a host still answering (`unresponsive`, `unreachable`) or
  one that only lost signaling (`disconnected`) nothing happens — the host
  keeps the room, a detached one has the reclaim grace (see
  [Room lifecycle](#room-lifecycle)); after a heartbeat timeout or the
  grace → `room_closed { reason: 'noHost' }`;
- `status = 'migrating'`, `pendingEpoch = epoch + 1`; the host session, if
  still connected, stops being the room's host at once (its answers, ICE
  candidates and heartbeats are ignored; it stays a member); every member
  but the old host gets `host_migrating`;
- the candidate: the assigned successor whose `standby_status` arrived no
  more than `room.checkpointMaxAgeMs` (12 s; the status comes every 5 s, the
  master's own clock is used) ago → mode `checkpoint`; otherwise
  `pickSuccessor` without the `hidden` filter (in an emergency anyone able
  will do) → mode `cold`; candidates run out → `room_closed { reason:
'noHost' }`;
- `promote { …, promotionToken }` (128 random bits, one use) to the
  candidate; it must take the room within `room.promotionTimeoutMs` (10 s;
  `room.coldPromotionTimeoutMs`, 25 s, for `cold` — the candidate reloads
  its page). A missed deadline, `promote_failed` or, for a non-`cold`
  candidate, its closed WS (host and successor gone at once) →
  `promote_cancelled` to it and the next untried candidate in `cold`.

**Promotion.** `register_host { roomId, epoch, promotionToken, … }` with the
candidate's user, the pending epoch and the token → the room gets the new
host and epoch (`roomSecret` of the old host stops matching by itself), back
to `online`, a new successor is picked; the new host gets `host_registered`,
the old host (if its session lives) `host_revoked`, everybody else
`host_changed { epoch, mode }`. A cold candidate reloads its page: the new
session's `memberId` differs, the stale member record is dropped.

**Cancel by reclaim.** A migration caused by the host's signaling closing
(`disconnected`) is cancelled by `reclaim_host` of the same epoch before the
candidate registers: `promote_cancelled` to the candidate, `host_changed {
epoch: N, mode: 'reclaimed' }` to the members, and the host keeps the room.
The cancel happens only after every other reclaim check has passed (a
reclaim refused with `hostLimit` leaves the migration running). A forced
migration cannot be cancelled this way (`staleEpoch`).

**Guest reports and the probe.** `host_unreachable` with the current epoch
(at most once per 2 s per member). If the host's signaling is gone — host
lost at once. Otherwise the master sends the host `probe { nonce }`; no
`probe_ack` within `room.probeTimeoutMs` (2 s) → lost (`unresponsive`). The
host answers — and if reports from at least `max(1, ceil(live guests / 2))`
guests arrived within `room.reportWindowMs` (5 s), its P2P side is broken →
forced migration (`unreachable`). Forced migrations (by reports/probe) happen
at most once per `room.forcedMigrationCooldownMs` (30 s) per room; inside the
cooldown only the probe runs.

#### Planned handoff

Host-migration stage 8: the host gives the role away itself ("Leave
server", "Hand over host") — the successor continues from the same tick.
`handoff_begin { roomId, epoch, reason, stay }` from the current host:

- the room must be `online` with this `epoch` (`handoff_unavailable` with
  `busy`/`staleEpoch` otherwise), and its successor must be live with a
  `standby_status` no older than `room.checkpointMaxAgeMs` — the final
  checkpoint travels over the `standby` channel (`noSuccessor` otherwise; on
  `leave` the host leaves anyway and the emergency path takes over);
- `status = 'handing_off'`, `pendingEpoch = epoch + 1`; unlike a migration
  the host stays bound (heartbeats count, it still runs the match). The
  host gets `handoff_go`, the successor `promote { mode: 'planned' }`,
  everybody else `host_migrating { reason }` (`reason`: `leave`,
  `handover`, and the automatic `overload`, `hidden`, `network` of stage 9;
  an unknown one is taken as `handover`);
- offers of new guests get `error { code: 'migrating' }` — the client
  retries in 1 s, by then to the successor; the room is not listed in
  `GET /servers`;
- success — the successor's `register_host` as in a migration; the old host
  gets `host_released` instead of `host_revoked`, the members `host_changed
{ mode: 'planned' }`;
- failure — the successor missed `room.handoffTimeoutMs` (8 s), sent
  `promote_failed` or its WS closed → `promote_cancelled` to it,
  `handoff_aborted` to the host, `host_changed { epoch: N, mode: 'reclaimed'
}` to the members (they dropped their transport on `host_migrating` and
  resume to the same host), back to `online(N)`: the epoch grows only on a
  successful change;
- the host is lost mid-handoff (WS closed, heartbeat timeout,
  `host_leaving`) → the room becomes `migrating` with the same candidate: it
  gets `promote` again with the same epoch and token but `mode:
'checkpoint'` (no final checkpoint will come — restore the last periodic
  one at once) and the usual `room.promotionTimeoutMs`; its failure now
  moves on to the next candidate (`cold`) instead of aborting.
  `reclaim_host` during a handoff is refused with `staleEpoch`;
- while the host is changing (`handing_off`, `migrating`) the successor is
  not re-picked: the promoted successor and the host streaming the final
  checkpoint must see the same one; the pick resumes once the room is
  `online` again.

**`host_leaving { roomId, epoch }`** — the host's `pagehide`: an emergency
migration at once (`reason: 'leaving'`, not cancellable by `reclaim_host`),
the successor restores its last periodic checkpoint; nobody else in the
room → the room is closed.

#### Host network lag

Host-migration stage 9c. The host cannot compare itself with its successor
(the successor does not see the other players), so the master decides, by
the same `score` ruler for everybody (see
[Member RTT and successor](#member-rtt-and-successor)). On every
`host_health` of an `online` room with the current epoch:

- **lag** — `peerRttMedian > room.lagRttThresholdMs` (250) with `peerCount
≥ 1`, continuously for `room.lagSustainMs` (10 s). A sample at or below
  the threshold, `peerCount: 0`, `peerRttMedian: null`, a gap of more than
  5 s between reports (the match was frozen, or an old page) or a new epoch
  restarts the window;
- **hysteresis** — `score(successor) ≤ (1 − room.lagImprovementRatio) ×
score(host)` (0.35: at least 35 % better), both measured; the successor
  must be live with a fresh checkpoint stream (as for `handoff_begin`);
- **cooldown** — `room.autoMigrationCooldownMs` (90 s) since the room's
  last automatic host change and since the current host took the role.

Then the host gets `request_handoff { reason: 'network', defer: true }` and
the window restarts (a host that ignores it is asked again no sooner than
after another `lagSustainMs`). The handoff itself is the usual
`handoff_begin` (`reason: 'network'`). **`room.lastAutoMigrationAt`** is set
by every successful host change with an automatic reason — `overload`,
`hidden` (the host's own triggers) or `network`, also when the handoff
degraded into an emergency migration; a failed handoff does not set it. A
failed `network` handoff (the successor did not take the room, refused or
left) sets `room.lastLagHandoffFailedAt` instead: the lag rule stays quiet
for `room.autoMigrationCooldownMs` after it, so a failing successor does not
freeze the match every lag window.
The cooldown is shared, so a host that gave the role away for an overload
does not hand the room on to a successor with a bad network within 90 s.
`handoff_begin` with `overload`/`hidden` is never refused by this cooldown:
the match suffers right now, and the host's own tenure and cooldown limit
those.

**Epoch fencing.** `update_host`, `heartbeat`, `webrtc_answer` and host ICE
candidates count only from the session bound as the room's host; a stale
`register_host`/`reclaim_host` gets `staleEpoch`; offers and answers carry
`epoch`, so clients drop signaling of another epoch.

## Cheating host

The browser host physically runs the simulation in its own process — WASM
memory is reachable from its JS, and a modified client can cheat by bypassing
the core's logic. Technical defense against this is impossible without
moving authority back to a trusted server (which would defeat the point of
P2P). Heavier schemes (cross-validating host state through shadow
validators, server-side replay checks, cryptographic snapshot signatures)
were considered and rejected: they all ultimately trust a stream of
input/state controlled by the very host being checked.

The social server rating (`/like`·`/unlike`) that used to stand here has
been removed: with a dynamic host a "server's" rating means nothing. A bad
host — a cheat, a troll or just a weak machine — is replaced instead: by
the automatic triggers (overload, hidden tab, network lag, see
[Host migration](#host-migration)) and by the players'
[Change host vote](#change-host-vote). Both exist in lobby mode only.

## Change host vote

Host-migration stage 10, `master/HostVoteManager.js`. The master counts the
votes, not the host: the host runs the match and could filter a vote
against itself out of its own chat or vote modules. A member starts it with
the `/changehost` chat command (lobby mode only — the dedicated server and
the standalone SDK have one host by definition and no master to count; the
command reaches the game there as plain text). The vote menu of the game is
not touched.

- **Start** — `host_vote_start` from a member of the room, not its host;
  the room is `online`, no vote is running or waiting for its forced host
  change; `room.vote.roomVoteCooldownMs` (120 s) since the room's last vote
  started and `room.vote.userStartCooldownMs` (60 s) since this user last
  started one in the room; someone could take the room right now (the same
  candidate check as an emergency migration) — otherwise `noSuccessor`.
- **Eligible** — the room's live members (connected or in grace) except the
  host at the start; the initiator counts as "yes" and gets
  `host_vote_started` ("Voting has started" in its chat, as for a host
  vote). `host_vote` goes to the rest of them.
- **Outcome** — "yes" > half of the eligible members (strict majority),
  decided as soon as it is certain, otherwise when
  `room.vote.hostVoteDurationMs` (15 s) runs out — silence is "no". A member
  who leaves the room (`leave_room`, or its grace runs out) leaves the
  eligible set too and the majority is counted from those who remain; an
  empty set cancels the vote. A room of the host and one guest is decided by
  that guest alone — the cooldowns and `demotedUntil` keep that in check.
- **Cancel** — the host starts changing (a migration or a planned handoff
  begins): `host_vote_result { cancelled: true }`.
- **Passed** — the old host's **user** is barred until `now +
room.vote.demotedCooldownMs` (10 min; `room.demotedUsers`, so reloading
  the tab or rejoining with a new `memberId` does not lift it): neither
  successor nor host of the room meanwhile (`pickSuccessor`), unless an
  emergency migration finds nobody else able — the room matters more. The
  master remembers the vote itself (`room.votedOutEpoch`): any planned
  handoff of that host is recorded with `reason: 'vote'`, whatever reason
  its page sends. The host gets `request_handoff { reason: 'vote', defer:
false }` and hands over as usual (it stays as a guest; a handoff already
  waiting for the round boundary is hurried). If it has not started within
  `room.vote.voteForceAfterMs` (5 s) — an old page, a refusal — or the
  handoff fails, the master changes the host **by force**: the emergency
  path with `reason: 'vote'` (the host is unbound at once, the successor is
  promoted from its last checkpoint, the old host gets `host_revoked`). The
  forced-migration cooldown does not apply: the players decided, not
  network reports. When nobody can take the room (the last guest left), the
  host keeps the role and the room lives on.

## Protection

- **Origin allowlist** — the `packages/engine/src/lib/security.js` pattern (`createOriginValidator` with the master's parameters).
- **1 room per IP** — `RoomRegistry.add`/`restore`: an IP that hosts a room cannot host another (`hostLimit`).
- **Ping rate limiting** — `RateLimiter` (fixed window, 10 requests/sec per IP by default).
- **The address behind both limits** comes from `clientIp()` (`src/lib/clientIp.js`): the socket address, or `X-Real-IP` when the master runs behind a proxy (`trustProxy`, passed as `isProduction` from `lobby.js`). `X-Forwarded-For` is deliberately not used: the deploy's Nginx sets it with `$proxy_add_x_forwarded_for`, which _appends_ the real address to whatever the client sent, so its first hop is client-controlled — keying on it would let anyone lift both limits with one header, and claim someone else's bucket to keep them from hosting. `X-Real-IP` is set by the same Nginx with `$remote_addr`, overwriting anything the client sends. A proxy that fails to set it makes every client key on the proxy's own address — one shared bucket, so exactly one room could exist on the whole master; `clientIp()` logs a one-off warning when that happens, and [deployment.md](deployment.md#required-proxy-header-x-real-ip) lists the required `proxy_set_header`. A connection whose address cannot be determined at all (an already-broken socket) is terminated; the `error` listener is attached before that, so a late `ECONNRESET` on it cannot become an `uncaughtException`.
- **Security headers** (environment hygiene) — the master sets `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY` on every response; `Content-Security-Policy` only in production (it would break Vite HMR in dev). Production static assets and `.wasm` are served with CSP by Nginx — see [deployment.md](deployment.md); the policy's single source of truth is `packages/engine/src/config/master.js` (`security.csp`, a function of `authServiceUrl` — see [auth.md](auth.md#lobby-login-client) — so `connect-src` allows the lobby's `POST /nick` fetch to the central auth service; `security.authServiceUrl` is overridable via `VIMP_AUTH_SERVICE_URL` in production).
- **Registry submissions** — `POST /games/submit` and `POST /games/mine/:id/version` are limited to 5 requests per minute per user (`429 { "error": "tooManyRequests" }`). The limit sits **before** the npm fetch and the tarball unpack, which is work the master does at its own expense; the auth service's own per-IP limiter only ever sees a submission that already passed the package check. The id, the package name and the version are matched against `gameRefs.js` before any of that, so a malformed reference costs nothing.
- **A bad host** — the automatic handoff triggers and the
  [Change host vote](#change-host-vote), lobby mode only; the vote is
  counted by the master and bypasses the host.
- Input string sanitization (`sanitizeMessage`), clamping numeric fields.

## Tests

`tests/master/` (a node Vitest project): `RoomRegistry.test.js` (room creation, `roomId` collision, per-IP limit, members join/detach/leave/grace, `currentPlayers`, `sweep` — lost host, empty room — all `GET /servers` selection logic including `roomId`/`gameId`/`gameId/roomId` search, the public shape without name and rating, room-secret attribution), `roomSecret.test.js` (determinism, dependence on each field and the key, constant-time comparison, garbage input), `SignalingServer.test.js` (connection lifecycle, routing of every signaling message on fake ws sockets, identity-token verification against a real RSA-signed JWKS, `reclaim_host` — live room, after a master restart, hijack attempt, stale epoch — `join_room`/`leave_room`, `hostId` aliases, `room_closed` when nobody can take over, rate limiting, `like_host`/`unlike_host` ignored, `mapsVersion`/`codeVersion` in `host_registered`, per-game `mapsVersion` via a `gameCatalog` stub), `MapCatalog.test.js` (manifest, map serving, version stability), `WorkerCatalog.test.js` (bundle version hash and URL, empty catalog in dev, picking the newest of several), `GameCatalog.test.js` (resolving configured `{id, package}` entries to `node_modules/<package>/dist/manifest.json`, per-game map catalogs, unbuilt/unknown games, dev `/@fs/` entry rewriting), `JwksProxy.test.js` (proxying, TTL caching/expiry, upstream failure — injected `fetchImpl`), `PlayerDataProxy.test.js` (proxying GET/PUT `/rank`+`/state`, the public `getLeaderboard` (no `Authorization` header, `limit` in the query) and the per-user `getPlacement` — lobby page plan, no caching, upstream failure — injected `fetchImpl`), `LeaderboardCache.test.js` (miss calls the proxy, hit within TTL doesn't, refetch after TTL expiry, non-200 responses aren't cached, `game`/`limit` are separate cache keys — injected `now`, code review L2). The registry direction adds `GameRegistryProxy.test.js` (every registry call, token pass-through), `npmRegistry.test.js` (packument, version resolution, `integrity`/`shasum` mismatch, size and file-count ceilings), `gamePackageCheck.test.js` (the structural rules, no code executed), `GameStore.test.js` (download, idempotent `ensure`, staging never reaching the served tree, `prune`), `GameSync.test.js` (a pass, a registry outage leaving the catalog alone, a locally linked game winning, per-game `lastError`), `rebaseManifest.test.js` (versioned base, `wasmNode` untouched), `adminAuth.test.js` (signature, issuer, the `role` claim) and `lobbyGamesRoutes.test.js` (the submission and moderation handlers on stub dependencies). The client-error journal adds `ClientReportsProxy.test.js` (URL, Bearer, query without unset fields, encoded id) and `clientReportsRoutes.test.js` (field filtering, the auth status passed through, `502` on a network failure). Direct links add `roomRoutes.test.js` (`GET /rooms/:roomId`: `400`/`404`/`200`, hidden rooms, per-IP `429`). Host migration adds `MigrationCoordinator.test.js` (through `SignalingServer` on fake ws, a fake clock and a manual timer queue: promotion with a checkpoint and cold, the per-IP limit bypass, a cold reload, token/user/epoch checks, deadlines and `promote_failed`, no candidates, cancel by reclaim, reports, the probe, the quorum and the cooldown, the heartbeat timeout, the network-lag rule — threshold, continuity, the 35 % hysteresis, the shared automatic cooldown) and `tests/lib/roomSettings.test.js`. The
"Change host" vote adds `HostVoteManager.test.js` (the same harness: start
checks and cooldowns, who gets the window, answers and changed minds, an
early outcome, the timeout, a 1+1 room, leavers, the cancel, `demotedUntil`
in successor picking and its emergency exception, the forced host change
after `voteForceAfterMs` and after a failed handoff). The successor adds `successor.test.js` (candidate filters, connectivity tiers, the relay penalty, hysteresis on a fake clock) and a `SignalingServer.test.js` block (ping/pong EMA, terminating a dead session, `member_update`, assignment messages, `standby_status`). Rate limiter — `tests/lib/rateLimiter.test.js`.

---

[← Previous: Architecture](architecture.md) · [Next: Central Auth Service →](auth.md)
