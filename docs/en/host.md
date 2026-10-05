# Browser Host

The browser host runs **the authoritative part of the match right in the
current host's tab** — first the room creator's, later whichever member the
role migrated to (see [Host migration](#host-migration)): the WASM
simulation core (`core/`) and the JS meta layer run in a Web Worker, while
the `RTCPeerConnection` router runs in the main thread. This is the canonical "server side" of the game: the legacy
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
`HostGame` with the room's settings, and delegates the per-client handshake
to `PortMachine` (see [below](#port-state-machine-portmachinejs)) — an
automaton over client ports 0–8 (see [network.md](network.md)). The Worker
itself is a thin adapter: the `postMessage` transport, the lobby identity
strategy and this switch over main-thread messages. Main-thread messages:

- `init(room, handoff?)` — dynamically imports `HostPlugin` from
  `room.game.hostEntryUrl` (`room.game = { id, version, hostEntryUrl,
wasmUrl }`, built by `HostRole.createRoom` from the active `GameManifest`),
  assembles the game config (a merge of the engine defaults
  `packages/engine/src/config/hostDefaults.js` and the `gameConfig` view —
  `packages/engine/src/lib/gameConfigView.js`, the engine's single read point
  for the plugin's config: it validates the four required paths and fills in
  a documented default for every other field, so a game of any age loads;
  see [plugin-api.md](plugin-api.md#gameconfig-fields-and-their-defaults))
  and applies room settings to it
  (`applyRoomOverrides`, `packages/engine/src/lib/applyRoomOverrides.js`:
  name/map/limit ≤ `roomDefaults.maxPlayers`/timers (`roundTime`/`mapTime`
  clamped to `roomTimeMin…roomTimeMax`)/friendly fire; maps come
  from `room.maps` if the main thread fetched the master's catalog),
  initializes the core via `HostPlugin.createCore(coreConfigJson, {
wasmUrl: room.game.wasmUrl })`, creates `HostGame`, replies
  `ready { mapName, lobbyInfo, seed }`. Everything except the postMessage wrapping is
  `packages/engine/src/lib/createHostRuntime.js` — the same function the
  headless runner boots a match with, so the two cannot drift apart (its
  injection points — `loadHostPlugin`, `createSocketManager`, `hostOptions`,
  `overrideGameConfig` — are unused in production and default to the
  behaviour above). The `seed` in `ready` is the PRNG seed the match
  actually runs on: `room.seed` when given, otherwise drawn from `clock` —
  it is what makes a recording replayable, see
  [debugging.md](debugging.md);
  `handoff` is the Worker handoff state: the room is restored instead of a
  cold start; `checkpoint` (gzip bytes, transferred) + `seqFloor` is a host
  checkpoint (host-migration stage 5): the match comes up **paused** with
  humans detached, see [Checkpoints](#checkpoints). A failure (game
  import/WASM/config/handoff meta/checkpoint) sends
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
- `prepare_handoff` / `cancel_handoff` / `resume` / `handoff_complete` — the
  Worker handoff protocol (see the section of the same name below);
- `checkpoint_start { intervalMs }` / `checkpoint_stop` /
  `checkpoint_request { final }` / `start_after_restore { waitForResume }` /
  `freeze` / `unfreeze` — host checkpoints (see [Checkpoints](#checkpoints);
  `waitForResume` — [Successor promotion](#successor-promotion));
- `round_boundary_wait` / `round_boundary_cancel` — a planned handoff in a
  game without `migration.midRound` waits for the next round (host
  migration stage 8d): the Worker answers `round_boundary` once the next
  round has started (the round is not held back — the successor restarts it
  from the soft checkpoint anyway, and a failed handoff must not leave the
  room without a round), and at once for a game with `midRound`;
- `shutdown { timeoutMs }` — the host closes the room ("Leave server" with
  nobody else in it): the Worker calls `HostGame.destroy()` — closes the
  participants' games and waits for the urgent profile flush — at most
  `timeoutMs` (3 s by default), then answers `shutdown_done`; an exception
  in `destroy` goes out as `diagnostic { kind: 'shutdown' }` and
  `shutdown_done` follows anyway. `HostController.shutdown()` first cancels a
  Worker handoff still waiting for the round boundary (`cancel_handoff`), and
  during a handoff already moving the state it resolves at once (the old
  Worker wrote the scores before handing the meta over). From then on a new `connect` (a guest whose
  offer reached the host before `host_closing`) is answered `close_client`
  without a code — in lobby mode the guest goes looking for another room
  instead of entering a match about to close. The Worker is not terminated —
  the main thread does that;
- `debug { action, requestId }` — dev-only debugging requests
  (`startRecording`/`stopRecording`/`dump`), answered by `debug_result` with
  the same `requestId`. The promise on the main thread has a 5 s timeout:
  debugging is needed precisely when the Worker is stuck, and a silently
  hanging `await` would be the same failure mode the tooling exists to
  remove. See [debugging.md](debugging.md).

The Worker sends back to the main thread `to_client` (a wire frame: a JSON
string or a binary `ArrayBuffer` via a Transferable), `close_client`,
`ready { mapName, lobbyInfo, seed }`, `error` (init failure),
`map_changed { mapName }` (a map change from a vote/timer; kept for main
threads loaded before host-migration stage 2), `lobby_info { info }` (the
room's lobby card text changed — the main thread updates the room record at
the master; see `gameConfig.lobbyInfo` in
[plugin-api.md](plugin-api.md#gameconfig-fields-and-their-defaults)),
`handoff_state { state }` (a handoff: room state at a round
boundary), `checkpoint { checkpointId, seq, createdAt, final, mode, bytes }`
(a host checkpoint, `bytes` in the transfer list; an encoding failure is a
`diagnostic` with `kind: 'checkpoint'`), `health { health }` (host health,
see below) and `debug_result { requestId, … }`. The
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

**Host health** (host-migration stage 9a). The loop measures itself in ~1 s
windows (`TimerManager`, `onLoopStats`): `tickRate` (loop iterations per
second, nominal 120), `maxGapMs` (the longest gap between iterations) and
`lostMs` (time cut off by the 0.1 s `dt` cap — the simulation lags behind
real time), plus `windowMs`. `HostGame` adds `peerRttMedian` / `peerCount`
— the median smoothed RTT of remote humans that answered at least one ping
(the host player on loopback and the initial 100 ms guess do not count;
none — `null` / `0`) — and the Worker posts `health { health }` to the main
thread (`HostController.onHealth`). While the match is frozen or paused the
loop stands still and there are no metrics, so a freeze never looks like
an overload. While the host tab is hidden, the main thread aggregates the
metrics and writes one summary per hidden episode to the client error
journal (see [debugging.md](debugging.md)).

### Port state machine (`PortMachine.js`)

`packages/engine/src/host/PortMachine.js` is the handshake automaton itself,
and it is **isomorphic**: no `self`, no `postMessage`, no DOM — everything it
knows about transport arrives through its dependencies. That is what lets the
same automaton run in the Worker, in an inline browser host and in a Node
process; a second copy of it would drift exactly the way copies of
`createHostRuntime` would.

```js
new PortMachine({ host, socketManager, clientCfg, authSchema, makeSocket, identity });
```

`makeSocket(socketId)` returns the wire socket (`send`/`sendBinary`/`close`,
the `SocketManager` contract); `identity` is the identity strategy below.
Methods: `connect(socketId)` (register the socket, send `CONFIG_DATA`, start
the handshake — or refuse a **full room** with `4006`/`roomFull`),
`restore(socketId, gameId)` (a participant already restored from handoff meta:
the machine comes up in the game state, no handshake), `message(socketId,
data)` (a wire frame `JSON [port, payload]`, dispatched by allowed ports),
`disconnect(socketId)`, `has(socketId)` and the `socketIds` getter (what
`HostGame.completeHandoff(new Set(...))` is fed), `startGraceFor(gameIds)`
(host migration stage 7: starts the grace timer of participants restored
from a checkpoint as detached — they never dropped on this host, so nobody
else would; with `resumeGraceMs` at `0` they are removed at once).

**Session resume** (host migration stage 4) is opt-in through two more
dependencies, `resumeGraceMs` and `resumeRequestTimeoutMs`. Only the lobby
Worker passes them (from `config/hostDefaults.js`: 20 s / 5 s); the
dedicated server and the inline host leave `resumeGraceMs` at `0` and
behave exactly as before. With resume on:

- after `FIRST_SHOT_READY` the participant gets a resume secret
  (`HostGame.issueResumeKey`, 128 random bits, hex, never logged) in
  `SESSION_DATA { resumeKey, gameId }`;
- `disconnect` of a participant who holds a key **detaches** it
  (`HostGame.detachUser`) and starts a grace timer; the timer removes the
  participant only if it is still detached. A participant without a key
  (still in the handshake) and the host player are removed at once;
- `LEAVE` (client port 10) removes the participant at once;
- `connect(socketId, { resume: true })` sends no `CONFIG_DATA`, opens only
  `RESUME_REQUEST` and closes the connection with `4008` if nothing comes
  in `resumeRequestTimeoutMs`;
- `RESUME_REQUEST` is checked in order — format version, the participant
  and its key (constant-time compare; an unknown `gameId` and a wrong key
  both answer `unknown`), the token's nick against the nick the participant
  entered with (`auth`) — and re-checked after the async identity check. On
  success an old connection still bound to the participant is closed
  (session takeover), the grace timer stops, the in-game ports open and
  `HostGame.resumeUser` sends `RESUME_RESULT`, the entry packet and a
  rotated `SESSION_DATA`. A refusal sends `RESUME_RESULT { ok: false,
reason }` and closes; the detached participant keeps waiting.

The wire side of the protocol is in
[network.md](network.md#session-resume).

### Identity strategies (`identity.js`)

Who a participant is — the one thing the handshake cannot decide on its own —
is a pluggable strategy, `packages/engine/src/host/identity.js`:

| Strategy                                   | Used by                | `params`         | `errorField` | `resolve`                                        |
| ------------------------------------------ | ---------------------- | ---------------- | ------------ | ------------------------------------------------ |
| `createTokenIdentity({ jwksUrl, issuer })` | lobby (production)     | `[]`             | `token`      | the `nick` claim of a verified identity token    |
| `createGuestIdentity({ fallbackPrefix })`  | standalone / dedicated | one `name` field | `name`       | the form's nickname, `Player_xxxx` as a fallback |

The contract is `{ params, errorField, resolve(data, socketId) }`. `params`
go in front of the game's `authSchema.params` in both directions (the nickname
is the first field a player fills in): they go out
on `AUTH_DATA` (so a guest nickname field reaches the client form through the
very same channel as the game's own fields) and they are checked by
`validateAuth` on `AUTH_RESPONSE`. A rejected `resolve` answers `AUTH_RESULT`
with `[{ name: <errorField>, error: 'invalid' }]` and no user is created.

Guest identity declares `name` with the engine's own `isValidName` validator
(`packages/engine/src/lib/validators.js`), so the host validates the nickname
without a line of game code. **Its limits are accepted deliberately**: guest
nicknames are neither unique nor spoof-proof — there is no central identity in
that contour at all.

### Auth response (Stage B3)

Port 1 (`AUTH_RESPONSE`) still runs `validateAuth` against the game's
`HostPlugin.authSchema.params`/`.validators` (game-specific fields only,
e.g. `model` — `name` was removed from the game plugin's `src/config/auth.js`,
e.g. `vimp-tanks`'s).
Once those pass, the host itself is the authority on identity: in the lobby
the Worker wires `createTokenIdentity`, whose `resolve(data)` lazily fetches
and caches `GET /auth/jwks` (the master's proxy of the central auth service,
see [auth.md](auth.md#joining-a-room-host-verification) and
[master.md](master.md#get-authjwks)) for the strategy's lifetime, then
`verifyIdentityToken` (`packages/engine/src/lib/jwt.js`) checks the RS256
signature (Web Crypto `crypto.subtle`, no JWT dependency), `iss`
(`config/authClient.js`'s `issuer`) and expiry, and returns the token's
`nick` claim. Only then does `host.createUser({ ...data, name: nick },
socketId, cb)` run — a client can no longer type an arbitrary name. A
missing/invalid/expired token sends `AUTH_RESULT` with
`[{ name: 'token', error: 'invalid' }]` and no user is created; a client
that disconnects mid-verification is checked against the machine's live
client registry before `createUser` runs.

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
  state and _rank delta_ to the master (`Promise.allSettled`, best-effort —
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
  `RoundManager._resolveRound()` (round end) — both alongside the existing
  `Stat.reset()`/`Stat.updateHead()` calls at those same boundaries.
  `HostGame.removeUser()` does one more best-effort `flush()` for the
  leaving participant before deleting its `PlayerDataSync` entry.
- **Numbered writes** (host-migration 7.7): a game-result write gets a
  number (`writeSeq`) the moment it is sent, and its sum leaves
  `pendingPoints`/`pendingBest` for the queue `writes: [{ writeSeq, points,
best }]`. It stays there until auth answers: `ok` or a `4xx` other than
  `429` closes it; a `5xx`, a `429` or a network failure keeps it, and the
  next flush repeats it **with the same number and the same sum** — only
  then do the rest of the queue and the points finished in between go out,
  in the same flush series. `serialize()` carries `writes` separately (they
  are not in `pendingPoints`), so a host restored from a checkpoint or a
  Worker handoff whose final flush timed out repeats the write its
  predecessor may already have delivered, and auth drops the repeat
  ([auth.md](auth.md), "Idempotent writes"). `restore()` does **not**
  continue the checkpoint's numbering — the old host may have used
  `writeSeq + 1, + 2…` after the checkpoint, and fresh points under those
  numbers would be dropped as repeats. Instead the points pending at the
  checkpoint are pinned at once as `writeSeq + 1` (the number the old host
  would have given them, so auth drops them if it did send them), and every
  later write takes a number from a new random range. What remains is games
  finished inside the rolled-back window (≤ ~1 s), which may be counted
  twice. Numbers start at a random point of a 48-bit range per profile entry
  (`crypto.getRandomValues`; the constructor option `writeSeqStart` replaces
  it in tests): auth's key has no room in it, and a participant who leaves
  and comes back gets a fresh entry — counting from zero again would collide
  with the numbers of the first visit. `PUT /auth/state` is not numbered — it
  is an absolute value, the last write wins.
- **Diagnosing rank/state sync**: because none of the above is allowed to
  break a round, every failure path is tolerated — so each one logs a
  `[playerData]` warning in the Worker's console instead of passing
  unnoticed: a non-`ok` `GET` on join (which leaves `rankLoaded`/`stateLoaded`
  `false` and thereby gates off _all_ later `PUT`s), a non-`ok` `PUT` on
  flush, and any rejected request. Silence across a whole match means the
  requests were never issued at all, which points at `createUser` rather than
  at the sync. Related invariant: the module takes `fetchImpl` and must keep
  calling it as a standalone function — the constructor's default wraps the
  global `fetch` in an arrow for that reason. Storing bare `fetch` in a field
  and calling it as `this._fetch(...)` passes the instance as the receiver,
  which is a `TypeError` in a browser/Worker before any request goes out, and
  tests injecting a plain-function `fetchImpl` never see it.
- **A contour without a master** (the headless runner, and the standalone /
  dedicated hosts) has nowhere to fetch a profile from — a relative URL does
  not even resolve outside a tab. It passes
  `hostOptions.playerDataFetch: offlinePlayerData()`
  (`packages/engine/src/lib/offlinePlayerData.js`), whose every response is
  `{ rank: 0, state: null }`. That is not a stub for the sake of silence: an
  empty profile _is_ the correct state of such a match, and it takes the
  network calls, the `[playerData]` warnings and the retries with it.
- **Attribution**: every `PUT` body also carries `roomId` **and the room
  secret `roomSecret`**, so the master can stamp the event with this room's
  verified `sessionId` before forwarding it to auth and key its per-room
  write limit by it (see [master.md](master.md#getput-authrank-getput-authstate)).
  The secret proves the host hosts `roomId` (public via `GET /servers`), so a
  cheating host can't attribute its writes to another active room.
  `PlayerDataSync` doesn't know its `roomId`/`roomSecret` at construction (the
  Worker starts before the master's `host_registered` reply);
  `setRoom({ roomId, roomSecret, epoch })` is called once that reply
  arrives — `host.worker.js`'s `set_room` message, posted by
  `HostController.setRoom` (called from the `host_registered` handler of
  `client/session/HostRole.js`) — and again, without waiting for a fresh reply, from
  `room.roomId`/`room.roomSecret`/`room.epoch` on a Worker-handoff `init`
  (Stage 5.2), since `HostController` persists them onto `_room` so a
  swapped-in Worker inherits them immediately. A Worker started by a page
  loaded before host-migration stage 2 still gets `set_host_id
{ hostId, hostSecret }` (or `room.hostId`/`room.hostSecret`) — the Worker
  maps it onto `set_room`.

`HostGame` exposes `getPlayerRank(gameId)`/`isPlayerRankLoaded(gameId)`/
`addPlayerRank(gameId, delta)`/`flushPlayerData()`/
`overrideMapData(mapData)`/`getPlayerState(gameId)`/
`setPlayerState(gameId, state)`/`setRoom({ roomId, roomSecret, epoch })` for game-plugin modules
(and a future `/rank` chat command, Stage B5) to read/write rank and the
opaque state blob. `getPlayerRank` answers `0` both for an unknown `gameId`
and while `PlayerDataSync.load()` is still in flight, so a game that writes
the rank into a stat column of its own (`bodyMethod: '='`) needs
`isPlayerRankLoaded`: it tells "rank 0" from "no rank yet" and keeps the
starting zero from overwriting the real value. `flushPlayerData()` syncs every
current participant's profile to the master right now: both scheduled
`flushAll()` calls live in `RoundManager` (map change, round end), so a game
with `endlessRound` that rebuilds its geometry through `overrideMapData`
instead of changing the map passes through neither — without it, a match's
accumulated rank only reaches auth when a participant leaves, and a closed
host tab loses it entirely. It is best-effort like the rest of
`PlayerDataSync`: the promise does not reject. The Rust/WASM game core is not involved at all —
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
  - event drain), send throttling (`SnapshotThrottle` — a frame every
    `networkSendRate`-th tick), `adapter.packBody()` once per tick, then a
    per-user `adapter.packFrame(...)` (the core itself assembles the
    prediction player block for `playerId`);
- **connection lifecycle**: `createUser` (registering a spectator in every
  module — called with the host Worker's verified nick, not a freely-typed
  name, see "Auth response" below), `removeUser`, `mapReady`,
  `firstShotReady`, `sendMap` (a proxy to RoundManager); **input** via
  `updateKeys(gameId, 'seq:action:name')` — the same entry point takes the
  pointer channel as `'seq:aim:x:y:flags'` (a world point plus bit 0
  «pressed» / bit 1 «double tap»), which reaches the core through
  `GameCoreAdapter.applyAim`; a spectator's pointer is dropped, as their keys
  are;
  **chat and votes** via `pushMessage` (sanitizing, `/commands` →
  CommandProcessor) and `parseVote`; bridges for `TimerManager`/`RTTManager`
  callbacks (kicks), `reportKill`, `triggerCameraShake`, `updateRTT`;
- **the host player is excluded from kick policies** (idle- and RTT-kicks):
  its loopback _is_ the room, so kicking it would kill the room for
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
  of a cold start) — see "Worker handoff" below;
- **checkpoints**: `setCheckpointSink(fn)`, `startCheckpoints(ms)` /
  `stopCheckpoints()`, `requestCheckpoint({ final })`,
  `freeze()`/`unfreeze()`, `startAfterRestore()`,
  `startAfterResume(onStart)` (a successor's start once people are back),
  `detachedGameIds()`, the constructor's `checkpoint`/`seqFloor`/`roomSettings`/`mapsVersion`
  options — see "Checkpoints" below;
- **planned handoff**: `awaitRoundBoundary(cb)` / `cancelRoundBoundary()`
  (`RoundManager.onRoundBoundary`: `cb` once, right after the next round
  starts; immediately for a game with `migration.midRound`);
- `destroy()` — the public teardown: stops the timers, `flushAll()`s the
  profiles and removes every participant, returning the flush promise. In a
  tab the match dies with its Worker; a long-lived process (the dedicated
  server) needs a graceful shutdown, or the timers hold the process and
  rank/state are lost.

The client-facing `CONFIG_DATA` (port 0: base config + vote time + prediction
data) is assembled by `packages/engine/src/lib/buildClientConfig.js`.

### Debug recorder (dev only)

When `gameConfig.isDevMode` is on (`room.isDevMode`, which `client/session/hostRoomPrep.js`
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
  `changePlayerData` → `reset_actor`; on a layered (2.5D) map a respawn
  point may name its level (`[x, y, angle, level]`), and right after
  `spawn_actor`/`spawn_scripted_actor`/`reset_actor` the adapter passes it
  on with `set_actor_level(gameId, level)`. The call is guarded by a
  `typeof` check, not out of caution for its own sake: a published game's
  `dist` carries the glue code of its own core generation and has no such
  method — there the level is derived from the geometry inside the core, as
  it is for a point without one;
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
comes from `GameManifest.entries` via `HostRole.createRoom`, so the engine never
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
  the world (in the core, through `GameCoreAdapter`), sends every human the
  spectator key set (`KEYSET_DATA`) and then `CLEAR`, moves everyone to
  spectators, broadcasts the map, restarts
  timers, recreates bots. The key set goes **before** `CLEAR` on purpose: it
  switches the client's prediction off, otherwise prediction recreates the
  local entity right after the canvas is cleared and it stays there as a
  ghost;
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
  once survivors remain in at most one team (the win goes to that team,
  whoever made the last kill — a suicide or a team kill included; no
  survivors is a draw), announces the winning team to everyone, spectators
  included, plays `victory` to the winning team and to spectators (on any
  outcome, a draw included) and `defeat` to everyone else, restarts after `roundRestartDelay`. Each wiped team's head
  gets `deaths +1` once per round (on a draw — the last players of several
  teams dying in one tick — every wiped team gets it at once). With 3+ teams
  a wipe can leave survivors in several teams; the round then waits, and
  `checkRoundOutcome()` — called by `changeTeam`, `HostGame.removeUser` and
  the bot kick that frees a slot for a joining human — ends it when a
  departure leaves survivors in only one (without a wipe earlier in the
  round, or while `destroy()` tears the match down, a departure decides
  nothing). A map change forgets the round's recorded wipes;
- `setActive`/`setSpectator` — player↔spectator transitions, sending the key
  set and the panel.

**CommandProcessor** — parses chat commands (messages starting with `/`).
The engine has **no** commands of its own: it is a bare registry the game
fills through `HostPlugin.chatCommands` → `registerCommand(name, handler)`,
and a handler receives the meta context — `handler(ctx, gameId, args)`. The
former engine commands `/name`, `/nr`, `/timeleft`, `/mapname` and `/rank` are
game code now (the `create-vimp-game` scaffold ships them in
`src/host/metaCommands.js`), so one name may mean different things — or
nothing — in two games. A game registers its own commands the same way (e.g. `vimp-tanks` registers a bot-spawn command — see that
plugin's own docs for its syntax); if more than one human is active, a
vote runs instead of immediate execution (category `botManagement` for the
tanks example). An unknown command produces a "Command not found" system
message.

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
  brings the `b:*` and `t:*` groups, the game plugin's
  `src/host/systemMessages.js`, e.g. `vimp-tanks`'s); the template texts
  live on the client, and a code without a text is dropped there silently.
  Host migration adds `s:7` `HOST_CHANGED` (sent to everybody when a
  successor starts the restored match), `s:8` `HOST_REVOKED` (added
  locally by a former host's client, never on the wire) and, in place of
  `s:7` after an automatic handoff, `s:9` `HOST_CHANGED_OVERLOAD`, `s:10`
  `HOST_CHANGED_HIDDEN`, `s:11` `HOST_CHANGED_NETWORK` (the reason comes from
  `promote` in `start_after_restore`). Every system
  message is a code — data goes in params, never a raw text array.
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
  latency measurement in the lobby). An offer with `resume: true` (a guest
  reconnecting, host migration stage 4) is passed on as
  `HostController.open(clientId, { resume: true })` → the Worker's
  `connect { socketId, resume: true }`; if a peer with the same `clientId`
  is still half-open, it is closed first (the Worker detaches the
  participant and then takes it back on `RESUME_REQUEST`). A repeated offer
  without `resume` is still ignored.

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

On `onReady` the host sends `register_host` (game/limit/card text/`memberId`
— the card text, `info`, comes from the Worker's `ready.lobbyInfo` and is
`null` when the game sets none; a room has no name) and starts a heartbeat
(`update_host { info }` every
`lobbyConfig.create.heartbeatInterval` ms, less than the master's
`heartbeatTimeout`). The master answers `host_registered { roomId, epoch,
roomSecret }`; `HostRole` keeps them (`HostRole.room`) and passes them to the Worker
(`HostController.setRoom` → `set_room`). The number of players is counted by
the master from the room's members — the host no longer reports it. `info`
— whenever the card text changes (`lobby_info` from the Worker: a map change
under `lobbyInfo: 'map'`, or a module's `lobby.setInfo`). When the host
player leaves, `handleDisconnect` stops the heartbeat, closes peers
(`HostConnectionManager.destroy`) and the Worker (`HostController.destroy`);
the master notices the host's signaling closing and moves the room into
migration ([Host migration](#host-migration)); only a room nobody can take
over gets `room_closed` ([master.md](master.md#room-lifecycle)).

**Signaling reconnect**: the host's signaling WS needs to stay up
permanently (offers, heartbeat, listing) — on a drop, `GuestSession` reconnects
with exponential backoff (`lobbyConfig.reconnect`), and a fresh `welcome`
sends `reclaim_host { roomId, epoch, roomSecret, … }`: the room keeps its
`roomId` across the reconnect and across a master restart (the secret is an
HMAC the restarted master can verify). If the room can't be reclaimed
(`roomTaken`, or `invalidRoomSecret` — a dev master without
`VIMP_ROOM_SECRET_KEY` after a restart) the host registers a new room with
`register_host`. Established P2P connections aren't affected by a signaling
drop. In its `host_registered` reply the master sends `mapsVersion` and
`codeVersion` — a mismatch against the versions the room was raised on
triggers a map catalog re-read (see below) / a Worker handoff.

### Dynamic maps

A room starts on the master's current maps rather than the ones baked into
the bundle: `HostRole.createRoom` fetches `GET /games/:id/maps/manifest.json`
(`:id` — the active game's manifest id, Stage 6.4) plus every map and passes
them to the Worker's `init` (`room.maps`; catalog unavailability is
non-critical — falls back to the bundled maps). Updating on the fly:
`host_registered.mapsVersion` (after a reconnect) or the master's
`update_available` signal → `HostRole.refreshMaps` → fetch the catalog →
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
clients see a regular round start. The core dump does not participate here
— it is used by [checkpoints](#checkpoints), which carry a room to another
machine in the middle of a round.

**Detecting a new version.** The room's Worker is created from the `url` in
the master's `GET /worker/manifest.json` (`lobbyConfig.worker.manifestUrl`)
— Vite hashes asset names, so after a deploy the old page's bundle URL
disappears from what's served; a composite `hostCodeVersion` is remembered:
`{ engine, game: { id, version } }` (Stage 6.5). A deploy restarts the
master → the signaling WS drops → a regular reconnect → `reclaim_host` →
`host_registered.codeVersion` differs from ours in either half (an engine
deploy changes `engine`, a game-plugin-only deploy changes `game.version`) →
`HostRole.refreshWorker()`: re-fetches **both** `GET /worker/manifest.json` and
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
2. at the boundary, the old Worker stops the game (`stopGameTimers` + idle),
   syncs player profiles to the master (`PlayerDataSync.flushAll({ urgent:
true })`, waiting at most `handoffFlushTimeoutMs`, see
   [configuration.md](configuration.md) — `terminate()` would cut in-flight
   writes) and sends `handoff_state { state }`; from this point
   `HostController` buffers incoming client messages (a capped queue);
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
`HANDOFF_VERSION = 4` as of host-migration stage 5: the
[checkpoint](#checkpoints) format with `kind: 'boundary'` and always
`mode: 'soft'`, plus `localTokens: { [gameId]: token }`. Tokens travel
**only** here — a `postMessage` to the next Worker of the same tab — and
never in a network checkpoint; the new Worker restores the profiles
(`PlayerDataSync.restore`) with them and re-loads any profile that never
arrived from the master, so rank/state keep being written after a swap
(before v4 they were lost until the end of the session). The new Worker
still accepts **v3** from a Worker of the previous code version. v3 —
Stage D3, which renamed the `bots` field to `scripted`; v2 of Stage 6.5
added `gameId`/`gameVersion`. What v3 carries, v4 carries too):
the loaded `HostPlugin`'s `id` and the room's `gameVersion` (so a restore
into a mismatched game — should that ever happen — fails loudly instead of
restoring bogus state), human participants with `isReady` (gameId/socketId/
name/model/team) and scripted participants (with their original gameId —
the single numeric id space is preserved), the entire `Stat` score, the current map plus its
remaining time, the frame `seq` (snapshot numbering continues — clients'
interpolators aren't disturbed), and the lobby card text a game module set
with `lobby.setInfo` (`lobbyInfo`, optional — the new Worker's modules start
from scratch and would not set it again; a meta without it restores no
text). The new Worker's `ready.lobbyInfo` goes straight to the master card
(`HostController` → `onLobbyInfoChange`): the Worker does not report its
starting value by itself. **Deliberately not carried over**: chat
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
`HostRole` and in `HostController`).

**Yielding to a planned handoff.** A swap that is still waiting for the
round boundary (up to an hour in a game with long rounds) gives way to a
[planned handoff](#planned-handoff) — the successor prepares the room from
the current worker bundle anyway. `HostController.cancelPendingSwap()`
sends the old Worker `cancel_handoff` (`HostGame.cancelHandoff` removes the
boundary callback, the next `initiateNewRound` starts a round as usual) and
rejects the swap promise with `swap preempted`; `HostRole.refreshWorker` does not
mark that version as failed. If the Worker had already sent
`handoff_state` before `cancel_handoff` arrived, the late state is answered
with `resume`. A swap that is already carrying state (after
`handoff_state`) cannot be cancelled — the handoff is refused. If the
handoff is aborted and the tab stays the host, `HostRole.refreshWorker()` runs
again and restarts the swap when the version still differs.

`HandoffFlow.start` goes through `HostRole.preemptSwap()`: a swap that is
still fetching its manifests is flagged and simply never reaches
`swapWorker`; one waiting for the round boundary is cancelled as above. The
code update is also resumed when a deferred handoff is cancelled (load back
to normal before the boundary) and when the swap was preempted but the
handoff did not start. Dropping the host role (`HostController.destroy`,
e.g. after `host_revoked`) rejects a pending swap with `host destroyed` —
not counted as a failed version either; `HostRole.teardown()` resets the
swap flags, so a tab promoted again later is not stuck with a stale swap.

### Host migration

In the lobby mode the room outlives the tab that created it: the host role
moves to another member under the same `roomId` with the next `epoch`, and
the match goes on. The parts, in the order a migration uses them:

1. [Checkpoints](#checkpoints) — the core dump plus the whole meta, taken
   at a frame boundary;
2. [Standby successor](#standby-successor) — the member the master picked
   receives checkpoints ~2/s over the `standby` channel and keeps a
   pre-warmed Worker;
3. [Emergency migration](#emergency-migration) — the host is lost, the
   successor restores the latest periodic checkpoint (a rollback);
4. [Planned handoff](#planned-handoff) — the host gives the role away
   ("Leave server", "Hand over host", [automatic triggers](#automatic-triggers),
   the [`/changehost` vote](#vote)) through a final checkpoint, no rollback;
5. [Successor promotion](#successor-promotion) — how the new host raises
   the match and takes the room over; then the guests `RESUME`;
6. [Limitations](#limitations).

The master's side (members, successor choice, detection, votes) —
[master.md](master.md#host-migration); the wire protocol —
[network.md](network.md#host-migration).

### Checkpoints

A **checkpoint** is everything needed to continue a match on another host
— possibly on another machine — from the same tick: the core dump plus the
whole meta.

**Taking.** Only at a frame boundary: right after `pack_body` at the end of
a sending `_onShotTick` (the core's snapshot accumulators are drained — the
precondition of `serialize_state`). `requestCheckpoint({ final })` takes one
at the nearest boundary; `startCheckpoints(intervalMs)` takes them
periodically (not more often than the interval). While the loop stands
(`freeze`, or a restored match waiting for `startAfterRestore`) the request
is served at once, after a `packBody` of its own. The Worker encodes the
result with `lib/checkpointCodec.js` and sends `checkpoint { …, bytes }`
with `bytes` in the **transfer list** — `serialize_state` returns a copy in
the JS heap anyway, and the compressed buffer is new, so no second copy is
made two times a second.

**Format** (`HANDOFF_VERSION = 4`). The container is
`[u32 metaLen LE][meta JSON utf-8][core bytes]`, gzipped as a whole
(`CompressionStream`, present in the Worker and in Node ≥ 18); `decode`
refuses more than `maxCheckpointBytes` unpacked (a "zip bomb" from someone
else's host). The meta, all JSON, **without tokens or secrets**:

| Field                                                                                        | Content                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `kind`, `mode`                                                                    | `4`; `'checkpoint'` or `'boundary'` (in-tab handoff); `'midRound'` or `'soft'`                                                                                                                                                                                                                  |
| `gameId`, `gameVersion`, `engineVersion`, `createdAt`, `checkpointId`, `seq`, `snapshotTick` | identity and the frame counter                                                                                                                                                                                                                                                                  |
| `room`                                                                                       | `{ roomId, epoch, settings, game: { id, version } }` — `settings` is what `applyRoomOverrides` reads, so a successor builds the same core config (without `isDevMode` — the dev mode belongs to the tab's build)                                                                                |
| `map`                                                                                        | `{ name, data, mapsVersion, override }` — the catalog JSON of the current map (the successor's catalog may differ) and a map the game substituted with `overrideMapData`                                                                                                                        |
| `timers`                                                                                     | `TimerManager.serialize()`: remaining map/round time, `teamChangeGraceLeft`, `pending` (deferred round restart, map change with its `targetMap`), `voteCooldowns`                                                                                                                               |
| `round`                                                                                      | `isRoundEnding`, `wipedTeamIds`, `removedPlayers`, `startMapNumber`                                                                                                                                                                                                                             |
| `participants`                                                                               | humans (`gameId`, name, model, team, status, camera, `respawnIndex`, `lastInputSeq`, `chatColor`, `resumeKey`, `identityName`, `isHostPlayer`), scripted, `teamSizes`, `activePlayers`, `dropped` (humans left out of the checkpoint — a `midRound` restore removes their actors from the core) |
| `stat`, `panel`, `playerData`                                                                | the score, panel values, profiles (`PlayerDataSync.serialize`: ratings, unsent points, state, `writeSeq`, the unanswered numbered writes `writes`)                                                                                                                                              |
| `plugin`                                                                                     | `{ [moduleName]: module.serializeState() }`                                                                                                                                                                                                                                                     |
| `lobbyInfo`                                                                                  | the lobby card text set by a game module                                                                                                                                                                                                                                                        |

A network checkpoint carries the humans who have a `resumeKey` (entered the
match); the in-tab handoff carries those who finished the handshake, with
their `socketId`.

**Mode.** `'midRound'` only when the game set
`gameConfig.migration.midRound` (see [plugin-api.md](plugin-api.md)) **and**
the core dump (and every module's `serializeState`) succeeded; then the
core bytes are attached and the restore continues the round from the same
tick. Otherwise `'soft'`: no core, the restore is today's handoff — the
meta moves, the round starts anew. A failing dump is logged
(`[checkpoint] mid-round state skipped: core serialize_state failed: …`) and
the match goes on.

**Restoring** (`HostGame` option `checkpoint: { meta, core }` + `seqFloor`):
the core is deserialized first (a bad dump fails `init` before the meta is
touched); the JS side of the map is rebuilt from `map.data` without
`createMap`/`load_map` (`RoundManager.restoreMap` — `scripted.createMap`
only remembers respawn points); participants come back **detached**
(stage 4: the slot is taken, sends go to a stub, they wait for RESUME with
their `resumeKey`), profiles without tokens (writes wait for
`attachToken` on resume); `seq = max(meta.seq, seqFloor) + 30` — clients
saw frames newer than the checkpoint, and a smaller number would be dropped
by their interpolators. The match stays **paused** (no loop, no timers)
until `start_after_restore`: in `'midRound'` it resumes every timer with
its remainder (`TimerManager.resumeFromState`, a pending map change is
rescheduled by `RoundManager.scheduleMapChange`) and the loop from the same
tick; in `'soft'` it resumes the map with its remaining time and starts a
new round.

**Freeze.** `freeze()` stops the loop and every countdown with its
remainder (`TimerManager.pause` — timers, votes, cooldowns, pings, the idle
check); `unfreeze()` continues them — this is how a planned handover takes its
final checkpoint. A checkpoint taken while frozen drains the frame body outside the
loop (`pack_body` is the dump's precondition), so its events (removals,
explosions, tracers) never reach anyone; if the handover is aborted,
`unfreeze()` therefore sends every ready participant still connected the
resume entry packet (keyset, `CLEAR`, the map with `resume: true`, the
first frame) — without it stale entities would linger on their canvas.

**Deliberately not carried**: active votes (their `resultFunc` are
closures; clients close the vote window on resume), chat history (lives on
the clients), RTT (measured again), `lastActionTime` (reset to "now").

`HostController` (main thread) wraps the protocol: `startCheckpoints(ms)`,
`stopCheckpoints()`, `requestCheckpoint({ final })`, `onCheckpoint(cb)`
(returns an unsubscribe), `freeze()`, `unfreeze()`,
`startAfterRestore({ waitForResume })`, `initFromCheckpoint(room, bytes,
callbacks)` (a pre-warmed Worker);
its constructor takes `{ checkpoint, seqFloor }` and passes the bytes to
`init` in the transfer list. The headless check for games is the
`vimp-sim` step `checkpointRestore` — see [debugging.md](debugging.md).

### Standby successor

In a room with two or more people the master names a **successor** (see
[master.md](master.md#member-rtt-and-successor)) and tells the host with
`successor_assigned`. The host streams checkpoints to it; the successor
keeps the latest one and a pre-warmed Worker; the handover itself is
[Emergency migration](#emergency-migration) or
[Planned handoff](#planned-handoff).

**Channel** (`client/network/StandbySender.js`). The host finds the
successor's peer by `memberId` in `HostConnectionManager`
(`peerConnectionOf` — a peer with both `meta`/`state` open) and opens
`pc.createDataChannel('standby', { ordered: true })` on it: no SDP
renegotiation is needed, the SCTP association already exists. The previous
successor's channel is closed. A successor that connects after the
assignment, or reconnects with a new `RTCPeerConnection`, gets a new
channel on the next peers change (`refresh()`). While a channel exists,
`HostController.startCheckpoints(migration.checkpointIntervalMs)` is on;
without one, `stopCheckpoints()`. A channel that closes by itself while the
successor's peer is alive is reopened by a timer with an exponential backoff
(`migration.standbyReopenDelayMs` 1 s, doubling up to
`standbyReopenMaxDelayMs` 10 s; an open resets it; a new successor or
`destroy` cancels it) — otherwise the checkpoint stream would stall until
the next peers change.

**Chunks** (`client/network/standbyChunks.js`). The logical stream of one
checkpoint is `[u16 descLen][desc JSON][checkpoint bytes]`, where
`desc = { checkpointId, createdAt, mode, game }` — the successor reports
the id and freshness to the master, and pre-warms the game
(`game: { id, version }` from the Worker's `checkpoint` message, or `null`;
the receiver keeps only non-empty strings of at most 64 characters), without
unpacking. A host older than the `game` field does not send it — pre-warming
then reads `room.game` from the checkpoint itself. It is cut into pieces of at
most `migration.standbyChunkBytes` (64 KB) including a 24-byte
little-endian header:

| Offset | Type | Field                                     |
| -----: | ---- | ----------------------------------------- |
|      0 | u32  | `wireId` — the sender's checkpoint number |
|      4 | u32  | `index`                                   |
|      8 | u32  | `count`                                   |
|     12 | u32  | `totalBytes` — the logical stream length  |
|     16 | u32  | `seq` — the host's frame number           |
|     20 | u8   | `final` (a planned handover's last one)   |
|     21 | u8   | chunk format version (1)                  |
|     22 | u16  | reserved                                  |

**Backpressure.** When the channel's `bufferedAmount` exceeds
`migration.standbyHighWaterBytes` (1 MB) the next periodic checkpoint is
skipped (the next one is fresher anyway; the skip goes to the error journal
as `engine.standby.skipped`). A `final` checkpoint is never skipped: it
waits for the channel to open and for `bufferedamountlow`, and has
priority: while it waits no periodic checkpoint is sent, and a periodic one
taken no later than it (`seq` not newer — encoding in the Worker is
asynchronous) is dropped. The receiver mirrors this: a periodic checkpoint
not newer than the final one does not replace it. `stats` (sent,
skipped, size, interval, latency) is logged in a dev build as
`standby sent`.

**Pre-warming.** `HostController` takes `{ preload: true, onPreloaded }`:
the Worker gets `preload { room }` instead of `init`, imports the
`HostPlugin`, checks its `gameConfig` shape and compiles the wasm
(`preloadHostRuntime` in `lib/createHostRuntime.js`: `compileStreaming`,
falling back to `compile(arrayBuffer)`), replies `preloaded` and creates no
match; a failure replies `error`. A later `import` of the same URL in that
Worker comes from the module cache and the wasm from the HTTP cache. The
warm-up buys the HTTP cache and the browser's wasm code cache
(`compileStreaming`); the compiled `WebAssembly.Module` itself is not
reused. See [client.md](client.md) for the successor side.

### Emergency migration

The host is gone without a word (tab closed, network lost, crash); the
pieces above turn that into a 1–3 s pause:

1. **Before**: the host streams checkpoints (every
   `migration.checkpointIntervalMs`, 500 ms) over the `standby` channel to
   the successor the master picked; the successor keeps the latest full one
   and a pre-warmed Worker (see [Standby successor](#standby-successor)).
2. **Detection** is the master's: the host's signaling closed, its
   heartbeat stopped, or guests reported `host_unreachable` and the host did
   not answer a `probe` (see [master.md](master.md#host-migration)).
3. **Promotion**: `promote { mode: 'checkpoint' }` when the successor's
   checkpoint is fresh, otherwise `'cold'` on any able member (see
   [Successor promotion](#successor-promotion)).
4. **Guests** close the transport to the old host at once on
   `host_migrating`, wait under "Switching host…" and, on `host_changed`,
   resume their places at the new host (see
   [network.md](network.md#host-migration)).
5. **The old host**, if it comes back, is demoted to a guest of the new
   epoch.

What the player sees: a 1–3 s pause, then the world of the checkpoint —
up to ~0.5 s back, the same round, map and score (a game without
`migration.midRound` restarts the round with the meta kept). Frame numbers
keep growing (`seq = max(checkpoint seq, seqFloor) + 30`), every command is
released and re-sent by the clients for the keys still held, active votes
are dropped. A `cold` restart starts the match afresh in the same room.

### Planned handoff

The same machinery without the rollback: the host gives the role away on
purpose — "Leave server" or "Hand over host" in the room menu
([client.md](client.md#ui-hierarchy-z-index)); the automatic triggers and
the vote below enter the same
`HandoffFlow.start({ reason, stay, defer })` (`client/network/PlannedHandoff.js`).

1. The host sends `handoff_begin { roomId, epoch, reason, stay }`; the
   master moves the room to `handing_off` and answers `handoff_go` (the
   successor gets `promote { mode: 'planned' }`, everyone else
   `host_migrating`), or `handoff_unavailable` — then a handover is simply
   not done, a leave goes on as an emergency migration (`host_leaving`).
   The successor gets no `host_migrating`: on `promote { mode: 'planned' }`
   it pauses its own player's session itself (`Promotion` option
   `holdSession` → `SessionSupervisor.migrate({ keepTransport: true })`)
   and keeps the connection to the frozen host — the `standby` channel with
   the final checkpoint runs over it.
2. `handoff_go` → `freeze()` → `requestCheckpoint({ final: true })`: the
   final checkpoint goes over `standby` ahead of any periodic one.
3. The successor waits for it (`migration.finalWaitMs`, see
   [Successor promotion](#successor-promotion)), restores the match from the
   same tick and registers with the next epoch.
4. `host_released` → the old host drops its Worker and peers; with `stay`
   its own player resumes as a guest of the new host, without it the tab
   goes to the lobby. `handoff_aborted`, a refusal, a signaling drop or
   `migration.handoffDeadlineMs` → `unfreeze()` (with a full resync, see
   _Freeze_ in [Checkpoints](#checkpoints)): the match goes on, the tab
   stays the host, the epoch is unchanged. The host's own player is not in
   resume mode and answers the resync's first frame with
   `FIRST_SHOT_READY`; `firstShotReady` of a participant that is already
   ready is ignored — no `USER_JOINED`, no `initialVote`, no second actor
   with `noSpectators`.

A game without `migration.midRound` hands over (`stay`) only at a round
boundary (`awaitRoundBoundary`, at most `migration.deferMaxMs`); a leave
does not wait — the successor starts a new round from the soft checkpoint.
A Worker swap still waiting for the round boundary does not block a
handoff — it is cancelled (see _Yielding to a planned handoff_ in
[Worker handoff](#worker-handoff)). Closing the host's tab is not planned: `beforeunload` asks for confirmation
while other people are in the room, and `pagehide` sends `host_leaving` —
an emergency migration with the usual rollback (the dialog stops the main
thread, so no final checkpoint can leave the tab during it).

#### Automatic triggers

`client/network/HostHealthPolicy.js` (lobby mode) watches the Worker's
`health` samples (~1 per second, see _Host health_ above), the tab's
visibility and whether the master has assigned a successor, and starts a
planned handoff with `stay: true` on its own (`migration.auto` in
[configuration.md](configuration.md)):

| Trigger       | Condition                                                                                                                      | Action                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| soft overload | mean `tickRate` of the last `overloadWindowMs` (5 s) below `overloadTickRate` (100)                                            | `reason: 'overload'`, waits for boundary |
| hard overload | mean of the last `criticalWindowMs` (3 s) below `criticalTickRate` (60), or `lostMs > 0` in `lostWindows` (3) samples in a row | `reason: 'overload'`, at once            |
| hidden tab    | hidden continuously for `hiddenHandoffMs` (1.5 s)                                                                              | `reason: 'hidden'`, at once              |

A new handoff needs a successor, `minHostTenureMs` (30 s) in the host role
and `autoHandoffCooldownMs` (90 s) since this tab's previous automatic one
(counted from its start, whatever the outcome; the policy outlives the host
role, so the cooldown does too); a hidden tab held back by them is handed
over the moment they expire, even with the match idle. A gap in the samples (the match was frozen
or paused) restarts the windows. A hard trigger or the hidden tab while a
handoff waits for the round boundary hurries it (`PlannedHandoff.hurry`:
`round_boundary_cancel`, then `handoff_begin` at once). When the soft
overload is gone before the boundary — every sample of the last
`recoverWindowMs` (5 s) above `recoverTickRate` (110), a hysteresis over
the entry threshold so a rate hovering around 100 Hz does not flip it —
the policy cancels its own deferred handoff (`cancelDeferred`,
`round_boundary_cancel`) and gives the cooldown back. A deferred "Hand over
host" of the user is never cancelled.

**Network lag** is decided by the master, which alone can
compare the host's network with the successor's: `HostHealthReporter`
sends `host_health { tickRate, peerRttMedian, peerCount }` at most every
`migration.auto.hostHealthIntervalMs` (2 s) from the latest sample (none
while the match is frozen); on sustained lag with a markedly better
successor the master answers `request_handoff { reason: 'network', defer:
true }` ([master.md](master.md#host-network-lag)), and the host starts a
planned handoff with `stay: true` that waits for the round boundary (unless
`migration.auto.enabled` is `false`). The policy does not cancel it — only
its own `overload` — but a hard trigger or the hidden tab still hurries it.
Guests report their mean render FPS over the interval (`client/lib/FpsMeter.js`: frames ÷ elapsed time, restarted when the tab becomes visible; `Ticker.FPS` is a single frame's rate) in `member_update.caps.fps` every
`migration.auto.fpsReportIntervalMs` (10 s) so that the master does not pick
a weak tab as the successor.

Players learn why the host changed: the successor's Worker sends, in place
of `HOST_CHANGED`, "Host changed: the previous host was lagging"
(`overload`), "… went inactive" (`hidden`) or "… had a poor connection"
(`network`) — see _Successor promotion_ below. Every other reason keeps
"Host changed".

#### Vote

The players can take the role away too (lobby mode only): a
guest's `/changehost` starts a "Change host" vote that the **master**
counts — the host never sees the window and cannot filter the vote out of
its chat or vote modules ([master.md](master.md#change-host-vote)). A
passed vote sends the host `request_handoff { reason: 'vote', defer: false
}`: the page starts a planned handoff with `stay: true` at once, whatever
`migration.auto.enabled` says and without waiting for a round boundary.
A host that does not start it within `room.vote.voteForceAfterMs` (5 s),
or whose handoff fails, is replaced by force — the emergency path with the
usual rollback to the successor's last checkpoint, and `host_revoked` for
the old host. Either way the old host stays as a guest and cannot be the
room's successor or host for `room.vote.demotedCooldownMs` (10 min). The
dedicated server and the standalone SDK have no vote: there `/changehost`
is ordinary chat text for the game.

### Successor promotion

When the master promotes a member (`promote { roomId, epoch,
promotionToken, mode }`, [master.md](master.md#host-migration)), the tab
raises the match and takes the room over with `register_host { roomId,
epoch, promotionToken, … }` — the room is the same, only the epoch grows.

**`checkpoint`** (`client/network/Promotion.js`): the latest full
checkpoint of `StandbyReceiver` is restored in the pre-warmed Worker
(`HostPrewarm.take()` + `HostController.initFromCheckpoint(room, bytes,
callbacks)`) when it runs the game version of the checkpoint, otherwise in
a new `HostController` with `{ checkpoint, seqFloor }`; `seqFloor` is the
larger of the last host frame this client saw and the checkpoint's `seq`.
The room gets `hostSocketId`, `roomId` and the new epoch. The checkpoint
comes from the host — another player — so it is untrusted data: of
`meta.room.settings` only the keys of `sanitizeRoomSettings`
(`lib/roomSettings.js`: `map`, `maxPlayers`, `roundTime`, `mapTime`,
`friendlyFire`, numbers clamped) are taken, while the game, the master's
maps and the dev mode are the successor's own (`prepareHostRoom`; the
checkpoint does not carry `isDevMode` at all). The checkpoint's
`room.game` is checked against the game the master confirms —
`promote.game { id, versions }`: another game or an unconfirmed version →
`promote_failed` (a master without the field skips the check). Pre-warming
checks it the same way against `standby_assigned.game` and ignores such a
checkpoint (the warm Worker stays). `ready` (the
match paused) → the tab adopts the host role (the same
`HostConnectionManager`/`StandbySender`/heartbeat as a created room) and
registers. `host_registered` → `start_after_restore { waitForResume: true,
reason }` (`reason` of `promote`; a main thread of an older engine sends
none): `HostGame.startAfterResume` starts the match once every person of the
checkpoint is back or after `resumeWaitMs` (3 s), whichever comes first,
sends `HOST_CHANGED` to the chat (`HOST_CHANGED_OVERLOAD`/`_HIDDEN`/
`_NETWORK` for an automatic handoff), and hands the ids still detached to
`PortMachine.startGraceFor` — the grace window counts from the start, the
switching pause does not eat it. The successor's own player comes back
through `LoopbackTransport(controller, 'local', { resume: true })` with its
`resumeKey`; the participant is re-bound to `'local'`, so the host-player
exemptions (no kick, no detach) move to it. A checkpoint received longer than
`migration.maxRestoreAgeMs` (15 s) ago is not restored — rolling the world
back that far is worse than a cold start; a planned handover's final
checkpoint is always fresh. A failure at any step (no or too old a
checkpoint, no resume secret of the own player, plugin/wasm, `init` →
`error`, the master rejecting the registration) sends `promote_failed` and
the tab goes back to waiting as a guest; `promote_cancelled` tears the
Worker down the same way. Once registered, the room is the tab's: if the
own player still fails to come back (refused RESUME, the loopback closed,
the window ran out), the host role stays — Worker, peers, heartbeat and the
checkpoint stream go on and the guests keep playing; the tab shows "Your
player could not be restored — the room keeps running for the others."
instead of reloading.

**`planned`** (planned handover): the same as `checkpoint`, but
first `StandbyReceiver.waitForFinal(0, migration.finalWaitMs)` (3 s) waits
for the frozen host's final checkpoint, so the match continues from the
same tick. Not there in time → the latest periodic one (a minimal
rollback). A repeated `promote` of the same epoch and token with `mode:
'checkpoint'` (the host vanished mid-handover) drops the wait at once
(`Promotion.degrade`); `promote_cancelled` (the handover was aborted) also
calls `StandbyReceiver.discardFinal()` — that final checkpoint stays the
latest one but cannot complete the next handover. If it has not arrived yet
(it was waiting for the channel to drain), it is taken as a periodic one
when it does: the channel is ordered and the host sends no periodic
checkpoint until the final one is out, so a stale final can only be the
first checkpoint after the cancel.

**`cold`** (no fresh checkpoint): the tab saves `{ roomId, epoch,
promotionToken, gameId, settings }` to `sessionStorage` (`vimp.promotion`)
and reloads into the room link. The route bootstrap takes the record
(always removing it), starts `HostRole.createRoom` with the room defaults plus
the master's `settings` and registers with the token instead of creating a
room. The match starts afresh; the other members reload into the room and
enter with a full handshake.

**A former host** (`host_revoked`, or `staleEpoch` on its `reclaim_host`
after the network came back) stops its Worker, peers, checkpoint stream and
heartbeat, shows `HOST_REVOKED` in the chat and comes back as a guest of
the new epoch: `join_room`, then a WebRTC resume under its own `gameId`
(its place is in the successor's checkpoint as a detached participant);
`RESUME_RESULT !ok` → a clean entry into the room.

In the lobby (`packages/engine/src/client/main.js`):

- **joining** — a server card → `GuestSession.connectToRoom(roomId)` → `WebRtcManager`
  (offerer);
- **creating a server** — the button in the lobby (`#lobby-host`,
  `packages/engine/src/config/lobby.js`) → `HostRole.createRoom(room)`
  → `HostController` + Worker + `LoopbackTransport` (the host player) +
  `HostConnectionManager` (remote clients, each peer kept with its
  `memberId` from the offer) + registering with the master.

From there client code is identical (the transport is abstracted). The host
leaving does not kill the room: the master promotes a successor (see
[Successor promotion](#successor-promotion)); the leaving tab itself goes
through `handleDisconnect`, which stops rendering.

### Limitations

- **An emergency migration rolls back**: the world returns to the latest
  periodic checkpoint — up to ~`migration.checkpointIntervalMs` (0.5 s) of
  play plus the transfer time; only a planned handoff continues from the
  same tick.
- **A 1–3 s pause** on every switch: guests hold no backup connections to
  the successor, they open new WebRTC peers after `host_changed`.
- **`beforeunload` does not save a final checkpoint**: while the
  confirmation dialog is open the main thread — the Worker ↔ DataChannel
  relay — stands still; closing the tab is an emergency migration
  (`pagehide` → `host_leaving` only shortens detection).
- **Soft mode** for a game without `gameConfig.migration.midRound` (every
  game published before it): the meta moves, the round starts anew; a
  planned "Hand over host" waits for the round boundary.
- **Not carried**: active votes, chat history, RTT, idle timers (see
  _Deliberately not carried_ in [Checkpoints](#checkpoints)).
- **No fresh checkpoint** (host and successor gone together, a successor
  just assigned) → a `cold` restart: the same `roomId`, a new match.
- **The dedicated server and the standalone SDK** have one host by
  definition: no successor, no room menu, no `/changehost`.

## Tests

Host and meta module tests live in `tests/host/`:

- `GameCoreAdapter.test.js` — unit tests against a fake core: mapping
  commands to the ABI, telling bots and humans apart, projecting events into
  the panel/facade, camera flags.
- `HostGame.fixture.test.js` — integration on top of the bundled **miniGame
  fixture** (`packages/engine/tests/fixtures/`), whose core is a plain JS
  object implementing the Wasm Host ABI — so this suite needs no Rust build
  and no game plugin, and proves the host works against _any_ conforming
  `HostPlugin`. The equivalent suite on a real WASM core lives in the game
  plugin's own repository. Covered: onboarding, an active player with a
  player block, movement, shooting (tracer + ammo), bots, `players_data`,
  `removeUser` (a null marker in the frame), the room limit (`isFull`), the
  host player's kick exclusion, `updateMaps`/`onMapChange`, the Worker
  handoff (collecting meta at a round boundary, restoring
  participants/score/`seq`, `completeHandoff` kicking anyone who didn't
  reconnect, `resumeAfterHandoff`, refusal on an incompatible version/a map
  gone from the catalog); binary frames are decoded by the client core
  (`ClientCore.decode_frame`; the scaffold is `tests/host/fixtureHarness.js` with
  `FakeSocketManager`).
- `portMachine.test.js` — the handshake automaton on the same fixture, with
  no Worker and no network: the guest path through to a created participant,
  a nickname rejected by the schema, the fallback nickname, a refusing
  identity strategy, a message on a disabled port, a full room
  (`4006`/`roomFull`, no machine created), `disconnect`, `restore` (a handoff
  participant coming up in the game state) and a client that disconnects
  mid-`resolve`.
- `identity.test.js` — the identity strategies: the guest field descriptor
  and its fallback, and the token strategy against a stubbed JWKS `fetch`
  with an RS256 token signed in the test (caching, and a failure that must
  not be cached forever).
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
  `restoreHuman`/`restoreScripted`), `Chat`, `Vote`, `Stat` (including
  `serialize`/`restore`), `Panel`, `TimerManager`, `RTTManager`,
  `SocketManager`.
- related: `tests/client/network/SignalingClient.test.js` (the host's
  outgoing `register_host`/`update_host`/`webrtc_answer`/`pong_host`),
  and, in the game plugin's own repository,
  `tests/core/core.test.js` (`body_has_events()` — meta/state
  classification, run against that game's real core).

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
npm run dev            # master: lobby + signaling, https://localhost:3002
```

The core's web target is built in the game plugin's own repository (its own
`npm run core:build`, e.g. `vimp-tanks`'s) — not a script of this repository —
before the plugin is linked/installed into `node_modules`; see
[core.md](core.md#build) and [getting-started.md](getting-started.md).

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
- [ ] a drop of the host (lobby, 3 profiles): close the host tab mid-round →
      the others see "Switching host…" for 1–3 s, the world rolls back at
      most ~0.5 s, the round and score go on, the successor is the new host;
      the host offline (DevTools) → the same through reports/probe; the old
      host back online → it is a guest; host and successor gone at once →
      a cold restart of the same `roomId` on the third player.

**Rooms, links and migration** (lobby mode; `npm run dev:auth` + `npm run
dev`, dev login through a bookmark
`http://localhost:3010/dev/login?nick=P1&returnUrl=https://localhost:3002/`;
three Chrome profiles + Firefox):

| #   | Scenario                                                   | Expected                                                                       |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | Create a room (no name), copy the link                     | card `tanks/<roomId>`, link `#/tanks/<roomId>`                                 |
| 2   | Open the link in a logged-out profile                      | login → straight to the game's auth screen in that room                        |
| 3   | `#/tanks` with an empty and a non-empty lobby              | creates / joins                                                                |
| 4   | Guest: offline for 5 s                                     | "Reconnecting…", the same tank                                                 |
| 5   | Host: "Hand over host" mid-fight                           | pause ≤ 2 s, no rollback, the former host is a guest                           |
| 6   | Host: "Leave server"                                       | the same, the former host is in the lobby                                      |
| 7   | Host: close the tab (confirm)                              | rollback ≤ 0.5–1 s, the match goes on at the successor                         |
| 8   | Host: offline                                              | migration through reports/probe; network back → the former host is a guest     |
| 9   | Host and successor closed at once                          | a cold restart on the third player, the same `roomId`                          |
| 10  | CPU throttling 6× on the host                              | handoff at the round boundary or after 30 s                                    |
| 11  | Minimize the host's tab for 10 s                           | handoff                                                                        |
| 12  | Slow 3G on the host                                        | handoff after ~10 s, not repeated sooner than 90 s                             |
| 13  | `/changehost` vote                                         | passes by majority, the host never sees the vote; no item in the `M` menu      |
| 14  | Snakes: all of 5, 7                                        | snake lengths and crystals kept                                                |
| 15  | Master restart (nodemon) mid-match                         | the room is back with the same `roomId`, the match was not interrupted         |
| 16  | Standalone (`startStandaloneGame`) and `npm run dedicated` | work as before; `/changehost` is not intercepted                               |
| 17  | Kick for inactivity                                        | no reload: address without hash, "Kicked for inactivity.", a click → the lobby |
| 18  | The room closed (last host left / `room_closed`)           | reload to `#/tanks` — a quick game of the same game                            |

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
