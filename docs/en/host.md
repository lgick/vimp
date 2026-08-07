# Browser Host

The browser host runs **the authoritative part of the match right in the room
creator's tab**: the WASM simulation core (`core/`) and the JS meta layer run
in a Web Worker, while the `RTCPeerConnection` router runs in the main
thread. This is the canonical "server side" of the game: the legacy
authoritative WS server (`src/server/`) has been fully removed.

Host code lives in `packages/engine/src/host/` (Worker + core + meta modules under
`packages/engine/src/host/meta/`) and `packages/engine/src/client/network/` (the main-thread router +
transports).

## Host tab topology

```
Host tab
├─ Main thread (client + router)
│   ├─ client (packages/engine/src/client/main.js): render, prediction, sound — a regular client
│   ├─ HostController: spawns the Worker, routes packets Worker ↔ clients
│   ├─ LoopbackTransport: host-player transport (a WebRtcManager-shaped
│   │  interface over postMessage)
│   └─ HostConnectionManager: WebRTC answerer for remote clients
│      (register_host, meta/state, backpressure)
└─ Web Worker (packages/engine/src/host/host.worker.js): authoritative simulation
    ├─ GameCore (WASM, the game plugin's core/pkg-web, e.g. vimp-tanks's)
    ├─ GameCoreAdapter: physics/bots/packing surface over the core
    └─ HostGame facade + meta packages/engine/src/host/meta/ (RoundManager, Participant-
       Manager, Chat, Vote, Stat, Panel, TimerManager, RTTManager,
       CommandProcessor, VoteCoordinator, SocketManager) + ~120 Hz loop
```

Key rule: `RTCPeerConnection` **lives in the main thread** (it can't be
created inside a Worker), while the game loop lives **in the Worker** (its
timers aren't throttled by the browser in a background tab, unlike the main
thread). The main thread is a dumb pipe: it forwards wire frames between the
DataChannel/loopback and the Worker.

## Web Worker (`packages/engine/src/host/host.worker.js`)

Loads the game's `HostPlugin` (dynamic `import(room.game.hostEntryUrl)`,
Stage 6.4 — the Worker doesn't know the game at build time), builds
`HostGame` with the room's settings, and holds a per-client port state
machine — an automaton over client ports 0–8 (see [network.md](network.md)).
Main-thread messages:

- `init(room, handoff?)` — dynamically imports `HostPlugin` from
  `room.game.hostEntryUrl` (`room.game = { id, version, hostEntryUrl,
  wasmUrl }`, built by `connectAsHost` from the active `GameManifest`),
  assembles the game config (a merge of the engine defaults
  `packages/engine/src/config/hostDefaults.js` and `HostPlugin.gameConfig`)
  and applies room settings to it
  (`applyRoomOverrides`, `packages/engine/src/lib/applyRoomOverrides.js`:
  name/map/limit ≤ `roomDefaults.maxPlayers`/timers (`roundTime`/`mapTime`
  clamped to `roomTimeMin…roomTimeMax`)/friendly fire; maps come
  from `room.maps` if the main thread fetched the master's catalog),
  initializes the core via `HostPlugin.createCore(coreConfigJson, {
  wasmUrl: room.game.wasmUrl })`, creates `HostGame`, replies
  `ready { mapName, seed }`. Everything except the postMessage wrapping is
  `packages/engine/src/lib/createHostRuntime.js` — the same function the
  headless runner boots a match with, so the two cannot drift apart (its
  injection points — `loadHostPlugin`, `createSocketManager`, `hostOptions`,
  `overrideGameConfig` — are unused in production and default to the
  behaviour above). The `seed` in `ready` is the PRNG seed the match
  actually runs on: `room.seed` when given, otherwise drawn from `clock` —
  it is what makes a recording replayable, see
  [debugging.md](debugging.md);
  `handoff` is the Worker handoff state: the room is restored instead of a
  cold start. A failure (game import/WASM/config/handoff meta) sends
  `error { message }`: on a cold start the main thread tears down the room
  and returns to the lobby, on a handoff it resumes the old Worker;
- `connect(socketId)` — a new client: registers a wire socket in
  `SocketManager`, sends `CONFIG_DATA` (port 0), starts the
  config→auth→map→firstShot handshake. **A full room** (`HostGame.isFull`,
  **humans** against `maxPlayers`; bots don't take a slot — connecting a
  human past the combined limit kicks a bot, `_freeSlotForHuman`) is refused:
  the connection closes with code `4006` and reason `roomFull` (no waiting
  queue in a P2P room). A client from handoff meta is restored past the
  handshake — its port state machine comes up already in the game state;
- `message(socketId, data)` — an incoming client message
  (`JSON [port, payload]`), dispatched by allowed ports;
- `disconnect(socketId)` — removes the participant from the game and the
  registry;
- `update_maps(maps)` — an updated map catalog from the master →
  `HostGame.updateMaps`;
- `prepare_handoff` / `resume` / `handoff_complete` — the Worker handoff
  protocol (see the section of the same name below);
- `debug { action, requestId }` — dev-only debugging requests
  (`startRecording`/`stopRecording`/`dump`), answered by `debug_result` with
  the same `requestId`. The promise on the main thread has a 5 s timeout:
  debugging is needed precisely when the Worker is stuck, and a silently
  hanging `await` would be the same failure mode the tooling exists to
  remove. See [debugging.md](debugging.md).

The Worker sends back to the main thread `to_client` (a wire frame: a JSON
string or a binary `ArrayBuffer` via a Transferable), `close_client`,
`ready { mapName, seed }`, `error` (init failure), `map_changed { mapName }`
(a map change from a vote/timer — the main thread updates the room record at
the master), `handoff_state { state }` (a handoff: room state at a round
boundary) and `debug_result { requestId, … }`. The
per-user **wire socket** (`makeWorkerSocket`) implements the `SocketManager`
contract (`send`/`sendBinary`/`close`) over `postMessage`. Transport quirks:

- `close(code, data)`: closing a data channel carries no code/reason — the
  reason (idle/RTT kick, full room) is delivered as a separate
  `TECH_INFORM_DATA` over meta **before** `close_client` (reliable-ordered
  guarantees the order), and the client shows it instead of a generic "Host
  left";
- `send(port, data, reliable)`: `reliable: false` routes a JSON message onto
  the unreliable state channel — only `PING` travels this way (see
  `network.md`).

The ~120 Hz game loop starts on its own (`HostGame` constructor →
`RoundManager.createMap` → `TimerManager.startGameTimers`); frames only go
out to participants ready to play.

### Auth response (Stage B3)

Port 1 (`AUTH_RESPONSE`) still runs `validateAuth` against the game's
`HostPlugin.authSchema.params`/`.validators` (game-specific fields only,
e.g. `model` — `name` was removed from the game plugin's `src/config/auth.js`,
e.g. `vimp-tanks`'s).
Once those pass, the Worker itself is the authority on identity: it calls
`verifyClientToken(data.token)`, which lazily fetches and caches
`GET /auth/jwks` (the master's proxy of the central auth service, see
[auth.md](auth.md#joining-a-room-host-verification) and
[master.md](master.md#get-authjwks)) for the Worker's lifetime, then
`verifyIdentityToken` (`packages/engine/src/lib/jwt.js`) checks the RS256
signature (Web Crypto `crypto.subtle`, no JWT dependency), `iss`
(`config/authClient.js`'s `issuer`) and expiry, and returns the token's
`nick` claim. Only then does `host.createUser({ ...data, name: nick },
socketId, cb)` run — a client can no longer type an arbitrary name. A
missing/invalid/expired token sends `AUTH_RESULT` with
`[{ name: 'token', error: 'invalid' }]` and no user is created; a client
that disconnects mid-verification is checked against the live `clients` map
before `createUser` runs.

### Player rank and state sync (Stage B4)

Now that the identity token is verified once (above), it's also **retained**
on the participant — `HumanParticipant.token` (set from `params.token` by
`ParticipantManager.createHuman`) — so later authenticated writes back to
the auth service can reuse it without re-verifying.

`meta/modules/PlayerDataSync.js` is a per-participant in-memory map of
`{ token, rank, state, rankLoaded, stateLoaded }`. `rankLoaded`/`stateLoaded`
(added in a post-B4 code-review pass, `plan/done/central-auth/auth_fixes.md`) track whether the
value currently held was actually confirmed by the auth service, as opposed
to still being the join-time default:

- **Load on join**: `HostGame.createUser()` fires
  `playerDataSync.load(gameId, params.token)` fire-and-forget — it doesn't
  block the join flow. `load()` calls the master's `GET /auth/rank` and
  `GET /auth/state` (same relative-fetch pattern the Worker already uses for
  JWKS, see [auth.md](auth.md#joining-a-room-host-verification) and
  [master.md](master.md#getput-authrank-getput-authstate)) using the
  participant's own token. On any failure (auth service down, network
  error) it keeps the defaults — rank `0` and the game's declared
  `playerState.defaultState` (`HostGame` reads it from
  `data.playerState?.defaultState`, e.g. the game plugin's
  `src/config/game.js`, `vimp-tanks`'s,
  cloned per participant rather than shared) — a join is never blocked by
  auth-service unavailability, and `rankLoaded`/`stateLoaded` stay `false`
  until a real value is confirmed. A rank delta applied via `addRank` while
  the load is still in flight is added to, not overwritten by, the server
  value once it arrives.
- **Accumulate**: `RoundManager.reportKill()` is the single choke point for
  rank, mirroring how it already accumulates the ephemeral `Stat` score
  there — `playerDataSync.addRank(killerId, +1 or -1)` with the same
  win/team-kill branching as the score update.
- **Sync back**: `flush(participantId)` `PUT`s the participant's current
  state and *rank delta* to the master (`Promise.allSettled`, best-effort —
  a failure never propagates into the round, and a later flush retries with
  whatever's accumulated by then; it is logged, not swallowed, see
  "Diagnosing rank/state sync" below). Since server-rating stage 1, auth's `/rank` is an append-only
  ledger, not an absolute value — `PlayerDataSync` tracks `pendingRankDelta`
  (everything `addRank` has added since the last successful flush) and
  `PUT`s that instead of the locally accumulated total; on a `200`, exactly
  the delta that was sent is subtracted back out, so an `addRank` racing the
  in-flight request isn't lost (same pattern as the load-race fix below). If
  `rankLoaded`/`stateLoaded` is still `false` (the initial `load` never
  succeeded), `flush` retries `load()` first and only `PUT`s the part that's
  now confirmed loaded — otherwise a transient auth-service outage at join
  time would `PUT` the rank-`0` default over a player's real saved rank on
  the very next map/round boundary. `flushAll()` flushes every current
  participant. Two lifecycle points call `flushAll()`:
  `RoundManager.createMap()` (map change) and
  `RoundManager._checkTeamWipe()` (round end) — both alongside the existing
  `Stat.reset()`/`Stat.updateHead()` calls at those same boundaries.
  `HostGame.removeUser()` does one more best-effort `flush()` for the
  leaving participant before deleting its `PlayerDataSync` entry.
- **Diagnosing rank/state sync**: because none of the above is allowed to
  break a round, every failure path is tolerated — so each one logs a
  `[playerData]` warning in the Worker's console instead of passing
  unnoticed: a non-`ok` `GET` on join (which leaves `rankLoaded`/`stateLoaded`
  `false` and thereby gates off *all* later `PUT`s), a non-`ok` `PUT` on
  flush, and any rejected request. Silence across a whole match means the
  requests were never issued at all, which points at `createUser` rather than
  at the sync. Related invariant: the module takes `fetchImpl` and must keep
  calling it as a standalone function — the constructor's default wraps the
  global `fetch` in an arrow for that reason. Storing bare `fetch` in a field
  and calling it as `this._fetch(...)` passes the instance as the receiver,
  which is a `TypeError` in a browser/Worker before any request goes out, and
  tests injecting a plain-function `fetchImpl` never see it.
- **Attribution** (code-review fix, `plan/done/server-rating/review.md` finding
  №1): every `PUT` body also carries `hostId` **and its per-room
  `hostSecret`**, so the master can stamp the event with this room's verified
  `hosterUserId`/`sessionId` before forwarding it to auth (see
  [master.md](master.md#getput-authrank-getput-authstate)) — without it,
  stage 4's rank/skill voiding on a blocked hoster had nothing to void. The
  secret proves the host owns `hostId` (public via `GET /servers`), so a
  cheating host can't attribute its writes to another active room to dodge
  the void. `PlayerDataSync` doesn't know its own `hostId`/`hostSecret` at
  construction (the Worker starts before the master's `register_host` reply);
  `setHostId(hostId, hostSecret)` is called once that reply arrives —
  `host.worker.js`'s `set_host_id` message, posted by
  `HostController.setHostId` (called from `client/main.js`'s
  `host_registered` handler) — and again, without waiting for a fresh
  `register_host`, from `room.hostId`/`room.hostSecret` on a Worker-handoff
  `init` (Stage 5.2), since `HostController` persists them onto `_room` so a
  swapped-in Worker inherits them immediately.

`HostGame` exposes `getPlayerRank(gameId)`/`getPlayerState(gameId)`/
`setPlayerState(gameId, state)`/`setHostId(hostId, hostSecret)` for game-plugin modules
(and a future `/rank` chat command, Stage B5) to read/write rank and the
opaque state blob. The Rust/WASM game core is not involved at all —
rank/state is a purely engine/JS-side concept.

## HostGame (`packages/engine/src/host/HostGame.js`)

The host facade — module wiring + the participant lifecycle:

- simulation/bots/snapshot packing live in the Rust core, reached through
  `GameCoreAdapter`;
- meta (`RoundManager`, `ParticipantManager`, `Chat`, `Vote`, `Stat`, `Panel`,
  `TimerManager`, `RTTManager`, `CommandProcessor`, `VoteCoordinator`,
  `SocketManager`, `PlayerDataSync`) lives in `packages/engine/src/host/meta/` modules (see "Meta modules"
  below), with dependencies passed through constructors (DI);
- the hot `_onShotTick` is core-driven: `adapter.updateData(dt)` (a core step
  + event drain), send throttling (`SnapshotThrottle` — a frame every
  `networkSendRate`-th tick), `adapter.packBody()` once per tick, then a
  per-user `adapter.packFrame(...)` (the core itself assembles the
  prediction player block for `playerId`);
- **connection lifecycle**: `createUser` (registering a spectator in every
  module — called with the host Worker's verified nick, not a freely-typed
  name, see "Auth response" below), `removeUser`, `mapReady`,
  `firstShotReady`, `sendMap` (a proxy to RoundManager); **input** via
  `updateKeys(gameId, 'seq:action:name')`;
  **chat and votes** via `pushMessage` (sanitizing, `/commands` →
  CommandProcessor) and `parseVote`; bridges for `TimerManager`/`RTTManager`
  callbacks (kicks), `reportKill`, `triggerCameraShake`, `updateRTT`;
- **the host player is excluded from kick policies** (idle- and RTT-kicks):
  its loopback *is* the room, so kicking it would kill the room for
  everyone. `hostSocketId` arrives in the options (from
  `lobbyConfig.create.hostSocketId`, value `'local'`, agreed with
  `LoopbackTransport`); guests are kicked normally;
- `isFull`/`maxPlayers` — the room-fullness gate for the Worker's port state
  machine: only humans count; bots yield their slot (a bot is kicked by
  `RoundManager.changeTeam` when a player joins a full team, and by
  `_freeSlotForHuman` when a human connects past the combined limit);
- `updateMaps(maps)` — updates the map catalog: `_maps`/`_mapList` are
  mutated in place (the same references are held by `RoundManager` and
  votes) — new data applies from the next map change on, with no
  `RoundManager` changes needed;
- map changes are tracked in the tick (`onMapChange` → `map_changed` to the
  main thread) — the master's lobby sees the room's current map;
- **Worker handoff**: `requestHandoff(cb)` (stops the game and collects
  handoff meta at the nearest round boundary), `completeHandoff(socketIds)`
  (in the new Worker: kicks anyone who didn't reconnect, resumes timers,
  starts the first round), `resumeAfterHandoff()` (rollback if the new
  Worker fails), and the constructor's `handoff` option (restoring instead
  of a cold start) — see "Worker handoff" below.

The client-facing `CONFIG_DATA` (port 0: base config + vote time + prediction
data) is assembled by `packages/engine/src/lib/buildClientConfig.js`.

### Debug recorder (dev only)

When `gameConfig.isDevMode` is on (`room.isDevMode`, which `client/main.js`
sets from `import.meta.env.DEV`), `HostGame` owns a `DebugRecorder`
(`packages/engine/src/host/DebugRecorder.js`, Worker-safe — it only uses
`clock`) that writes the live match into the headless runner's scenario
format: seed, joins, and every `updateKeys`/`pushMessage`/`parseVote` tagged
with its tick. In production the recorder is `null` and every recording
point degrades to `?.`.

Public surface: `startRecording()`, `stopRecording()`, `isRecording`,
`debugSnapshot()` (host meta — seed, seq, tick, participants, current map —
plus the core's `debug_json`). It reaches the tab through the Worker's
`debug`/`debug_result` pair and `HostController.startRecording/
stopRecording/dump()`; the recorder's own events also go to the clients'
consoles over port `CONSOLE`. Full loop:
[debugging.md](debugging.md#the-browser-half).

## GameCoreAdapter (`packages/engine/src/host/GameCoreAdapter.js`)

Implements the physics/bots/packing surface consumed by
`RoundManager`/`SocketManager`/`HostGame`, backed by `GameCore`:

- **lifecycle/physics** → the core's ABI: `createMap` → `load_map` (the map
  is already scaled in JS by `RoundManager.scaleMapData`, so it's loaded
  with `scale: 1` — the core doesn't scale it again); `createPlayer`/
  `removePlayer` tell scripted participants and humans apart via
  `participant.isScripted` (`spawn_scripted_actor`/`remove_scripted_actor` —
  a tank + AI in the core — versus `spawn_actor`/`remove_actor`);
  `changePlayerData` → `reset_actor`;
- **input** → `apply_input` (seq is confirmed by the core in the frame's
  player block);
- **event projection**: after `step`, drains `take_events()` and routes the
  standard engine dictionary (Wasm Host ABI, `packages/engine/core/src/events.rs`) itself,
  with no game-side mediator: `panelSet`/`panelActive` →
  `panel.updateUser(..., 'set')`/`panel.setActiveWeapon` (`field` is the
  game's panel-schema key, not tied to a specific weapon), `death` →
  `HostGame.reportKill`, `shake` → `HostGame.triggerCameraShake`
  (health/ammo live in the core, the panel is their projection). `custom` is
  the only type carrying game-specific meaning outside the dictionary:
  drained as-is into the optional `HostPlugin.onCoreEvent(data, { panel,
  vimp })` (tanks doesn't use it — `onCoreEvent` is left unset). The core
  operates on numeric ids (u32), meta keys by string — the adapter converts
  event ids to strings at this boundary;
- **packing**: `packBody` → `pack_body`, `packFrame` → `pack_frame` +
  `frame_bytes` (a copy from WASM memory, works on both the web and nodejs
  targets);
- **the first frame**: `getPlayersData` → the core's `players_data()` (a
  full player snapshot without draining accumulators — for
  `FIRST_SHOT_DATA`).

The game's scripted module (the game plugin's `src/host/`, e.g.
`vimp-tanks`'s `TanksBotManager.js`) is a thin bot manager registering
participants and linking them to `Stat`/`Panel` (AI, navigation, and the
spatial grid live in the core). It's built by the `createModules(ctx)`
factory (the game plugin's `src/host/createModules.js` returns
`{ scripted }`); the engine calls the scripted-module contract: `createMap`,
`createScripted(count, team?)`, `removeScripted(team?)`,
`removeOneForHuman(team)`, `getCount`, `getCountsPerTeam`. Parameters come
from the game config's `scripted` (`namePrefix`, `defaultModel`).

**The game's HostPlugin** (the game plugin's `src/host/index.js`, e.g.
`vimp-tanks`'s; the default export
of the game's host-entry bundle) — the whole game half of the host as a
single object: `id`, `engineApi`, `createCore(coreConfigJson, { wasmUrl })`,
`gameConfig`, `authSchema`, `chatCommands` (e.g. a bot-spawn command),
`systemMessages` (a plugin-defined group), `createModules` (returns the
scripted module), `buildClientGameConfig()` (the game half of CONFIG_DATA);
optionally `onCoreEvent` for game-specific `custom` core events (`vimp-tanks`
doesn't set it).
`host.worker.js` loads it with a dynamic `import(room.game.hostEntryUrl)` on
`init` (Stage 6.4) — `room.game` (`{ id, version, hostEntryUrl, wasmUrl }`)
comes from `GameManifest.entries` via `connectAsHost`, so the engine never
imports the game statically at all. It's consumed by `host.worker.js`
(`createCore`, configs/auth) and `HostGame` (commands, codes, modules,
`onCoreEvent`).

## Meta modules (`packages/engine/src/host/meta/`)

The Worker's JS meta layer: game logic on top of the core's events. Modules
are dependency-injected and Worker-safe (isomorphic APIs only —
`Date`/`Math`/`performance`/`setTimeout`/`queueMicrotask`, no Node globals).

### ParticipantManager — the participant registry (`meta/player/`)

**The single source of truth for participants** (humans + scripted
participants/bots):

- `Participant` classes (base: `gameId`, `name`, `model`, `team`, `teamId`,
  `status`) → `HumanParticipant` (`socketId`, `isReady`, `currentMap`,
  `isWatching`, `watchedGameId`, `forceCameraReset`, `pendingShake`,
  `lastActionTime`, `lastInputSeq`) and `ScriptedParticipant`;
- scripted vs. human is told apart with `isScripted`/`isNetworked` getters,
  **not** by id shape: humans and scripted participants share a single numeric id
  space (the generator picks the lowest free id);
- API: `createHuman`/`createScripted`/`remove`/`get`/`getAll`/`getHumans`/
  `getScripted`/`getNetworkedReady` (ready to be broadcast to), `checkName`
  (name deduplication; a scripted name is the game config's
  `scripted.namePrefix` + id), team sizes (`getTeamSize`/`addToTeam`/
  `resetTeamSizes`), the active-watch list (`addActive`/`removeActive`/
  `getActiveList`/`replaceWatched`), the `maxPlayers` limit (`totalCount`).

Bots and players already share this registry and a single numeric id space,
but behavior (networked input vs. the core's AI) is still handled by separate
code paths — fully unifying the two into one abstraction is a future task.

### `meta/core/` managers

**RoundManager** — rounds, teams, maps. Owns state: `currentMap`,
`currentMapData`, `scaledMapData`, `isRoundEnding`, `removedPlayersList`.

- `createMap()` — stops timers, resets Panel/Stat/Vote and teams, recreates
  the world (in the core, through `GameCoreAdapter`), sends `CLEAR` to
  everyone, moves everyone to spectators, broadcasts the map, restarts
  timers, recreates bots;
- `initiateNewRound()`/`_startRound()` — clears the active list, recreates
  the map, applies deferred team changes, resets the panel, sends a full
  stat table, the key set matching status, respawns and creates tanks;
- `changeTeam(gameId, team)` — checks for a free respawn (may evict a bot),
  honors the grace period at round start, otherwise defers the change to the
  next round;
- `changeName`, `changeMap` (a player-suggested map vote), `forceChangeMap`,
  `onMapTimeEnd` (a vote for the next map on timer; if nobody votes, the
  current map is extended);
- `reportKill(victimId, killerId)` — stats (frags/deaths/friendly fire),
  moving spectators to the killer, `_checkTeamWipe` → ends the round
  (awards the win, plays victory/defeat sounds, restarts after
  `roundRestartDelay`);
- `setActive`/`setSpectator` — player↔spectator transitions, sending the key
  set and the panel.

**CommandProcessor** — parses chat commands (messages starting with `/`).
The engine core: `/name <nick>`, `/timeleft`, `/mapname`, `/nr` (new round,
**dev mode only**); game commands are registered via
`registerCommand(name, handler)` and receive the meta context —
`handler(ctx, gameId, args)`. A game plugin can register its own commands
this way (e.g. `vimp-tanks` registers a bot-spawn command — see that
plugin's own docs for its syntax); if more than one human is active, a
vote runs instead of immediate execution (category `botManagement` for the
tanks example). An unknown command produces a "Command not found" system
message. (`/like`·`/unlike` never reach the host — the client intercepts them
and sends the vote straight to the master, see [master.md](master.md).)

**VoteCoordinator** — creates votes on top of the `Vote` module:
`canCreateVote` (topic cooldown check), `createVote` (payload + result
callback + participant list), `reset`. Topic cooldown — `timeBlockedVote`
(30 s).

### `meta/modules/` modules

- **`Panel`** — per-user HUD: the schema from `game:panel` (`fields` —
  game-defined keys, e.g. `vimp-tanks`'s health/ammo; `activeKey` — the
  active-item key, e.g. the active weapon in `vimp-tanks`),
  `updateUser(gameId, param, value, op)` accumulating `pendingChanges`,
  `processUpdates()` emits only changes once per snapshot tick (strings
  `'key:value'`, round time `t` — on every second change),
  `getFullPanel`/`getEmptyPanel`, `setActiveWeapon` (writes the schema's
  `activeKey`), `hasResources`/`getCurrentValue`. Authoritative game state
  (e.g. health/ammo) lives in the core — the panel is filled by a
  projection of its events (`GameCoreAdapter`).
- **`Stat`** — the scoreboard: row (body) and team totals (head) per the
  `game:stat` config; `addUser`/`removeUser`/`moveUser`/`updateUser`/
  `updateHead`; `getLast()` — the delta for this tick, `getFull()` — full
  state (on join).
- **`PlayerDataSync`** (Stage B4) — per-participant rank/state, loaded from
  and flushed back to the master's `/auth/rank`/`/auth/state` proxy; see
  "Player rank and state sync (Stage B4)" above for the full flow.
- **`Chat`** (`meta/modules/chat/`) — user messages and system templates
  (`systemMessages.js`): `push` (broadcast), `pushSystem`/
  `pushSystemByUser` (templated `'group:number:params'`), queues
  `shift`/`shiftByUser`. The code registry holds the engine groups
  `s`/`v`/`m`/`c`/`n`; game codes are registered via `registerCodes` (tanks
  brings the `b:*` group, the game plugin's `src/host/systemMessages.js`,
  e.g. `vimp-tanks`'s); the
  template texts live on the client.
- **`Vote`** — vote mechanics: a queue (a new vote during an active one
  isn't rejected, it waits), lifetime `voteTime`, list pagination (more
  than 7 options gets Back/More pages), tie resolution by random pick,
  per-user delivery (`pushByUser`/`shiftByUser`), `addInVote`, `getResult`.
- **`TimerManager`** — every game timer: the game loop (`onShotTick`,
  ~120 Hz), round (`onRoundTimeEnd`), map (`onMapTimeEnd`), RTT pings, idle
  checks, deferred calls (round restart, map change);
  `getRoundTimeLeft`/`getMapTimeLeft`.
- **`RTTManager`** — ping tracking: `scheduleNextPing()` (who to ping and
  with what id), `handlePong` (latency, EMA), kick callbacks at
  `maxLatency`/`maxMissedPings`. Ping/pong travel over the unreliable state
  channel — the measurement isn't skewed by the reliable meta stream's
  retransmissions.

### SocketManager (`meta/SocketManager.js`)

The single send point: JSON `_send(socketId, port, data, reliable)` and
binary `sendShot(socketId, frameBuffer, reliable)`; typed methods
(`sendConfig`, `sendMap`, `sendPanel`, `sendStat`, `sendChat`, `sendVote`,
`sendKeySet`, `sendGameInform`, `sendTechInform`, …) and `close` with a
technical code. Game parametrization comes from the game config:
`sendSoundCue(socketId, cue)` maps engine events
(`roundStart`/`victory`/`defeat`/`frag`/`death`) to the game's sound names
via `soundCues`, and `sendFirstVote` sends the `initialVote` vote (team
selection in tanks). Composite sends: `sendFirstShot` (first frame + full stat +
empty panel + key set 0), `sendPlayerDefaultShot`/
`sendSpectatorDefaultShot`. Transport is abstracted: in the Worker, wire
sockets sit underneath (`makeWorkerSocket`), and the `reliable` flag
classifies the meta/state channels.

## Main thread: router and transports (`packages/engine/src/client/network/`)

- **`HostController`** — spawns the Worker (from `workerUrl` in the master's
  manifest; without it, a bundled `new Worker(new URL('host.worker.js'),
  { type: 'module' })`; the factory is injected for tests), sends
  `init(room)`, routes `to_client`/`close_client` to registered clients, and
  forwards incoming messages to the Worker. Shared by loopback and remote
  clients; `onReady` (Worker is up) is the moment the room registers with
  the master (not called again during a handoff); `swapWorker(url)` — the
  Worker handoff (see the section of the same name).
- **`LoopbackTransport`** — the host-player transport: implements the
  `WebRtcManager` interface (`publisher` with `message`/`close`,
  `send`/`close`), but data travels through `HostController` → the Worker as
  postMessages. Transparent to client code; the `reliable` flag is ignored
  (loopback is reliable and ordered by nature).
- **`HostConnectionManager`** — the WebRTC answerer for remote clients (a
  mirror of `WebRtcManager`, which is the offerer on the client). Through
  `SignalingClient` it catches `webrtc_offer`, creates a `RTCPeerConnection`
  per client, accepts the `meta`/`state` channels in `ondatachannel`, sends
  `webrtc_answer` and exchanges ICE. Once both channels are open, it brings
  the client's connection up in the Worker (`HostController.open` →
  `connect`). Answers the client's signaling `ping_host` (`pong_host` — a
  latency measurement in the lobby).

### Channel classification and backpressure

An outgoing Worker frame is routed by channel: **events → `meta`**
(reliable-ordered), **pure positions → `state`** (unreliable). The decision
is driven by a `reliable` flag that `HostGame` computes per user:
`core.body_has_events()` (tracers/bombs/explosions/removals in the body — a
stateless getter on the core, doesn't change `pack_body`'s signature) ∨
`forceReset` on the camera ∨ `shake`. The JSON protocol (ports
`[portId, payload]`) is always over `meta`. The flag flows through
`SocketManager.sendShot(socketId, buffer, reliable)` → the worker socket →
`to_client` → the answerer. **Backpressure**: before sending a positional
frame, the state channel's `bufferedAmount` is checked; above the threshold
the frame is dropped (the next one compensates), `meta` is never dropped.

### Registering with the master

On `onReady` the host sends `register_host` (name/limit/map — the actual map
comes from the Worker's `ready`) and starts a heartbeat (`update_host` every
`lobbyConfig.create.heartbeatInterval` ms, less than the master's
`heartbeatTimeout`). `currentPlayers` = 1 (the host player) + the number of
WebRTC peers, refreshed as clients join/leave (`onPeersChange`); `mapName` —
on a map change (`map_changed` from the Worker). The host player leaving
kills the room: `handleDisconnect` stops the heartbeat, closes peers
(`HostConnectionManager.destroy`) and the Worker (`HostController.destroy`).

**Signaling reconnect**: the host's signaling WS needs to stay up
permanently (offers, heartbeat, listing) — on a drop, `main.js` reconnects
with exponential backoff (`lobbyConfig.reconnect`), and a fresh `welcome`
re-registers the room (a new `hostId` is acceptable). Established P2P
connections aren't affected by a signaling drop. In its `host_registered`
reply the master sends `mapsVersion` and `codeVersion` — a mismatch against
the versions the room was raised on triggers a map catalog re-read (see
below) / a Worker handoff.

### Dynamic maps

A room starts on the master's current maps rather than the ones baked into
the bundle: `connectAsHost` fetches `GET /games/:id/maps/manifest.json`
(`:id` — the active game's manifest id, Stage 6.4) plus every map and passes
them to the Worker's `init` (`room.maps`; catalog unavailability is
non-critical — falls back to the bundled maps). Updating on the fly:
`host_registered.mapsVersion` (after a reconnect) or the master's
`update_available` signal → `refreshHostMaps` → fetch the catalog →
`HostController.updateMaps` → the Worker's `update_maps` →
`HostGame.updateMaps`. New data applies **from the next map change on**
(the regular `RoundManager.createMap` path: scaling in JS → the core's
`load_map` with `scale: 1`); the vote map list updates immediately. Guests
need no changes — the host sends them the map over port 3.

### Worker handoff

Updating the code of a live room: on a new deploy, the host's Worker is
swapped for a new bundle **without dropping WebRTC connections** —
`RTCPeerConnection` lives in the main thread and doesn't notice the Worker
swap. A **soft handoff at a round boundary** is implemented: the core isn't
dumped (the world is recreated from scratch at the start of every round
anyway — `RoundManager._startRound`), and only JS meta is carried over;
clients see a regular round start. `serialize_state`/`deserialize_state`
remain in the core's ABI for future use (mid-round handoff) but don't
participate here.

**Detecting a new version.** The room's Worker is created from the `url` in
the master's `GET /worker/manifest.json` (`lobbyConfig.worker.manifestUrl`)
— Vite hashes asset names, so after a deploy the old page's bundle URL
disappears from what's served; a composite `hostCodeVersion` is remembered:
`{ engine, game: { id, version } }` (Stage 6.5). A deploy restarts the
master → the signaling WS drops → a regular reconnect → re-register →
`host_registered.codeVersion` differs from ours in either half (an engine
deploy changes `engine`, a game-plugin-only deploy changes `game.version`) →
`refreshHostWorker()`: re-fetches **both** `GET /worker/manifest.json` and
the active game's `GET /games/:id/manifest.json`
(`lobbyConfig.game.manifestUrl`), builds a fresh `room.game` object
(`{ id, version, hostEntryUrl, wasmUrl }` from the fresh manifest's
`entries.host`/`entries.wasm`), and calls
`HostController.swapWorker(url, freshRoomGame)` — so a game-only redeploy
triggers a relay exactly like an engine-only one, and the new Worker never
imports a stale `hostEntryUrl`. A `codeVersion` whose swap failed is
remembered (by the same composite key) and not retried on every re-register.
The `update_available { codeVersion }` push from the master is also handled
(for future use). In dev the worker manifest is empty (`version: null`) —
code updates are disabled, the Worker is bundled.

**Swap protocol** (`HostController.swapWorker(url, game)`):

1. the old Worker receives `prepare_handoff` → `HostGame.requestHandoff`
   installs a callback in `RoundManager`; the game continues until the
   nearest round boundary (a single funnel, `initiateNewRound`: the round
   timer, a deferred restart after a team wipe, a restart on a team change);
2. at the boundary, the old Worker stops the game (`stopGameTimers` + idle)
   and sends `handoff_state { state }`; from this point `HostController`
   buffers incoming client messages (a capped queue);
3. `HostController` overwrites `room.game` with the fresh manifest passed to
   `swapWorker` (Stage 6.5 — falls back to the room's existing `game` if none
   was passed), creates a new Worker from the new version's URL, and sends it
   `init { room, handoff: state }` (`room.maps` carries the current map
   catalog, `room.game` the fresh `hostEntryUrl`/`wasmUrl`);
4. the new Worker imports `room.game.hostEntryUrl` (Stage 6.4), restores the
   room (see below) and replies `ready` → `HostController` reconnects every
   live client with internal `connect` calls (port state machines come up
   past the handshake), delivers the buffered queue, sends
   `handoff_complete`, and tears down the old Worker (`terminate`);
5. `handoff_complete` in the new Worker: `HostGame.completeHandoff` kicks
   restored participants whose `connect` never arrived (dropped during the
   pause), resumes timers (the map — with its time remaining,
   `TimerManager.startMapTimer(duration)`), and starts the first round —
   clients get the usual `sendClear`/respawn/round start (`sendSoundCue`+`sendGameInform`).

**Handoff meta** (`HostGame._collectHandoff`, a versioned format —
`HANDOFF_VERSION = 3` as of Stage D3, which renamed the `bots` field to
`scripted`; v2 of Stage 6.5 added `gameId`/`gameVersion`):
the loaded `HostPlugin`'s `id` and the room's `gameVersion` (so a restore
into a mismatched game — should that ever happen — fails loudly instead of
restoring bogus state), human participants with `isReady` (gameId/socketId/
name/model/team) and scripted participants (with their original gameId —
the single numeric id space is preserved), the entire `Stat` score, the current map plus its
remaining time, the frame `seq` (snapshot numbering continues — clients'
interpolators aren't disturbed). **Deliberately not carried over**: chat
history, active votes and cooldowns, RTT stats, panel (health/ammo live in
the core and reset at round start), guests who hadn't finished the
handshake (their scoreboard rows are wiped, and such a guest goes through
the handshake again on the client).

**Fault tolerance**: a new Worker's init failure (`error`: incompatible
`HANDOFF_VERSION`, a `gameId` mismatch, a map left the catalog, a WASM
failure) or a timeout (15 s) → the new Worker is torn down, and `resume` is
sent to the old one (`resumeAfterHandoff`: restoring timers + resuming the
interrupted round) — **the room keeps living on the old code version**, and
players notice nothing. Concurrent swaps are prevented (a guard in
`main.js` and in `HostController`).

In the lobby (`packages/engine/src/client/main.js`):

- **joining** — a server card → `connectToHost(hostId)` → `WebRtcManager`
  (offerer);
- **creating a server** — the button/name field in the lobby
  (`#lobby-host`/`#lobby-name`, `packages/engine/src/config/lobby.js`) → `connectAsHost(room)`
  → `HostController` + Worker + `LoopbackTransport` (the host player) +
  `HostConnectionManager` (remote clients) + registering with the master.

From there client code is identical (the transport is abstracted). The host
leaving kills the room (no host migration) — same as for a regular client:
`handleDisconnect` stops rendering and returns to the lobby.

## Tests

Host and meta module tests live in `tests/host/`:

- `GameCoreAdapter.test.js` — unit tests against a fake core: mapping
  commands to the ABI, telling bots and humans apart, projecting events into
  the panel/facade, camera flags.
- `HostGame.test.js` — integration on top of the **real** core (`pkg-node`,
  `describe.skipIf` without a build): onboarding, an active player with a
  player block, movement, shooting (tracer + ammo), bots, `players_data`,
  `removeUser` (a null marker in the frame), the room limit (`isFull`), the
  host player's kick exclusion, `updateMaps`/`onMapChange`, the Worker
  handoff (collecting meta at a round boundary, restoring
  participants/score/`seq`, `completeHandoff` kicking anyone who didn't
  reconnect, `resumeAfterHandoff`, refusal on an incompatible version/a map
  gone from the catalog); binary frames are decoded by the client core
  (`ClientCore.decode_frame`; the scaffold is `tests/host/harness.js` with
  `FakeSocketManager`).
- `LoopbackTransport.test.js` — unit tests against a fake Worker:
  `HostController` (routing, a connect queue before `ready`, the `reliable`
  flag, `error`/`map_changed`/`updateMaps`; the handoff — `workerUrl`,
  buffering while paused, connect/flush/`handoff_complete` ordering, rollback
  to the old Worker on `error`, the concurrent-swap guard) and
  `LoopbackTransport`.
- `HostConnectionManager.test.js` — unit tests against fake peers/channels:
  offer→answer, meta/state channels, reliable classification, backpressure,
  ICE, the signaling pong, closing, an open/close race, cleanup on SDP
  failure, the non-fatal nature of a transient `'disconnected'`.
- meta module unit tests: `RoundManager`, `CommandProcessor`,
  `VoteCoordinator`, `ParticipantManager` (including the handoff's
  `restoreHuman`/`restoreBot`), `Chat`, `Vote`, `Stat` (including
  `serialize`/`restore`), `Panel`, `TimerManager`, `RTTManager`,
  `SocketManager`.
- related: `tests/client/network/SignalingClient.test.js` (the host's
  outgoing `register_host`/`update_host`/`webrtc_answer`/`pong_host`),
  `tests/core/core.test.js` (`body_has_events()` — meta/state
  classification).

## Build

The Worker loads the game plugin's `core/pkg-web` (the web target of the
core, e.g. `vimp-tanks`'s). That WASM build happens in the game plugin's own
repository, not here — see [core.md](core.md#build) and
[getting-started.md](getting-started.md) for how a game plugin package gets
installed/linked into `node_modules` for local development.

## Manual run checklist

The P2P migration is complete: client-side math (interpolation, prediction,
projectile spawning, frame unpacking) now lives entirely in the Rust core
(`packages/engine/core/src/client/` +
the game plugin's own `core/src/client/`, e.g. `vimp-tanks`'s); legacy JS equivalents and the JS-parity tests were
removed. What's left is this manual two-tab smoke test — Vitest doesn't
reproduce real WebRTC reordering, so an end-to-end match check is manual, in
the browser:

```bash
npm run core:build     # web target of the core for the Worker (once)
npm run dev            # master: lobby + signaling, https://localhost:3002
```

Open `https://localhost:3002`, "Create server" → the host tab. Remote
clients are other tabs/machines: lobby → the room shows up in the list →
joining.

Checklist (gameplay-specific steps below use `vimp-tanks` as the reference
plugin — swap in the active plugin's own equivalents):

- [ ] your own actor's movement (prediction/reconciliation without jitter);
- [ ] game actions (e.g. shooting), damage, death and respawn, team change
      (chat command or menu);
- [ ] bots: spawn, patrol, combat (AI in the core);
- [ ] chat, votes (map/team change), stats, panel — all update;
- [ ] a round: start/timer/team victory/new round;
- [ ] a full multi-player + bots match end-to-end;
- [ ] a drop: the host leaving kills the room → remote clients redirect
      to the lobby (`handleDisconnect`); there's no host migration.

**The Worker handoff** can only be checked on a built `dist` (the code
manifest is empty in dev): `npm run build` → run the master in prod mode →
create a room + connect a guest → edit the host code → `npm run build:app`
→ restart the master → wait for the host's reconnect/re-register:

- [ ] at a round boundary the room migrates to the new Worker (console:
      `[worker] room migrated to code version …`);
- [ ] P2P connections stay alive, the guest sees a normal round start;
- [ ] the scoreboard's score and names are preserved, bots are in place, the
      map's `/timeleft` keeps counting down (not reset);
- [ ] chat/votes keep working after the migration.

---

[← Previous: Central Auth Service](auth.md) · [Next: Rust Core →](core.md)
