# 08 — Engine-owned gameplay meta

These rules live in the engine. You cannot replace them; you parameterise them
through `gameConfig`. Design your game to fit them, or accept implementing an
alternative entirely inside your WASM core.

## Rounds

- A round **ends when one team is wiped** — every participant of a team,
  humans *and* bots, is not alive.
- The round timer expiring does **not** end the round with a result: it simply
  starts a new round, no score change.
- Wipe caused by something other than an enemy (self-destruction, environment,
  the killer having already left) ends the round with **no winner**: every
  player receives the `defeat` sound cue and a round-end message without a
  winning team.
- After a round ends, the next one starts after `timers.roundRestartDelay`
  (5 s default).

If your game is not round-based, the closest available shapes are: one long
round (large `roundTime`) with respawns handled in the core, or a single team
so that a wipe cannot occur.

## Scoring

| Event | Effect |
| --- | --- |
| Kill an enemy | killer `score +1`, killer `rank +1`, victim `deaths +1`, victim `status = 'dead'` |
| Team kill | killer `score −1`, killer `rank −1`, victim `deaths +1` |
| Suicide | victim `deaths +1` only — no score or rank change |
| Killer already left | no frag, victim still dies, round still resolves |
| Team wipe | winning team head `score +1`, losing team head `deaths +1` |

Rank is written **synchronously with the kill report** and there is no hook to
change the `±1` rule. A dead player becomes a spectator (watching the killer)
until the next round.

Sound cues fired here: `frag` to the killer, `death` to the victim,
`victory`/`defeat` to every player at round end.

## Teams

- `gameConfig.teams` maps team names to numeric ids and **includes the
  spectator team**; `spectatorTeam` names which one it is.
- One playing team is a valid configuration (the engine's minimal test fixture
  uses exactly one).
- Joining a full team triggers `scripted.removeOneForHuman(team)`; if that
  returns false, the player receives `TEAMS_TEAM_FULL` and stays put.
- Team capacity is `respawns[team].length` on the current map — see
  `07-maps-and-assets.md`.
- Switching team inside `timers.teamChangeGracePeriod` (10 s from round start)
  is free. Outside it, the switcher dies and spectates until the next round.
- Dropping below **2 active humans** resets statistics and immediately starts
  a new round.

## Map rotation

- `timers.mapTime` (10 min default) expiring triggers a system vote offering
  `mapsInVote` maps chosen from the catalog.
- Players can also propose a map through the vote menu; a single proposal is
  applied directly.
- `timers.mapChangeDelay` (2 s) elapses before the switch.
- On map change: all bots are removed and re-created, panel and stat reset,
  votes cleared, and rank/state are flushed to the master.

## Spectators

- Dead players and members of the spectator team follow another participant;
  the camera tracks the killer after a death.
- `spectatorKeys` (`nextPlayer` / `prevPlayer`) cycle the watched player; they
  come from key set index `0`.
- The cursor auto-hides after 3 s of inactivity.

## Kicks

| Trigger | Threshold | Close code |
| --- | --- | --- |
| Latency | EMA (α = 0.1) above `rtt.maxLatency` (1000 ms) | 4003 |
| Missed pings | more than `rtt.maxMissedPings` (5) | 4004 |
| Idle | `idleKickTimeout.player` (120 s) / `.spectator` (`null` = off) | 4005 |
| Room full | — | 4006 |
| Host blocked by rating | master decision | 4002 (whole room) |

The host's own connection (`socketId === 'local'`) is immune.

**There is no kick vote and no `/ban` endpoint.** Social moderation happens in
the lobby: `/like` and `/unlike` are intercepted client-side and sent to the
master, which keeps a host rating in `−10 .. 10`. At `−10` the host is
blocked, its room evacuated with code 4002, and its contribution to players'
rank/state is rolled back. None of this passes through the plugin.

## Timer reference

| Key | Default | Effect |
| --- | --- | --- |
| `timers.timeStep` | `1000/120` ms | simulation tick |
| `timers.networkSendRate` | `4` | send a frame every 4th tick → 30 fps |
| `timers.roundTime` | `120000` | round duration |
| `timers.mapTime` | `600000` | map duration |
| `timers.roomTimeMin` / `roomTimeMax` | `10000` / `3600000` | clamp for user-chosen times |
| `timers.voteTime` | `10000` | vote window |
| `timers.timeBlockedVote` | `30000` | per-category vote cooldown |
| `timers.teamChangeGracePeriod` | `10000` | free team switch window |
| `timers.roundRestartDelay` | `5000` | pause between rounds |
| `timers.mapChangeDelay` | `2000` | pause before a map switch |
| `timers.rttPingInterval` | `3000` | ping cadence |
| `timers.idleCheckInterval` | `30000` | idle sweep cadence |
| `rtt.maxMissedPings` | `5` | kick threshold |
| `rtt.maxLatency` | `1000` | kick threshold, ms |
| `idleKickTimeout.player` | `120000` | ms; `null` disables |
| `idleKickTimeout.spectator` | `null` | ms; `null` disables |
| `chatMaxLength` | `60` | authoritative message length |

Remember the shallow merge: overriding `timers` means restating **every** key.

## Sound cues

```js
soundCues: {
  roundStart: 'roundStart',
  victory:    'victory',
  defeat:     'defeat',
  frag:       'frag',
  death:      'gameOver',
}
```

Exactly these five engine events exist. The values are names in your client
sound config. Cued sounds bypass the world voice limit. An empty object
(`{}`) disables them.

## Game informs

`gameCodes` is fixed by the engine:

| Code | Index into `gameInform.list` |
| --- | --- |
| `winnerTeam` | `0` |
| `roundStart` | `1` |
| `gameOver` | `2` |

```js
gameInform: { list: ['{0} WINS!', 'ROUND START!', 'GAME OVER!'] }
```

The indexes are positional — reordering the array changes the meaning of the
messages. Code `1` (round start) also triggers the panel/logo animation on the
client.

## Technical informs

`techInformList` (client config, engine defaults available) is indexed by the
tech codes listed in `03-host-plugin.md`: full server, another device,
loading, kick idle, kick for latency, kick for missed pings, room full.
Placeholders `{0}`, `{1}` are filled from the params array.

## Initial vote

```js
initialVote: 'teamChange',
```

The vote sent to a player right after their first frame. Usually the team
choice. Set to `null`/omit to drop straight into the game.

## Player profile

- **`rank`** — engine-owned integer, cross-game format, rendered by the
  master's lobby. `±1` per kill, no hook.
- **`state`** — your own JSON blob ("skills"), seeded from
  `playerState.defaultState`, read/written via `onCoreEvent`'s `vimp` object,
  flushed to the master on round end, map change and departure.

Both are namespaced per `(user, gameId)`. Because the host is an untrusted
browser, both are technically forgeable — this is a known limitation of the
P2P model.
