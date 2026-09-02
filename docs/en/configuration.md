# Configuration

This page covers the **engine's own** configuration. The game plugin (e.g.
`@vimp-games/tanks`) supplies its own half through the plugin contract
(`HostPlugin.gameConfig`/`authSchema`/`buildClientGameConfig()`,
`ClientPlugin` — see [plugin-api.md](plugin-api.md)) and documents it in its
own repository's docs (e.g. `vimp-tanks`'s `docs/en/configuration.md`).

The engine's configuration splits into two layers:

1. **Environment variables** (`.env`) — parameters for a master server
   instance (domain, port). Only apply in production.
2. **`packages/engine/src/config/`** — shared config used by the master (Node.js), the
   browser host's Worker, and the client (Vite bundle).

The master collects its config into a single store,
`packages/engine/src/lib/config.js` (accessed via colon-separated paths), inside
[packages/engine/src/master/main.js](../../packages/engine/src/master/main.js); the host Worker
([packages/engine/src/host/host.worker.js](../../packages/engine/src/host/host.worker.js)) assembles the
game config as a merge of the engine defaults (`hostDefaults`) and the
game half from the `HostPlugin` loaded dynamically from the active game's
manifest (`gameConfig`, `authSchema`, `buildClientGameConfig()`), layering
the room's settings on top. The client receives its config (CONFIG_DATA)
from the host on connect (port `0`).

## Environment variables (.env)

Read by [packages/engine/src/config/env.js](../../packages/engine/src/config/env.js).
The lobby master applies them when `NODE_ENV=production` only (`npm start`
uses `node --env-file .env`); in development they are ignored and the values
from `packages/engine/src/config/master.js` apply instead. The
[dedicated server](dedicated.md) applies them **always** — the game, port and
room settings have no other source.

| Variable | Purpose | Default |
| --- | --- | --- |
| `NODE_ENV` | `production` / `development` | — |
| `VIMP_DOMAIN` | The master's domain. **Required** in production (the process exits with an error otherwise) | `localhost` |
| `VIMP_MASTER_PORT` | The master server's port | `3002` |
| `VIMP_AUTH_SERVICE_URL` | The central auth service's origin (`packages/auth`), overrides `security.authServiceUrl` — used for the CSP `connect-src` and the `/auth/*` proxy routes ([auth.md](auth.md), [deployment.md](deployment.md#central-auth-service-packagesauth)) | `http://localhost:3010` |
| `VIMP_DEDICATED_GAME` | The dedicated server's game — `<id>` or `<id>@<version>`; when set, `src/master/main.js` starts the [dedicated server](dedicated.md) instead of the lobby master | — |
| `VIMP_DEDICATED_ROOM` | JSON object with the dedicated room's overrides (`map`, `maxPlayers`, `roundTime`, `mapTime`, `friendlyFire`, `seed`); malformed JSON is a startup failure | `{}` |
| `VIMP_GAMES_DIR` | Root of the game package store the master downloads approved games into (`master:gameStore:dir`). In production this is a mounted volume, so the packages survive a container recreate | `<repoRoot>/.games` |
| `GAMES_MATRIX` | JSON array overriding `master:games` (the **static** game list, `{id, package}[]`), read in development too — see [master.md](master.md#get-gamesmanifestjson-get-gamesid-get-gamesidversion) | `[{"id":"tanks","package":"@vimp-games/tanks"}]` |

`GAMES_MATRIX` is no longer how a production catalog is set: games come from
the registry of the central auth service, and the master downloads them
itself. It stays an override for two cases — local development and a
self-hosted master running without a registry.

Outside production the catalog also **discovers itself**: with no
`GAMES_MATRIX` set, every built `@vimp-games/*` package found in
`node_modules` (an ordinary dependency or an `npm link` symlink) is added to
`master:games`, sorted by id and ahead of the configured entries
(`src/master/localGames.js`). So a linked game shows up in the lobby without
editing the engine's published config, and it **wins over the registry entry
with the same id** — that is what makes HMR development of a game possible.
The first entry of the catalog is the lobby's active game — set
`GAMES_MATRIX` locally when you need to pin which one that is.

Game parameters (map, player limit, timers, friendly fire) aren't set
through environment variables in the lobby contour (there `VIMP_DEDICATED_ROOM`
does not apply): the room's creator picks them in the lobby,
and defaults live in `packages/engine/src/config/hostDefaults.js` (engine)
and the active game plugin's own config (game).

`VIMP_AUTH_SERVICE_URL` has a build-time counterpart: `VITE_AUTH_SERVICE_URL`
is a Docker build `ARG` (not a runtime `.env` value) that Vite substitutes
into the client bundle's `authClient.js:serviceUrl` when the image is built
(`npm run build:app`) — see [auth.md](auth.md#lobby-login-client) and
[deployment.md](deployment.md#central-auth-service-packagesauth). Both are
set from the same `AUTH_SERVICE_URL` GitHub repository variable in
`deploy.yml`.

### Auth service (`packages/auth`)

Read in [packages/auth/src/main.js](../../packages/auth/src/main.js) when
`NODE_ENV=production`; the service exits at startup if any of these are
missing (see [auth.md](auth.md#running)).

| Variable | Purpose | Default |
| --- | --- | --- |
| `VIMP_AUTH_DATABASE_URL` | PostgreSQL connection string | `postgres://localhost:5432/vimp_auth` |
| `VIMP_AUTH_PORT` | The auth service's port | `3010` |
| `VIMP_AUTH_PUBLIC_URL` | Its own public origin, used to build the OAuth `redirect_uri`. **Required** in production | — (dev falls back to `http://localhost:PORT`) |
| `VIMP_AUTH_ALLOWED_ORIGINS` | CSV of master origins allowed to CORS `POST /nick` and to receive an OAuth redirect (`returnUrl`). **Required** in production | `https://localhost:3002` (dev only) |
| `VIMP_AUTH_STATE_SECRET` | HMAC secret for the stateless OAuth `state` param. **Required** in production | — |
| `VIMP_AUTH_GITHUB_CLIENT_ID` / `VIMP_AUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth App credentials. **Required** in production | — |

## packages/engine/src/config/hostDefaults.js — engine host defaults

Source: [packages/engine/src/config/hostDefaults.js](../../packages/engine/src/config/hostDefaults.js).
The engine half of the host config: limits, timers, kick policies, and the
spectator keyset (spectating is an engine mechanism). The host Worker
merges it with the active game plugin's `HostPlugin.gameConfig` and layers
the room's settings on top.

| Parameter | Value | Description |
| --- | --- | --- |
| `isDevMode` | `false` | Development-mode flag: unlocks dev chat commands and the debug recorder in `HostGame` ([debugging.md](debugging.md#the-recorder)). A room sets it from `room.isDevMode`, which the client fills from `import.meta.env.DEV` — in a production bundle it stays `false` |
| `maxPlayers` | `30` | The default participant limit; a host's room clamps it to the creator's setting (capped by the game's `roomDefaults.maxPlayers`), counted by humans |
| `chatMaxLength` | `60` | The max chat message length (authoritative on the host; must match the `maxlength` of the input in `chat.pug`) |
| `spectatorKeys` | `nextPlayer`/`prevPlayer` | Commands of a spectator or inactive player (switching the observed player) |

### Timers (`timers`, ms)

| Parameter | Value | Description |
| --- | --- | --- |
| `timeStep` | `1000/120` | The core's physics tick step (~120 Hz) |
| `networkSendRate` | `4` | A snapshot is sent every Nth tick (4 → 30 packets/sec) |
| `roundTime` | `120000` | Round duration |
| `mapTime` | `600000` | Map duration |
| `roomTimeMin` / `roomTimeMax` | `10000` / `3600000` | Server-side clamp bounds for the room's user-set `roundTime`/`mapTime` (the lobby form is not a trust boundary) |
| `voteTime` | `10000` | How long a vote window stays open |
| `timeBlockedVote` | `30000` | Cooldown between votes on the same topic |
| `teamChangeGracePeriod` | `10000` | The team-change window at round start |
| `roundRestartDelay` | `5000` | Pause between rounds |
| `mapChangeDelay` | `2000` | Pause before a map switch after a vote |
| `rttPingInterval` | `3000` | RTT ping interval |
| `idleCheckInterval` | `30000` | How often idleness is checked |

### Kicks (`rtt`, `idleKickTimeout`)

- `rtt.maxMissedPings: 5` — consecutive missed pong replies before a kick;
- `rtt.maxLatency: 1000` — smoothed (EMA) latency (ms) above which a
  player is kicked; the threshold is sized for P2P hosting over home
  connections (a real RTT of 200–300 ms and spikes at a map change are
  normal);
- `idleKickTimeout.player: 120000` — kicks an idle player (2 minutes);
- `idleKickTimeout.spectator: null` — `null` disables the kick (spectators
  are never kicked).

## The game half of the host config

The game half of the host config reaches the Worker as the active game
plugin's `HostPlugin.gameConfig` field (`host.worker.js` loads
`HostPlugin` dynamically by `entries.host` from the active
`GameManifest`) — parameters like `friendlyFire`, `mapScale`, `teams`,
`scripted`, `soundCues`, the `stat`/`panel`/`playerKeys` schemas, and
`playerState.defaultState`. This is entirely game-owned data; see the
active game plugin's own docs for its concrete values (e.g. `vimp-tanks`'s
`docs/en/configuration.md`). Player rank/state sync mechanics (engine
side) — [auth.md](auth.md#rank-and-state-loading-and-sync-host) and
[host.md](host.md#player-rank-and-state-sync-stage-b4); `rank` and `state`
are opaque as far as the engine is concerned — only the game interprets
their shape.

`spectatorKeys` — a spectator's commands (`nextPlayer`/`prevPlayer`); the
set is engine-owned and lives in
`packages/engine/src/config/hostDefaults.js`. `playerKeys` (a player's
commands) is game config, with a bitmask `key` (`1 << n`, used by the
predictor and the core in the input history) and an optional `type`:

- `type: 0` (default) — a repeatable action: starts on keyDown, ends on
  keyUp (movement, turret rotation);
- `type: 1` — fires once on keyDown.

## The client config: clientDefaults.js + the game's own client config

The client's CONFIG_DATA is assembled from two halves: the engine
defaults — [packages/engine/src/config/clientDefaults.js](../../packages/engine/src/config/clientDefaults.js)
(interpolation, control modes/service keys, the engine modules' DOM
structures, `techInformList`) and the game half, supplied by the active
game plugin's `HostPlugin.buildClientGameConfig()` (`parts.*`, canvases,
the player keyset, panel/stat schemas, chat/vote/gameInform texts,
`initIdList`). The deep merge is done by
[packages/engine/src/lib/buildClientConfig.js](../../packages/engine/src/lib/buildClientConfig.js) in the
host's Worker; before sending it appends:

- `modules.vote.params.time` = `game:timers:voteTime`;
- `prediction` — data for the client-side motion and shooting replica
  (`timeStep`, `playerKeys`, `models`, `weapons`, all game-owned).

The full table of which config fields are engine-owned vs. game-supplied
lives in [plugin-api.md](plugin-api.md#clientplugin-api) (`ClientPlugin API` section).

### `interpolation` — snapshot interpolation (engine)

- `delay: 100` — ms; the world renders in the past
  (`renderTime = serverNow − delay`), ~3 frames at 30 packets/sec;
- `maxFrameAge: 1000` — a safety cleanup of stale buffered frames.

### `divergence` — prediction divergence detector (engine, optional)

Absent from the production config, and then the frame path does nothing
extra. Consumed by the client core, set from a scenario's `divergence` field
in a headless run: `thresholds` (positional over the player block),
`defaultThreshold`, `capacity` (ring buffer). See
[debugging.md](debugging.md#prediction-divergence-detector).

### `modules.canvasManager` — canvases and camera

The common `dynamicCamera` parameters are engine-owned; the `canvases`
set is game-owned. The canvas elements are generated by `main.js` from
this config (the key is the element id; `width`/`height` — the initial
size before the first resize):

| Parameter | Description |
| --- | --- |
| `aspectRatio` | The aspect ratio (`'16:9'`). The canvas fills the window while keeping the ratio. Without it — 100% of the window |
| `fixSize` | A fixed size in px (`'150'` — a square, `'200:100'` — a rectangle). Disables `aspectRatio` and adaptive scaling |
| `baseScale` | The base zoom (`'numerator:denominator'`). For adaptive canvases — the scale at a reference width of 1920px (`result = width/1920 × baseScale`); for fixed ones — a constant multiplier |
| `dynamicCamera` | Enables the dynamic camera (look-ahead + speed-based zoom) |
| `shakeCamera` | Allows camera shake |

Adaptive scaling guarantees the same field of view on any monitor
(reference: Full HD, 1920px).

`dynamicCamera` (common parameters): `lookAheadFactor` (camera offset
ahead of motion), `zoomOutFactor`/`maxZoomOut` (zooming out with speed),
`smoothnessPosition`/`smoothnessZoom`/`smoothnessVelocity` (smoothing).

**`pointerCanvas`** (game, optional) — the canvas whose coordinate system
the pointer channel is converted into; the first declared canvas by default.

Canvas names, sizes, and zoom are game-owned; e.g. `vimp-tanks` defines
`vimp` (16:9, 5:1 zoom, dynamic camera, shake) and `radar` (150×150px,
1:8 scale).

### `modules.controls` — controls

- **`keySetList`** (game) — an array of `keyCode: 'command'` sets, entirely
  game-defined (e.g. `vimp-tanks` uses two: `[0]` — spectator (`n`/`p` —
  switch the watched player), `[1]` — player (`w/s/a/d` — movement,
  `k/l/u` — turret, `j` — fire, `n/p` — weapon switch)). Which set is
  active is dictated by the host over port `17` (KEYSET_DATA).
- **`pointer`** (game, optional) — the pointer channel (mouse/finger/stylus).
  Omit it and the engine attaches no pointer listener at all. Keys:
  `keySets` (indices of `keySetList` the channel is live in; default — all),
  `doubleTapMs` / `doubleTapPx` (double-tap thresholds, default `300` /
  `40`), `sendIntervalMs` (the floor between two `move` messages, default
  `50`). The wire format is `"seq:aim:x:y:flags"` with a **world** point;
  see [client.md](client.md) and
  [../ai/04-client-plugin.md](../ai/04-client-plugin.md).
- **`modes`** (engine) — UI modes: `c` — chat, `m` — vote, `tab` — stats.
- **`cmds`** (engine) — service keys (`escape`, `enter`), with top
  priority, used within modes.

### Other modules

DOM structures (`elems`) are engine-owned; texts and schemas are
game-owned:

- **`chat`** — DOM element ids, output limits (`listLimit: 5` lines,
  `lineTime: 15000` ms), and a cache — engine; **system message
  templates** (`messages`, game): a code registry of groups, engine-owned
  groups `s` (status/commands), `v` (votes), `m` (maps), `c` (teams), `n`
  (names) plus any groups the game plugin registers (e.g. `vimp-tanks`
  adds `b` for bots). The host only sends `'group:number:params'`, the
  client assembles the text.
- **`panel`** — the `containerId` container (engine); the mapping from
  server keys (`t`, `h`, `wa`, `w1`, `w2`) to fields (`keys`) and the
  typed field schema `fields` (game): an ordered list of
  `{ name, elem, type: 'bar'|'value'|'time'|'weapon', max?, blocks? }` —
  `PanelView` generates the panel DOM and rendering behavior from the
  types, not from field names.
- **`stat`** — the container id (engine); the `columns` labels, head/body
  tables (`heads`, `bodies`), and `sortList` (game) — `StatView` generates
  the scoreboard DOM from the schema; `sortList` — sort parameters: an
  array of `[cell index, descending?]` pairs; on a tie, comparison moves
  to the next pair.
- **`vote`** — DOM ids/classes (engine) and **vote templates**
  (`templates`, game): `[a title with {0} placeholders, options (an
  array — static, a string — request the list from the host), timeOff]`.
  `menu` — the main vote menu's items.
- **`gameInform`** / **`techInformList`** — templates for on-screen game
  messages (the element id — engine, the `list` texts — game) and
  technical screens (engine: room full, idle/latency kicks, etc.).
- **`initIdList`** (game) — which modules/canvases to initialize at
  startup (`vimp`, `radar`, `panel`, `chat`); the initialization
  mechanism is engine-owned (`main.js`).

## packages/engine/src/config/master.js

The master server's config (see [master.md](master.md)); read by
`packages/engine/src/master/main.js` (and `vite.config.js` — `httpsOptions` for dev HMR):

- `protocol`, `domain`, `port` — the address; the default port is `3002`
  (`3001` — Vite HMR). In production the domain is overridden by
  `VIMP_DOMAIN`, the port by `VIMP_MASTER_PORT`;
- `httpsOptions` — paths to local certificates
  `.certs/key.pem`/`cert.pem` (dev only; production HTTPS terminates at
  Nginx);
- `games` — the **static** game list, `{id, package}[]`, **empty by default**.
  The regular source of the catalog is the game registry of the central auth
  service, from which the master downloads approved packages itself
  (`GameSync`); this array and `GAMES_MATRIX` remain the override for local
  development (where it is also filled in from `node_modules`) and for a
  self-hosted master without a registry. `package` is resolved as an ordinary
  `node_modules/` dependency (the game plugin's own repository, e.g.
  `vimp-tanks`, publishes it), so the plugin version comes from the installed
  dependency, not from this list.
  An entry may also carry **`maxGameScore`** (snakes-v3) — the ceiling on the
  result of ONE game of that game, which the master clamps `best`/`points` of
  `PUT /auth/rank` by. For registry games an admin sets it while moderating;
  here it is only the fallback. Omitted, `master:playerData:maxGameScore`
  applies: a per-game number is the working limit, because one exact limit for
  hundreds of games is wrong by construction;
- `gameStore` — the game package store (the master downloads approved games
  from the npm registry and serves them from disk instead of receiving them as
  an npm dependency at image build time):
  - `dir: null` — the store's root; `null` means `<repoRoot>/.games`. In
    production it is set by `VIMP_GAMES_DIR` and mounted as a volume;
  - `registryUrl: 'https://registry.npmjs.org'` — the npm registry;
  - `refreshInterval: 60000` — how often the auth registry is polled for
    catalog changes, ms;
  - `maxTarballBytes: 67108864`, `maxFiles: 5000` — unpacking ceilings for an
    untrusted archive;
  - `keepVersions: 2` — how many versions of one game to keep on disk (the
    served one plus a staged one);
  - `timeout: 30000` — registry response timeout, ms;
- `servers` — `GET /servers` parameters: `regionThreshold: 15` (at or
  below this many rooms, the regional filter and pagination are disabled),
  `defaultLimit: 10`, `maxLimit: 50`;
- `leaderboard` — `GET /auth/leaderboard` parameters (code review L2, see
  [master.md](master.md#get-authleaderboard-get-authplacement)):
  `cacheTtl: 15000` (`LeaderboardCache`'s in-memory TTL, ms — this is the
  most frequent anonymous lobby request, and the underlying ranking changes
  slowly), `maxLimit: 100` (upper bound clamp for `?limit=`, replacing what
  used to be a hardcoded `100`);
- `placement` — `GET /auth/placement` and the aggregating
  `GET /auth/placements` (snakes-v3): `cacheTtl: 30000` — `PlacementCache`'s
  in-memory TTL, ms. A place moves slowly and costs more than the top does (a
  window function over the ledger), and every participant's join asks for
  three slices at once, so this cache is what keeps a busy lobby off the auth
  service;
- `playerData` — the ceiling on profile writes (snakes-v3, "hundreds of games,
  hundreds of servers"): `writesPerMinute: 120` — `PUT /auth/rank` +
  `PUT /auth/state` per **verified room** per minute, over it a `429`. An
  honest room of 32 at a five-minute flush interval writes ~13 a minute, so
  the rest is headroom for the urgent boundaries (a leaving participant
  bypasses the interval); the ceiling exists for a broken or malicious room,
  which is why the headroom is measured from an honest one. And
  `maxGameScore: 10000` — the default ceiling on the result of one game for a
  game that declares no `maxGameScore` of its own. The minimum interval
  between writes is held on the host side (`lobbyConfig.playerData`); this
  block is what stops a broken or malicious server that ignored it;
- `host` — room constraints: `maxNameLength: 30`, `maxPlayersLimit: 8`,
  `heartbeatTimeout: 30000` (a room without a heartbeat for longer is
  removed), `sweepInterval: 10000`;
- `rating` — server-rating defaults (`/like`·`/unlike`, replacing the old
  `/ban`, see [master.md](master.md#server-rating-likeunlike)): `min: -10`,
  `max: 10`, `blockAt: -10` (a hoster whose rating hits this score can't
  create rooms); `refreshInterval: 30000` — how often `main.js` calls
  `SignalingServer.refreshRatings()` to re-poll every active room's cached
  `rating` from the auth service (stage 3 — catches a score changed on a
  different master or after a restart). Mirrored in
  `packages/auth/src/config/auth.js` (`rating`) — the auth service is the
  one that actually clamps/decides `blocked`;
- `regionHeader: 'x-region'` — the header carrying a host's region from
  Nginx/CDN;
- `pingRateLimit` — the limit on signaling `ping_host` requests per IP
  (`limit: 10` over `windowMs: 1000`);
- `security` (environment hygiene) — `csp` (the Content-Security-Policy
  string: the single source of truth for the policy, set by the master on
  its own responses in production, authoritatively on static assets/
  `.wasm` — Nginx, see [deployment.md](deployment.md)) and
  `referrerPolicy: 'no-referrer'`; the master always sends
  `nosniff`/`X-Frame-Options`/`Referrer-Policy`, CSP only in production
  (it would break Vite HMR in dev);
- `iceServers` — ICE config for clients and hosts (STUN; TURN optional).

## packages/engine/src/config/lobby.js

The client lobby's config (see
[client.md](client.md#mvc-components-packagesenginesrcclientcomponents)). Unlike
`client.js`, it's **bundled into the build** rather than delivered by the
host: the lobby happens before connecting to a host.

- `serversUrl: '/servers'` — the master's server-list REST endpoint;
- `gamesManifestUrl: '/games/manifest.json'` — the master's game catalog
  (`GameCatalog`): the room-creation form's `roomDefaults` and the
  ClientPlugin come from here;
- `maps` — the master's map catalog, per-game function URLs:
  `manifestUrl: gameId => '/games/<id>/maps/manifest.json'`,
  `baseUrl: gameId => '/games/<id>/maps'` — a host's room starts on the
  active game's current maps (falls back to the bundle if unavailable);
- `game` — a specific game's manifest:
  `manifestUrl: gameId => '/games/<id>/manifest.json'` — the Worker handoff
  re-reads it before a swap so the new Worker gets fresh `entries.host/wasm`;
- `worker` — the master's worker bundle manifest:
  `manifestUrl: '/worker/manifest.json'` — the room's Worker is created
  from the `url` in the manifest, a `codeVersion` mismatch on re-register
  triggers a Worker handoff (falls back to the bundled URL with no code
  updates — dev/unavailability);
- `auth` — the auth endpoints the master proxies under its own origin:
  `jwksUrl: '/auth/jwks'` (the host Worker fetches it itself and verifies a
  joining player's identity-token signature, see
  [auth.md](auth.md#joining-a-room-host-verification)),
  `rankUrl: '/auth/rank'` / `stateUrl: '/auth/state'` (the host requests
  them with the player's identity-token on join and syncs back on
  round/map boundaries, see [host.md](host.md));
- `playerData` — everything `PlayerDataSync` needs, and the engine's own
  answer to "how often may a room write to the database" (snakes-v3). The
  endpoints: `rankUrl: '/auth/rank'` (a `PUT` of the game result
  `{ points, best }`), `stateUrl: '/auth/state'`,
  `placementsUrl: '/auth/placements'` (the aggregating route — all three
  slices in one round trip on join) and `placementUrl: '/auth/placement'`
  (one slice re-asked by `refreshPlacement`). The budget:
  `minFlushInterval: 300000` ms per participant, `flushJitter: 0.2` (±20 %
  per room, so hundreds of servers do not write on the same second),
  `maxRequestsPerSecond: 1` (the room's request queue — held strictly below
  the master's own ceiling, `master:playerData:writesPerMinute / 60 = 2/s`, so
  the queue throttles itself instead of learning its limit from a `429` that
  costs a round trip and drops the whole room into backoff),
  `backoff: { baseMs: 30000, maxMs: 900000 }` (the room's exponential backoff
  on `5xx`/`429`/network failures — both bounds are sized against
  `minFlushInterval`, because a pause SHORTER than the interval would delay
  nothing and leave the backoff as dead code) and `placementTtl: 30000` (the
  throttle on `refreshPlacement`).

  **Where the five minutes come from.** The target scale is 100 games × 100
  servers × 8 players = 80 000 players at once, and a participant with a fresh
  result costs two writes per interval: 80 000 × 2 / 60 s is 2700 writes a
  second, 80 000 × 2 / 300 s is 530. What is paid for it is the freshness of
  the GLOBAL ratings and nothing else — results merge in the room's memory
  (sums add, maxima take the maximum), so nothing is lost, the player sees
  their own numbers immediately, and the urgent boundaries still bypass the
  interval. Nothing is sent when nothing changed, so a quiet room
  writes nothing at all; a game only ever *requests* a flush;
- `leaderboardUrl: '/auth/leaderboard'`, `placementUrl: '/auth/placement'`,
  `leaderboardLimit: 10` (lobby page plan) — the master's proxied game
  leaderboard/placement endpoints (see
  [master.md](master.md#get-authleaderboard-get-authplacement)) and the
  top-N size requested for the Leaderboard tab; same origin as the master,
  so no CSP changes are needed;
- `leaderboardPeriods: [{ id, title }]` and
  `defaultLeaderboardPeriod: 'all'` (rank-periods) — the time slices offered
  above the Leaderboard list and the one open on arrival. The order is the
  order of the buttons, `id` travels to auth as `?period=` (so it must be one
  of `day`/`month`/`all` — anything else is a `400`), `title` goes into the
  list heading. `elems.periodBtnIds` maps each id to its button;
- `reconnect` — the host's signaling WS reconnect: exponential backoff
  from `baseDelay: 1000` to `maxDelay: 30000` (ms);
- `pageSize: 10` — the page size for "Load more" (`offset`/`limit`);
- `debugReportUrl: '/debug/report'` — the upload endpoint of the debugging
  loop (`window.__vimpDebug`); the master registers the route in dev only,
  see [debugging.md](debugging.md#upload-post-debugreport);
- `pingInterval: 5000` — the minimum interval between repeated
  `ping_host` calls for one server (anti-spam while scrolling/redrawing);
- `elems` — lobby DOM element ids (from `lobby.pug`), including
  `nameId`/`hostBtnId` — the name field and the "create server" button
  (the browser host, [host.md](host.md)) — `gameId` (the game picker,
  populated from the master's catalog) and `fieldsId` (the room-field
  container, generated from the active game's `roomDefaults` keys — the
  engine doesn't know the game's fields), and, since the lobby page plan,
  the tab/leaderboard ids (`tabServersBtnId`, `tabLeaderboardBtnId`,
  `serversContentId`, `leaderboardContentId`, `leaderboardListId`,
  `leaderboardTitleId`, `leaderboardTotalId`, `myPlacementId`);
- `create` — room creation settings: `defaultName`,
  `heartbeatInterval: 10000` (the master's `update_host` period; must be
  below `master.host.heartbeatTimeout`, 30 s, or the room gets swept),
  `hostSocketId: 'local'` — the loopback socketId of the host player (the
  Worker uses it to exclude the host from kick policies). The player limit,
  round/map time, friendly fire and the default map are **not** here: they
  come from the active game's `roomDefaults` in its manifest
  ([plugin-api.md](plugin-api.md#gamemanifest)).

## The game's auth config

The auth form schema (`HostPlugin.authSchema`: DOM element ids, form
parameters, the game's validators, texts) is entirely game-owned data; the
engine only provides the neutral `auth.pug` shell (title, help sections,
a `Start` button — no `name` field, see [auth.md](auth.md#joining-a-room-host-verification))
and `AuthView`, which fills in the game's title/help sections from `texts`.
`authSchema.params` typically declares only game-specific fields (e.g.
`vimp-tanks`'s `model`, validated by its own `isValidModel`); the engine's
`isValidName` ([packages/engine/src/lib/validators.js](../../packages/engine/src/lib/validators.js))
exists for a game that opts into a form-typed name field, but is unused by
the default form since the nick comes from the verified lobby identity
token, not user input. Validation runs on the client (with validators from
the game bundle) and is repeated by the host (Worker) as the actual
authority; only `elems`/`params`/`texts` travel over the wire (`AUTH_DATA`,
port 1) — the validator code doesn't. The game's own auth config is
documented in its own repo's docs.

## The game's sound catalog

The sound catalog (file names, priorities, volumes, loop flags, codec
list) is game data, served under the game's `assetsBase`. Playback
mechanics (voice limits, priorities) are engine-owned — see
[client.md](client.md#soundmanager).

## packages/engine/src/config/wsports.js and packages/engine/src/config/opcodes.js

- **`wsports.js`** — the numeric port registry for the game protocol
  (the source of truth). Full tables — [network.md](network.md#ports).
- **`opcodes.js`** — the binary snapshot format version
  (`SNAPSHOT_FORMAT_VERSION = 3`), `ENGINE_API_VERSION` and `HOT_FLAGS`.
  The snapshot key registry is game data, supplied through
  `HostPlugin.gameConfig.snapshot` (a numeric id + `kind` per key, which
  drives the block's byte layout). An unregistered key breaks frame
  packing. Details — [network.md](network.md#binary-snapshot-frame-port-5).
- **`gameCodes.js`** — the `GAME_INFORM_DATA` (port 7) message codes
  (`winnerTeam`/`roundStart`/`gameOver`), the source of truth shared by the
  host (`SocketManager.sendGameInform`) and the client (`GAME_ROUND_START_CODE`
  in `main.js`, which triggers the round-start panel/logo animation).

## lib/clock.js

Source: [packages/engine/src/lib/clock.js](../../packages/engine/src/lib/clock.js).
Not a config file but the injection point that makes a match reproducible:
a singleton (same idiom as `lib/config.js`) exposing `now()` (epoch ms,
`Date.now`), `monotonic()` (high resolution, `performance.now`), `random()`,
`setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`, plus
`install(custom)` (returns a rollback function) and `reset()`.

Every host timer goes through `lib/AbstractTimer.js`, which takes its timer
functions from `clock`; host call sites use `clock.now()`/`clock.monotonic()`
/`clock.random()` instead of the globals. Defaults resolve the globals at
call time, so production behaviour (and `vi.useFakeTimers()` in tests) is
unchanged, while the headless runner can swap in a `VirtualClock` and run a
ten-minute match in seconds — deterministically. See
[debugging.md](debugging.md).

## Game data (models, weapons, maps)

Model/tank parameters, weapon definitions, and maps are entirely
game-owned static data — see the active game plugin's own docs (e.g.
`vimp-tanks`'s `docs/en/configuration.md`) for their concrete shape and
values. One cross-cutting invariant to know as an engine contributor:
motion-model coefficients are typically shared between a game's
authoritative core and its client prediction replica, so games gate
changes to them behind their own cargo parity tests.

---

[← Previous: Network Protocol](network.md) · [Next: Deployment →](deployment.md)
