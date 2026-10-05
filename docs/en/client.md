# Client Modules and Systems

The client is a browser app built on PixiJS (Vite build, Pug templates in
[packages/engine/src/client/views/](../../packages/engine/src/client/views/)). The entry point is
[packages/engine/src/client/main.js](../../packages/engine/src/client/main.js).

## Single shared PixiJS instance

The engine and the dynamically loaded game plugin (`@vimp-games/*`) must
resolve `pixi.js` to the exact same browser module — two independent
bundled copies mean two separate PixiJS extension/pipe registries, which
crashes rendering (`RenderTargetSystem` receiving a render target bound by
the "other" renderer's registry). This is enforced end to end:

- `pixi.js` is `external` in the engine's production build
  ([packages/engine/vite.config.js](../../packages/engine/vite.config.js))
  — the client chunk never bundles its own copy.
- [packages/engine/scripts/sync-pixi-vendor.mjs](../../packages/engine/scripts/sync-pixi-vendor.mjs)
  (run via `predev`/`prebuild`) uses esbuild to bundle `pixi.js` and
  `pixi.js/unsafe-eval` into self-contained ESM files with no bare
  imports (`bundle: true`, resolved via the package's `import` export
  condition — not the raw `lib/**/*.mjs` tree, whose files import their
  own npm dependencies, e.g. `eventemitter3`, by bare specifier and would
  fail to resolve in the browser) and `splitting: true`, so the two
  entries share one chunk of common classes — required for
  `pixi.js/unsafe-eval`'s prototype patches to land on the exact same
  class objects the main bundle uses. Output goes to
  `packages/engine/public/vendor/pixi/` — a generated, gitignored
  directory Vite serves/ships as static assets.
- [packages/engine/index.html](../../packages/engine/index.html) declares
  an `importmap` mapping the bare specifiers `pixi.js` and
  `pixi.js/unsafe-eval` to those bundled files, before the entry
  `<script type="module">` — the browser resolves both the engine's own
  import and the game plugin's externalized import to the same file.
- The game plugin's own build must externalize `pixi.js` too (as a
  `peerDependency`, not bundled) — this is the plugin-side half of the
  contract, done in the plugin's own repository.
- `pixi.js` is pinned to an exact version (no `^` range) in
  [packages/engine/package.json](../../packages/engine/package.json):
  nothing enforces that this version satisfies the plugin's
  `peerDependencies` range the way `GameCatalog` enforces
  `ENGINE_API_VERSION`, so an unpinned range could silently drift out of
  the plugin's supported range and reintroduce the dual-instance crash.

Engine and plugin releases that touch this must ship together: a plugin
built with `pixi.js` external cannot run standalone without the engine's
import map, and bumping the engine's `pixi.js` version out of sync with the
plugin's `peerDependencies` range reintroduces the dual-instance crash.

## Boot modes (`boot.js`)

There is exactly one engine client, and it runs in three contours. The mode
is resolved by `packages/engine/src/client/boot.js` before `main.js` does
anything else:

| Mode        | Master                          | Host                              | Transport         |
| ----------- | ------------------------------- | --------------------------------- | ----------------- |
| `lobby`     | yes (catalog, signaling, OAuth) | Web Worker in the host's tab      | WebRTC / loopback |
| `solo`      | no                              | inline, in the page's main thread | loopback          |
| `dedicated` | no                              | a Node.js process                 | WebSocket         |

`resolveBootConfig()` returns, in order of preference: the config injected by
the standalone SDK (`setBootConfig(cfg)`), then `GET /config` (served by a
dedicated server), and finally `{ mode: 'lobby' }` — a network failure, a 404
or a malformed body all mean "production lobby", so existing deployments are
unaffected. The channel between the SDK and `main.js` is the module's own
state: both resolve `boot.js` to the same instance in the bundler graph, so
no globals are put on `window`.

Config shape (all fields but `mode` are optional): `container` (mount point
for the shell and canvases), `manifest`, `clientPlugin`, `hostPlugin`,
`room`, `autoAuth`, `startupVotes`, `startupCommands` (solo), `wsUrl`,
`gameId` (dedicated).

`main.js` branches on the mode in exactly five places: the manifest/plugin
source, signaling + lobby, the
transport, auto-authentication with autostart, and the canvas mount point.
Everything else — the dispatcher, MVC modules, ClientCore, the render loop —
is identical in all three modes.

Two properties fall out of this for free and are worth stating: `solo` and
`dedicated` never call `ensureWebRtcAvailable()` or `supportsModuleWorker()`
(both live on lobby paths only), so the game starts in a browser with WebRTC
disabled and without module-Worker support.

### DOM shell (`views/gameShell.js`)

Production markup comes from pug (`views/includes/*.pug`), but the
standalone SDK embeds into the game repository's page where there is no pug —
while the engine's modules look elements up by fixed ids. `ensureGameShell(container)`
builds the missing ones (`#panel`+`#logo`, `#chat`+`#chat-box`+`#cmd`,
`#stat`, `#auth`+its form nodes, `#game-informer`, `#tech-informer`) and is
idempotent: in `lobby` mode, where the markup already exists, it does
nothing. `#vote` is not created here (`components/view/Vote.js` builds it at
runtime **inside the boot container**), and neither are the canvases — their
sizes arrive in `CONFIG_DATA`, so `ensureCanvas(id, size, container)` handles
them from the `CONFIG_DATA` handler. A `<canvas>` the game already placed in
the document is reused as is and never moved.

The container **must be full-screen and positioned** (`position: relative`):
`#panel`, `#stat`, `#vote` — and, since the letterbox fix, the canvas itself —
are `position: absolute`, and their containing block is the nearest positioned
ancestor. `style.css` centres the canvas with
`.vimp-shell > canvas.vimp-letterbox { position: absolute; inset: 0; margin: auto }`:
the element already has the size `CanvasManagerModel.resize` computed for the
configured `aspectRatio`, so `margin: auto` splits the black bars evenly
instead of piling them on one side. The class is what scopes the rule:
`ensureCanvas` puts `vimp-letterbox` on a canvas WITHOUT `fixSize` only — the
one the engine sizes itself. A fixed-size canvas is a game overlay (the radar
in `vimp-tanks`, placed with `position: absolute; right: 1%; top: 35px`), the
engine has no rule for it at all, and a bare `canvas` selector used to leak
`bottom`/`left`/`margin` into it and drag it into the middle of the screen.
Two more consequences: an unpositioned container lets the canvas escape to the
viewport, and a `<canvas>` the game placed itself is reused where it is
(`ensureCanvas` neither moves nor marks it) and has to be laid out by the game. Visibility of the screens is handled
by the engine itself: `ensureGameShell` marks the container with the
`vimp-shell` class (exported as `SHELL_CLASS`), and `style.css` hides
`.vimp-shell > *` — each screen is then shown by its own module (`main.js`
walks `initIdList` and sets an inline `display`, `AuthView.show`,
`StatView.show`, the informers). The rule keys on the container and not on
`body`, so the page embedding the SDK keeps its own markup, and the container
needs no `display` from the page at any nesting depth. One consequence for a
game's own CSS: the rule is a class selector, so a top-level element inside the
container that the game shows with a type or class rule
(`canvas { display: block }`) loses to it — target such elements by id, or let
`initIdList` reveal them.

The engine's own page keeps the pre-JS form of that rule (`body > *`) inline in
`packages/engine/index.html`: until `ensureGameShell` marks `body`, there is no
`vimp-shell` class and the pug markup would flash. Once it has run, the two
forms select exactly the same elements.

The two sources of markup must not drift apart: `tests/client/gameShell.test.js`
scrapes the ids out of the pug includes and compares them with the set the
shell builds.

### Auto-authentication and autostart (solo)

With `boot.autoAuth` set, the `AUTH_DATA` handler does not build the Auth MVC
at all — it answers immediately with the schema defaults overridden by
`autoAuth`. After `FIRST_SHOT_READY`, on the **first `renderTick`** (not in
the same synchronous call), `client/lib/autostart.js` sends `boot.startupVotes`
to `VOTE_DATA` and only then `boot.startupCommands` to `CHAT_DATA`.

That order is mandatory, and it is not about delivery races. The real gate on
chat is `HostGame.pushMessage`, which drops messages while `user.isReady ===
false` (the flag is set synchronously in `firstShotReady`). The actual
blocker is the team: a participant joins as a spectator, and the game may
require an active team (in tanks, `/bot` is rejected for a spectator). The
only way out of the spectators is answering the initial vote
(`['teamChange', '<team>']` on port `VOTE_DATA`) — hence votes strictly
before commands. The host has no chat rate limit (only a length limit,
`chatMaxLength`), so the commands do not need to be spread over frames.

### Direct links (`lobby` mode, `client/lib/roomLink.js`)

The lobby mode has three kinds of URL; the route lives in the hash (one page,
the server knows nothing about routes):

| URL                   | Opens                                                             |
| --------------------- | ----------------------------------------------------------------- |
| no hash               | the lobby (all games)                                             |
| `#/<gameId>`          | quick play: the fullest non-full room of the game, else a new one |
| `#/<gameId>/<roomId>` | that room directly — the lobby is never shown                     |

The route is read once, after `welcome` and login (`RouteBoot` in `client/session/RouteBoot.js`;
the decision is the pure `decideRouteAction`). A room link asks
`GET /rooms/:roomId` first: a live room is joined (the room's own `gameId`
wins over the link's), a missing or full room falls back to quick play of the
same game, a game missing from the tab's catalog shows the lobby with a
dismissible `#tech-informer`. A room that is changing its host
(`status: 'migrating'`, host migration stage 7, or `'handing_off'` — a
planned handoff, stage 8) is alive but has nobody to
connect to: `#tech-informer` shows "Switching host…" and the tab re-asks
`GET /rooms/:roomId` every `session.migrationPollMs` (1 s) for up to
`session.linkWaitMaxMs` (90 s, room for a chain of candidates) — `online` again → join, `404` (the room
is gone) or still migrating at the deadline → quick play; a network error or
`5xx` counts as "still migrating" and is asked again (`classifyRoomPoll`); a
hash change abandons the wait and the new route is read. Quick play asks the
master for the room — `GET /quickplay/:gameId` (`lobbyConfig.quickPlayUrl`,
[master.md](master.md#get-quickplaygameid): exact `gameId`, not full, most
players, first on a tie); on a network error or a non-2xx answer (a master
without the route) it picks one itself from
`GET /servers?search=<gameId>` (`pickQuickPlayRoom`, the same rule), and
otherwise creates one with the creation form's defaults
(`lobbyConfig.quickPlay.autoCreate`). Before creating it waits a random
`quickPlay.createDelayMinMs` … `createDelayMaxMs` (0.5–2 s,
`quickPlayCreateDelay`) and asks the master once more: the guests of a closed room arrive together, and
without the pause each would create a room of its own. Other hashes
(`#auth`, garbage) are left alone.

While the tab is in a room the address bar shows its link (`setRoute`,
`history.replaceState` — no history entry): a guest right after connecting, a
host after `host_registered`. The lobby's address has no hash, so F5 never
repeats a route. `hashchange` outside a room runs the bootstrap again; inside
a room a link to the same room is ignored and anything else reloads. Only one route runs at a time: a hash changed while a route still waits
for the network is handled after it, unless the tab has entered a room by
then. A game that fails to load from a route shows the reason in a
dismissible `#tech-informer` over the lobby.

**Login.** A signed-out player gets the login window over the page (it has no
URL of its own); `LobbyAuthModel.loginUrl` puts the hash into `returnUrl`, and
after the OAuth (or `/dev/login`) redirect `main.js` strips only the query
(`?token=`), so the player lands where the link pointed.

**Leaving a room** (`decideExitRoute`, lobby mode only):

| Cause                                                                                                                                                                                                                                                       | What happens                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| kick — idle, latency, missed pings (TECH_INFORM key 3–5 over P2P, close code 4003–4005; `policyClose.isKickClose`) the room's Worker failed to start, or `hostLimit` (another room is hosted from this network — quick play would only hit the limit again) | no reload: the address becomes the lobby's, the reason stays in `#tech-informer`; a click on it (or F5) opens the lobby |
| the room closed (host left, `room_closed`, `unknownRoom`)                                                                                                                                                                                                   | reload into `#/<gameId>` — quick play of the same game                                                                  |
| policy refusals (`policyClose.js`)                                                                                                                                                                                                                          | no reload, as before                                                                                                    |

`solo` and `dedicated` ignore routes; `dedicated` still reloads after a
reloadable close.

## main.js — bootstrap, dispatcher, and render loop

- **Bootstrap**: before anything else, fetches the master's game catalog
  (`GET /games/manifest.json`, `GameCatalog` — see [master.md](master.md))
  and dynamically loads the active game's `ClientPlugin` by its manifest's
  `entries.client` (`packages/engine/src/lib/gamePlugin.js`,
  `loadClientPlugin`), rejecting a mismatched `engineApi`. The catalog's
  first manifest entry (or `boot.gameId`) is only the **initial** active
  game — it is not frozen: `bindActiveGame` re-points
  `activeGameManifest`, `clientPlugin` and the injected game stylesheet at
  whatever game the player picks, and `client/lib/gameActivator.js` loads
  that game's `ClientPlugin` on demand (cached per `gameId`; a failed load
  is **not** cached, so a retry re-imports). The switch is safe because all
  per-game state — `Factory` entities, Pixi apps, `clientCore`, sounds — is
  built at match start (`CONFIG_DATA`) from the bindings as they stand
  then, and lobby mode reloads the page after a match; the lobby is
  therefore always in a pristine pre-match state. Activation happens at
  **click** time, not on picker change, so browsing the catalog downloads
  nothing. The lobby's game picker (`#lobby-game`, `populateGameSelect`) is
  populated with the whole catalog; changing it swaps the room-creation
  form and the Leaderboard tab's game synchronously. Bootstrap also brings up
  the **LobbyAuth** login gate independently of the signaling socket (see below)
  and connects `SignalingClient`. The lobby (`initLobby`) opens only once
  both `welcome` (from the master) and `authenticated` (from LobbyAuth) have
  fired — `#lobby` stays hidden until the player is signed in. Picking a
  server activates that room's game (the `join` payload carries its
  `gameId`; hosts older than 6.4 send none, and the join proceeds on the
  active game) and then `GuestSession.connectToRoom` creates a `WebRtcManager`,
  and establishes P2P. A
  plugin that fails to load is reported inline in `#lobby-error` and leaves
  the lobby usable — `#tech-informer` covers the whole tab and is reserved
  for terminal causes.
- **Chat**: outgoing chat goes through `handleChatSend` — the interception
  point for commands addressed to the master rather than the host. In lobby
  mode `/changehost` (host-migration stage 10, `client/lib/hostVoteCommand.js`
  → `parseChangeHost(text, bootMode)`) never reaches the host: a guest sends
  `host_vote_start` to the master (its `host_vote_started` prints "Voting
  has started", `v:1`, as for a host vote), the host tab gets a hint to use "Hand
  over host", no signaling — "No connection to the master server", extra
  arguments — "Usage: /changehost"; the master's refusals (`voteRejected`,
  `noSuccessor`) and the vote's result are local chat notices (codes
  `v:6`…`v:15`). In `solo`/`dedicated` the command goes to the host as plain
  text. Everything else goes to the host (port `CHAT_DATA`).
- **"Change host?" window** (lobby, guests): `host_vote` →
  `VoteCtrl.openEngineVote` with the engine vote `@changeHost`, title
  "Change host? (started by <nick>)", `Yes`/`No`, open for the rest of the
  vote (`durationMs` from arrival). The answer is caught in
  `handleVoteSend` before `VOTE_DATA` and goes to the master as
  `host_vote_answer` (its `host_vote_accepted` prints "Your vote has been
  accepted", `v:2`, as for a host vote); `host_vote_result` closes the window (or takes it off
  the queue) and prints the result. See
  [master.md](master.md#change-host-vote).
- Branches incoming host packets (`handleMessage`) by data type: a string →
  the JSON dispatcher `[portId, payload]` → `socketMethods[portId]`; an
  `ArrayBuffer` → `clientCore.push_frame` (decoding, seq insertion into the
  buffer, and predictor reconciliation all happen in the core; a version
  mismatch drops the frame).
- On `CONFIG_DATA` (port 0) it initializes every module: the PixiJS
  `Application`s, the MVC components, `BakingProvider` (texture baking),
  `SoundManager`, and the **client core** (`ClientPlugin.createClientCore(configJson,
{ wasmUrl })`, where `wasmUrl` is the active game manifest's
  `entries.wasm` — the plugin runs its own wasm-bindgen `init()` and returns
  `{ core, memory }`; the config is assembled by
  [packages/engine/src/lib/clientCoreConfig.js](../../packages/engine/src/lib/clientCoreConfig.js) from the
  `prediction`/`interpolation` sections of CONFIG_DATA); it replies
  `CONFIG_READY`.
- The first frame (`FIRST_SHOT_DATA`, port 4) is applied immediately
  (`applyShot`), bypassing the core.
- **The render loop** `renderTick` on `Ticker.shared` (rAF):
  `clientCore.sample(now)` → reading the flat hot buffer zero-copy from
  WASM memory (tanks/dynamics/camera/predicted tank) **in full, before any
  other call into the core** → `take_frames()` for rare event frames →
  applied through the previous `parse` pipeline in the order "frames → hot
  data → camera" (`lib/hotTick.js`; see "Client Core" below).
- Resets: a map change (`MAP_DATA` → `set_map`) and `CLEAR` (→ `reset`)
  clear the frame buffer and the predictor in the core; `reset` also drops
  the local player's identity (`my_game_id`), so the prediction overlay
  stops rendering an entity the host no longer has.
- **The map (`applyMapData`)** hands the payload to the client core
  (`set_map`) and assembles the static render data. The core gets the
  layered fields as they arrived — `levels` (above-ground levels: `map`,
  `floor`, `walls`, `layers`) and `ramps` — so that it builds the same
  geometry as the host; without them its level prediction would drift from
  the authoritative one in silence. The render data is assembled **per
  level**: level 0 from `layers` over the `map` grid, every above-ground
  level from `levels[n].layers` over the `levels[n].map` grid. The keys
  `s0..sN` run across all levels (they are part-instance ids in
  `GameModel` — two `s0`s would overwrite each other and half the map would
  never appear), and each instance receives `level` (its level number),
  `solid` (the tiles that block movement on it — `physicsStatic` for level
  0, `levels[n].walls` above) and `floor` (`levels[n].floor`, empty on level 0) next to `map`, `step`, `layer`, `tiles`, `physicsStatic`, `scale` and
  `spriteSheet` it already read. A map without `levels` produces exactly
  what it produced before.
- **Tab wake-up** (`visibilitychange` → visible): besides unmuting, the
  shell calls `clientCore?.resync?.()` — the interpolator clock is reseeded
  from the next frame instead of crawling back through the EMA. The call is
  optional: an older plugin build has no such ABI method. It only fires
  after a pause of at least `RESYNC_AFTER_HIDDEN_MS` (3 s): a resync drops
  the whole frame buffer, including event frames (entity create/delete), so
  doing it after a short alt-tab would freeze the scene for the
  interpolation delay and lose removals.
- **WebGL context loss** (`webglcontextlost` on each canvas): every visible
  pixel is a GPU-only `RenderTexture` with no CPU source, so a lost context
  would leave the scene blank. The handler calls `preventDefault()` (without
  it the browser never fires `webglcontextrestored`) and stops the render
  loop. Loss is tracked per canvas (`lib/contextTracker.js`) — the canvases
  are independent contexts and the browser restores them separately, so
  re-baking on the first `webglcontextrestored` would draw into a context
  that is still dead (empty textures), while the second event would find
  nothing left to do. On `webglcontextrestored`, once **every** context is
  alive again, the shell removes all controllers (they hold dead textures),
  re-bakes the assets (`BakingProvider.bakeAll` into the same `Map` instance
  `GameModel._assets` holds — the old render textures are destroyed first,
  each exactly once), rebuilds the map from the cached `MAP_DATA` payload
  **without** re-sending `MAP_READY` (the host no longer expects it), and
  restarts the render loop. Tanks and dynamics come back on their own from
  the next frames. `renderTick` goes on and off the ticker only through
  `startRenderLoop`/`stopRenderLoop`, since `Ticker.add` does not
  deduplicate.
- **Zero-sized resize** (minimized tab/window) is ignored by
  `CanvasManagerModel`: it would drive the scale to `0` and the renderer to
  `0x0`, and neither recovers until the next real resize; emitted sizes are
  clamped to at least `1`.
- **Transport drop** (`SessionSupervisor`, host migration stage 4): in
  lobby mode a guest's dropped WebRTC connection mid-match is not terminal —
  the supervisor reconnects and resumes the participant's place (see
  [Network layer](#network-layer-packagesengineclientnetwork)).
  The same supervisor carries the session through a host change (stage 7).
  `handleDisconnect` runs only on a **terminal** close.
- **Terminal close** (`handleDisconnect`): the room closed, a kick or a
  policy close, the reconnect window ran out — removes the render tick (not `app.stop()`: with a shared
  ticker that stops it globally, and `autoStart` revives it on the next
  `add()` from any part — without `renderTick`), drops the context
  listeners and the cached render contexts (a context restored after the
  drop would otherwise resume rendering a dead game), shows a
  placeholder, and returns to the lobby by reloading. A terminal close
  reason already shown by the tech informer (a kick, a full room — any code
  but `loading`) isn't overwritten by the generic "Host left…" message; the
  reason is delivered by the host's Worker as a `TECH_INFORM_DATA` message
  right before the channel closes (see
  [network.md](network.md#rtt-pingpong-and-kicks)). `techInformList` has a
  bundle default (`packages/engine/src/config/clientDefaults.js`) — a full-room refusal arrives
  before `CONFIG_DATA`. The reload is skipped in `solo` (there is no lobby to
  return to) and on a dedicated server's policy close codes —
  `shouldReloadAfterClose` in `client/network/policyClose.js`, keyed on
  `config/closeCodes.js` (`invalidOrigin`, `roomFull`, `handshakeTimeout`,
  `tooManyConnections`; the full table is in
  [network.md](network.md#connection-lifecycle)). Reloading would only trip the same limit, restart the same
  timer, leave the same origin or fail to free a slot, so the client shows the
  reason and stays put. The text comes from `POLICY_CLOSE_INFORMS`, whose
  entries are fallbacks: they are written only when the server sent no reason
  of its own (4006 arrives from the server as a `TECH_INFORM` frame, and that
  text wins). See [dedicated.md](dedicated.md#game-websocket).
- **WebRTC unavailable** (`ensureWebRtcAvailable`): if `RTCPeerConnection`
  is unavailable (Firefox with `media.peerconnection.enabled = false`,
  resist fingerprinting, etc.), `GuestSession.connectToRoom`/`HostRole.createRoom` show a
  plain message and stay in the lobby instead of failing with a black
  screen.
- **The host role**: before starting the Worker, `HostRole.createRoom` fetches
  the master's map catalog (falls back to the bundle), registers the room
  and starts a heartbeat once `ready` fires; the host's signaling WS
  reconnects with backoff on a drop
  (`lobbyConfig.reconnect`) and reclaims the same room with `reclaim_host`
  (a fresh `welcome` doesn't recreate the lobby — a guard in `initLobby`). A
  Worker init failure (`error`) tears down the room with a message and
  returns to the lobby.
- **Room membership** (lobby mode): the tab gets a `memberId`
  (`crypto.randomUUID()` at page load, kept in memory — two tabs of one
  profile are two members); the WebRTC offer carries it, and once the
  match is entered (`AUTH_RESULT` without an error) a guest sends
  `join_room { roomId, memberId, token }` so the master knows who is in the
  room ([master.md](master.md#room-lifecycle)). The signaling reconnect with
  backoff is common to the whole lobby mode: after a fresh `welcome` the host
  sends `reclaim_host`, a guest that has announced its membership
  (`memberJoined`, set when `join_room` is sent, cleared on leaving the room
  or taking the host role) repeats `join_room` with the same `memberId` —
  even while its WebRTC transport is reconnecting. A reply `unknownRoom` to
  `join_room` for the current room means the master restarted and the host
  has not reclaimed the room yet: `JoinRetry` (`client/lib/JoinRetry.js`)
  repeats `join_room` after 1, 2, 4, 8, 8, 8 s for up to
  `session.joinRetryWindowMs` (45 s) and stops on `room_joined`; past the
  window nothing happens — the P2P match may live on. Signaling `error`s are handled (the master's `re`/`roomId`
  tell which request and room the error is about): `unknownRoom` is decided
  by `decideUnknownRoom` (`client/lib/signalingErrors.js`) — an error about
  another room is ignored; a successor taking the room drops the role on a
  reply to `register_host`; while the supervisor is `migrating` the outcome
  is left to `host_changed`/`room_closed` and the migration timer; a reply to
  an offer while the current transport is a WebRTC one with its channels not
  open yet — "Room no longer exists" and back to the lobby;
  `invalidToken` is decided by `decideInvalidToken` (same file) — a
  successor's `register_host` refused: it drops the role and reports
  `promote_failed`, staying signed in; a guest's `join_room` refused while
  its session is not `closed`: the match goes on (the P2P link needs no
  token), the `JoinRetry` stops and only `engine.session.tokenExpired` is
  logged, with no UI message; otherwise sign-out (sign in again), leaving
  the room if in one; `hostLimit` — the room is closed
  with a message; `roomTaken`/`invalidRoomSecret` — the host registers a new
  room; `staleEpoch` — the host tab was replaced while it was away: it
  becomes a guest of the new epoch
  ([host.md](host.md#successor-promotion)); a successor whose
  `register_host` came too late (`staleEpoch`, `invalidPromotion`,
  `unknownRoom`) drops the role and reports `promote_failed`. `room_closed` for the
  current room shows "The host left — the room is closed." and goes through
  the `handleDisconnect` path — sooner than waiting for WebRTC to fail.
  `unknownRoom` during a reconnect attempt ends the session the same way.
- **Protocol errors**: a second `CONFIG_DATA`, or a second successful
  `AUTH_RESULT`, inside a live session (e.g. a host that did not understand
  `resume`) is logged to the error journal
  (`engine.session.protocol`) and, in lobby mode, reloads into the same room
  link — the client never builds a second core or `Application`.
- **Debug API (dev build only)**: `window.__vimpDebug`
  (`packages/engine/src/client/debug.js`) — `dump()`, `startRecording()`,
  `stopRecording()`, `divergence()`, `handoff()`, `save()`. The branch is guarded by
  `import.meta.env.DEV`, so the production bundle drops it; the same flag
  goes into `room.isDevMode` and switches on the host recorder. Port 12
  (`CONSOLE`) carries the host's debug log into this tab's console as
  `[vimp:debug][host] …`. See [debugging.md](debugging.md#the-browser-half).

## Room scenarios (`client/session/`)

`main.js` executes on import and cannot be brought up in a test, so the
lobby-mode room scenarios live in `packages/engine/src/client/session/` as
modules with injected dependencies (signaling, supervisor, factories,
config, DOM actions as callbacks) — none of them imports `main.js` or touches
the global DOM. `main.js` only creates them and wires them together; every
module has its own tests in `tests/client/session/`.

| Module             | What lives there                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roomContext.js`   | the tab's shared room state: `roomId`, host `epoch`, `memberJoined`, `entered`, `startFailed`                                                                                                 |
| `Membership.js`    | `join_room` and its retry after a master restart (`JoinRetry`), `caps` for successor selection, `member_update` (ICE type, guest FPS, the token-lifetime timer)                               |
| `hostRoomPrep.js`  | `prepareHostRoom` (game by manifest or checkpoint version, master maps, worker bundle URL, composite `codeVersion`) and the manifest fetches                                                  |
| `HostRole.js`      | creating a room (`createRoom`), adopting the host role (`adopt`), `register_host`/`reclaim_host` and heartbeat, `host_registered`, `probe`, `successor_assigned`, map refresh, Worker handoff |
| `StandbyRole.js`   | the successor: `standby_assigned`/`standby_released`, `StandbyReceiver`, `HostPrewarm`, periodic `standby_status`                                                                             |
| `PromotionFlow.js` | `promote` (checkpoint and cold), `promote_cancelled`, `host_revoked`, finishing a promotion, demoting a former host                                                                           |
| `HandoffFlow.js`   | planned handoff (`PlannedHandoff`, `HostHealthPolicy`, `TokenHandoffTimer`), `request_handoff`, late `host_released`, "Leave server" and the guest's leave                                    |
| `GuestSession.js`  | joining and reconnecting over WebRTC, `host_migrating`/`host_changed`, `room_closed`, signaling reconnect, the "Change host" vote, master error codes                                         |
| `RouteBoot.js`     | direct links: route boot, quick play, waiting for a migrating room, cold promotion from `sessionStorage`, `hashchange`                                                                        |

## Error reporting (`lib/diagnostics.js`)

The client keeps a journal of its own errors: `main.js` creates the reporter
right after the boot mode is known and installs it on `window`. Reports go
to the server that served the page — `POST /client-reports` on the lobby
master or the dedicated server (`lobbyConfig.clientReportUrl`); the
standalone SDK sends only when the embedder passes `reportUrl`
([standalone.md](standalone.md#api)). The server forwards them to the
central journal — see [master.md](master.md#post-client-reports-client-error-reports).

**Caught:**

- uncaught exceptions (`error` as an `ErrorEvent`) and unhandled rejections
  (`unhandledrejection`) of the page;
- errors of the host Worker: `worker.onerror`, `onmessageerror`, the init
  failure (`error`, which still rolls the room back as before) and unhandled
  rejections inside the Worker, which it forwards itself as a
  `{ type: 'diagnostic' }` message (source `host-worker`). A Worker
  `ErrorEvent` reaches the main thread with `error: null`, so the report
  gets a frame built from `filename:lineno:colno` (and `Worker error` when
  the message is empty); an init failure carries the Worker's own stack;
- Content-Security-Policy violations (`securitypolicyviolation`, kind
  `csp`) — only in production, where the master sets CSP; violations whose
  `blockedURI` or `sourceFile` belongs to a browser extension
  (`chrome-extension:`, `moz-extension:`, `safari-extension:`,
  `safari-web-extension:`) are dropped;
- explicit `warn(code, details)` / `capture(error)` of a game's parts
  through the `diagnostics` pool service
  ([plugin-api.md](plugin-api.md#the-diagnostics-service));
- a non-finite camera (`NaN`, `Infinity`, `undefined`, `null` in `x`/`y`):
  `applyCamera` applies such a frame neither to the canvas nor to the sound
  listener, and reports it as a `warn` with code `engine.camera.non-finite`,
  `source: 'client'`, `details: { x, y }` as strings.
- a host tab that was hidden (host-migration stage 9a): while hidden, the
  host's `health` metrics (see [host.md](host.md)) are aggregated, and once
  the tab is visible again, stops being the host or is closed (`pagehide`,
  sent at once), one `warn` with code
  `engine.host.hiddenHealth`, `source: 'client'`,
  `details: { hiddenMs, samples, minTickRate, maxGapMs, lostMs }` is written
  — how far the browser throttled the match. An episode without a single
  metric (a frozen match, a hide shorter than the ~1 s window) is skipped.

**Not caught, on purpose:** `console.error` / `console.warn` calls (noise
and arbitrary data in their arguments; the console is never wrapped),
errors caught by `try/catch`, resource and network failures (`404`,
`fetch`, a failed `<img>`/`<script>` arrives as a plain `Event` and is
skipped), errors before the boot mode is known (module imports,
`resolveBootConfig`), server-side errors of a dedicated process (they are in
its logs).

**Limits.** Identical reports are deduplicated by source, kind, code or
message and the first stack frame with `:line:column`; a repeat only
increments a counter. At most 50 distinct reports per session (then one
`console.warn('[vimp] diagnostics: session cap reached')`, and repeats of
known ones are still counted). The first send goes 2 s after the first
report, later sends at most every 10 s; `pagehide`, the tab becoming hidden
(`visibilitychange`) and a context change send at once. When the game or role
changes, the reports buffered so far go out with the old context. Only reports
whose counter grew since the last send go out, with the increment as `count`.
A request carries at most 10 reports; a batch over 15 000 bytes loses its
`details`, then its stacks are cut to 1000 characters, and if it is still too
big the reports go one per request. The transport is `navigator.sendBeacon`,
falling back to `fetch` with `keepalive` when the beacon is refused or throws;
the response is not read. The reporter swallows its own failures and never
reports an error raised while it is reporting.

Fields are cut to the server's limits: `message` 500, `stack` 4000, `code`
64 characters, `details` 2048 bytes of JSON (larger becomes
`{ truncated: true }`).

**Privacy.** A report carries no nickname, player id or IP address. The
context is `{ mode, role, gameId, gameVersion, page, userAgent }`, where
`page` is the pathname only; URLs in CSP reports lose their query and hash.

### The Errors panel (`ClientReports`)

Admins read the central journal in the lobby: the `Errors` button in the user
badge (`#reports-open`) is shown only to the `admin` role
(`ClientReportsCtrl.setAdmin`, next to the games panel's), and opens
`#reports-panel` (`views/includes/reports.pug`) in place of `#lobby`, the same
way the games panel does. The triplet `components/{model,view,controller}/ClientReports.js`
takes every URL and element id from `lobbyConfig.clientReports`; the model
talks REST to its own master (`GET`/`PATCH /admin/client-reports`, see
[master.md](master.md#getpatch-adminclient-reports-client-error-journal)) with
the lobby token and turns every failure into an error code, never an
exception. Dedicated servers have no admin panel; the journal is shared, so
any lobby master shows it.

- **Filters** — the status tabs `Open` (default), `Fixed`, `Ignored`, `All`
  and a game select (`All games` plus the tab's catalog). Changing either
  reloads the list from the first page; `Load more` appends the next
  `pageSize` (50) rows and is visible while fewer than `total` are loaded.
- **A row** shows how long ago it was last seen, `×count`, `kind/source`,
  `code` or the message (cut to 120 characters), `gameId@gameVersion`, the
  engine version, the box and the status. A click expands the full message,
  the stack and `details` in scrollable `<pre>` blocks, the user agent, the
  tab's role (`client`/`host`) and page, first and last seen, the first 12
  characters of the fingerprint and who set the status, when, with which note.
- **Statuses.** The note field plus the buttons `Mark fixed`, `Ignore`,
  `Reopen` — every status but the current one. A row that no longer matches
  the open tab leaves the list. A repeat of a report never reopens it: the
  fingerprint includes the engine and game versions, so a fix ships as a new
  version, and a regression in it is a **new** row while the old one stays
  `fixed`.

**Security.** Every field of a report is attacker-controlled — any browser
can post any string. The view writes them only through `textContent`, never
through `innerHTML`, markup templates or `insertAdjacentHTML`; a unit test
(`tests/client/ClientReportsView.test.js`) renders a report full of
`<img onerror>` and checks that no element appears.

## Network layer (packages/engine/src/client/network/)

The game transport is WebRTC, not WebSocket (channel details —
[network.md](network.md#transport-webrtc)):

- **`SignalingClient`** — a thin wrapper around the master's signaling
  WebSocket: `connect()`, caching `id`/`iceServers` from `welcome`,
  relaying incoming messages to subscribers by `type` (via `Publisher`),
  methods `sendOffer`/`sendIceCandidate`/`pingHost`.
  The transport is injected by a factory for tests.
- **`WebRtcManager`** — the P2P connection to the host: `RTCPeerConnection`
  - the `meta` (reliable-ordered) and `state` (unreliable-unordered)
    channels. The client is the offerer: it creates the channels/offer,
    exchanges SDP/ICE through `SignalingClient`. `Publisher` events: `open`
    (both channels open), `message` (data from either channel in a single
    stream), `close` (a drop). `RTCPeerConnection` is injected by a factory
    for tests. Options for host migration: `resume` (the offer carries
    `resume: true`), `minEpoch` (answers/candidates of an older host epoch
    are ignored; the epoch of the first answer is pinned), and
    `connectTimeoutMs` (`lobbyConfig.webrtc`, 10 s — the channels did not
    open in time → `close`). An `error { code: 'migrating' }` from the
    master before the host answered (the room is changing hosts or its
    host's signaling is detached; an error about another room or another
    request is ignored) re-sends the same offer and the candidates gathered
    so far after `offerRetryMs` (`lobbyConfig.webrtc`, 1 s), restarting the
    connect window — the guest reaches whichever host the room has by then.
    `isOpen` — both channels open and the manager not closed.
    `destroy()` unsubscribes from signaling and
    closes the peer without emitting `close`, so an abandoned attempt never
    eats the answers of the next one. Host migration stage 6: after the
    channels open (and every `iceStatsIntervalMs`, 30 s) it reads
    `pc.getStats()` and emits `iceType` — the type of its own local
    candidate in the selected pair (`selectedLocalCandidateType`: by
    `transport.selectedCandidatePairId`, else the `nominated && succeeded`
    pair; none → `null`); a `standby` channel opened by the host is emitted
    as `standby`.
- **`StandbyReceiver`** (host-migration stage 6) — the successor's side of
  the `standby` channel: assembles the chunks of a checkpoint
  (`standbyChunks.js`), drops an unfinished one as soon as a newer one
  starts, and keeps the **latest full** one: `latest()` →
  `{ bytes, checkpointId, wireId, seq, createdAt, final, mode, game, receivedAt }`
  (`game` — `{ id, version }` from the chunk descriptor, or `null`),
  the `checkpoint` event, `waitForFinal(minWireId, timeoutMs)` for a planned
  handover (a periodic checkpoint not newer than a received final one does
  not replace it; `discardFinal()` on `promote_cancelled` keeps an aborted
  handover's final checkpoint — even one arriving after the cancel — from
  completing the next one). `noteFrame` remembers the `seq` of the last host frame this
  client saw (the restored match's `seqFloor`). **`HostPrewarm`** — on the
  first full checkpoint (`warm(latest, { allowedGame })`) it prepares the
  room the way creating one does (`prepareHostRoom({}, gameRef)` in
  `client/session/hostRoomPrep.js` — the checkpoint's room settings are not needed, promotion takes
  them from the checkpoint itself; `gameRef` comes from the descriptor's
  `game`, and only without it is the checkpoint unpacked; it loads the game
  manifest of the version in the checkpoint — `lobbyConfig.game.versionManifestUrl` when
  it differs from the active one —, the master's maps, the worker bundle
  URL) and brings up a `HostController` with `preload: true`
  ([host.md](host.md#standby-successor)); a new game version in a checkpoint
  warms up again, a failed version is not retried. In the lobby,
  `client/session/Membership.js` sends `caps` (`lib/hostCaps.js`: `canHost`, `mobile`, `hidden`,
  `iceType`) in `join_room`/`register_host` and `member_update` on
  `visibilitychange` and on an `iceType` change. `canHost` is also false
  while the sign-in (`LobbyAuthModel.getTokenExpiresAt()`) expires within
  `migration.minTokenLifetimeMs` (10 min; `tokenAllowsHosting`): the host
  shows its token to the master mid-match (`register_host`,
  `reclaim_host`) and it is never renewed. A one-shot timer sends
  `member_update` at the moment the sign-in gets that short, such a tab
  answers `promote` (both modes, and a cold promotion after reload) with
  `promote_failed` before preparing anything, and a host arms a timer for
  `migration.tokenHandoffLeadMs` (5 min) before expiry
  (`TokenHandoffTimer`): if it has a successor then, it starts a planned
  "Hand over host" (`handover`, stays as a guest, waits for the round
  boundary); with no successor yet, a Worker relay in progress or an aborted
  handoff it retries every `migration.tokenHandoffRetryMs` (5 s) until the
  sign-in expires, tries at once when a successor is assigned inside that
  window, and re-arms on a new sign-in; on `standby_assigned` it
  reports `standby_status` on the first checkpoint and every
  `migration.standbyStatusIntervalMs` (5 s), with the checkpoint's age
  `ageMs` (the master judges freshness by it); `standby_released`, leaving
  the room or a new epoch terminates the pre-warmed Worker and drops the
  checkpoints.
- **`SessionSupervisor`** — owns the current transport (`attach`), forwards
  its messages to the dispatcher and decides what a `close` means. States:
  `connecting` → `handshake` → `inGame` → `reconnecting` → `inGame` |
  `closed`; any live state → `migrating` → `reconnecting` | `closed`.
  Terminal (`closed` → `handleDisconnect`): a close before the
  match, no resume secret yet (`SESSION_DATA`), a kick/policy close, the
  user leaving (`stopGame`, `leaveRoomWith`), and every close in `solo`,
  `dedicated` and on the host tab's loopback (no `reconnect` factory — the
  supervisor is pass-through there). Otherwise → `reconnecting`: the
  "Reconnecting…" overlay (`#session-overlay`), keys disabled, sound muted;
  a new `WebRtcManager` with `resume: true` to the same room, and once its
  channels open — `RESUME_REQUEST { v, gameId, resumeKey, token }`.
  Failed attempts repeat with backoff (`session.reconnectBaseDelayMs` …
  `reconnectMaxDelayMs`) inside `session.reconnectWindowMs` (15 s), then
  the session is terminal. `RESUME_RESULT ok` → `clientCore.reset()`, the
  host's votes are dropped (`removeHostVotes`; a "Change host?" window
  stays — the master runs it), keys and sound come back, `inGame`; the host then
  sends the entry packet, during which `FIRST_SHOT_DATA` is applied without
  `FIRST_SHOT_READY`/autostart (`supervisor.resuming`), and the closing
  `SESSION_DATA` triggers `Controls.resendHeld()`. `RESUME_RESULT !ok` →
  `reloadTo(#/<gameId>/<roomId>)` — a clean entry into the same room.
  **Silence watchdog**: in `inGame`, outside a map load (`MAP_DATA` …
  `FIRST_SHOT_DATA`), no message from the host for
  `session.hostSilenceMs` (3 s) closes the transport and starts the
  reconnect. After a resume and until the first binary frame
  (`noteFrame()` from `handleMessage`) the limit is
  `hostSilenceMs + session.resumeSilenceGraceMs` (6 s): a match raised from
  a checkpoint stands still up to the Worker's `resumeWaitMs` (3 s) waiting
  for the others, and the guest that came back first must not take that for
  a dead transport. Messages from an abandoned transport are dropped. A drop the
  client noticed itself (closed transport or silence) is first reported to
  the master — `host_unreachable { roomId, epoch }` (`onHostLost`), its
  evidence for a probe or a host change
  ([master.md](master.md#host-migration)).
  **Host change** (host migration stage 7, lobby guests only; the host tab
  gets `host_revoked` instead): `host_migrating` with a newer epoch →
  `migrate()` → `migrating`: the transport to the old host is destroyed at
  once (`WebRtcManager.destroy()` → `pc.close()`, no ICE timeouts), so a
  "zombie" host of epoch N that still runs its Worker can never feed this
  client frames next to the new host of N+1; the "Switching host…" overlay,
  keys disabled, sound muted, the silence watchdog stopped. Rendering keeps
  running — the frame stands, snapshot-independent animations go on.
  `migrate({ keepTransport: true })` — only the successor of a planned
  handoff (`Promotion` `holdSession` on `promote { mode: 'planned' }`):
  the same `migrating`, but the transport stays open, because the
  `standby` channel with the final checkpoint shares its
  `RTCPeerConnection`; its messages are dropped while `migrating`, its
  close is not terminal (the outcome is up to `host_changed`, `promote` or
  the wait timer), and `hostChanged`/`resumeWith` drop it.
  `host_changed { epoch, mode }` → `hostChanged()`: the tab adopts the epoch
  (`minEpoch` of the next offers — older answers are ignored);
  `checkpoint`/`planned`/`reclaimed` (the old host came back before a
  successor registered) → the reconnect path above with no report to the
  master (the overlay stays "Switching host…"), `RESUME_RESULT !ok` → a
  clean entry into the room; `cold` (the new host started the match afresh)
  → `reloadTo(#/<gameId>/<roomId>)`. `reclaimed` while not waiting is
  ignored — the transport to that host is still good. No secret yet
  (`SESSION_DATA`) → a clean entry as well. The wait lasts
  `session.migrationWaitMs` (40 s) or the master's `host_migrating.waitMs`,
  whichever is longer (`migrate({ waitMs })`, capped at 120 s); a repeated
  `host_migrating` of the same epoch (the next candidate, a handoff turned
  emergency) → `extendMigration(waitMs)`: extends the wait, never shortens
  it. Nothing within it, or `room_closed` → terminal: the room
  is closed, `reloadTo(#/<gameId>)` (quick play of the same game).
  **Role change** — `resumeWith(transport, { reconnect, getToken })`: the
  tab resumes its place through the given transport — a successor through
  the loopback to the Worker it raised (`reconnect: null`: no other
  attempts, no silence watchdog, a close is terminal), a former host
  through WebRTC to the new host (with the guest attempt factory). The
  migration wait ends; the window and `RESUME_REQUEST` are the usual ones.
  With `onFailed` a failed return (no secret, `RESUME_RESULT !ok`, a close
  without a factory, the window) closes the session but calls `onFailed`
  instead of `onResumeRejected`/`onTerminal` — a successor is already the
  room's host and must not tear it down; `hasSession` tells whether there
  is a secret to return with.
- **`Promotion`** (host migration stage 7) — raises the match of a
  `promote { mode: 'checkpoint' }` from the latest checkpoint of
  `StandbyReceiver` (`mode: 'planned'` first waits up to
  `migration.finalWaitMs` for the final one; a repeated `promote` of the
  same epoch and token with `mode: 'checkpoint'` → `degrade()` drops the
  wait): in the pre-warmed Worker (`HostPrewarm.take()`) when
  its game version matches the checkpoint, otherwise in a new
  `HostController`; `onReady` → `PromotionFlow` adopts the host role and
  registers with `promotionToken`, `onFailed` → `promote_failed`;
  `cancel()` on `promote_cancelled`; without a resume secret of the own
  player (`hasSession`) it fails before touching a Worker. `savePendingPromotion`/
  `takePendingPromotion` keep a `cold` promotion in `sessionStorage`
  (`vimp.promotion`, `try/catch`, removed on read) across the reload into
  the room. `LoopbackTransport(controller, socketId, { resume: true })`
  connects with `resume` and emits `open` on the next microtask, so the
  supervisor sends `RESUME_REQUEST` to the tab's own Worker. The whole
  flow — [host.md](host.md#successor-promotion).
- **`PlannedHandoff`** (host migration stage 8) — the host's side of a
  planned handoff; `HandoffFlow` enters it through
  `HandoffFlow.start({ reason, stay, defer })` (refused while a promotion owns
  the Worker or a Worker handoff is already carrying state; a Worker handoff
  still waiting for the round boundary yields — once the handoff has begun,
  `HostRole.preemptSwap()` cancels it; one still fetching its manifests is
  left alone and stopped by the running handoff itself — and an aborted handoff or a
  cancelled deferred one calls `HostRole.resumeCodeUpdate()`, which reruns
  `HostRole.refreshWorker()` only if the handoff deferred or preempted a
  code update; dropping the host role rejects a pending
  swap with `host destroyed`, not counted as a failed version; a
  repeated call while one is running is ignored). `defer` (the default for `stay`) first waits for the round
  boundary — `HostController.awaitRoundBoundary`, answered at once by a game
  with `migration.midRound`, otherwise when the next round starts, at most
  `migration.deferMaxMs` (30 s); the handoff counts as started meanwhile
  (the menu shows "Handing over…", a Worker handoff waits), and its deadline
  and `onSlow` run from `handoff_begin`. A leaving host does not wait. `start` sends `handoff_begin { roomId, epoch, reason, stay }`;
  `handoff_go` → `HostController.freeze()` then
  `requestCheckpoint({ final: true })` and `onFrozen` (the own player gets
  the "Switching host…" overlay, keys and sound off); `host_released` →
  `onReleased { stay, epoch }`. `stay` — the role is dropped like on
  `host_revoked` (without the chat notice) and the own player resumes as a
  guest of the new epoch over WebRTC under its `gameId`/`resumeKey`;
  `!stay` — `leave_room` and `reloadTo('')` (the lobby, not quick play: it
  would lead back into the room). The handoff has one outcome, announced once, and one deadline: `migration.handoffDeadlineMs` (10 s) from `handoff_begin`, above the master's `handoffTimeoutMs` with room for its answer to travel back — normally the master announces a cancel (`handoff_aborted`), the deadline is a safety net. No `handoff_go` within `migration.handoffSlowMs` (3 s) is not a failure: `onSlow` (the room menu's "Slow connection…" status), and a late `handoff_go` before the deadline still freezes the match and sends the final checkpoint instead of the successor rolling everyone back to a periodic one. A final cancel — `handoff_unavailable` (nothing was frozen), `handoff_aborted`, a signaling drop or the deadline — unfreezes a frozen match (the Worker resyncs the guests), the overlay goes away and the tab stays the host (after a signaling drop the reconnect's `reclaim_host` tells whether the successor took over — `staleEpoch` demotes the tab). A
  leaving host (`stay: false`) leaves anyway: `host_leaving` to the master
  (an emergency migration from the latest periodic checkpoint) and the
  lobby; a `host_released` that arrives after the deadline still demotes the tab. `abort()` (role teardown) cancels silently.
- **`HostUnloadGuard`** (`client/lib/hostUnloadGuard.js`, host migration
  stage 8.4, lobby mode) — `beforeunload` is registered only while the tab
  is the current host and the room has other people (`update({ role,
othersPresent })` from `main.js`: role changes, `HostConnectionManager`
  peer count): Ctrl+W/F5 shows the browser's "Leave site?" dialog. No final
  checkpoint is promised while it is open — the main thread, which relays
  Worker → DataChannel, stands still, so the guests see a frozen match.
  `pagehide` (after "Leave" and on a close without the dialog; the only
  hook on mobile, where `beforeunload` is unreliable): the host sends
  `host_leaving` (the master starts an emergency migration at once), a
  guest sends `LEAVE` to the host and `leave_room` to the master (its seat
  is freed at once, not after `resumeGraceMs`) — best-effort, a dropped
  connection covers what does not arrive. A guest whose session ends without
  a reload (`handleDisconnect`: a kick takes it to the lobby, the signaling
  session lives on) sends `leave_room` too — otherwise the tab would stay a
  "ghost" member of the room: counted in the lobby, eligible to vote, a
  successor candidate. A `memberTaken` error is only logged. `exit()` ("Leave server", any
  move to the lobby) drops both: the leave is already announced. `pagehide`
  fires on a programmatic reload too, so every client reload goes through
  `reloadPage(hashPart?)` (`createPageReload`, `client/lib/pageReload.js`),
  which calls `exit()` first — ESLint rejects a direct `location.reload()` or
  `reloadTo` import elsewhere in `src/client/` — otherwise a
  guest reloading back into the same room (a successor's cold promotion,
  `reloadToRoom`) would announce a leave and lose its seat.

The client's role is picked in the lobby (`packages/engine/src/client/main.js`): **joining**
(`GuestSession.connectToRoom` → `WebRtcManager`, offerer) or **hosting** (`HostRole.createRoom`
→ a browser host in the same tab). For a host, the game transport is
**`LoopbackTransport`**: the same interface as `WebRtcManager` (`publisher`
with `message`/`close`, `send`/`close`), but data travels through
`HostController` → the Web Worker as postMessages, bypassing WebRTC. Client
code is identical either way — the transport is transparent.

Outside the lobby the client uses two more transports of the same shape:

- **`WebSocketTransport`** (`dedicated`) — a plain WebSocket to the game
  server. `binaryType` is forced to `'arraybuffer'` (the dispatcher tells a
  snapshot frame from a JSON port by `data instanceof ArrayBuffer`, and a
  browser WebSocket would hand it a `Blob`); `reliable` is ignored, since a
  WebSocket has no reliability levels. Consequences —
  [network.md](network.md#transport-webrtc).
- **`InlineHostBridge`** (`solo`) — not a transport but a replacement for
  `HostController`: the same `open`/`send`/`disconnect` interface, so
  `LoopbackTransport` is reused unchanged, but the authoritative host runs in
  the same thread instead of a Worker. It builds `createHostRuntime` +
  `PortMachine` with a guest identity and an offline profile fetch
  (`lib/offlinePlayerData.js`); `await bridge.ready` before the first
  `open()`. A `HostPlugin` cannot be passed into a Worker at all
  (`postMessage` does not carry functions), which is why solo is inline —
  the production path is untouched, and the dev/prod divergence is
  deliberate.

A host tab additionally brings up main-thread routing infrastructure (the
main thread, not the Worker): **`HostController`** spawns the Worker with
the core and bridges it to the transports; **`HostConnectionManager`** is
the **WebRTC answerer** for remote clients (a mirror of `WebRtcManager`):
listens for `webrtc_offer` via `SignalingClient`, creates a
`RTCPeerConnection` per client, catches the `meta`/`state` channels in
`ondatachannel`, sends `webrtc_answer`+ICE, registers the room with the
master (`register_host`/heartbeat), and answers the lobby ping
(`ping_host`). **`RoomPeersReporter`** (`client/network/RoomPeersReporter.js`,
no DOM, timers injectable) tells the master which guests are really
connected: `room_peers { roomId, epoch, memberIds }` with
`HostConnectionManager.connectedMemberIds()` (peers with both channels open)
on every peer change (debounced 500 ms), at once on `host_registered` and
every `migration.peersReportIntervalMs` (15 s); nothing while the tab has
no registered room. The master counts the lobby's players and the successor
candidates by it ([master.md](master.md#room-lifecycle)). Remote clients'
data flows into the same Worker as the host player's loopback. `HostController` also wraps the Worker's host checkpoints
(`startCheckpoints`/`stopCheckpoints`/`requestCheckpoint`/`onCheckpoint`,
`freeze`/`unfreeze`, `startAfterRestore`; a constructor `checkpoint` raises
the match from one). Details — [host.md](host.md#checkpoints).
`shutdown({ timeoutMs })` closes the room cleanly: the Worker's `shutdown`
(participants' games closed, profiles flushed), resolved by `shutdown_done`
or after `timeoutMs + 500` ms; a Worker handoff still waiting for the round boundary is cancelled first (`cancel_handoff`), one already moving the state resolves it at once (the old Worker wrote the scores before handing the meta over); a repeated call returns the promise already in flight (a second `HostGame.destroy()` would flush the same delta twice), and `main.js` ignores a second "Leave server" while the first is waiting; the Worker is terminated only by `destroy()`.

There's no classic-Worker fallback (it would forbid ESM and require an
inlined WASM binary — see PLAN.md risk #5), so "Create server" first feature-
detects module-Worker support
(`packages/engine/src/client/network/workerSupport.js`,
`supportsModuleWorker` — a browser only reads a `type` constructor option if
it understands module Workers). On an unsupported browser it shows a plain
"this browser cannot be a host" message and returns without touching
anything else — joining existing rooms is unaffected.

## MVC components (packages/engine/src/client/components/)

Ten `model/` + `view/` + `controller/` triplets: **LobbyAuth**, **Auth**,
**Lobby**, **CanvasManager**, **Controls**, **Game**, **Chat**, **Panel**,
**Stat**, **Vote**.

**LobbyAuth** — the login gate shown before the lobby (`plan/done/central-auth/auth_b2.md`):

- **model** — talks to the central auth service (`packages/auth`, see
  [auth.md](auth.md)) directly, not through the master. `boot(search)` reads
  the OAuth-redirect query string (`?token=`/`?pendingToken=`/`?authError=`)
  once at startup, falling back to a persisted identity JWT in
  `localStorage`; `submitNick` does the one REST call this model makes
  itself (`POST /nick` with the pending token, unlike the signaling-relayed
  I/O other models publish as events) since it's a plain cross-origin fetch,
  not signaling traffic. Publishes `login-required`/`nick-required`/
  `authenticated`/`login-error`/`nick-error`. The identity JWT's payload is
  decoded client-side only for display (`packages/engine/src/lib/jwt.js`,
  `decodeJwtPayload`, no signature check) — a host authoritatively verifies
  it against `/jwks` (`plan/done/central-auth/auth_b3.md`; see
  [auth.md](auth.md#joining-a-room-host-verification)).
- **view** — toggles `#lobby-auth-login`/`#lobby-auth-nick`
  (`views/includes/lobbyAuth.pug`) and, on `authenticated`, hides
  `#lobby-auth` and reveals `#lobby` plus the `#lobby-user` nick/sign-out
  badge (`views/includes/lobby.pug`) — `#lobby` itself starts hidden in the
  template and only `LobbyAuthView` (or `LobbyCtrl.open`) turns it on.
  Provider buttons (`.lobby-auth-provider`, `data-provider`) are filtered
  against the configured provider list.
- **controller** — `login(provider)` navigates the browser
  (`window.location.href = model.loginUrl(provider)`) to the auth service's
  `GET /oauth/:provider/start`; this is a top-level navigation, not a fetch,
  so it isn't subject to CSP `connect-src`. `nick`/`logout` proxy to the
  model.

Config — [packages/engine/src/config/authClient.js](../../packages/engine/src/config/authClient.js)
(bundled into the build like `lobby.js` — `serviceUrl` must point at the
real auth-service domain per deployment; the master's CSP `connect-src`
(`config/master.js`, `security.csp`) is templated with the same
`authServiceUrl` so the lobby's `POST /nick` fetch isn't blocked in
production. `GET /oauth/:provider/start` and the callback redirect are
top-level navigation and unaffected by CSP either way).

**Lobby** — the server-selection screen BEFORE connecting to a host. The
panel is split into two columns (lobby page plan — `#lobby-setup-panel` /
`#lobby-browser-panel`, `.lobby-grid` in `style.css`, single column below
800px): setup/create on the left, a tabbed browser (Active Servers /
Leaderboard) on the right. Both sit in a `.lobby-column` wrapper, with
`#lobby-footer` under them — the same three-cell strip as the entry form's
footer, and styled by the same rules: a link to the engine's repository,
its version, and the copyright. `LobbyView` writes both once from
`client/lib/engineVersion.js`, which imports the engine package's own
`package.json` (`version` plus `repository`/`homepage`) and is baked into the
bundle at build time — the master has no version endpoint. Both footers build
their link with the one pair `resolveProjectUrl`/`projectLink`
(`src/lib/packageLink.js`, rendered by `client/lib/footerLink.js`): the
package's `repository` (else `homepage` — also when the declared `repository`
resolves to nothing), normalised to https, labelled `GitHub` or by its host.
There is no fallback — a package declaring neither gets no link and the cell
stays empty, which is what makes the missing metadata visible; contract rule
`A7` warns about it, and `npm create vimp-game --repository <url>` writes the
field from the start. The crate
`vimp-engine-core` is deliberately absent there: it is `rlib`-only, its WASM
is built in the game's repository, and every game pins its own version of it,
so a crate version on the lobby screen would be a claim the page cannot back.

- **model** — the server registry (responses from the master's
  `GET /servers`), pagination, search, smart pinging, and the selected
  game's Leaderboard state (`setLeaderboard`/`setPlacement`/
  `clearLeaderboard`, lobby page plan). Does no I/O of its own: it publishes
  `fetch` (request the REST endpoint), `ping-request` (a signaling ping),
  `join` (a server was picked), `list`/`ping-update` (for the view), and
  `leaderboard` (leaderboard/total/myPlacement/loaded — `loaded` distinguishes
  "still fetching" from "fetch resolved, genuinely empty" for the view's
  empty-state placeholder). `setLeaderboard`/
  `setPlacement`/`clearLeaderboard` coalesce into a single `leaderboard`
  emit via `queueMicrotask` (code review M2 — `main.js`'s `Promise.all`
  normally resolves both calls back-to-back; without coalescing, the first
  emit would render the new leaderboard list next to the _previous_ game's
  `myPlacement` for one frame). `latency` lives separately from the list and
  survives a refresh/pagination.
- **view** — renders cards, search, "Load more", the Active
  Servers/Leaderboard tab switch (`showTab`, toggles `.lobby-tab-btn.active`
  and the two content containers, UI-only — it does not trigger a fetch), the
  Daily/Monthly/All-Time slice buttons (`setPeriod` toggles
  `.lobby-period-btn.active` and keeps the slice's caption for the header;
  a click emits `show-period`) and
  the Leaderboard list itself (`renderLeaderboard`: numbered rows using the
  server's competition-ranking `place` — not the row index, so ties don't
  drift out of sync with the caller's own placement (code review M3, see
  `GET /leaderboard` below) — `"<GAME TITLE> TOP-N — <SLICE>"` header, total player
  count, an "No ranked players yet" placeholder when the list is empty and
  the model's `loaded` flag is `true`, or "Loading…" while it's still `false`
  (`clearLeaderboard` sets it to `false`, `setLeaderboard` back to `true` —
  distinguishes "still fetching" from "fetch resolved, genuinely empty" so
  the empty-state placeholder doesn't flash during the request), and the
  caller's own placement row: "Not ranked yet" if
  `myPlacement.placement` is `null`, hidden entirely if the caller's own
  nick (`setSelfNick`, set once by `main.js` at lobby open from
  `LobbyAuthModel.getNick()`) is already present in the rendered top —
  otherwise a `…` gap marker (`.lobby-placement-gap`). Visibility is decided
  by **nick membership** in the rendered list, not by comparing
  `myPlacement.placement` to `leaderboard.length` (code review M4: those are
  different scales — `placement` is a competition ranking with gaps on ties,
  `leaderboard.length` is just the page size — and could disagree exactly at
  a tie straddling the `LIMIT` boundary, making a tied player vanish from
  both the list and the placement row; nicks are globally unique, so
  membership is unambiguous). **Smart pinging** through `IntersectionObserver`:
  a card entering the visible area → `visible` → the controller sends
  `ping_host`; `pong` updates latency and re-sorts cards ascending.
  `IntersectionObserver` is injected for tests. Each card's name is
  `"<gameId>/<roomId>"` (a room has no name; matches the `gameId/roomId`
  search syntax on `GET /servers`, see [master.md](master.md#get-servers)); the
  model keys servers by `roomId`, falling back to `hostId` from an older
  master. The info line is `<lobbyInfo> · players/max · region`, and an empty
  segment is left out: no text when the game sets no `lobbyInfo`
  ([plugin-api.md](plugin-api.md#gameconfig-fields-and-their-defaults)), no
  region when the master doesn't know it (`'unknown'` is never shown); this is
  engine-level lobby UI, not something a game plugin renders.
- **controller** — proxies view events to the model; ping throttling lives
  in the model (`pingHost` returns `false` if the server was pinged
  recently, interval `pingInterval`). It does no fetching itself (lobby page
  plan): `gameChanged(gameId, title)` (invoked by `main.js` on
  `#lobby-game`'s `change`, and once at lobby open for the default game) is
  one of the two triggers — the other is `show-period`, the time slice of the
  rating (rank-periods). Both emit the controller's own `leaderboard-needed`,
  carrying `{ gameId, period }`: a slice is a different answer from the
  server, not a different sort of the same rows, so switching it refetches.
  `setPeriods(periods, default)` (called once by `main.js` from
  `lobbyConfig.leaderboardPeriods`) seeds the open slice; a click on the slice
  already open is ignored, and a slice picked before any game was chosen
  refetches nothing. Switching tabs
  (`showTab`) is UI-only and never triggers a fetch on its own (code review
  L4/L5 — an earlier "fetch lazily on first tab open" branch could fire
  before `gameChanged` ever ran, sending a `gameId: null` request); Leaderboard
  data is always fetched ahead of the tab being opened. `main.js` listens for
  `leaderboard-needed`, clears the model's stale leaderboard/placement first
  (code review M1 — otherwise the previous game's rows stay visible under
  the new game's title until the fetch resolves, or forever on a network
  failure), tags the request with a monotonically increasing id so a
  slower, now-stale response can't overwrite a faster one from a game
  switched to afterwards (latest-wins), then calls
  `fetchLeaderboard`/`fetchPlacement` (`GET /auth/leaderboard`/
  `GET /auth/placement`, proxied by the master — see
  [master.md](master.md#get-authleaderboard-get-authplacement)) and feeds
  the results back into `model.setLeaderboard`/`setPlacement`.

Config — [packages/engine/src/config/lobby.js](../../packages/engine/src/config/lobby.js) (bundled into the
build, since the lobby happens before connecting to a host). The ping
measurement is **approximate** (client→master→host, not P2P RTT) and shown
as such in the UI.

The "Create server" form is **generated** from the active game manifest's
`roomForm` — an explicit array of field descriptors (`populateRoomForm` in
`main.js`, built via `client/lib/formBuilder.js`) — see
[plugin-api.md](plugin-api.md#form-schema). The engine no longer infers a
control from the default value's type; a manifest without `roomForm` logs a
warning and renders an empty field list rather than guessing. The game
picker (`#lobby-game`, `populateGameSelect`) is always populated with the
**whole** master catalog (lobby page plan — it used to hold only the
active game and stay hidden with a single-game catalog); picking a
different entry rebuilds the room form from that manifest's `roomForm` and
triggers a Leaderboard refresh via `gameChanged`. On submit, the form is
validated first (an invalid form costs no plugin download), the field
values are read **before** the `await` that activates the picked game, and
both the `roomDefaults` being overridden and the `room.game` entries sent
to the Worker come from the _picked_ manifest (see the Bootstrap note
above). Each built field's `getValue()` (already unit-converted,
e.g. `unit:'s'` seconds→ms) overrides the matching `roomDefaults` key, and
the result is sent as the room object to `HostRole.createRoom` → `HostController`
→ the Worker, where `applyRoomOverrides`
(`packages/engine/src/lib/applyRoomOverrides.js`) reads `maxPlayers`/`roundTime`/`mapTime`/
`friendlyFire`/`map`.

**An empty catalog is a lobby state, not a load failure.** Games live in the
auth service's registry, so a moderator may pull the last one off the air and
a fresh deployment has none approved yet. In lobby mode the bootstrap then
binds no game at all and `applyCatalogState`
([client/lib/catalogState.js](../../packages/engine/src/client/lib/catalogState.js)) disables "Create
server" and prints `create.emptyCatalogText` in the lobby's error line —
everything that does not depend on a game (sign-in, the user badge, "My
games", "Moderation") stays up, and those are exactly what brings the catalog
back: staging a version with "Test" activates it in place, an approval brings
it in on the next tab reload. A _non-empty_ catalog with nothing playable in
it (an engine upgrade left every published game asking for a capability it no
longer has) is the same lobby state — `pickActiveGame`'s reason replaces
`emptyCatalogText` in that line instead of ending the load. Only solo and
dedicated still treat "no game" as fatal. A terminal load failure now
paints `#tech-informer` over the page (`showBootFailure` in
[views/gameShell.js](../../packages/engine/src/client/views/gameShell.js)) instead of replacing
`document.body`: wiping the markup used to take the moderation panel with it,
so the moderator who disabled the last game had no way back.

The Publisher pattern within a triplet:

- `main.js` or the `view` → calls the `controller`'s methods **directly**;
- the `controller` → calls the `model`'s methods **directly**;
- the `model` → the `view` — **through `Publisher`**
  ([packages/engine/src/lib/Publisher.js](../../packages/engine/src/lib/Publisher.js)): the model publishes
  an event, the view is subscribed; external subscribers can listen to a
  model too.

**LobbyCtrl** (lobby page plan) is the one controller that also owns a
`Publisher` of its own, for the same reason a model does: `main.js` needs to
react to a UI-only event (the game selector changing, the Leaderboard tab
opening for the first time) without the controller doing network I/O
itself — see `leaderboard-needed` above.

What each component does:

- **LobbyAuth** — the pre-lobby login gate against the central auth service
  (see above).
- **Auth** — the per-room login form for game-specific fields only (e.g.
  `model`), client-side validation (`validators.js`), localStorage. Its
  fields are built by the same `formBuilder.js` as the room form, from
  `PS_AUTH_DATA.params[]` — see [plugin-api.md](plugin-api.md#form-schema).
  The nick is no longer typed here (Stage B3, see
  [auth.md](auth.md#joining-a-room-host-verification)): `main.js` attaches
  `LobbyAuthModel.getToken()` to the `AUTH_RESPONSE` payload as `token`, and
  the host verifies it against `/auth/jwks` to derive the nick.
- **CanvasManager** — manages several PixiJS `Application`s at once:
  `vimp` (the main game canvas) and `radar` (the mini-map); the canvas
  elements are generated by `main.js` from the game's canvases config
  (`modules.canvasManager.canvases`, including the initial
  `width`/`height`) — they're not in the HTML. Adaptive
  scaling (a 1920px reference width), `aspectRatio`/`fixSize`/`baseScale`,
  a dynamic camera (look-ahead, speed-based zoom), and shake — parameters
  in [configuration.md](configuration.md#modulescanvasmanager--canvases-and-camera).
  The camera frame only MOVES the scene (`updateCoords`: `stage.position`,
  `stage.scale`) and never draws — the canvas is drawn by the ticker
  (`TickerPlugin` keeps `app.render` on `Ticker.shared` at priority LOW,
  that is after `renderTick`), once per tick, on a frame that has been
  applied in full. A draw of its own would mean one per CAMERA frame, and a
  tick carries several (the discrete frame's camera first, the predicted one
  after it): two or three full passes over the scene per visible frame, each
  running every part's `onRender` on a half-applied frame. Both `updateCoords`
  and `toWorld` measure in `renderer.screen` units — the ones the scene's
  transform lives in — never in canvas buffer pixels: the two coincide only
  while the renderer's `resolution` is 1, and the drift would be silent
  (the picture stays put while the camera centre a game reconstructs from
  the scene transform — the 2.5D height projection in `vimp-tanks` — moves
  off by half a screen).
- **Controls** — keyboard capture (`InputListener`), the active key set
  dictated by the server (port 17), `chat`/`vote`/`stat` modes, input sent
  as `"seq:action:name"`. Optionally a **pointer channel** as well (mouse,
  finger, stylus — one set of Pointer Events): declared by the game as
  `modules.controls.pointer`, it sends `"seq:aim:x:y:flags"` with a **world**
  point (converted by `CanvasManagerView.toWorld`) and a bit mask — bit 0
  «pressed», bit 1 «double tap». It obeys the same gates as the keys: input
  disabled, an open mode or a key set outside `pointer.keySets` mutes it and
  releases a held pointer. A game that does not declare `pointer` gets no
  listener and no traffic — see
  [../ai/04-client-plugin.md](../ai/04-client-plugin.md).
- **Game** — the rendering core: `GameCtrl.parse(name, data)` creates/
  updates/removes entity instances from snapshot data through `Factory`.
- **Chat** — message output (row/lifetime limits), the command line;
  escaping happens on output (`textContent`).
- **Panel** — the HUD: round time, health, ammo, active weapon (from
  `'key:value'` strings). `PanelView` **generates the DOM from the game's
  schema** (`modules.panel.fields`: an ordered list of
  `{ name, elem, type }`; cell semantics come from
  `type: 'bar' | 'value' | 'time' | 'weapon'`, not from field names — a
  `bar` field also takes `max` and `blocks`) inside the engine's `#panel`
  container; the cells' look is the game's CSS (bar blocks use the
  engine-neutral `panel-bar-*` classes). The `#logo` header inside `#panel`
  shows the game's title from `authSchema.texts.title` (same value as
  `#auth-title`, applied when `PS_AUTH_DATA` arrives, falling back to
  `'VIMP'` before that / if absent); `#panel`/`#logo` CSS is flex-based so
  the panel table reflows around titles of any length. The same handler fills
  the entry form's footer (`#auth-link`), a three-cell strip like the lobby's:
  `#auth-package-link` (the active game's repository) and `#auth-version`
  (its npm version) come from the package metadata the master adds to the
  manifest — `packageVersion` and `packageUrl`, read off the game package's
  own `package.json` by `GameCatalog` (see [master.md](master.md)). Note this
  is the npm semver, not `manifest.version`, which is a bundle hash. A
  manifest without those fields (a standalone SDK
  manifest, for instance) leaves both cells empty and the footer keeps its
  layout: the three cells are equal flex columns, so the version stays
  centred even when the cells beside it are blank.
- **Stat** — sortable scoreboard tables (`sortList`), shown on Tab.
  `StatView` **generates the header and tables from the game's schema**
  (`modules.stat.params`: `columns` — column labels, `bodies` — an
  arbitrary number of teams) inside the `#stat` container; team
  colors/labels are the game's CSS.
- **Vote** — vote windows built from templates, pagination, a lifetime
  timer. Engine votes (a name starting with `@`, reserved — today only
  `@changeHost`) come from the master, not the host: `createEngineVote`
  shows one for the rest of its `deadline`, and an engine vote and a host
  vote never overwrite each other — whichever comes second waits in a queue
  until the open window closes (an engine vote whose time ran out in the
  queue is skipped). The `M` menu opens over an engine vote, which comes
  back after it; `closeEngineVote` removes it on the master's result.

## Client Core (ClientCore)

Client-side math — snapshot interpolation, the local tank's prediction,
visual shot spawning, and v3 frame decoding — lives in the Rust core
(`packages/engine/core/src/client/` + the game plugin's own `core/src/client/`,
e.g. `vimp-tanks`'s, the
wasm-bindgen class `ClientCore` from the same WASM
binary as the host's `GameCore`). The JS shell (`main.js`) only forwards
data and applies the result to rendering; ABI and layouts —
[core.md](core.md#rust-traits-vimp-engine-core).

Data flow:

- **Input**: `handleMessage` hands a binary frame to `push_frame(bytes,
now)` — the core decodes it (a version mismatch drops the frame),
  inserts it into the buffer by `seq` with deduplication, and, if the frame
  carries a player block, reconciles the predictor. Ports
  `MAP_DATA`/`PANEL_DATA`/`KEYSET_DATA`/`CLEAR` mirror into
  `set_map`/`sync_panel`/`set_active`/`reset`; the tank model — `set_model`
  on auth. `reset` means "the world is gone": along with the buffer and the
  predictor it clears `my_game_id`, and the identity is restored from the
  first player block that follows (a spectator has none, so no predicted
  entity is drawn either).
- **`resync()`**: clears the network half only — the interpolation buffer
  and the outgoing frame queue — leaving prediction and identity intact.
  Called by the shell when a tab becomes visible again after a long pause,
  so the clock offset is reseeded exactly instead of being chased by the EMA
  while entities on the canvas stay alive.
- **Render tick**: `sample(now)` returns the length of the flat **hot
  buffer**, read zero-copy: `hot_ptr()` first, then
  `new Float32Array(wasm.memory.buffer, ptr, len)` — the buffer is taken
  after the call into the core, never before it. The view is recreated
  every tick and lives only until the WASM memory grows: growth detaches
  the buffer, and a detached view reads `undefined`. Any allocating call into
  the core can grow it — `take_frames()` builds a JSON string on the WASM
  heap, parts call the core while parsing frames — so `lib/hotTick.js` copies
  out everything it needs before the first such call. The camera used to be
  read after `take_frames()` and turned into NaN: the canvas went blank until
  a camera reset, and the sound listener made `Howl.pos()` throw, taking the
  ticker with it. The buffer carries flags, the camera (already resolved:
  predicted position or interpolated), interpolated tank/dynamic records,
  and the game's predicted records last — the local actor's
  (`render_overlay`) followed by any bodies the game predicts itself
  (`render_rows`: map dynamics, remote actors in contact). The `reconstructHot` adapter
  (`packages/engine/src/lib/reconstructHot.js` — `buildSnapshotKeysById`
  builds the reverse schema index, `reconstructHot(hot, keysById)` walks the
  buffer; shared with the headless runner, which decodes frames through the
  very same code) assembles the previous shape
  `{ m1: { id: [...] }, c1: {...} }` from it and feeds the existing
  `applyGameData` — GameCtrl/parts were never touched; a trailing record
  lands in `game[key][id]` like any other, so it overrides the interpolated
  row of the same entity through the same pipeline. The `PREDICTED` flag is
  raised by either tail — the local actor's record or the game's own rows —
  and the consumer gates the whole parse on it (`GAME | PREDICTED`), so a
  buffer that carries rows alone is still parsed.
- **Event frames** (the `hasFrames` flag): `take_frames()` returns a JSON
  array `[{ game, camera }, …]` — every crossed `renderTime` frame emitted
  exactly once (events `w1`/`w2e`, creations/removals, camera reset/shake),
  already with duplicate own shots suppressed; applied through the previous
  `applyShot`. Sound and effects trigger as before, from the parts
  themselves on entity creation — there's no separate eventId dispatcher.
- **Input**: `apply_input(action, name, now)` records predictor history, and
  `apply_aim(x, y, flags, now)` records the pointer in the same history (both
  are trait methods; `apply_aim` has a default empty implementation, so a
  core that ignores the pointer needs no change);
  game actions go through the `ClientPlugin.hooks.onLocalAction` hook
  (`try_fire(now)` — cooldown/ammo/pending-bomb/alive gates are internal
  to the core — returns spawn JSON for `applyGameData`;
  `nextWeapon`/`prevWeapon` — `cycle_weapon`). Sending `"seq:action:name"`
  to the host is unchanged.

**The game's ClientPlugin** (the game plugin's `src/client/index.js`, e.g.
`vimp-tanks`'s; loaded dynamically by the engine from the master's
`GameManifest`, stage 6.3 —
`packages/engine/src/lib/gamePlugin.js`) supplies `parts` (entity renderers),
`bakers` (procedural textures), the game CSS and the hooks. The core's game
methods are called only from its hooks — `onAuth` (`set_model` on auth), `onPanel` (`sync_panel`
per panel frame), `onLocalAction` (e.g. `try_fire`/`cycle_weapon` in
`vimp-tanks`); `main.js` doesn't know the core's game methods. The game's
CSS (panel cells, canvases, team colors) is the game plugin's own
`src/client/*.css` (e.g. `vimp-tanks`'s `tanks.css`); the engine UI skeleton
is `packages/engine/src/client/style.css`.

Internally the core implements the following algorithms:

- **interpolation** (`client/interpolator.rs`): an EMA offset of server
  time, `renderTime = serverNow − delay` (config `interpolation.delay: 100`
  ms), lerp for actors/dynamics/camera (angles by shortest path), discrete
  fields taken from the reference frame, hold with no extrapolation,
  seq-based insertion + immediate emission of late-frame events;
- **prediction** (the game plugin's own `client/predictor.rs`, e.g.
  `vimp-tanks`'s): a replica of the authoritative
  motion without Rapier collisions, at a fixed `timeStep`; tick formulas
  are **shared** with the game plugin's own actor-update code (e.g.
  `vimp-tanks`'s `core/src/motion.rs`) — the replica
  can't diverge from the authoritative path on formulas, integration
  parity (manual vs. Rapier) is locked in by the `client::predictor::parity` cargo
  tests; input history, replay from the frame's `serverTime`,
  `visualError` with exponential decay and a snap, freeze at `condition
0`, resets on a camera forceReset/map change/keySet;
- **shot spawning** (the game plugin's own `client/shot.rs` +
  the engine's `client/raycast.rs`): a replica of
  the authoritative gate and muzzle formulas, DDA raycasting over wall
  tiles + an OBB test against dynamics and actors, a single
  pending-projectile gate, RTT-compensated projectile position,
  suppressing authoritative duplicates by author id (a FIFO queue with a
  timeout, local keys `L<n>`) — field names and exact gating are
  game-defined (e.g. `vimp-tanks`'s `tracers`/`bombs` entity blocks, see
  [network.md](network.md)). Any client-side-only visual randomness (e.g.
  tracer spread) is a purely visual effect — the authoritative entity
  arrives in a frame.

## Rendering

### parts/ — entities

The game plugin's own `src/client/parts/` (e.g. [`vimp-tanks`'s](https://github.com/lgick/vimp-tanks/tree/main/src/client/parts)) —
classes rendered on the PixiJS canvases, one per game entity type (e.g.
`vimp-tanks`'s `Tank`, `TankRadar`, `Map`, `MapRadar`, `Bomb`, `Smoke`,
`Tracks`). Effects follow the same plugin-owned convention (e.g.
`vimp-tanks`'s `parts/effects/`), animated on `Ticker.shared`.

Mapping snapshot keys to classes, and their canvas assignment, is
`gameSets`/`entitiesOnCanvas` in `client.js`. There's no fixed contract for
a part — use the existing ones as a template when creating a new one.

### Factory

[packages/engine/src/lib/factory.js](../../packages/engine/src/lib/factory.js) — an entity-name → class
registry. `GameCtrl.parse(name, data)` creates an instance from incoming
data, calls `update(data)` on an existing one, or removes it (`null`).

### Providers

- **`BakingProvider`**
  ([providers/BakingProvider.js](../../packages/engine/src/client/providers/BakingProvider.js))
  — one-time procedural texture generation at startup from the
  `bakedAssets` config; baking functions live in
  [the game plugin's `src/client/bakers/`](https://github.com/lgick/vimp-tanks/tree/main/src/client/bakers) (e.g. `vimp-tanks`'s; no fixed
  interface, follow the existing ones). A baker owns what it returns:
  re-baking destroys the previous result (each object once per pass, even
  if it was returned under several keys) together with its `TextureSource`,
  so a view onto a shared atlas must not be returned.
- **`DependencyProvider`** — injects services (`renderer`, `soundManager`,
  `assetsBase`, `localPlayer`) into components via the
  `componentDependencies` map. `localPlayer` (`{ id, is(id) }`,
  [lib/localPlayer.js](../../packages/engine/src/client/lib/localPlayer.js))
  answers whether an entity belongs to this client: a part compares the id it
  got as the fourth constructor argument (`{ id }`) with the client's own
  game id, read lazily out of the client core. That is how a game plays a cue
  for the local player only instead of for every entity on the canvas.
  `assetsBase` is the active game's asset base taken from its manifest: a
  part that draws from image files builds its own URLs as
  `${assetsBase}img/<file>`, the same way sounds resolve to
  `${assetsBase}sounds/`. The engine ships no game images — they travel in
  the plugin package (`dist/img/`).
  Next to the engine's own services the pool carries the **game's** ones:
  `ClientPlugin.hooks.services(core)` (optional) returns a map that is merged
  into the pool before the engine keys, so a game reaches its own core from a
  part without the engine knowing what it hands over (the tanks plugin serves
  `mapDynamics` that way — the geometry of the predicted map dynamics, which
  the shot effect uses to anchor its debris to the box it hit). An engine key
  always wins a name clash, and a service nobody declared in
  `componentDependencies` is simply never handed out.
  The engine's own five names live in an append-only registry
  ([config/clientServices.js](../../packages/engine/src/config/clientServices.js)):
  a name a published game wrote into `componentDependencies` keeps working
  forever, and retiring one means an alias, not a deleted row. Because the
  pool hands out **what was asked for**, a sixth engine service demands
  nothing of older games — they neither ask for it nor receive it. An unknown
  name is not a load failure either: the part simply gets `undefined` (which
  is exactly why `vimp-contract` has rule C4 — an unserved service looks like
  a blank canvas with no error at all).

## SoundManager

[packages/engine/src/client/SoundManager.js](../../packages/engine/src/client/SoundManager.js) (built on
Howler.js). Sounds are described in the game plugin's `src/config/sounds.js`
(e.g. `vimp-tanks`'s); its
`path` field is overridden client-side (`main.js`, `CONFIG_DATA` handler) to
`${activeGameManifest.assetsBase}sounds/` — the game build's own sound copy
served alongside its client/host bundles (the game plugin's `dist/sounds/`),
rather than the engine-bundled `/sounds/` static copy.

- **UI/system** (no position): `playSystemSound(name)` — plays instantly,
  bypassing priorities (also used for port 6 sounds).
- **Spatial** (positioned in the world): `registerSound(name, { position
})` → `processAudibility()` → `updateActiveSounds()` — the manager
  decides what's audible on its own, honoring a voice limit
  (`WORLD_VOICE_LIMIT = 30`) and priorities from the config.
- **Non-spatial** (the player's own): `registerSound(name, { position,
spatial: false })` — the source belongs to the player, not to the world.
  The listener sits at the camera, which is the predicted position of the
  player's own tank, so their engine and their shot land right on top of it:
  HRTF at zero distance folds the loop into comb filtering (heard as a
  hum), not into a silent pan. Such an instance gets **no `PannerNode` at
  all** — it runs straight into the gain and keeps the sample's stereo.
  Howler builds the node lazily, on the first `pos()`/`pannerAttr(id)`, and
  finishes building it with a `pause()`/`play()` pair, i.e. a click; so as
  long as the source sits on the listener, neither call is made. An instance
  that has already been panned (it was out in the world before) is recentred
  on `equalpower` instead. The flag can be changed later through
  `updateSoundData(id, { spatial })` — the owner of a tank learns it is the
  local one after construction. A **world** source, by contrast, gets its
  node on the very first frame and keeps it: the click Howler makes inside
  `setupPanner` then falls on the start of the sample, where it is
  inaudible. There is no dead-zone and no distance threshold any more — the
  position is one continuous formula (see below), so nothing switches
  between "no node, dry stereo" and "HRTF hard in one ear" mid-sound.
- **Unregistering**: `unregisterSound(id)` stops the sound instance and
  drops the registration — for an entity whose sound must die with it.
  `releaseSound(id)` drops the registration but lets an already playing
  one-shot finish (a looped sound is still stopped: a loop must go silent
  with its owner). Used by entities that disappear earlier than their sound
  — a detonated bomb still finishes its "planted" sample.
- **`reset()`** stops every playing instance and **keeps looped
  registrations**, only clearing their active-instance ids: registrations
  are owned by entities, which unregister them in their own `destroy()`. On
  a full `CLEAR` the registry is empty anyway; after a partial one a
  surviving loop is restarted by the next `processAudibility()`. One-shot
  registrations are dropped instead: `Howler.stop()` fires no `end` event,
  so the registration of a sample that already played would survive and be
  started over from the beginning. Only `destroy()` clears the registry
  outright.

### Virtual elevation and spread

The listener always sits at `(0, 0, 0)` and a world source is placed by the
vector from it. The listener is lifted `virtualElevation` above the plane of
the game, and inside `innerRadius` that vector is faded out with a
`smoothstep`, so the position is **one continuous formula per frame** — no
threshold, no step, no click:

```
dx  = x - listenerX
dy  = y - listenerY
d2d = Math.hypot(dx, dy)

zoom = camera zoom multiplier (1 = at rest, < 1 = zoomed out)
H    = virtualElevation / zoom
R    = innerRadius      / zoom

spread = smoothstep(0, R, d2d)     // 0 at the centre, 1 past the radius
sx = dx * spread
sy = dy * spread
```

The projection profile (`mode`) maps `(sx, sy, H)` onto the Web Audio axes.
World `x` grows right and world `y` grows **down**, while the listener's up
vector (`Howler.orientation(0, 0, -1, 0, 1, 0)`) is +Y — hence the minus
sign wherever world `y` lands on axis Y:

| Profile        | `X`  | `Y`                    | `Z`  | default `panningModel` |
| -------------- | ---- | ---------------------- | ---- | ---------------------- |
| `topDown`      | `sx` | `-H`                   | `sy` | `HRTF`                 |
| `sideScroller` | `sx` | `-sy * verticalFactor` | `-H` | `equalpower`           |
| `cockpit`      | `sx` | `-sy`                  | `-H` | `HRTF`                 |

At `d2d = 0` a `topDown` source sits at exactly `(0, -H, 0)`: straight below
the listener, equal in both ears, with no ear filtering. At `dx = 20`,
`H = 180` the azimuth is `atan(20/180) ≈ 6.3°`; at `dx = 600` it is `≈ 73°`.
The real 3D distance is never shorter than `H`, which is why `refDistance`
sits above it (`200 > 180`) — a source right next to the player still plays
at full volume. `equalpower` is the default of `sideScroller` because
front/back is physically meaningless in a side view while a clean left/right
timbre is not, and `verticalFactor` (`0.2`) holds the vertical down for the
same reason a platformer's height is barely readable by ear.

**The scene scale divides the elevation and the spread radius, but not the
attenuation distances.** `setListenerPosition(x, y, scale)` carries the
scale of the scene — `CanvasManager.getCameraZoom()`, which is the canvas's
own scale (`currentScale / baseScale`, i.e. the fraction of the design width
1920 the canvas occupies) **times** the dynamic camera zoom: exactly the two
factors whose product is the canvas's `finalScale`. A narrower window and a
zoomed-out camera both shrink the picture, so both have to shrink the stereo
base with it — otherwise the panorama is wider than what the eye sees.
`refDistance` / `maxDistance` / `rolloffFactor`, however, are
attributes of the `PannerNode` itself: they are set once through
`pannerAttr` at the `Howl` level and are never recomputed per frame.
Scaling only the JS cut-off (in `_updateSpatialSound` and the candidate
filter of `processAudibility`) would open a window where the engine counts a
source as audible while the node already returns silence — invisible to
every test and heard as sounds that randomly disappear. `maxDistance`
therefore stays in world coordinates.

### `parts.sounds.spatial`

The block is optional: a game that declares nothing gets the engine defaults
([config/clientDefaults.js](../../packages/engine/src/config/clientDefaults.js))
and sounds right. Every key is validated on its own and falls back to its
default with a console warning, so a bad value cannot break the audio
context:

```javascript
parts: {
  sounds: {
    codecList: ['webm', 'mp3'],
    spatial: {
      mode: 'topDown',          // 'topDown' | 'sideScroller' | 'cockpit'
      virtualElevation: 180,    // world units, ear height above the plane
      innerRadius: 40,          // world units, the player's own size
      verticalFactor: 0.2,      // sideScroller only: vertical contribution
      panningModel: 'HRTF',     // 'HRTF' | 'equalpower' (profile default)
      distanceModel: 'inverse', // 'linear' | 'inverse' | 'exponential'
      refDistance: 200,         // world units, full volume up to here
      maxDistance: 1200,        // world units, silence past it
      rolloffFactor: 0.9,
    },
    sounds: { /* the catalog */ },
  },
}
```

**The numbers are world units, not screen pixels.** The manager is fed world
coordinates (the camera from the core's hot buffer, `regSound.position` from
the game's parts), while the screen scale is a separate factor of
[CanvasManager](../../packages/engine/src/client/components/model/CanvasManager.js):
`currentScale = baseScale * (window width / 1920)`. In `vimp-tanks`
(`mapScale 0.3`, `baseScale 5`) one world unit is 5 screen px; in
`vimp-snakes` (`mapScale 1`, `baseScale 1`) it is exactly one.

- `innerRadius` is **the player's own size in world units**: everything
  sounding inside it is folded smoothly to the centre and spread evenly over
  both ears. Tanks: a hull of `8 × 6` units, half-diagonal `≈ 5`. Snakes:
  `baseRadius 14`. The engine default `40` is only right for a game whose
  world unit equals a screen pixel.
- `virtualElevation` is calibrated off the **visible half-height of the
  screen in the design window (1920×1080)**: `H ≈ (canvas height / 2) /
baseScale`. Bigger `H` is softer panning near the player, smaller is a
  more aggressive ear separation. For a game with `mapScale 0.3` and
  `baseScale 5` that gives `H ≈ 540 / 5 = 108`, and half the screen across
  is `960 / 5 = 192` units — an azimuth of `atan(192/108) ≈ 60°` at the edge
  of the screen, while at the size of the player it is a few degrees. Only
  the design window needs to be calibrated: on any other window size the
  engine scales `H` itself through the scene scale above, so the number a
  game declares stays correct on a laptop and on a 4K display alike.

A typo in a key, or a `mode` the engine does not know, is a **silent**
fallback to the default. Statically that is caught only by `vimp-contract`
rule **E6** — see [debugging.md](debugging.md).

### How often the position is written

The geometry above is recomputed every frame, but it reaches the
`PannerNode` under two guards, and both exist for the same reason: inside
Howler one `pos()` is three `setValueAtTime` calls on `positionX/Y/Z` plus
a `'pos'` event, and at 60 Hz across the voice limit that is thousands of
automation writes per second. WebKit answers such a stream with artefacts,
clipping and dropouts — its HRTF is a real convolution per node, not a
cheap approximation — while the panorama itself gains nothing from the
extra writes.

- **A movement threshold.** The last position written into the node is
  remembered per instance; a source that has not moved past it is not
  rewritten. Most world sources are stationary — a burning wreck, an
  ambience, a dropped item.
- **A rate gate.** Positions are written at most every `1000 / 30` ms,
  with a two-millisecond tolerance at the boundary so that a 60 Hz frame
  arriving a hair early does not push the write to the next one and drop the
  effective rate to 20 Hz. 30 Hz is the usual update rate for game audio,
  and the ear does not hear the difference from 60.

**Only the position write is gated.** Volume goes through `_applyVolume`
every frame, and so do the `rate` update and the reaping of instances whose
source is gone. Volume has to: a game drives it from speed (an engine loop),
where a 30 Hz staircase would be audible, and the `maxDistance` mute has to
land in the same frame the source leaves the radius, not 33 ms later.

**A non-finite value never reaches an audio parameter.** `setValueAtTime`
throws on NaN/Infinity, and an exception in the render tick stops the Pixi
ticker — the game freezes. `_writePos`, the only position write point,
skips a non-finite position and does not remember it; `_applyVolume` treats
a NaN distance as beyond `maxDistance` and mutes the source. The same holds
for `rate`: Howler validates volume but hands `rate` straight to
`playbackRate.setValueAtTime`, so `updateActiveSounds` passes it on only
when it is finite; until then the previous rate plays.

## InputListener

[packages/engine/src/client/InputListener.js](../../packages/engine/src/client/InputListener.js) — low-level
keydown/keyup capture for Controls; `modes`/`cmds` take priority over the
game key set.

## UI hierarchy (z-index)

`vimp` (1) → `radar` (2) → `chat` (3) → `vote` (5) →
`game-informer` (6) → `panel`/`stat` (7) →
`lobby`/`auth`/`session-overlay` (8) → `tech-informer` (9). The session
overlay ("Reconnecting…", host migration stage 4; "Switching host…",
stage 7) is never shown together
with the lobby or the auth screen; a terminal reason in `#tech-informer`
stays above it. The lobby (`#lobby`, z-index 8) is the starting
server-selection screen, shown by `main.js` only when the route leads to
it (a direct link or quick play never shows it — the lobby login only
reveals the user badge) and hidden once the game starts. The room menu
(`#room-menu`, `RoomMenu` MVC, `views/includes/roomMenu.pug`) is a button
inside the panel, right of its table (once the session starts, `main.js`
calls `RoomMenuCtrl.setInPanel` and the view moves the node into `#panel`:
the panel markup is shared with the standalone SDK, which has no room menu;
a game without `panel` in `initIdList` keeps the button in the corner; its
list is `position: fixed`, past the panel's `overflow:
hidden`), lobby mode only, visible while the tab is in a room
(the room link itself sits in the address bar). Items (host migration
stage 8d): **Leave server** — everyone; a guest sends `LEAVE` to the host
and `leave_room` to the master and reloads into the lobby, the host with
other people hands the role over (`reason: 'leave', stay: false`) and goes
to the lobby, a host alone closes the room: "Leaving…" overlay,
`host_closing` (the master hides the room and stops letting anyone in),
`HostController.shutdown` — the Worker writes the participants' scores, at
most `migration.leaveFlushTimeoutMs` (3 s); a Worker handoff still waiting
for the round boundary is cancelled first — then `host_leaving` (no people,
the master closes it at once). **Hand over host** — only the current host,
when the room has other people and the master assigned a successor
(`successor_assigned` with a non-null `successorMemberId`):
`HandoffFlow.start({ reason: 'handover', stay: true })`, no confirmation
(the role can be handed back). While a handoff runs both are disabled and a
status takes their place ("Handing over…", "Slow connection…"); a failed one
shows "Host handover failed" until the menu is closed. The panel sits above
the transparent `#game-informer`, which would otherwise swallow the menu's
clicks, and under the game's auth screen.

---

[← Previous: Rust Core](core.md) · [Next: Network Protocol →](network.md)
