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

Read in [packages/engine/src/master/main.js](../../packages/engine/src/master/main.js) when
`NODE_ENV=production` (`npm start` uses `node --env-file .env`). Ignored in
development — values from `packages/engine/src/config/master.js` apply instead.

| Variable | Purpose | Default |
| --- | --- | --- |
| `NODE_ENV` | `production` / `development` | — |
| `VIMP_DOMAIN` | The master's domain. **Required** in production (the process exits with an error otherwise) | `localhost` |
| `VIMP_MASTER_PORT` | The master server's port | `3002` |
| `VIMP_AUTH_SERVICE_URL` | The central auth service's origin (`packages/auth`), overrides `security.authServiceUrl` — used for the CSP `connect-src` and the `/auth/*` proxy routes ([auth.md](auth.md), [deployment.md](deployment.md#central-auth-service-packagesauth)) | `http://localhost:3010` |
| `GAMES_MATRIX` | JSON array overriding `master:games` (game-plugin list resolved by `GameCatalog`, `{id, package, version}[]`) — see [master.md](master.md#get-gamesmanifestjson-get-gamesidmanifestjson-get-gamesidmaps) | `[{"id":"tanks","package":"@vimp-games/tanks","version":"0.1.0"}]` |

Game parameters (map, player limit, timers, friendly fire) aren't set
through environment variables: the room's creator picks them in the lobby,
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
| `isDevMode` | `false` | Development-mode flag (unlocks dev chat commands) |
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

Canvas names, sizes, and zoom are game-owned; e.g. `vimp-tanks` defines
`vimp` (16:9, 5:1 zoom, dynamic camera, shake) and `radar` (150×150px,
1:8 scale).

### `modules.controls` — controls

- **`keySetList`** (game) — an array of `keyCode: 'command'` sets, entirely
  game-defined (e.g. `vimp-tanks` uses two: `[0]` — spectator (`n`/`p` —
  switch the watched player), `[1]` — player (`w/s/a/d` — movement,
  `k/l/u` — turret, `j` — fire, `n/p` — weapon switch)). Which set is
  active is dictated by the host over port `17` (KEYSET_DATA).
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
- `games` — the game-plugin list resolved by `GameCatalog`:
  `{id, package, version}[]` (default: `@vimp-games/tanks`). `package` is
  resolved as an ordinary `node_modules/` dependency (the game plugin's own
  repository, e.g. `vimp-tanks`, publishes it); `version` isn't used by
  `GameCatalog` itself — reserved for deploy-time version checks.
  Overridable in production via the `GAMES_MATRIX` env var (JSON);
- `servers` — `GET /servers` parameters: `regionThreshold: 15` (at or
  below this many rooms, the regional filter and pagination are disabled),
  `defaultLimit: 10`, `maxLimit: 50`;
- `leaderboard` — `GET /auth/leaderboard` parameters (code review L2, see
  [master.md](master.md#get-authleaderboard-get-authplacement)):
  `cacheTtl: 15000` (`LeaderboardCache`'s in-memory TTL, ms — this is the
  most frequent anonymous lobby request, and the underlying ranking changes
  slowly), `maxLimit: 100` (upper bound clamp for `?limit=`, replacing what
  used to be a hardcoded `100`);
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
[client.md](client.md#mvc-components-srcclientcomponents)). Unlike
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
- `leaderboardUrl: '/auth/leaderboard'`, `placementUrl: '/auth/placement'`,
  `leaderboardLimit: 10` (lobby page plan) — the master's proxied game
  leaderboard/placement endpoints (see
  [master.md](master.md#get-authleaderboard-get-authplacement)) and the
  top-N size requested for the Leaderboard tab; same origin as the master,
  so no CSP changes are needed;
- `reconnect` — the host's signaling WS reconnect: exponential backoff
  from `baseDelay: 1000` to `maxDelay: 30000` (ms);
- `pageSize: 10` — the page size for "Load more" (`offset`/`limit`);
- `pingInterval: 5000` — the minimum interval between repeated
  `ping_host` calls for one server (anti-spam while scrolling/redrawing);
- `elems` — lobby DOM element ids (from `lobby.pug`), including
  `nameId`/`hostBtnId` — the name field and the "create server" button
  (the browser host, [host.md](host.md)) — and, since the lobby page plan,
  the tab/leaderboard ids (`tabServersBtnId`, `tabLeaderboardBtnId`,
  `serversContentId`, `leaderboardContentId`, `leaderboardListId`,
  `leaderboardTitleId`, `leaderboardTotalId`, `myPlacementId`);
- `create` — room creation settings: `defaultName`, `maxPlayers` (≤ 8),
  `heartbeatInterval` (the master's `update_host` period),
  `hostSocketId: 'local'` — the loopback socketId of the host player (the
  Worker uses it to exclude the host from kick policies).

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
