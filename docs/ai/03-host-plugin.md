# 03 — Host plugin contract

`src/host/index.js` default-exports the `HostPlugin`. It is imported by the
Worker that runs the authoritative match. **Worker-safe code only**: no
`window`, no `document`, no PixiJS.

## The object

```js
import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import init, { GameCore } from '../../core/pkg-web/my_game_core.js';
import gameConfig from '../config/game.js';
import authSchema from '../config/auth.js';
import clientConfig from '../config/client.js';
import systemMessages from './systemMessages.js';
import botCommand from './botCommand.js';
import createModules from './createModules.js';

export default {
  id: 'my-game',                       // === manifest.id
  engineApi: ENGINE_API_VERSION,

  async createCore(coreConfigJson, { wasmUrl }) {
    await init({ module_or_path: wasmUrl });
    return new GameCore(coreConfigJson);
  },

  gameConfig,
  authSchema,
  chatCommands: [botCommand],          // REQUIRED array (may be empty)
  systemMessages,                      // optional
  createModules,                       // REQUIRED
  buildClientGameConfig: () => clientConfig,   // REQUIRED, called unconditionally

  onCoreEvent(data, { vimp, panel }) {} // optional
};
```

### Real obligation of each field

| Field | Required? | Notes |
| --- | --- | --- |
| `id` | ✅ | must equal `manifest.id` |
| `engineApi` | ✅ | compared with the engine build |
| `createCore(json, { wasmUrl })` | ✅ | async; returns the `GameCore` instance. `wasmUrl` comes in two shapes: the `.wasm` asset URL in the browser, and a `file:` URL of the Node glue (`entries.wasmNode`) under `npm run sim` — see [Two shapes of `wasmUrl`](#two-shapes-of-wasmurl) |
| `gameConfig` | ✅ | validated field-by-field, see below |
| `authSchema` | ✅ | sent to every joining client |
| `chatCommands` | ✅ **array** | the engine iterates it without a guard — omit it and boot throws. Use `[]` for none |
| `createModules` | ✅ | the engine calls it and reads `.scripted` off the result |
| `buildClientGameConfig()` | ✅ | called unconditionally when building `CONFIG_DATA` |
| `systemMessages` | optional | merged into the chat code registry |
| `onCoreEvent(data, ctx)` | optional | receives `custom` core events only |

> Older engine documentation lists `chatCommands` and `createModules` as
> optional and mentions a `views: { Panel, Stat }` field. Both are wrong:
> the first two are mandatory, `views` does not exist.

## Two shapes of `wasmUrl`

The browser passes the hashed `.wasm` asset from `entries.wasm`, and the
engine's headless runner passes a `file:` URL of your `--target nodejs`
build (`entries.wasmNode`, see `13-debugging.md`). They load differently:
the Node build pulls the wasm in itself, so there is no `init()` to call,
and `fetch()` cannot read `file:` URLs in Node anyway. Branch on the suffix
in **both** plugins (host and client), from one shared helper — a headless
run that used a different core than the browser would be worthless:

```js
// src/nodeCore.js
export const isNodeCore = wasmUrl => (wasmUrl ?? '').endsWith('.js');
export const loadNodeCore = wasmUrl => import(/* @vite-ignore */ wasmUrl);
```

```js
async createCore(coreConfigJson, { wasmUrl }) {
  if (isNodeCore(wasmUrl)) {
    const node = await loadNodeCore(wasmUrl);

    return new node.GameCore(coreConfigJson);
  }

  await init({ module_or_path: wasmUrl });

  return new GameCore(coreConfigJson);
}
```

The client side is the same, except the Node build exposes no WASM memory —
return `memory: null`; the headless client reads the hot buffer by copy
(`hot_values()`), not through a memory view.

## `gameConfig` validation gate

Immediately after import the Worker asserts these paths exist (a missing one
throws with a clear message instead of failing deep inside init):

```
roomDefaults.maxPlayers
snapshot
parts.models
parts.weapons
parts.friendlyFire
panel.fields
playerKeys
teams
spectatorTeam
```

Plus one cross-check: `spectatorTeam` must be a **key of `teams`**. A typo
there leaves the spectator team id `undefined`, and the first participant to
join lands in a team that does not exist — the gate names the typo instead.

A game that declares `noSpectators: true` is exempt from both: `spectatorTeam`
drops off the required list, and `teams` must instead declare **exactly one**
team — the one every joining human is put into.

## Config merge order

```
game = structuredClone({ ...hostDefaults, ...gameConfig })   // shallow merge
game = applyRoomOverrides(room, game)                        // 5 keys + maps
```

The merge is **shallow at the top level**: supplying `timers` in `gameConfig`
replaces the whole engine `timers` object, so you must repeat every key you
still want. The same holds for `rtt` and `idleKickTimeout`.

### Engine defaults you may override (`hostDefaults`)

| Key | Default | Meaning |
| --- | --- | --- |
| `isDevMode` | `false` | enables `/nr` and other dev-only commands |
| `maxPlayers` | `30` | hard ceiling before the room-form clamp |
| `chatMaxLength` | `60` | authoritative message length limit |
| `timers.timeStep` | `1000 / 120` ms | simulation tick (~120 Hz) |
| `timers.networkSendRate` | `4` | send a frame every Nth tick (4 → 30 frames/s) |
| `timers.roundTime` | `120000` | round length |
| `timers.mapTime` | `600000` | map length |
| `timers.roomTimeMin` / `roomTimeMax` | `10000` / `3600000` | clamp bounds for user-chosen round/map time |
| `timers.voteTime` | `10000` | vote duration |
| `timers.timeBlockedVote` | `30000` | per-category vote cooldown |
| `timers.teamChangeGracePeriod` | `10000` | free team switch window at round start |
| `timers.roundRestartDelay` | `5000` | delay before the next round |
| `timers.mapChangeDelay` | `2000` | delay before applying a map change |
| `timers.rttPingInterval` | `3000` | ping interval |
| `timers.idleCheckInterval` | `30000` | idle sweep interval |
| `rtt.maxMissedPings` | `5` | missed pongs before a kick |
| `rtt.maxLatency` | `1000` | EMA latency (α = 0.1) kick threshold, ms |
| `idleKickTimeout.player` | `120000` | idle kick for players; `null` disables |
| `idleKickTimeout.spectator` | `null` | idle kick for spectators |
| `spectatorKeys` | `{ nextPlayer, prevPlayer }` | spectator camera controls |

> **Trap:** the core's own `timeStep` is read straight from the engine
> `hostDefaults` when building the core config, **not** from your merged
> `gameConfig.timers.timeStep`. Overriding `timers.timeStep` changes the
> Worker loop but not the physics step the core was configured with. Leave it
> alone unless you know exactly what you are doing.

### Game-owned `gameConfig` keys

| Key | Shape | Purpose |
| --- | --- | --- |
| `parts.models` | `{ modelId: {…} }` | player model catalog; passed verbatim to the core and to prediction |
| `parts.weapons` | `{ weaponId: {…} }` | weapon catalog; same |
| `parts.friendlyFire` | `boolean` | overridable per room |
| `parts.*` (free-form) | any | extra keys are passed to the client config untouched (tanks uses `mapConstructor`, `hitscanService`) |
| `snapshot` | schema object | the binary protocol layout — see `06-snapshot-protocol.md` |
| `teams` | `{ teamName: teamId }` | includes the spectator team; **required** |
| `spectatorTeam` | `string` | which key of `teams` is spectators; **required** unless `noSpectators` |
| `noSpectators` | `boolean` | opt-in: no spectator concept at all. `teams` holds exactly one team, `spectatorTeam` is omitted (`spectatorTeam`/`spectatorId` are `null` in the host), a joining human is created in the playing team with their stat row there, and gets an actor from `RoundManager.admitPlayer` on `firstShotReady` — no vote, no team change. `admitPlayer` takes the first respawn slot no participant holds; if the map has none left it frees one with `scripted.removeOneForHuman(team)` (a human outranks a bot, the same rule `changeTeam` follows), and only then refuses, telling the player `TEAMS_TEAM_FULL` — under `noSpectators` there is no vote to ask for a place with, so the next round start (`/nr`, a bot command) is what hands them an actor |
| `endlessRound` | `boolean` | opt-in: the engine never restarts the round by itself — no stat wipe when fewer than two humans are active, no round end on a team wipe, no restart when the round timer expires. `/nr` and map changes still work. Independent of `noSpectators` |
| `scripted` | `{ namePrefix, defaultModel }` | bot naming/model defaults |
| `maps` | `{ mapName: mapObject }` | bundled maps (replaced by the master catalog at runtime) |
| `currentMap` | `string` | default map |
| `mapScale` | `number` | global map scale |
| `mapSetId` | `string` | default map construction set id |
| `mapsInVote` | `number` | how many maps a rotation vote offers |
| `stat` | schema | statistics table, host half |
| `panel` | `{ fields, activeKey }` | HUD schema, host half |
| `soundCues` | `{ roundStart, victory, defeat, frag, death }` | engine event → sound name |
| `initialVote` | `string` | vote sent to a player after their first frame |
| `playerState.defaultState` | any JSON | starting profile blob for a player with no saved record |
| `roomDefaults.maxPlayers` | `number` | room-size ceiling offered in the lobby |
| `roomForm` | array | lobby form schema (manifest only, not read at runtime) |

### Room overrides — the whitelist

`applyRoomOverrides` honours exactly five things plus the map catalog:

| Field | Effect |
| --- | --- |
| `maps` | replaces the bundled catalog with the master's; if the default map is gone, the first catalog map is used |
| `maxPlayers` | clamped to `1 .. roomDefaults.maxPlayers` |
| `map` | applied only if present in the catalog |
| `roundTime` | clamped to `roomTimeMin .. roomTimeMax` |
| `mapTime` | clamped the same way |
| `friendlyFire` | boolean only |

**Everything else in the room form is silently dropped.** Do not design a
game whose rules depend on a custom room setting — there is no path for it to
reach the host.

## `createModules(ctx)`

```js
export default function createModules(ctx) {
  return { scripted: new MyBotManager(ctx) };
}
```

The context is exactly:

```js
{ participants, coreAdapter, panel, stat, chat, socketManager, scripted }
```

- `participants` — the participant registry (humans + bots).
- `coreAdapter` — the JS wrapper over the WASM `GameCore`.
- `panel`, `stat`, `chat`, `socketManager` — engine meta modules.
- `scripted` — the `gameConfig.scripted` **config object**
  (`{ namePrefix, defaultModel }`), not a module.

> There is **no** `timerManager` and **no** `voteCoordinator` in this context
> — they exist only in the chat-command context below. If a bot manager needs
> timing, drive it from the core's AI tick or from a chat command.

Only the `scripted` key of the returned object is read. Returning other
modules is harmless but they will never be called by the engine.

### The `scripted` module contract

The engine calls exactly five methods:

| Method | When | Returns |
| --- | --- | --- |
| `createMap(scaledMapData)` | on every map load (data already scaled) | — |
| `getCountsPerTeam()` | when balancing teams | `{ teamName: count }` |
| `removeScripted(team?)` | clearing bots (all, or one team) | — |
| `createScripted(count, team?)` | spawning bots | number actually created |
| `removeOneForHuman(team)` | a human needs a slot in a full team | `boolean` — freed or not |

A `getCount()` method is *not* called by the engine; add it only for your own
chat commands.

## `chatCommands`

```js
export default {
  name: '/bot',
  handler(ctx, gameId, args) {
    const count = Number(args[0]) || 1;
    const created = ctx.scripted.createScripted(count);

    ctx.chat.pushSystem('BOTS_SPAWNED', [created]);
    ctx.roundManager.initiateNewRound();
  },
};
```

Handler context:

```js
{ participants, chat, scripted, roundManager, voteCoordinator, timerManager,
  playerDataSync, teams, spectatorTeam, spectatorId, isDevMode }
```

The engine parses **no** commands of its own: `CommandProcessor` is a bare
registry, so this array is the entire set a player can type, and the same name
may mean different things in two games. The five the engine used to own —
`/name` (`ctx.roundManager.changeName`), `/nr` (`initiateNewRound`, guard it
with `ctx.isDevMode`), `/timeleft` (`ctx.timerManager.getMapTimeLeft()`),
`/mapname` (`ctx.roundManager.currentMap`) and `/rank`
(`ctx.playerDataSync.refreshPlacement(gameId, period)`, or `getRating` for the
value the last refresh left behind) — are game code now; the scaffold ships
them in `src/host/metaCommands.js`. Registering one name twice silently drops a
handler. `/like` and `/unlike` are intercepted by the client and go to the
master — they never reach the host.

## `systemMessages`

Chat system messages travel as short codes; the **texts live on the client**
(`modules.chat.params.messages`), so a code is `group:index[:p0,p1]`.

Engine-reserved groups — do not use these letters:

| Group | Indexes | Meaning |
| --- | --- | --- |
| `s` | 0–6 | team full, your team, new team, now spectator, kill report, joined, left |
| `v` | 0–5 | vote created / started / accepted / unavailable / passed / failed |
| `m` | 0–1 | current map, next map |
| `c` | 0–1 | command not found, rank |
| `n` | 0–1 | invalid name, name changed |

Your own codes pick any other letter (tanks uses `b`, the test fixture uses
`g`):

```js
export default { BOTS_SPAWNED: 'g:0' };   // client text: '{0} bot(s) spawned'
```

Registration is a blind `Object.assign` into the engine registry — a colliding
key overwrites an engine message with **no warning**. Placeholders in the
client text are `{0}`, `{1}`, … filled from the params array.

## Votes

`voteCoordinator` (available in chat-command context) exposes:

```js
canCreateVote(voteCategory, gameId) -> boolean
createVote({ voteName, voteCategory, payload, resultFunc, userList, gameId })
```

- `payload` = `{ name, params?, values? }`, where `name` is the client-side
  template key.
- `resultFunc(result)` runs when voting closes.
- `userList` restricts who may vote (default: everyone).
- `canCreateVote` returns `false` while a category is on cooldown
  (`timers.timeBlockedVote`, 30 s) or a vote of that category is already live.
- One vote is active at a time; further votes queue.
- A tie is broken **randomly**.
- Options are paginated 7 per page (keys `1`–`7`, `8`/`9` page, `0` cancel).

Reserved vote names: `mapChange`, `teamChange`. Reserved `values` shorthands
in client templates: `'teams'`, `'maps'` (the engine substitutes the live
list).

## Panel (host half)

`gameConfig.panel`:

```js
panel: {
  fields: {
    health: { key: 'h',  value: 100 },
    w1:     { key: 'w1', value: 200 },
  },
  activeKey: 'wa',
}
```

- `key` is the short wire key sent to the client; `value` is the **starting
  value**, and it is also handed to the WASM core as the initial resource
  amount (HP, ammo).
- `activeKey` names the cell that shows the active weapon; `null` if unused.
- Runtime operations (from the core, via events): `set`, `decrement`
  (default), `increment`; values floor at `0`.
- The engine hardcodes one extra cell, `t` — the round time in seconds. Your
  client panel schema **must** declare a field with `type: 'time'` bound to
  key `t`.

## Stat (host half)

```js
stat: {
  name:    { key: 0, bodyMethod: '=', headSync: true, headMethod: '#' },
  status:  { key: 1, bodyMethod: '=', bodyValue: '', headValue: '' },
  score:   { key: 2, bodyMethod: '+', bodyValue: 0, headMethod: '+', headValue: 0 },
  deaths:  { key: 3, bodyMethod: '+', bodyValue: 0, headMethod: '+', headValue: 0 },
  latency: { key: 4, bodyMethod: '=' },
}
```

- `key` — the column index on the wire.
- `bodyMethod` / `headMethod` — `'='` (replace), `'+'` (accumulate), `'#'`
  (count rows; head only).
- `headSync: true` — recompute the header cell when body rows change.
- **The engine writes exactly five names: `name`, `status`, `score`,
  `deaths`, `latency`.** A column you invent is never written by the engine;
  a column you omit simply never appears.
- Bots: the engine writes `status: 'dead'` for them like for anyone else, but
  it updates `latency` only from pong replies — bots have no socket, so their
  latency cell keeps whatever text **your bot manager** passed to
  `stat.addUser` (tanks passes `'BOT'`, the minimal fixture `'SCRIPTED'`).
  The engine never fills it for you.

## Player rank and state

The engine keeps a per-`(user, game)` profile on the auth service:

- **points and the ratings** — a game reports the RESULT OF A GAME, and the
  engine splits it into three slices: `day` (the best single game of the UTC
  day), `month` (the sum of the month's games) and `all` (the sum over all
  time, recomputed by a daily job). What a "game" is belongs to the game — a
  life, a round, a match.
- **`state`** — arbitrary JSON, opaque to the engine ("skills"). Starts from
  `gameConfig.playerState.defaultState`.

From `onCoreEvent` the `vimp` object gives you:

```js
vimp.addPlayerPoints(gameId, delta)     // points of the CURRENT game
vimp.finishPlayerGame(gameId)           // that game is over: sum it, max it
vimp.getPlayerRating(gameId, period)    // { value, placement, total } | null
vimp.isPlayerRatingLoaded(gameId)       // have the slices arrived yet?
vimp.refreshPlayerPlacement(gameId, p)  // re-ask the master for one place
vimp.getPlayerState(gameId)             // your blob
vimp.setPlayerState(gameId, state)      // replace it
vimp.flushPlayerData({ urgent })        // REQUEST a sync to the master
```

`period` is `'day' | 'month' | 'all'`.

**Points are not a rating until the game ends.** `addPlayerPoints` collects
them on the participant's current game; `finishPlayerGame` is what turns the
collected number into a sum (the monthly rating) and a maximum (the daily
one). `RoundManager` closes every participant's game at its own boundaries — a
map change and a round end — so a game with rounds gets a daily best without
touching anything. A game with neither (`endlessRound` plus geometry rebuilt
through `overrideMapData`) has to name its own boundary and call
`finishPlayerGame` there; in `@vimp-games/snakes` that boundary is the crash,
because one life is one game.

`getPlayerRating` answers `null` for an id it does not know and for one whose
`PlayerDataSync.load()` has not come back yet, so a game that writes a rating
into a stat column of its own (`bodyMethod: '='`) must gate that write on
`isPlayerRatingLoaded` — otherwise a starting zero lands in the cell instead
of the value the master returned, and `'='` keeps it there.

`refreshPlayerPlacement` re-asks the master for ONE slice's place and returns
a promise of the same `{ value, placement, total }`. A place moves with other
people's games and cannot be recomputed locally, which is what a `/rank`-style
chat command needs; the throttling of the request lives in `PlayerDataSync`.
Note that `CommandProcessor` neither awaits nor catches a command handler, so
such a handler must swallow its own failures — an unhandled rejection in the
host Worker takes the room down.

`getPlayerRank` / `isPlayerRankLoaded` still answer, from the `all` slice, and
`addPlayerRank` is a deprecated alias of `addPlayerPoints`.

### How often any of it is written

**The engine owns the write budget, not the game** (`lobbyConfig.playerData`).
`flushPlayerData` is a REQUEST:

- a `PUT /auth/rank` goes out only when something was actually earned, a
  `PUT /auth/state` only when the state actually changed — a quiet room writes
  nothing at all;
- one request in flight per participant, and at most one sync per participant
  per `minFlushInterval` (60 s, jittered ±20 % per room so that hundreds of
  servers do not write on the same second);
- a room-wide queue capped at `maxRequestsPerSecond`, and an exponential room
  backoff on `5xx` / `429` / network failures;
- `{ urgent: true }` bypasses the interval. The engine uses it on a
  participant's departure and on `destroy()`; a game may pass it too, and
  should reserve it for a boundary a player is about to look at (a new daily
  best right before the leaderboard opens).

The master holds the ceiling for a host that ignores all of the above:
`master:playerData:writesPerMinute` per verified room (over it → `429`) and
`maxGameScore` clamping the result of a single game.

It is best-effort and never rejects, so there is nothing to await and nothing
to catch.

```js
vimp.overrideMapData(scaledMapData)  // what _startRound places people on
```

`overrideMapData` is for a game that rebuilds its geometry on the fly instead
of going through a map change (a map change clears the world, the panel and
the stat table). Hand the engine the same map you handed the core: without it
the next round start — `/nr`, or a chat command that restarts the round —
distributes the respawn points of the CATALOG map, i.e. of geometry the core
no longer has. It replaces neither the room's current map nor the round.

State is flushed to the master on map change, round end and participant
departure — not on every mutation, and never faster than the budget above.

## `onCoreEvent`

```js
onCoreEvent(data, { vimp, panel }) {
  // data is the payload of a core event of type 'custom'
}
```

Only `custom` events reach the plugin; `panelSet`, `panelActive`, `death` and
`shake` are consumed by the engine itself. Ids arrive stringified.

## Handoff

When host duty migrates, the engine serialises:

```js
{ version: 3, gameId, gameVersion, seq, currentMap, mapTimeLeft,
  humans: [{ gameId, name, model, team, teamId, … }],
  scripted: [{ gameId, name, model, team, teamId }],
  stat }
```

**Not carried:** the physics world (the core is not dumped) and any JS state
held inside your host modules. A restored room re-creates the map and respawns
everyone. Design host modules so that losing their in-memory state at a
handoff is survivable.

## Kicks and close codes

| Code | Reason |
| --- | --- |
| `4002` | the host's account was blocked by server rating — the whole room is evacuated (issued by the master) |
| `4003` | EMA latency above `rtt.maxLatency` |
| `4004` | more than `rtt.maxMissedPings` unanswered pings |
| `4005` | idle beyond `idleKickTimeout.<role>` |
| `4006` | room full |

The host's own client is socket id `'local'` and is immune to all of these.
There is **no kick vote** in the engine; social moderation is the master's
`/like` · `/unlike` rating.

Technical messages are indexed into the client's `techInformList`:

| Key | Index |
| --- | --- |
| `fullServer` | 0 |
| `anotherDevice` | 1 |
| `loading` | 2 |
| `kickIdle` | 3 |
| `kickForMaxLatency` | 4 |
| `kickForMissedPings` | 5 |
| `roomFull` | 6 |
