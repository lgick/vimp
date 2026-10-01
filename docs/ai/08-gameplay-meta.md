# 08 — Engine-owned gameplay meta

These rules live in the engine. You cannot replace them; you parameterise them
through `gameConfig`. Design your game to fit them, or accept implementing an
alternative entirely inside your WASM core.

## Rounds

- A round **ends when one team is wiped** — every participant of a team,
  humans _and_ bots, is not alive — and survivors remain in at most one
  other team. With three or more teams the round goes on until only one
  team has anyone alive; a player leaving or switching team counts too, once
  a team has already been wiped that round.
- The round timer expiring does **not** end the round with a result: it simply
  starts a new round, no score change.
- The winner is **the team that still has survivors**, however the last
  player died — an enemy kill, a team kill, self-destruction, the environment,
  or a killer who has already left all resolve the same way. Every `death`
  event runs the wipe check, whatever its `killer`.
- A wipe that leaves **no survivors in any team** (both last players died at
  once, or a single-team game) ends the round with **no winner**: every
  player receives the `defeat` sound cue (spectators `victory`) and a
  round-end message without a winning team.
- After a round ends, the next one starts after `timers.roundRestartDelay`
  (5 s default).

If your game is not round-based, the closest available shapes are: one long
round (large `roundTime`) with respawns handled in the core, or a single team
so that a wipe cannot occur.

## Scoring

| Event               | Effect                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Kill an enemy       | killer `score +1`, killer `rank +1`, victim `deaths +1`, victim `status = 'dead'`                                    |
| Team kill           | killer `score −1`, killer `rank −1`, victim `deaths +1`                                                              |
| Suicide             | victim `deaths +1` only — no score or rank change                                                                    |
| Killer already left | no frag, victim still dies, round still resolves                                                                     |
| Team wipe           | every wiped team head `deaths +1` (once per round); at round end the surviving team head `score +1` (none on a draw) |

Rank is written **synchronously with the kill report** and there is no hook to
change the `±1` rule. A dead player becomes a spectator (watching the killer)
until the next round.

Sound cues fired here: `frag` to the killer, `death` to the victim,
`victory` to the winning team and to spectators (on any outcome, a draw
included), `defeat` to every other player at round end. The winning team's
announcement goes to everyone, spectators included.

## Teams

- `gameConfig.teams` maps team names to numeric ids and **includes the
  spectator team**; `spectatorTeam` names which one it is — unless the game
  declares `noSpectators: true`, in which case `teams` holds exactly one team,
  `spectatorTeam` is omitted, and a joining human goes straight into that team
  (`RoundManager.admitPlayer` on `firstShotReady`, no vote, no team change).
- One playing team is a valid configuration (the engine's minimal test fixture
  uses exactly one).
- Joining a full team triggers `scripted.removeOneForHuman(team)`; if that
  returns false, the player receives `TEAMS_TEAM_FULL` and stays put.
- Team capacity is `respawns[team].length` on the current map — see
  `07-maps-and-assets.md`.
- Switching team inside `timers.teamChangeGracePeriod` (10 s from round start)
  is free. Outside it, the switcher dies and spectates until the next round.
- Dropping below **2 active humans** resets statistics and immediately starts
  a new round — unless the game declares `endlessRound: true`, which switches
  off every engine-initiated round restart (this rule, the team wipe and the
  round timer). `/nr` and map changes still restart it.

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

| Trigger      | Threshold                                                      | Close code |
| ------------ | -------------------------------------------------------------- | ---------- |
| Latency      | EMA (α = 0.1) above `rtt.maxLatency` (1000 ms)                 | 4003       |
| Missed pings | more than `rtt.maxMissedPings` (5)                             | 4004       |
| Idle         | `idleKickTimeout.player` (120 s) / `.spectator` (`null` = off) | 4005       |
| Room full    | —                                                              | 4006       |

The host's own connection (`socketId === 'local'`) is immune.

**There is no kick vote and no `/ban` endpoint.** The server rating
(`/like` · `/unlike`, close code 4002) was removed; protection from a bad
host is now the engine's host migration — automatic triggers (overload,
hidden tab, network lag) and the `/changehost` vote, which the **master**
counts (lobby mode only; the command is reserved, see
[03-host-plugin.md](03-host-plugin.md)). None of it passes through the
plugin, and the game's vote menu gets no item for it.

## Timer reference

| Key                                  | Default             | Effect                               |
| ------------------------------------ | ------------------- | ------------------------------------ |
| `timers.timeStep`                    | `1000/120` ms       | simulation tick                      |
| `timers.networkSendRate`             | `4`                 | send a frame every 4th tick → 30 fps |
| `timers.roundTime`                   | `120000`            | round duration                       |
| `timers.mapTime`                     | `600000`            | map duration                         |
| `timers.roomTimeMin` / `roomTimeMax` | `10000` / `3600000` | clamp for user-chosen times          |
| `timers.voteTime`                    | `10000`             | vote window                          |
| `timers.timeBlockedVote`             | `30000`             | per-category vote cooldown           |
| `timers.teamChangeGracePeriod`       | `10000`             | free team switch window              |
| `timers.roundRestartDelay`           | `5000`              | pause between rounds                 |
| `timers.mapChangeDelay`              | `2000`              | pause before a map switch            |
| `timers.rttPingInterval`             | `3000`              | ping cadence                         |
| `timers.idleCheckInterval`           | `30000`             | idle sweep cadence                   |
| `rtt.maxMissedPings`                 | `5`                 | kick threshold                       |
| `rtt.maxLatency`                     | `1000`              | kick threshold, ms                   |
| `idleKickTimeout.player`             | `120000`            | ms; `null` disables                  |
| `idleKickTimeout.spectator`          | `null`              | ms; `null` disables                  |
| `chatMaxLength`                      | `60`                | authoritative message length         |

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

| Code         | Index into `gameInform.list` |
| ------------ | ---------------------------- |
| `winnerTeam` | `0`                          |
| `roundStart` | `1`                          |
| `gameOver`   | `2`                          |

```js
gameInform: {
  list: ['{0} WINS!', 'ROUND START!', 'GAME OVER!'];
}
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
