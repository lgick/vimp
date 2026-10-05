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

| Variable                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Default                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `NODE_ENV`                  | `production` / `development`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                       |
| `VIMP_DOMAIN`               | The master's domain. **Required** in production (the process exits with an error otherwise)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `localhost`             |
| `VIMP_MASTER_PORT`          | The master server's port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `3002`                  |
| `VIMP_AUTH_SERVICE_URL`     | The central auth service's origin (`packages/auth`), overrides `security.authServiceUrl` — used for the CSP `connect-src` and the `/auth/*` proxy routes ([auth.md](auth.md), [deployment.md](deployment.md#central-auth-service-packagesauth))                                                                                                                                                                                                                                                                                                                                                     | `http://localhost:3010` |
| `VIMP_DEDICATED_GAME`       | The dedicated server's game — a game id (`tanks`) or an npm package name (`@vimp-games/tanks`), either of them with a `@<version>` pin; when set, `src/master/main.js` starts the [dedicated server](dedicated.md) instead of the lobby master. A scoped package name is fetched straight from npm, so `VIMP_AUTH_SERVICE_URL` is not needed; only a game id has to be resolved through the registry                                                                                                                                                                                                | —                       |
| `VIMP_DEDICATED_ROOM`       | JSON object with the dedicated room's overrides (`map`, `maxPlayers`, `roundTime`, `mapTime`, `friendlyFire`, `seed`); malformed JSON is a startup failure. In production it is filled from the `settings` field of `SERVERS_MATRIX` ([deployment.md](deployment.md#dedicated-game-box-dedicatedgame))                                                                                                                                                                                                                                                                                              | `{}`                    |
| `VIMP_GAMES_DIR`            | Root of the game package store the master downloads approved games into (`master:gameStore:dir`). In production this is a mounted volume, so the packages survive a container recreate                                                                                                                                                                                                                                                                                                                                                                                                              | `<repoRoot>/.games`     |
| `VIMP_CLIENT_REPORTS_TOKEN` | Shared secret between the boxes and the auth service (`master:clientReports:token`): the box forwards client error reports to the auth service with it ([master.md](master.md#post-client-reports-client-error-reports)). Empty — forwarding is off, the box only logs new fingerprints. In production it comes from the `CLIENT_REPORTS_TOKEN` GitHub secret ([deployment.md](deployment.md#client-error-reports-secret-client_reports_token))                                                                                                                                                     | —                       |
| `VIMP_ROOM_SECRET_KEY`      | Key of the room secret (≥ 32 bytes): `roomSecret = HMAC-SHA256(key, roomId:epoch:hostUserId)` proves to the master that a tab hosts the room — for `PUT /auth/rank`·`/state` attribution and for `reclaim_host` after a master restart ([master.md](master.md#room-lifecycle)). **Required** for the lobby master in production (the process exits otherwise); in development a random key is generated per process, so rooms do not survive a dev master restart. In production it comes from the `ROOM_SECRET_KEY` GitHub secret ([deployment.md](deployment.md#room-secret-key-room_secret_key)) | — (dev: random)         |

**There is no environment variable for the game catalog.** The lobby master's
catalog comes from the game registry of the central auth service and from
nowhere else: games are submitted and moderated in the lobby, they live in the
auth service's Postgres, and the master downloads the approved packages
itself. An empty registry means an empty lobby — that is a legitimate state,
not a misconfiguration.

Outside production the catalog additionally **discovers itself**: every built
`@vimp-games/*` package found in `node_modules` (an ordinary dependency or an
`npm link` symlink) is added to `master:games`, sorted by id and ahead of the
configured entries (`src/master/localGames.js`). So a linked game shows up in
the lobby without editing the engine's published config, and it **wins over
the registry entry with the same id** — that is what makes HMR development of
a game possible. The first entry of the catalog is the lobby's active game.
In production this discovery is off: a package that happened to end up in the
image must not shadow the version that passed moderation.

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

| Variable                                                        | Purpose                                                                                                                                                                              | Default                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `VIMP_AUTH_DATABASE_URL`                                        | PostgreSQL connection string                                                                                                                                                         | `postgres://localhost:5432/vimp_auth`         |
| `VIMP_AUTH_PORT`                                                | The auth service's port                                                                                                                                                              | `3010`                                        |
| `VIMP_AUTH_PUBLIC_URL`                                          | Its own public origin, used to build the OAuth `redirect_uri`. **Required** in production                                                                                            | — (dev falls back to `http://localhost:PORT`) |
| `VIMP_AUTH_ALLOWED_ORIGINS`                                     | CSV of master origins allowed to CORS `POST /nick` and to receive an OAuth redirect (`returnUrl`). **Required** in production                                                        | `https://localhost:3002` (dev only)           |
| `VIMP_AUTH_STATE_SECRET`                                        | HMAC secret for the stateless OAuth `state` param. **Required** in production                                                                                                        | —                                             |
| `VIMP_AUTH_GITHUB_CLIENT_ID` / `VIMP_AUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth App credentials. **Required** in production                                                                                                                             | —                                             |
| `VIMP_ADMIN_NICKS`                                              | CSV of nicks granted `role = 'admin'` on every token issue. Optional; an unregistered nick on the list is claimed by whoever signs up with it first (see [auth.md](auth.md#running)) | — (no admins)                                 |
| `VIMP_ADMIN_IDENTITIES`                                         | CSV of `provider:uid` admin identities (`github:1234567`). Optional; while set it fully overrides `VIMP_ADMIN_NICKS`                                                                 | —                                             |

## packages/engine/src/config/hostDefaults.js — engine host defaults

Source: [packages/engine/src/config/hostDefaults.js](../../packages/engine/src/config/hostDefaults.js).
The engine half of the host config: limits, timers, kick policies, and the
spectator keyset (spectating is an engine mechanism). The host Worker
merges it with the active game plugin's `HostPlugin.gameConfig` and layers
the room's settings on top.

| Parameter       | Value                     | Description                                                                                                                                                                                                                                                          |
| --------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isDevMode`     | `false`                   | Development-mode flag: unlocks dev chat commands and the debug recorder in `HostGame` ([debugging.md](debugging.md#the-recorder)). A room sets it from `room.isDevMode`, which the client fills from `import.meta.env.DEV` — in a production bundle it stays `false` |
| `maxPlayers`    | `30`                      | The default participant limit; a host's room clamps it to the creator's setting (capped by the game's `roomDefaults.maxPlayers`), counted by humans                                                                                                                  |
| `chatMaxLength` | `60`                      | The max chat message length (authoritative on the host; must match the `maxlength` of the input in `chat.pug`)                                                                                                                                                       |
| `spectatorKeys` | `nextPlayer`/`prevPlayer` | Commands of a spectator or inactive player (switching the observed player)                                                                                                                                                                                           |

### Timers (`timers`, ms)

| Parameter                     | Value               | Description                                                                                                     |
| ----------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `timeStep`                    | `1000/120`          | The core's physics tick step (~120 Hz)                                                                          |
| `networkSendRate`             | `4`                 | A snapshot is sent every Nth tick (4 → 30 packets/sec)                                                          |
| `roundTime`                   | `120000`            | Round duration                                                                                                  |
| `mapTime`                     | `600000`            | Map duration                                                                                                    |
| `roomTimeMin` / `roomTimeMax` | `10000` / `3600000` | Server-side clamp bounds for the room's user-set `roundTime`/`mapTime` (the lobby form is not a trust boundary) |
| `voteTime`                    | `10000`             | How long a vote window stays open                                                                               |
| `timeBlockedVote`             | `30000`             | Cooldown between votes on the same topic                                                                        |
| `teamChangeGracePeriod`       | `10000`             | The team-change window at round start                                                                           |
| `roundRestartDelay`           | `5000`              | Pause between rounds                                                                                            |
| `mapChangeDelay`              | `2000`              | Pause before a map switch after a vote                                                                          |
| `rttPingInterval`             | `3000`              | RTT ping interval                                                                                               |
| `idleCheckInterval`           | `30000`             | How often idleness is checked                                                                                   |

### Kicks (`rtt`, `idleKickTimeout`)

- `rtt.maxMissedPings: 5` — consecutive missed pong replies before a kick;
- `rtt.maxLatency: 1000` — smoothed (EMA) latency (ms) above which a
  player is kicked; the threshold is sized for P2P hosting over home
  connections (a real RTT of 200–300 ms and spikes at a map change are
  normal);
- `idleKickTimeout.player: 120000` — kicks an idle player (2 minutes);
- `idleKickTimeout.spectator: null` — `null` disables the kick (spectators
  are never kicked).

### Session resume (host migration stage 4)

- `resumeGraceMs: 20000` — how long the host keeps the place of a
  participant whose connection dropped without `LEAVE` (slot taken, actor
  in the world, commands released, no RTT/idle kicks). Only the lobby
  Worker passes it to `PortMachine`; the dedicated server and the
  standalone SDK do not, and remove a participant at once;
- `resumeRequestTimeoutMs: 5000` — how long a resume connection may stay
  silent before `RESUME_REQUEST`; then it is closed with `4008`.

Details — [network.md](network.md#session-resume).

### Host checkpoints (host migration stage 5)

- `maxCheckpointBytes: 8388608` (8 MB) — the most a checkpoint may unpack
  to (`lib/checkpointCodec.js`); a bigger one is refused as a "zip bomb"
  from someone else's host. A raw tanks core dump is ~420 KB;
- `handoffFlushTimeoutMs: 3000` — how long the Worker handoff waits for the
  final profile sync (`PlayerDataSync.flushAll`) before handing its state to
  the new Worker; past it, whatever is unsent travels in the state;
- `resumeWaitMs: 3000` — how long a match a successor raised from a
  checkpoint stays paused waiting for the checkpoint's people to resume
  before it starts without them (their places are then kept for
  `resumeGraceMs`; host migration stage 7).

Details — [host.md](host.md#checkpoints),
[successor promotion](host.md#successor-promotion).

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

`coreParams` — an optional, opaque dictionary of the game core's **own**
parameters. `buildCoreConfig` merges it into the `game` half of the core
config (`hostPlugin.createCore(...)`), where the keys the engine does know
(`friendlyFire`, `models`, `weapons`, `playerKeys`, `panel`) win, so a game
cannot swap out the engine's part of the contract. The engine neither reads
nor validates the rest — it only delivers it to `GameSim::new`, which is
what lets a game add a parameter to its core without an engine release
(`vimp-tanks`, for one, passes the 2.5D fall parameters this way).

`mapFallTime` — seconds of falling per level of height (0.35 by default).
Unlike `coreParams` it is an **engine** key: `buildCoreConfig` puts it in the
`engine` half, because the trajectory (`FallModel` in the core) is shared by
whatever the game drops and by the map's own dynamic bodies, which the engine
steps itself. A map body that runs out of floor under it falls to the nearest
slab below.

A game with levels of its own usually owns that number already, in
`coreParams.levels.fallTime` — the value its core uses for tanks and for its
client-side prediction of the very same crates. Two independent fields would
send the host's crate and its own client's crate down at different speeds,
silently, so `buildCoreConfig` takes `coreParams.levels.fallTime` (when it is
a finite positive number) as `mapFallTime` too. The engine key stays the
default for games without levels, and an explicit override still wins over
both.

`maps[].levelHeight` — the height of one level in world units (unscaled, the
core applies the map scale itself; defaults to the tile size). It makes the
ramp slope dimensionless — `rise * levelHeight / span` instead of «levels per
pixel» — so climb constants (thrust, hull pitch, dust) can be tuned as
gradients. Validated by the core and by rule **E4**: finite and greater
than 0.

`maps[].volumes` (and `maps[].levels[n].volumes`) — an optional
`{ "<layers key>": height }` dictionary: the visual height of a render layer
in levels. It is validated by the core and by contract rule **E4** (the key
has to name a render layer of the same level, the height has to be within
`(0, 8]`), travels through the host untouched and reaches the render part as
`volume`; the geometry is the game's business.

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
`defaultThreshold`, `capacity` (ring buffer), `angles` (indices of angle
components, compared on the circle). See
[debugging.md](debugging.md#prediction-divergence-detector).

### `modules.canvasManager` — canvases and camera

The common `dynamicCamera` parameters are engine-owned; the `canvases`
set is game-owned. The canvas elements are generated by `main.js` from
this config (the key is the element id; `width`/`height` — the initial
size before the first resize):

| Parameter       | Description                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aspectRatio`   | The aspect ratio (`'16:9'`). The canvas fills the window while keeping the ratio. Without it — 100% of the window                                                                       |
| `fixSize`       | A fixed size in px (`'150'` — a square, `'200:100'` — a rectangle). Disables `aspectRatio` and adaptive scaling                                                                         |
| `baseScale`     | The base zoom (`'numerator:denominator'`). For adaptive canvases — the scale at a reference width of 1920px (`result = width/1920 × baseScale`); for fixed ones — a constant multiplier |
| `dynamicCamera` | Enables the dynamic camera (look-ahead + speed-based zoom)                                                                                                                              |
| `shakeCamera`   | Allows camera shake                                                                                                                                                                     |

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
  (`GameSync`). The array has no environment override and is left to two
  consumers: local development, where it is filled in from `node_modules`,
  and the [dedicated server](dedicated.md), which looks its game up here
  before going to the registry. `package` is resolved as an ordinary
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
  - `keepVersions: 2` — how many **served** versions of one game to keep on
    disk. An admin's staged draft is kept on top of this ceiling: it exists
    on disk only, while a served version can always be re-fetched from npm;
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
- `host` — room constraints: `maxPlayersLimit: 8`, `heartbeatTimeout: 30000`
  (a host without a heartbeat for longer is lost and its room migrates),
  `sweepInterval: 10000` (the room registry sweep period);
- `room` — room lifetime ([master.md](master.md#room-lifecycle)):
  `memberGraceMs: 15000` (a member whose signaling closed still counts as in
  the room — a reconnect window), `hostReclaimGraceMs: 10000` (the host's WS
  closing starts a migration at once; when nobody can be promoted the room
  waits this long for `reclaim_host`, then the sweep migrates or closes it), `maxInfoLength: 48` (the cap of the lobby card
  text a game sets through `gameConfig.lobbyInfo`/`lobby.setInfo`),
  `lookupRateLimit: { limit: 20, windowMs: 1000 }` (`GET /rooms/:roomId` and
  `GET /quickplay/:gameId` per IP, one shared bucket — against `roomId`
  enumeration); member RTT and the successor
  ([master.md](master.md#member-rtt-and-successor), host migration stage 6):
  `rttProbeIntervalMs: 5000` (`ws.ping()` of every session),
  `wsDeadAfterMs: 12000` (no `pong` for longer — the session is terminated),
  `minMemberAgeMs: 10000` (how long a member must be in the room to become
  the successor), `successorReviewMs: 15000` (the periodic re-pick),
  `successorSwitchSustainMs: 30000` and `successorSwitchRatio: 0.65` (the
  successor is replaced only by a candidate whose score is ≤ ratio × the
  current one's — or whose connectivity tier is better — for this long);
  emergency host migration ([master.md](master.md#host-migration), stage 7):
  `checkpointMaxAgeMs: 12000` (the successor is promoted with its checkpoint
  only if it received that checkpoint no longer ago — by
  `standby_status.ageMs`, more than two status periods; otherwise a cold
  promotion), `promotionTimeoutMs: 10000` and
  `coldPromotionTimeoutMs: 25000` (how long a promoted candidate has to take
  the room before the next one is tried; a cold one reloads its page),
  `probeTimeoutMs: 2000` (no `probe_ack` for longer — the host is lost),
  `reportWindowMs: 5000` (the window for the guest-report quorum),
  `forcedMigrationCooldownMs: 30000` (at most one migration by reports/probe
  per room within it), `minUnreachableReporters: 2` (reports and guests are
  counted per user; the quorum is `max(this, ceil(guest users / 2))`, and
  with fewer guest users reports never force a migration); planned host handoff ([master.md](master.md#planned-handoff),
  stage 8): `handoffTimeoutMs: 8000` (the successor did not take the room
  within it — the handoff is aborted and the host unfreezes the match);
  `migrationNoticeMarginMs: 5000` (`host_migrating.waitMs` is the current
  promotion's or handoff's deadline plus this margin — how long the guests
  wait for `host_changed`); the relations between these timings and the
  client's and the Worker's are checked by
  `tests/config/migrationTimings.test.js`;
  automatic triggers ([master.md](master.md#host-network-lag), stage 9c):
  `lagRttThresholdMs: 250` and `lagSustainMs: 10000` (the host's median RTT
  to its guests from `host_health` above the threshold for this long counts
  as lag), `lagImprovementRatio: 0.35` (the successor's score must be at
  least this much better than the host's), `autoMigrationCooldownMs: 90000`
  (since the room's last automatic host change — `overload`, `hidden`,
  `network` — and since the current host took the role), `minSuccessorFps:
30` (a member reporting a lower `caps.fps` is not picked as the successor;
  an unknown FPS does not exclude, an emergency promotion ignores it);
  `vote` — the "Change host" vote (stage 10, see
  [master.md](master.md#change-host-vote)): `hostVoteDurationMs: 15000`
  (how long a vote runs; silence is "no"), `roomVoteCooldownMs: 120000`
  (between vote starts in a room), `userStartCooldownMs: 60000` (between
  one user's starts in a room), `voteForceAfterMs: 5000` (a passed vote: the
  host has not started its handoff by then — or it failed — and is replaced
  by force), `demotedCooldownMs: 600000` (a voted-out host is neither
  successor nor host of the room meanwhile, unless nobody else can take it),
  `minVoterAgeMs: 30000` (a member votes and starts a vote only after this
  long in the room; votes are counted per user);
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
- `clientReports` — the client error journal
  ([master.md](master.md#post-client-reports-client-error-reports)):
  `token` (`VIMP_CLIENT_REPORTS_TOKEN`; empty — logging only),
  `flushIntervalMs: 30000`, `forwardBatch: 50`, `forwardTimeoutMs: 5000`,
  `maxPending: 500` (distinct fingerprints in the buffer), `logSeenMax: 5000`
  (fingerprints the process remembers as already logged),
  `newFingerprintsPerMinute: 60` (the box's budget of new fingerprints;
  repeats are free), `rateLimit: { limit: 30, windowMs: 60000 }` (per
  address, IPv6 by /64; the client sends at most every 10 s),
  `bodyLimit: '16kb'`, `maxItemsPerRequest: 10`;
- `iceServers` — ICE config for clients and hosts (STUN; TURN optional).

## packages/engine/src/config/lobby.js

The client lobby's config (see
[client.md](client.md#mvc-components-packagesenginesrcclientcomponents)). Unlike
`client.js`, it's **bundled into the build** rather than delivered by the
host: the lobby happens before connecting to a host.

- `serversUrl: '/servers'` — the master's server-list REST endpoint;
- `roomUrl: roomId => '/rooms/<roomId>'` — the room behind a direct link
  (`#/<gameId>/<roomId>`, [client.md](client.md));
- `quickPlayUrl: gameId => '/quickplay/<gameId>'` — the quick-play room the
  master picks ([master.md](master.md#get-quickplaygameid)); unavailable —
  picked from `GET /servers?search=<gameId>`;
- `quickPlay.autoCreate: true` — quick play (`#/<gameId>`) with no suitable
  room creates one with the creation form's defaults (`false` — show the
  lobby with that game selected); `quickPlay.createDelayMinMs: 500` …
  `createDelayMaxMs: 2000` — a random pause before creating, then
  `GET /servers` once more (host migration stage 7: the guests of a closed
  room arrive together and would each create a room);
- `roomMenu` — the in-match room menu: `elems` (`panelId` — the panel the menu button is moved into, `menuId`, `toggleId`,
  `listId`, `leaveId`, `handoverId`, `statusId`);
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
  `versionManifestUrl: (gameId, version) => '/games/<id>/<version>/manifest.json'`
  — the successor's pre-warm brings up the game version running in the
  room (host migration stage 6);
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
  writes nothing at all; a game only ever _requests_ a flush;

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
- `webrtc.connectTimeoutMs: 10000` — a guest's WebRTC attempt whose
  channels did not open in this time is closed (`WebRtcManager`);
  `webrtc.offerRetryMs: 1000` — the pause before re-sending an offer the
  master refused with `error { code: 'migrating' }` (a planned host
  handoff, stage 8);
- `migration` — host migration (stage 6; values from the stage 0
  measurements): `checkpointIntervalMs: 500` (the host's checkpoints for
  the successor), `standbyChunkBytes: 65536` (a chunk on the `standby`
  channel, header included — under the smallest `maxMessageSize` with a
  margin), `standbyHighWaterBytes: 1048576` (`bufferedAmount` above which a
  periodic checkpoint is skipped), `standbyStatusIntervalMs: 5000` (how
  often the successor reports its latest checkpoint, with its age, to the
  master), `maxRestoreAgeMs: 15000` (a promoted successor does not restore
  a checkpoint received longer ago — `promote_failed`, the master falls back
  to a cold start; above `master:room:checkpointMaxAgeMs` to allow for the
  status's travel), `standbyReopenDelayMs: 1000` …
  `standbyReopenMaxDelayMs: 10000` (exponential backoff before the host
  reopens a `standby` channel that closed while the successor's peer is
  alive), `finalWaitMs: 3000` (how long the successor of a planned handover, stage
  8, waits for the frozen host's final checkpoint before taking the latest
  periodic one), `handoffSlowMs: 3000` (no `handoff_go` in this time — the host reports a slow connection, the handoff goes on), `handoffDeadlineMs: 10000` (the planned handoff's single deadline from `handoff_begin` — `master:room:handoffTimeoutMs` plus room for the master's answer to travel back), `deferMaxMs: 30000` (the longest a planned handoff in a game without `migration.midRound` waits for the round boundary before it goes anyway, stage 8d), `peersReportIntervalMs: 15000` (how often the host repeats `room_peers` — the guests connected to it over WebRTC — to the master; on a peer change it goes at once, debounced 500 ms), `minTokenLifetimeMs: 600000` (a tab whose sign-in expires sooner reports `canHost: false` and declines a promotion — the host shows its token to the master mid-match and it is never renewed), `tokenHandoffLeadMs: 300000` (this long before its sign-in expires a host with a successor hands the role over — a planned handoff on the round boundary), `tokenHandoffRetryMs: 5000` (how soon that handoff is retried when there is no successor yet, a Worker relay is in progress or the handoff aborted; retries stop when the sign-in expires), `leaveFlushTimeoutMs: 3000` (how long "Leave server" of a host alone in the room waits for its Worker to write the participants' scores before closing the room — `HostController.shutdown`); `auto` — automatic handoff triggers (stage 9b, `HostHealthPolicy`, one sample = one Worker `health` message, ~1 s; see [host.md](host.md#automatic-triggers)): `enabled: true` (master switch), `overloadTickRate: 100` / `overloadWindowMs: 5000` (soft overload by the mean — the handoff waits for the round boundary), `criticalTickRate: 60` / `criticalWindowMs: 3000` and `lostWindows: 3` (hard overload by the mean or by `lostMs > 0` in a row — at once), `recoverTickRate: 110` / `recoverWindowMs: 5000` (every sample above — the deferred automatic handoff is cancelled), `hiddenHandoffMs: 1500` (hidden host tab — at once), `autoHandoffCooldownMs: 90000` (between this tab's automatic handoffs), `minHostTenureMs: 30000` (not right after taking the role), `hostHealthIntervalMs: 2000` (stage 9c: how often the host sends `host_health` to the master, from the latest sample; nothing while the match is frozen), `fpsReportIntervalMs: 10000` (how often a guest sends `member_update` with its mean render FPS over the interval in `caps.fps`); `enabled: false` also makes the host ignore the master's `request_handoff`;
- `session` — the guest's session supervisor (host migration stage 4,
  `SessionSupervisor`): `reconnectWindowMs: 15000` (how long after a drop
  to keep trying to get back into the match), `reconnectBaseDelayMs: 500` …
  `reconnectMaxDelayMs: 4000` (backoff between attempts),
  `hostSilenceMs: 3000` (no message from the host in a match, outside a map
  load — the transport is treated as dead); host migration stage 7:
  `migrationWaitMs: 40000` (how long after `host_migrating` to wait for
  `host_changed` — then the room counts as closed and the tab goes to quick
  play; longer than the master's search for a successor,
  `promotionTimeoutMs` + `coldPromotionTimeoutMs` = 35 s; the master's
  `host_migrating.waitMs` extends it, never shortens it),
  `migrationPollMs: 1000` (how often a room link re-asks
  `GET /rooms/:roomId` while the room is migrating);
  host migration review stage 9: `linkWaitMaxMs: 90000` (the cap of waiting
  on a room link whose room is changing its host — room for a chain of
  candidates; `404` ends it sooner), `resumeSilenceGraceMs: 3000` (after a
  resume and until the first frame the silence watchdog waits
  `hostSilenceMs` plus this — not below the Worker's `resumeWaitMs`, the
  pause of a match raised from a checkpoint); these and the timings above
  are tied to the master's and the Worker's, see
  `tests/config/migrationTimings.test.js`;
  host migration review stage 6: `joinRetryWindowMs: 45000` (how long a
  guest repeats `join_room` on `unknownRoom` after a master restart, until
  the host reclaims the room — longer than `reconnect.maxDelay` (the host's
  signaling backoff), with room for its `reclaim_host`; the pair is checked
  by `tests/config/migrationTimings.test.js`);
- `pageSize: 10` — the page size for "Load more" (`offset`/`limit`);
- `debugReportUrl: '/debug/report'` — the upload endpoint of the debugging
  loop (`window.__vimpDebug`); the master registers the route in dev only,
  see [debugging.md](debugging.md#upload-post-debugreport);
- `pingInterval: 5000` — the minimum interval between repeated
  `ping_host` calls for one server (anti-spam while scrolling/redrawing);
- `elems` — lobby DOM element ids (from `lobby.pug`), including
  `hostBtnId` — the "create server" button (the browser host,
  [host.md](host.md)) — `gameId` (the game picker,
  populated from the master's catalog) and `fieldsId` (the room-field
  container, generated from the active game's `roomDefaults` keys — the
  engine doesn't know the game's fields), and, since the lobby page plan,
  the tab/leaderboard ids (`tabServersBtnId`, `tabLeaderboardBtnId`,
  `serversContentId`, `leaderboardContentId`, `leaderboardListId`,
  `leaderboardTitleId`, `leaderboardTotalId`, `myPlacementId`);
- `create` — room creation settings (a room has no name — the master gives
  it a `roomId`): `heartbeatInterval: 10000` (the master's `update_host` period; must be
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
[client.md](client.md#soundmanager). The optional `parts.sounds.spatial`
block (projection profile, virtual elevation, spread radius, `PannerNode`
attributes) is documented there too; a game that omits it gets the engine
defaults. No `.env` variable is involved.

## packages/engine/src/config/wsports.js and packages/engine/src/config/opcodes.js

- **`wsports.js`** — the numeric port registry for the game protocol
  (the source of truth). Full tables — [network.md](network.md#ports).
- **`opcodes.js`** — the binary snapshot format version
  (`SNAPSHOT_FORMAT_VERSION = 5`), `ENGINE_API_VERSION` and `HOT_FLAGS`.
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
