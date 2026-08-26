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

| Mode | Master | Host | Transport |
| --- | --- | --- | --- |
| `lobby` | yes (catalog, signaling, OAuth) | Web Worker in the host's tab | WebRTC / loopback |
| `solo` | no | inline, in the page's main thread | loopback |
| `dedicated` | no | a Node.js process | WebSocket |

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
source, signaling + lobby + the `/like`·`/unlike` interception, the
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
`#panel`, `#stat` and `#vote` are `position: absolute`, and their containing
block is the nearest positioned ancestor. Visibility of the screens is handled
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
  active game) and then `connectToHost` creates a `WebRtcManager`,
  establishes P2P, and remembers `currentHostId` (for `/like`·`/unlike`). A
  plugin that fails to load is reported inline in `#lobby-error` and leaves
  the lobby usable — `#tech-informer` covers the whole tab and is reserved
  for terminal causes.
- **Server rating (`/like`·`/unlike`)**: outgoing chat goes through
  `handleChatSend` — it intercepts `/like <reason>`/`/unlike <reason>` and,
  instead of sending it to the host (port `CHAT_DATA`), sends the vote
  straight to the master (`signaling.likeHost`/`unlikeHost(currentHostId,
  reason, token)`, `token` — the voter's identity-token from `LobbyAuth`),
  bypassing the cheating host. A reason is required, available only to
  signed-in guests (`currentHostId` is set); for the host player or a signed-
  out player the command shows a local hint; a dropped signaling WS shows a
  plain error message (the vote wasn't sent). The master additionally only
  accepts votes from a session that actually connected to the room and
  verifies the identity-token — see
  [master.md](master.md#server-rating-likeunlike). The rest of chat goes to
  the host as usual.
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
  WASM memory (tanks/dynamics/camera/predicted tank) + `take_frames()` for
  rare event frames → applied through the previous `parse` pipeline (see
  "Client Core" below).
- Resets: a map change (`MAP_DATA` → `set_map`) and `CLEAR` (→ `reset`)
  clear the frame buffer and the predictor in the core; `reset` also drops
  the local player's identity (`my_game_id`), so the prediction overlay
  stops rendering an entity the host no longer has.
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
- **P2P drop** (`handleDisconnect`): the host leaving kills the room (no
  host migration) — removes the render tick (not `app.stop()`: with a shared
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
  resist fingerprinting, etc.), `connectToHost`/`connectAsHost` show a
  plain message and stay in the lobby instead of failing with a black
  screen.
- **The host role**: before starting the Worker, `connectAsHost` fetches
  the master's map catalog (falls back to the bundle), registers the room
  and starts a heartbeat once `ready` fires; the host's signaling WS
  reconnects with backoff on a drop
  (`lobbyConfig.reconnect`) and re-registers the room (a fresh `welcome`
  doesn't recreate the lobby — a guard in `initLobby`). A Worker init
  failure (`error`) tears down the room with a message and returns to the
  lobby.
- **Debug API (dev build only)**: `window.__vimpDebug`
  (`packages/engine/src/client/debug.js`) — `dump()`, `startRecording()`,
  `stopRecording()`, `divergence()`, `save()`. The branch is guarded by
  `import.meta.env.DEV`, so the production bundle drops it; the same flag
  goes into `room.isDevMode` and switches on the host recorder. Port 12
  (`CONSOLE`) carries the host's debug log into this tab's console as
  `[vimp:debug][host] …`. See [debugging.md](debugging.md#the-browser-half).

## Network layer (packages/engine/src/client/network/)

The game transport is WebRTC, not WebSocket (channel details —
[network.md](network.md#transport-webrtc)):

- **`SignalingClient`** — a thin wrapper around the master's signaling
  WebSocket: `connect()`, caching `id`/`iceServers` from `welcome`,
  relaying incoming messages to subscribers by `type` (via `Publisher`),
  methods `sendOffer`/`sendIceCandidate`/`pingHost`/`likeHost`/`unlikeHost`.
  The transport is injected by a factory for tests.
- **`WebRtcManager`** — the P2P connection to the host: `RTCPeerConnection`
  + the `meta` (reliable-ordered) and `state` (unreliable-unordered)
  channels. The client is the offerer: it creates the channels/offer,
  exchanges SDP/ICE through `SignalingClient`. `Publisher` events: `open`
  (both channels open), `message` (data from either channel in a single
  stream), `close` (a drop). `RTCPeerConnection` is injected by a factory
  for tests.

The client's role is picked in the lobby (`packages/engine/src/client/main.js`): **joining**
(`connectToHost` → `WebRtcManager`, offerer) or **hosting** (`connectAsHost`
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
(`ping_host`). Remote clients' data flows into the same Worker as the host
player's loopback. Details — [host.md](host.md).

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
footer, and styled by the same rules: a link to the engine's project page,
its version, and the copyright. `LobbyView` writes both once from
`client/lib/engineVersion.js`, which imports the engine package's own
`package.json` (`version` plus `name`/`homepage`) and is baked into the bundle
at build time — the master has no version endpoint. Both footers build their
link with the one pair `resolveProjectUrl`/`projectLink`
(`src/lib/packageLink.js`, rendered by `client/lib/footerLink.js`): the
package's `repository` (else `homepage`), normalised to https, labelled
`GitHub` or by its host. There is no fallback — a package declaring neither
gets no link and the cell stays empty, which is what makes the missing
metadata visible; contract rule `A7` warns about it, and
`npm create vimp-game --repository <url>` writes the field from the start. The crate
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
  emit would render the new leaderboard list next to the *previous* game's
  `myPlacement` for one frame). `latency` lives separately from the list and
  survives a refresh/pagination.
- **view** — renders cards, search, "Load more", the Active
  Servers/Leaderboard tab switch (`showTab`, toggles `.lobby-tab-btn.active`
  and the two content containers, UI-only — it does not trigger a fetch) and
  the Leaderboard list itself (`renderLeaderboard`: numbered rows using the
  server's competition-ranking `place` — not the row index, so ties don't
  drift out of sync with the caller's own placement (code review M3, see
  `GET /leaderboard` below) — `"<GAME TITLE> TOP-N"` header, total player
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
  `ping_host`; `pong` updates latency and re-sorts cards ascending,
  tied-latency cards breaking by `rating` descending (lobby page plan).
  `IntersectionObserver` is injected for tests. Each card's name is
  `"<gameId>/<name>"` (lobby page plan — matches the `gameId/name` search
  syntax on `GET /servers`, see [master.md](master.md#get-servers)) and also
  shows the hoster's cached rating (server-rating stage 3 —
  `.lobby-card-rating`, straight from the server object's `rating` field,
  signed for positive values (`+7`/`-3`/`0`); this is engine-level lobby UI,
  not something a game plugin renders.
- **controller** — proxies view events to the model; ping throttling lives
  in the model (`pingHost` returns `false` if the server was pinged
  recently, interval `pingInterval`). It does no fetching itself (lobby page
  plan): `gameChanged(gameId, title)` (invoked by `main.js` on
  `#lobby-game`'s `change`, and once at lobby open for the default game) is
  the **only** trigger — it's the sole source of the controller's own
  `leaderboard-needed` event, carrying the target `gameId`. Switching tabs
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
to the Worker come from the *picked* manifest (see the Bootstrap note
above). Each built field's `getValue()` (already unit-converted,
e.g. `unit:'s'` seconds→ms) overrides the matching `roomDefaults` key, and
the result is sent as the room object to `connectAsHost` → `HostController`
→ the Worker, where `applyRoomOverrides`
(`packages/engine/src/lib/applyRoomOverrides.js`) reads `maxPlayers`/`roundTime`/`mapTime`/
`friendlyFire`/`map`.

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
  own `package.json` by `GameCatalog` (see [master.md](master.md)). Note this is the npm semver, not `manifest.version`,
  which is a bundle hash. A manifest without those fields (a standalone SDK
  manifest, for instance) leaves both cells empty and the footer keeps its
  layout (`space-between`).
- **Stat** — sortable scoreboard tables (`sortList`), shown on Tab.
  `StatView` **generates the header and tables from the game's schema**
  (`modules.stat.params`: `columns` — column labels, `bodies` — an
  arbitrary number of teams) inside the `#stat` container; team
  colors/labels are the game's CSS.
- **Vote** — vote windows built from templates, pagination, a lifetime
  timer.

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
  buffer** — `new Float32Array(wasm.memory.buffer, hot_ptr(), len)` read
  zero-copy (the view is recreated every tick: WASM memory growth detaches
  the buffer). The buffer carries flags, the camera (already resolved:
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
- **prediction** (`client/predictor.rs`): a replica of the authoritative
  motion without Rapier collisions, at a fixed `timeStep`; tick formulas
  are **shared** with the game plugin's own actor-update code (e.g.
  `vimp-tanks`'s `core/src/motion.rs`) — the replica
  can't diverge from the authoritative path on formulas, integration
  parity (manual vs. Rapier) is locked in by the `client::predictor::parity` cargo
  tests; input history, replay from the frame's `serverTime`,
  `visualError` with exponential decay and a snap, freeze at `condition
  0`, resets on a camera forceReset/map change/keySet;
- **shot spawning** (`client/shot.rs` + `client/raycast.rs`): a replica of
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

## InputListener

[packages/engine/src/client/InputListener.js](../../packages/engine/src/client/InputListener.js) — low-level
keydown/keyup capture for Controls; `modes`/`cmds` take priority over the
game key set.

## UI hierarchy (z-index)

`vimp` (1) → `radar` (2) → `chat` (3) → `panel` (4) → `vote` (5) →
`game-informer` (6) → `stat` (7) → `lobby`/`auth` (8) → `tech-informer` (9).
The lobby (`#lobby`, z-index 8) is the starting server-selection screen,
shown before connecting to a host and hidden once the game starts.

---

[← Previous: Rust Core](core.md) · [Next: Network Protocol →](network.md)
