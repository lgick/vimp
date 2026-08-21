# Changelog

All notable changes to the npm package `vimp-engine` are documented here.
The Rust crate `vimp-engine-core` is versioned and released separately and
has its own journal: [core/CHANGELOG.md](core/CHANGELOG.md). The format is
based on [Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/) (in `0.x`, a breaking change
bumps the minor version).

## [Unreleased]

## [0.14.4] — 2026-08-21

### Changed

- The panel's line height follows its font size (16px for 14px text,
  `src/client/style.css`): at 12px the line box was shorter than the glyphs,
  so the bar only held together thanks to its own `height`/`overflow`.

## [0.14.3] — 2026-08-21

### Changed

- The panel's font size is 14px — 16px turned out to be too large for the
  24px bar (`src/client/style.css`, `b8efdb6`).

## [0.14.2] — 2026-08-21

### Changed

- The panel's font size is 16px instead of 10px, which was hard to read at
  the top of the canvas (`src/client/style.css`, `bb5418c`).

## [0.14.1] — 2026-08-21

### Fixed

- The hot buffer's `PREDICTED` flag is now raised when the game returned only
  its own predicted rows (`render_rows`) without a predicted record for the
  local actor: such a buffer used to be dropped by the client without being
  parsed at all, since both consumers gate the parse on
  `HOT_HAS_GAME | HOT_HAS_PREDICTED`.
- The hot-buffer reader rejects a truncated trailing record with an explicit
  error instead of silently producing a row with missing fields and walking
  past the end of the buffer.

## [0.14.0] — 2026-08-21

### Added

- Optional `ClientPlugin` hook `hooks.services(core)`: the game returns its own
  services, which are merged into the client's service pool next to the
  engine's own (`renderer`, `soundManager`, `localPlayer`, `assetsBase`) and
  reach a part through `componentDependencies`. That is how a part talks to the
  game core without the engine knowing what is handed over; engine keys win a
  name clash.
- `setId` in the `set_map` payload handed to the client core — the snapshot key
  the map's dynamics travels under (`c1`/`c2`), without which a game cannot tell
  its own dynamics block from another map constructor's.

## [0.13.0] — 2026-08-21

### Added

- The hot-buffer reader (`reconstructHot`) consumes the whole record tail
  instead of exactly one predicted record: besides the local actor's, a game
  core built on `vimp-engine-core` ≥ 0.7.0 may append rows for bodies it
  predicts itself (map dynamics, actors in contact), and each of them
  overrides the interpolated row of the same entity. Record width still comes
  from the game's snapshot schema, so the traversal invariant
  (`consumed === hot.length`, `devtools/invariants.js`) is unchanged.

## [0.12.0] — 2026-08-20

### Changed

- **Breaking.** `SNAPSHOT_FORMAT_VERSION` is 5. v4 gives a block schema an
  optional row tail (`optionalFrom`): the fields from that index on are
  written only when the row carries them, and a flag byte in front of the
  row says whether they follow — dynamic map elements use it to ship
  `[vx, vy, angvel]` only while they move, so a resting crate costs 12 bytes
  less every frame. v5 widens the reference plugin's tank row with `angvel`,
  which the client needs to predict how far another tank's hull turns during
  the interpolation delay. A client on the old version drops such frames:
  the engine and the game plugin have to ship as a matching pair.
  `ENGINE_API_VERSION` stays at 3 — `optionalFrom` is additive, an existing
  game's schema is still valid, and a frame is always packed and unpacked by
  the same plugin core off the same schema, so no already-published game
  becomes unloadable.
## [0.11.1] — 2026-08-20

### Fixed

- The lobby's game picker now actually hosts the game it shows. "Create
  server" was disabled whenever the picked game differed from the one loaded
  at bootstrap, so with more than one game in the master's catalog only the
  first entry could ever be hosted. The active game is no longer frozen:
  `src/client/lib/gameActivator.js` loads the picked game's `ClientPlugin` on
  click (cached per `gameId`, a failed load is not cached so a retry
  re-imports) and `bindActiveGame` re-points the manifest, the plugin and the
  injected game stylesheet at it, after which `roomDefaults` and the
  `room.game` entries sent to the Worker come from the picked manifest. The
  artificial gate (`src/client/lib/hostGate.js`) is gone.
- Joining a room of a game other than the loaded one connected with the wrong
  `ClientPlugin`. The `join` event now carries the room's `gameId`, and that
  game is activated before P2P is established; a host that sends no `gameId`
  (older than 6.4) still joins on the active game.
- A `ClientPlugin` that fails to load at lobby time is reported inline
  (`#lobby-error`) and leaves the lobby usable, instead of the bootstrap path
  that replaces the whole document body.

## [0.11.0] — 2026-08-19

### Added

- Pointer input (mouse, finger, stylus) as an engine primitive, opt-in per
  game through `modules.controls.pointer` (`keySets`, `doubleTapMs`,
  `doubleTapPx`, `sendIntervalMs`). `InputListener` now also listens to
  Pointer Events — one set covering mouse, finger and stylus, which is what
  makes a game playable on a phone (touch events did not exist here at all)
  — `ControlsModel` recognises the double tap itself (`dblclick` is not
  guaranteed on touch) and gates the channel exactly like the keys (input
  disabled, an open `chat`/`stat`/`vote`, a key set outside `keySets` — each
  mutes it and releases a held pointer), `CanvasManagerView.toWorld` turns
  the screen point into a world point (canvas of
  `modules.canvasManager.pointerCanvas`, the first one by default), and it
  travels the existing `KEYS_DATA` port as `'seq:aim:x:y:flags'` next to the
  byte-for-byte unchanged `'seq:action:name'`, reaching the core through
  `GameCoreAdapter.applyAim` / `ClientCore.apply_aim`. A game that does not
  declare `pointer` attaches no listener and sends nothing;
  `ENGINE_API_VERSION` is unchanged, because a core without the new trait
  method behaves exactly as before. Scenarios gained an `aim` op
  (`who`, `x`, `y`, `flags`) and `DebugRecorder` records it, so pointer
  input is replayable by `vimp-sim`. Canvases are created with
  `touch-action: none`, so a finger on the canvas plays the game instead of
  scrolling the page (`docs/ai/04-client-plugin.md`,
  `docs/{en,ru}/client.md`).

- The game catalog discovers itself outside production: with no
  `GAMES_MATRIX` set, every built `@vimp-games/*` package present in
  `node_modules` (an ordinary dependency or an `npm link` symlink) is added to
  `master:games`, sorted by id and ahead of the configured entries
  (`src/master/localGames.js`, used by both `src/master/lobby.js` and
  `src/dedicated/main.js`). A linked game now reaches the lobby without
  editing `src/config/master.js`, which ships with the package. The first
  catalog entry is the lobby's active game — set `GAMES_MATRIX` locally to
  pin the order.

- `localPlayer` — a fourth service in the part dependency pool
  (`{ id, is(id) }`, `src/client/lib/localPlayer.js`), plus the instance id
  itself, handed to every part as a fourth constructor argument
  (`{ id }`, `src/client/components/model/Game.js`; `{ id: null }` for an
  effect). Together they let a part tell the local player's entity from
  everyone else's — until now the id stayed inside `GameModel` and the
  client's own game id was only known to the client core, so a game could not
  play a cue for its player alone. Ask `localPlayer.is(id)` at the moment the
  answer is needed: entities are created from `FIRST_SHOT_DATA`, before the
  first player block, so a flag computed in the constructor is wrong exactly
  for the local entity. Both additions are backward compatible — a part that
  ignores the extra argument and a game that does not declare the service
  behave as before (`docs/ai/04-client-plugin.md`).

### Changed

- **Breaking:** the engine no longer parses any chat command of its own.
  `CommandProcessor` is a bare registry filled entirely from
  `HostPlugin.chatCommands`, so `/name`, `/nr`, `/timeleft`, `/mapname` and
  `/rank` are game code now — the same name may mean different things in two
  games, or exist in only one of them. Everything the old handlers used is
  still in the handler context (`roundManager`, `timerManager`,
  `playerDataSync`, `chat`, `isDevMode`); the `create-vimp-game` scaffold
  ships the three portable ones in `src/host/metaCommands.js`. Contract rule
  `B7` no longer reports "engine command" shadowing and checks the shape of
  the array instead: leading slash, a handler function, no duplicate names
  (`src/host/meta/core/CommandProcessor.js`,
  `src/devtools/contract/rules/b7-chat-commands.js`).
- The room capacity is declared by the game, not capped by the master: the
  upper bound of `maxPlayers` in `HostRegistry.add` now comes from
  `roomDefaults.maxPlayers` of the room's game manifest, resolved through the
  `gameMaxPlayers` option the lobby wires to `GameCatalog` — the same source
  the lobby's room form is seeded from (`src/master/HostRegistry.js`,
  `src/master/lobby.js`). `master:host:maxPlayersLimit` stays as the sanitary
  bound for a room whose game the master does not know (`gameId: null` from a
  pre-composition host, or an id outside the catalog) and keeps its default of
  8, so nothing that was accepted before is rejected now — a room registered by
  a known game is simply no longer clamped below what that game declares
  (`src/config/master.js`).

- Env overrides (`applyMasterEnv`) are read by the lobby master in
  development too, not only in production (`src/master/lobby.js`): the
  catalog is what `GAMES_MATRIX` mostly carries, and it was ignored exactly
  where a developer sets it by hand. `VIMP_DOMAIN` is still required in
  production and every other override is still guarded by its own presence
  check, so a dev run with no variables set behaves as before.

## [0.10.2] — 2026-08-18

### Changed

- `master:games` entries are now `{id, package}`: the `version` field was
  never read — `GameCatalog` resolves the plugin through `node_modules/` and
  takes its version from the package's own `dist/manifest.json`, so the pin
  lives in the root `package.json`. An entry that still carries `version` is
  ignored, not rejected, so an existing `GAMES_MATRIX` keeps working
  (`src/config/master.js`).

## [0.10.1] — 2026-08-18

### Fixed

- `roundTo2Decimals` JSDoc example referenced a nonexistent `round(value,
  precision)` signature; corrected to match the actual single-argument
  function (`src/lib/formatters.js`).

## [0.10.0] — 2026-08-18

### Added

- `vimp-contract` — a static contract checker for a game package, published
  as a second bin next to `vimp-sim`
  (`packages/engine/bin/vimp-contract.js`, rules in
  `packages/engine/src/devtools/contract/`). It reads `package.json`,
  `vite.config.js`, `core/Cargo.toml` and `dist/manifest.json`, imports both
  plugin halves as modules, and evaluates 32 rules over the result: packaging
  (`A1`–`A6`), host plugin (`B1`–`B10`), client plugin (`C1`–`C10`), snapshot
  schema (`D1`–`D3`) and shipped assets (`E1`–`E3`). Flags: `--game <path>`,
  `--json`, `--quiet`, `--strict`; exit code `1` on any `error`-level
  failure. A rule with no input returns `skip`, so the checker is usable from
  a plugin's first commit — and the `⚙`-marked half of
  `docs/ai/10-pitfalls.md` stops being a by-eye checklist. A rule that finds
  its file but not the data it needs (the `vimp-engine-core` pin, for one)
  reports that in the notes instead of passing, and a run where no rule
  found any input exits `1`. `files` now also publishes
  `core/Cargo.toml` — without the crate version in the tarball, rule `A5`
  could only check the pin inside this repository. Nothing is required from
  a plugin and `ENGINE_API_VERSION` is unchanged.
- `ParticipantManager.maxPlayers` — the room cap, readable by a game so it
  can clamp player input (`/spawn <count>`) before a loop instead of
  hammering `isFull` on every iteration.

### Fixed

- Draw order on the game canvas. `GameView.add()` passed a `layer`-based
  comparator to `stage.sortChildren()`, but PixiJS 8 takes no comparator
  there and skips the sort entirely unless the container is marked sortable
  and dirty — which never happened, because parts assign `zIndex` in their
  constructor, before `addChild`. Layers were painted in insertion order and
  a late-arriving map layer could silently cover the actors. The engine now
  sets `stage.sortableChildren` and calls `sortChildren()` with no
  arguments, so the documented `zIndex` contract holds.

## [0.9.0] — 2026-08-17

### ⚠️ Breaking

- The engine no longer serves any game image. `packages/engine/public/img/`
  (`tiles.png`, `tiles2.png`, `tiles3.png`, `b1.png`, `bob.jpg`,
  `stalin.jpg`) is gone, and with it the `/img/<name>` URL a plugin's `Map`
  part could rely on. Those files were never referenced by a single line of
  engine code — they were the tanks plugin's assets sitting in the engine's
  Vite `public/`, reachable only because the engine happens to serve that
  directory at the site root. A plugin that still requests `/img/*` gets a
  404 and renders an empty canvas with nothing in the console. Images now
  travel in the plugin package exactly as sounds already do.

### Added

- `assetsBase` in the client's `DependencyProvider` service pool
  (`renderer`, `soundManager`, `assetsBase`). It carries the active game's
  asset base from its manifest, so a part that draws from image files builds
  its own URLs — `${assetsBase}img/<file>` — the same way `SoundManager`
  resolves `${assetsBase}sounds/`. Declared like any other service, in the
  game's `parts.componentDependencies`. The engine keeps knowing nothing
  about file names or the layout inside the package.

### Migration

For a plugin that loaded images from the engine's `/img/`:

1. Move the files into your package (`assets/img/`) and copy them to
   `dist/img/` in the build — mirroring the sounds pipeline.
2. Declare the service in the client config:
   `componentDependencies: { assetsBase: ['Map'] }`.
3. Build the URL from it: `` `${dependencies.assetsBase}img/${data.spriteSheet.img}` ``
   instead of `` `/img/${data.spriteSheet.img}` ``. Throw when the service is
   missing — `undefined` as a base silently produces a blank map.

`ENGINE_API_VERSION` is unchanged (3): the addition is purely additive and
no manifest or plugin is rejected at load time. A plugin that keeps the old
URLs still loads — it just has nothing to draw.

## [0.8.0] — 2026-08-17

### Added

- `vimp-engine/host/PortMachine.js` — the client handshake automaton (client
  ports 0–8), lifted out of `host.worker.js` as an isomorphic module: no
  `self`, no `postMessage`, no DOM, all transport arriving through
  `makeSocket`. It can now be driven from a plain browser tab or a Node
  process, not only from the host Worker. `new PortMachine({ host,
  socketManager, clientCfg, authSchema, makeSocket, identity })`, methods
  `connect`/`restore`/`message`/`disconnect`/`has` and the `socketIds`
  getter. The lobby wire protocol is unchanged, byte for byte.
- `vimp-engine/host/identity.js` — pluggable identity strategies
  (`{ params, errorField, resolve(data, socketId) }`) for the port machine:
  `createTokenIdentity({ jwksUrl, issuer })` is the lobby path (the `nick`
  claim of an RS256 identity token verified against the master's JWKS, with
  the same per-instance cache the Worker used to hold), and
  `createGuestIdentity({ fallbackPrefix })` is the master-less one — it
  declares a `name` form field validated by the engine's own `isValidName`,
  and falls back to `Player_xxxx`. A strategy's `params` go in front of the
  game's `authSchema.params` in both directions, so a guest nickname reaches
  the client form through the same channel as the game's own fields — and as
  its first field.
- `vimp-engine/lib/offlinePlayerData.js` — `offlinePlayerData()` builds the
  `hostOptions.playerDataFetch` for a contour with no master: every profile
  request answers `{ rank: 0, state: null }` instead of hitting the network.
  It was the headless runner's private stub; the standalone and dedicated
  hosts need the same one.
- `HostGame.destroy()` — a public teardown (stop the timers, flush the
  profiles, remove every participant), returning the flush promise. A tab's
  match dies with its Worker, but a long-lived process needs a graceful
  shutdown.
- Client boot modes: `vimp-engine/client/boot.js` picks between `lobby`
  (the master, signaling and the OAuth gate — today's behaviour), `solo` (the
  host inline in the same tab) and `dedicated` (a direct WebSocket to a Node
  server). `setBootConfig(cfg)` is the SDK's injection point;
  `resolveBootConfig()` falls back to `GET /config` and then to
  `{ mode: 'lobby' }`, so a network failure, a 404 or a malformed body all
  keep existing deployments on the lobby path. `main.js` branches on the mode
  in five places only (manifest source, signaling/lobby, transport,
  auto-authentication, canvas mount point).
- `vimp-engine/client/network/WebSocketTransport.js` — the third
  transport, interface-compatible with `WebRtcManager`/`LoopbackTransport`.
  `binaryType` is forced to `'arraybuffer'`; `reliable` is ignored (a
  WebSocket has no reliability levels), which moves RTT measurement onto the
  TCP path and backpressure onto the server.
- `vimp-engine/client/network/InlineHostBridge.js` — a drop-in
  replacement for `HostController` that runs the authoritative host in the
  page's main thread (`createHostRuntime` + `PortMachine` + guest identity +
  `offlinePlayerData`), so `LoopbackTransport` is reused unchanged. A
  `HostPlugin` cannot cross `postMessage`, hence inline; the production
  Worker path is untouched.
- `vimp-engine/client/views/gameShell.js` — `ensureGameShell(container)`
  builds the game UI containers in code (idempotent, so the pug markup of the
  lobby build is left alone) and `ensureCanvas(id, size, container)` mounts a
  canvas into the boot container instead of `document.body`. A parity test
  keeps the two sources of markup from drifting.
- `vimp-engine/client/lib/autostart.js` — the solo autostart:
  `startupVotes` (leaving the spectators) strictly before `startupCommands`
  (the game's chat commands, e.g. spawning bots), both on the first
  `renderTick` after `FIRST_SHOT_READY`.
- `vimp-engine/standalone` — `startStandaloneGame({ hostPlugin, clientPlugin,
  wasmUrl, container, assetsBase, playerName, playerModel, auth, startupVotes,
  startupCommands, room, devMode })` runs a whole match inside one browser tab
  of a *game* repository: no master, no OAuth, no lobby screen. It takes the
  live plugin objects, checks both against `ENGINE_API_VERSION`, builds the UI
  shell and an in-memory manifest, and hands the boot config to the engine
  client; it resolves to `{ stop() }`, which tears the match down (render loop
  off, inline host destroyed). There is no `bots: N` option — the engine has
  no notion of a bot; scripted participants are spawned by the game's own chat
  command via `startupCommands`, and `startupVotes` must precede them.
  Documented in `docs/en/standalone.md`.
- `vimp-engine/client/main.js` exports `stopGame()` — the external stop used
  by the SDK; it closes the transport, which runs the existing teardown path.
- The published surface of the package grew to the client half of the engine:
  `files` now carries `src/client` (minus the `_*` scratch files) and
  `src/standalone`, with the new exports `./client/*`, `./standalone` and
  `./style.css`. Consequently `howler` moved from `devDependencies` to
  `dependencies` — it is imported by the published `src/client/SoundManager.js`.
  A consumer bundling the SDK must dedupe `pixi.js` (two copies mean two
  extension registries and a dead renderer).
- The dedicated Node.js server — `src/dedicated/main.js`: one authoritative
  match of one game inside a Node process, with browsers connecting over a
  direct WebSocket (`/game`) and no lobby, OAuth or WebRTC anywhere.
  `startDedicatedServer({ gameId, port, host, room, loadGame, serveClient })`
  is exported for tests and embedders; the process form is selected by
  `VIMP_DEDICATED_GAME`. It reuses `createHostRuntime`, `PortMachine`,
  `createGuestIdentity` and `offlinePlayerData`, serves the master's catalog
  routes for its single game, mirrors the Worker's frame format byte for byte,
  drops unreliable frames above 256 KB of `bufferedAmount`, validates
  `Origin`, and shuts down gracefully on `SIGTERM`/`SIGINT`. Being public and
  long-lived, it also caps what an anonymous socket can cost: a 64 KB
  `maxPayload`, 300 frames/s per socket, 30 connections/minute per address and
  a 120 s handshake timeout. Documented in `docs/en/dedicated.md`.
- `src/master/main.js` is now a dispatcher between `src/master/lobby.js` (the
  lobby master, the previous content of `main.js`, unchanged) and
  `src/dedicated/main.js`, so one entry point serves both roles.
- `GET /config` on both servers: `{ mode: 'lobby' }` from the master and
  `{ mode: 'dedicated', gameId, gameVersion, wsPath }` from the dedicated
  server — the single contract the engine client probes to pick its boot mode.
- `vimp-engine/lib/loadGamePackage.js` — `loadGamePackage(distDir, { core })`
  loads a built game package in Node (manifest, both plugin halves, the
  `file:` URL of `entries.wasmNode`), with the `engineApi` and stale-`dist/`
  checks and named failures when the node core is missing. Lifted out of
  `src/devtools/pluginLoader.js`, which now delegates to it: a production
  server must not depend on the debugging tooling.
- `vimp-engine/config/env.js` — `applyMasterEnv(config, env)` (the
  `VIMP_DOMAIN`, `VIMP_MASTER_PORT`, `VIMP_AUTH_SERVICE_URL`, `GAMES_MATRIX`
  overrides, previously inline in the master and production-only) and
  `readDedicatedRoom(env)` for `VIMP_DEDICATED_ROOM`. The dedicated server
  applies them in development too — the game, port and room have no other
  source.
- `vimp-engine/client/network/policyClose.js` — `shouldReloadAfterClose(code)`
  and `POLICY_CLOSE_INFORMS`, the client's rule for a server's policy close
  codes, split out of `client/main.js` so it can be tested.
- `vimp-engine/config/closeCodes.js` — the transport close codes as one map
  (`staleHost`, `invalidOrigin`, `blocked`, `kickForMaxLatency`,
  `kickForMissedPings`, `kickIdle`, `roomFull`, `handshakeTimeout`,
  `tooManyConnections`), a shared contract of the server circuits and the
  client the way `config/gameCodes.js` already is: every call site now names
  the code instead of spelling out a literal, and a test requires each entry
  to be classified by `policyClose.js`. The numbers are unchanged.

### Changed

- The page's base CSS rules (`html`/`body`, the screen-hiding rule,
  `body.hide-cursor`) moved from the inline `<style>` of
  `packages/engine/index.html` into `src/client/style.css`: a game
  repository has no `index.html` of ours, and without them every engine
  screen would show at once. The CSP hash of the inline importmap is
  unaffected. The published form of the hiding rule keys on the boot
  container — `.vimp-shell > *`, the class being set by `ensureGameShell` —
  so the screens stay hidden inside an SDK container, while the page
  embedding the SDK keeps its own top-level markup. `index.html` keeps the
  pre-JS form (`body > *`) inline: until the class is set there is no
  container to key on, and the pug markup would flash.
- The runtime-built vote window (`#vote`) is mounted into the boot container
  instead of `document.body`: in `solo` it used to land outside the SDK
  container, where it was both hidden and positioned against the wrong
  containing block.

### Fixed

- A dedicated server's policy refusal no longer puts the client in a reload
  loop. The client reloads the page 3 s after a disconnect, which is right for
  an ordinary drop and wrong for every close code the server uses to refuse a
  connection: reloading spends another connection against the same rate limit
  (4009), restarts the same handshake timer (4008), leaves the page's origin
  exactly as it was (4001) and does not free a room slot (4006). An abandoned
  tab reloaded forever, and a player waiting for a slot walked into the
  connection limit after 30 reloads and was shown its message instead of their
  own reason. The rule now lives in `vimp-engine/client/network/policyClose.js`
  (`shouldReloadAfterClose`, `POLICY_CLOSE_INFORMS`); the texts in that map are
  fallbacks, shown only when the server sent no reason of its own (`roomFull`
  arrives in a `TECH_INFORM` frame before the close and always wins).
- `vimp-engine/lib/clientIp.js` warns once per process when `trustProxy` is on
  but no `X-Real-IP` arrives. That combination silently keys every client on
  the proxy's own address — a single shared bucket, under which the master's
  "1 room per IP" rule allows one room on the whole server and the ping limit
  becomes global. It happens with a hand-written proxy config, a CDN in front,
  or an `/etc/nginx/vimp.template` older than the header.

### Security

- A `WebSocket` close reason is capped at 123 bytes, and `ws` enforces that by
  throwing: an `Origin` header longer than ~80 bytes made both the master's
  signaling server and the dedicated server answer a rejected connection with
  an over-long reason, raising an unhandled `RangeError` — an unauthenticated
  request could kill the process. The rejected client now gets the short
  `invalidOrigin` marker and the full text goes to the log.
- The dedicated server registers an `error` listener on every game socket (and
  on the WebSocket server): `ws` emits `'error'` on the socket itself
  (ECONNRESET, a malformed frame), and without a listener one broken client
  was an `uncaughtException` that took the whole match down.
- Rate limits no longer key on `X-Forwarded-For`. The deploy's Nginx sets that
  header with `$proxy_add_x_forwarded_for`, which *appends* the real address to
  whatever the client sent, so the first hop — the value the master's signaling
  server and the auth service used as their key — is written by the client:
  one header per request lifted the ping limit, the "one room per IP" rule and
  the auth service's nick-guessing and OAuth-start limits, and filling another
  address's bucket kept that person from hosting or signing in. The address now
  comes from the new `vimp-engine/lib/clientIp.js` — the socket address, or
  `X-Real-IP` when a `trustProxy` flag is set (production), where the same
  Nginx overwrites that header with `$remote_addr`. A signaling connection
  whose address cannot be determined is terminated instead of sharing one
  bucket with every other such connection, which also removes a `TypeError` on
  a socket that is already gone.
- The signaling server attaches its socket `error` listener before any early
  rejection, not after: both rejection paths call `ws.terminate()` and return,
  and the "no address" one runs precisely on an already-broken socket — the
  likeliest source of the late `ECONNRESET` that `ws` re-emits as `'error'`,
  which without a listener is an `uncaughtException`. The auth service answers
  `429` to a request with no address instead of counting it into a shared `''`
  bucket, and its rate limit moved into `packages/auth/src/lib/rateLimit.js`
  so that contract is covered by tests.

## [0.7.0] — 2026-08-09

Items marked *(app shell)* live in `src/client/**`, which is outside the
package `files`: they change the engine app, not the published artifact.

### Added

- Wasm ABI: `ClientCore.resync()` (from `vimp-engine-core`) — a clock resync
  after a long tab pause, network half only. The engine shell calls it as
  `clientCore?.resync?.()` on `visibilitychange` → visible, so a plugin
  built against an older crate keeps working; a plugin rebuilt on the new
  crate gets the method for free. `ENGINE_API_VERSION` is unchanged (**3**).
- WebGL context-loss handling in the client shell *(app shell)*: rendering is
  paused on `webglcontextlost`, and on `webglcontextrestored` assets are
  re-baked and the map is rebuilt from the cached `MAP_DATA` (no repeat
  `MAP_READY`) — every visible pixel is a GPU-only `RenderTexture` with no
  CPU source. Loss is tracked **per canvas** (`lib/contextTracker.js`): the
  browser restores each context separately, and re-baking into a still-dead
  one yields empty textures with no second event to fix them, so the scene
  is rebuilt only once every context is alive again.
- `SoundManager.releaseSound(id)` *(app shell)* — unregisters while letting
  an already playing one-shot finish, for entities that disappear earlier
  than their sound (a detonated bomb and its "planted" sample). A looped
  sound is still stopped.

### Changed

- `SoundManager.reset()` *(app shell)* no longer clears looped registrations,
  only stops the playing instances and their active ids: registrations belong
  to entities, and after a partial clear a surviving loop is restarted by the
  next `processAudibility()` instead of going silent for the rest of the
  session. One-shot registrations **are** dropped — `Howler.stop()` emits no
  `end`, so a sample that already played would otherwise be started over.
  `destroy()` still clears the whole registry.
- `RoundManager.createMap()` sends every human the spectator `KEYSET_DATA`
  right before `CLEAR`, so client prediction is off by the time the canvas
  is cleared and can no longer recreate the local entity as a ghost.
- `CanvasManagerModel` *(app shell)* ignores a zero-sized resize (minimized
  tab/window), which used to drive the scale to `0` and the renderer to
  `0x0` with no recovery until the next real resize; emitted sizes are
  clamped to `1`. `fixSize` now parses both parts as numbers — the height
  used to leak out as a string.
- `clientCore.resync()` *(app shell)* is called only after a tab pause of at
  least 3 s. A short alt-tab used to throw away a perfectly valid frame
  buffer together with its event frames (entity create/delete), freezing the
  scene for the interpolation delay and dropping removals.
- `BakingProvider` *(app shell)* destroys each baked object once per re-bake
  even when a baker returned it under several keys, and logs a failed
  `destroy` instead of swallowing it. A baker owns what it returns: re-baking
  destroys the result together with its `TextureSource`, so returning a view
  onto a shared atlas is not allowed.

## [0.6.0] — 2026-08-05

### ⚠️ Breaking — stricter `gameConfig` gate

The plugin API itself is unchanged: `ENGINE_API_VERSION` stays **3**, no
manifest restamp and no plugin rebuild are required. What changed is that
configs the engine used to accept and then fail on later — or silently
degrade on — are now rejected at load, naming the field:

- `teams` and `spectatorTeam` are **required** (`REQUIRED_GAME_CONFIG_PATHS`
  grew from seven paths to nine). They always were, de facto: without them
  `HostGame` dereferenced `undefined` and the game died in three different
  places with three unrelated messages.
- `spectatorTeam` must be a **key of `teams`**. A typo used to leave the
  spectator team id `undefined`, and the first participant to join crashed in
  `ParticipantManager.createHuman` on a team counter that does not exist.
- `null` in any required path now counts as **missing**. Previously only
  `undefined` did, so `snapshot: null` or `weapons: null` passed the gate and
  failed later, somewhere else.

**Migration.** If the host now refuses to start with
`gameConfig is missing required field(s): …` or
`spectatorTeam '…' is not a key of teams (…)`, the named field was already
broken — declare it (or spell it as one of the `teams` keys) and the plugin
loads as before. A plugin that passes today needs no change.

### Added

- `vimp-sim`: the built-in smoke scenario is now built from the game's own
  `gameConfig` — model from `parts.models`, playable team from `teams` minus
  `spectatorTeam`, and the first `playerKeys` entry that is not a `type: 1`
  trigger. It used to hardcode the engine fixture's `m1`/`team1`/`forward`,
  which crashed or failed a perfectly good third-party plugin.
- Scenario field `unusedSnapshotKeys: "*"` — "this scenario does not audit key
  coverage at all", which makes invariant 2 **skip** instead of reporting the
  game's keys as never spawning.
- `vimp-sim --core` without `--game` prints a notice: the run falls back to
  the fixture, whose core is plain JS, so the flag does nothing.

### Changed

- The `gameConfig` gate now runs inside `devtools/pluginLoader.js`, not only
  in `createHostRuntime` — the built-in scenario reads `gameConfig` before the
  run starts, so a plugin without one answered with a raw `TypeError`. The
  fixture goes through the same gate as a third-party plugin.
- Invariant 9 (`predictionDrift`) skipped by a scenario that sets
  `divergence: null` now says so, instead of blaming the client core for
  reporting no divergence data.
- `vimp-sim` usage errors (unknown option, missing option value) print the
  message and `USAGE` without a Node stack; `--scenario`/`--game`/`--core`/
  `--out` reject a missing value instead of silently falling back to the
  fixture.

### Fixed

- `vimp-sim --game <plugin>` no longer reports a false red verdict on a
  healthy game: the two invariants the built-in scenario cannot judge (2 —
  key coverage, 9 — prediction drift, whose thresholds are per-game) are
  skipped with a notice on stderr instead of being judged by the fixture's
  values.

## [0.5.0] — 2026-08-05

Code-review pass over the 0.4.0 debugging loop. No API change:
`ENGINE_API_VERSION` stays **3**.

### Added

- `GameManifest.entries.wasmNode` is now verified to exist at load. A manifest
  advertising a Node core that the published package did not ship failed with
  a raw `ERR_MODULE_NOT_FOUND` from the resolver; it now names the manifest,
  the declared path and the fix. Both plugin halves are additionally
  re-checked against the manifest's `engineApi`, which catches a rebuilt
  manifest sitting next to a stale `dist/`.
- Prediction-drift level 1 (`vimp-engine-core` 0.2.0): with
  `GameClientDef::predicted_state` implemented, the detector compares the
  core's own predicted state component-wise instead of the overlay camera.
- Browser debug requests to the Worker got a 5 s timeout — debugging is needed
  exactly on a hung Worker, where a silent `await` in the console is the very
  failure being investigated.

### Changed

- `RecordingSocketManager` now **inherits** `SocketManager` instead of
  re-declaring its ports, so a port added to the engine can no longer be
  invisible to the headless runner. Frames are published in wire order
  (a composite sender before the payloads it nests), and a second payload
  from one sender throws with the violated contract named instead of being
  silently overwritten.
- `ScenarioRunner`: frame-stream hashes are collected only under
  `--determinism` (a long match no longer carries megabytes of unused hashes
  into the report); the scenario's `config.timers` is merged explicitly;
  a leaving participant's client core is destroyed.

## [0.4.0] — 2026-08-04

Two large tracks: the headless debugging loop and the lobby page.
`ENGINE_API_VERSION` unchanged (**3**) — no plugin rebuild required.

### Added

- **Headless match runner** — `vimp-sim` (`packages/engine/bin/vimp-sim.js`,
  exposed as the package's bin) plus `src/devtools/`: virtual clock,
  recording transport, a real `ClientCore` per participant, scene dumps, and
  **12 invariant checks** that turn a silent contract break (a snapshot key
  that never spawns, a field-width drift, an uncovered `gameSets` class) into
  a named line of text. Root scripts: `npm run sim`, `sim:check`,
  `sim:replay`. Docs: `docs/en/debugging.md`, `docs/ru/debugging.md`.
- **`src/lib/createHostRuntime.js`** — the production match initialisation,
  now shared by `host.worker.js` and the runner, so the headless run cannot
  drift from the real one.
- **`src/lib/clock.js`** — a single injectable source of `now`/monotonic/
  random/timers, which is what makes a match reproducible under a virtual
  clock.
- **Browser half of the loop**: `DebugRecorder` in the host and
  `window.__vimpDebug` in the tab record a live match into the runner's
  scenario format; `POST /debug/report` on the master (dev only, 404 in
  production) collects the uploads into the same `.debug/` tree.
- **Rust core** (`vimp-engine-core` 0.2.0): `debug.rs` — a curated world dump
  behind `debug_json`; `client/divergence.rs` — a prediction-drift tracker
  behind `take_divergence`. Both arrive through the ABI macros, so a game
  implements nothing.
- **Lobby leaderboard**: `GET /auth/leaderboard` (public, no token) and
  `GET /auth/placement`, proxied by the master under the same origin (no CSP
  change), with a keyed TTL cache in front of the leaderboard
  (`master.leaderboard.cacheTtl`, `maxLimit`). Lobby config gained
  `leaderboardUrl`, `placementUrl`, `leaderboardLimit`.
- **`docs/ai/`** — a self-contained English spec of the plugin contract for
  an LLM authoring a game plugin, including a questionnaire and an authoring
  workflow.

### Changed

- Lobby page reworked: game selector filling from the master catalog,
  servers/leaderboard tabs, new panel and animations.
- `PlayerDataSync` no longer blocks a participant's entry: rank/state load
  asynchronously and an auth-service failure leaves engine defaults.

## [0.3.0] — 2026-07-30

### ⚠️ Breaking — plugin API v3 (`ENGINE_API_VERSION` 2 → 3)

The form-control set is reduced to **native form elements**:
`select` | `text` | `checkbox` | `radio`. `range`, `number`, `toggle` and
`segmented` are gone. A plugin whose `roomForm` or `authSchema.params[]`
still uses a removed control renders nothing for that field, and a plugin
built against v2 is rejected outright by `GameCatalog`, the host Worker and
the client.

### Added

- Native constraint validation on `control: 'text'`: `regExp` → `pattern`,
  plus `required` and `maxlength`; the engine calls `reportValidity()` on
  every control before submit (room form and auth form alike).
- `numeric: true` — a text field whose value is parsed as a number and
  converted through the same `unit` as the stored value. Empty or invalid
  input falls back to `default` instead of becoming `0` on submit.
- `hidden: true` — the field is built and submitted, but no row is rendered.

### Changed

- Controls are plain native elements with no themed markup, so a plugin's
  form always matches the rest of the page (≈160 lines of custom control CSS
  dropped).
- Silent token restore no longer shows an error: an expired or invalid stored
  token is dropped and a clean sign-in screen appears. `login-error`
  (`tokenExpired`/`invalidToken`) is emitted only on the interactive path
  (OAuth redirect, nickname submission) — a stale token on a return visit is
  expected, not an error.

### Migration (game plugins)

1. Bump the `vimp-engine` dependency to `^0.3.0` and rebuild so the manifest
   stamps `engineApi: 3`.
2. Replace removed controls: `range`/`number` → `text` with `numeric: true`
   (and an exact-range `regExp` generated by your manifest builder),
   `toggle` → `checkbox`, `segmented` → `radio` or `select`.
3. Republish; on the master, install the new plugin version and redeploy.

## [0.2.0] — 2026-07-28

### ⚠️ Breaking — plugin API v2 (`ENGINE_API_VERSION` 1 → 2)

Game plugins built against v1 are **rejected**: `GameCatalog` (master),
the host Worker, and the client all gate on `manifest.engineApi ===
ENGINE_API_VERSION`. A v1 plugin is silently dropped from the catalog, so a
server whose only game is a stale plugin reports **"master has no games in
its catalog"**. Every game plugin must be rebuilt against `vimp-engine@^0.2.0`
and republished so its manifest stamps `engineApi: 2`.

### Added

- **Explicit form-schema contract** for both in-app forms, rendered by the new
  shared module `src/client/lib/formBuilder.js`
  (`buildField`/`buildForm`/`mergeRoomDefaults`):
  - `GameManifest.roomForm` — the ordered field-descriptor array the
    "Create server" form is built from.
  - `authSchema.params[].options` — the same field-descriptor contract for the
    per-room player (auth) form, delivered over the wire in `PS_AUTH_DATA`.
  - Supported controls: `select`, `range` (with numeric readout), `number`,
    `toggle`, `segmented`, `text`. Numeric `min`/`max`/`step` are expressed in
    stored units (ms for `unit:'s'`); the engine converts them for display.
  - See [`docs/en/plugin-api.md` → Form schema](../../docs/en/plugin-api.md).
- Tokenized, theme-consistent styling for all form controls (design tokens in
  `:root`, shared `.panel`/`.btn`/`.form-row`, styled toggle/segmented/range/
  select) — same palette as before.

### Changed

- The engine no longer **infers** a control from a value's type. A manifest
  without `roomForm` renders an empty room form (with a console warning); an
  `authSchema` param without `options.control` is skipped (with a console
  error) instead of silently guessed.
- `roomDefaults` remains the single source of default values — the room form is
  seeded from it via `mergeRoomDefaults` (an explicit `descriptor.default`
  wins).
- `authSchema.elems`: **`formId` removed** (no longer used), **`fieldsId` added**
  (the `#auth-fields` container the engine renders player-setting controls into).

### Migration (game plugins, e.g. `vimp-tanks`)

1. Bump the `vimp-engine` dependency to `^0.2.0`, reinstall, and confirm the
   installed `ENGINE_API_VERSION` is `2` (the manifest's `engineApi` is stamped
   from it at build time).
2. Add `roomForm` to the manifest (one descriptor per `roomDefaults` key).
3. Give every `authSchema.params[].options` a `control`; drop `formId` and add
   `fieldsId: 'auth-fields'` in `authSchema.elems`.
4. Rebuild and verify `dist/manifest.json` shows `"engineApi": 2`, then
   republish. On the master, install the new plugin version and redeploy —
   startup should log `-> Games loaded: <id>`.

[0.14.4]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.14.4
[0.14.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.14.1
[0.14.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.14.0
[0.13.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.13.0
[0.11.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.11.1
[0.11.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.11.0
[0.10.2]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.10.2
[0.10.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.10.1
[0.10.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.10.0
[0.9.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.9.0
[0.8.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.8.0
[0.7.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.7.0
[0.6.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.6.0
[0.5.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.5.0
[0.4.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.4.0
[0.3.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.3.0
[0.2.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.2.0
