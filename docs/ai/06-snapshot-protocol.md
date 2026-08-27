# 06 — Snapshot protocol and ports

The state channel is a compact binary format driven entirely by **your**
schema. The engine never knows what a field means; it knows how many bytes it
occupies and whether it interpolates.

## The schema

`gameConfig.snapshot` — one entry per entity kind:

```js
export default {
  m1: {
    id: 1,
    kind: 'indexed8',
    class: 'hot',
    fields: [
      { name: 'x',        ty: 'f32', interp: 'lerp' },
      { name: 'y',        ty: 'f32', interp: 'lerp' },
      { name: 'angle',    ty: 'f32', interp: 'lerpAngle' },
      { name: 'team',     ty: 'u8' },
    ],
  },
  w1: {
    id: 2,
    kind: 'list16',
    class: 'event',
    fields: [
      { name: 'startX', ty: 'f32' },
      { name: 'startY', ty: 'f32' },
      { name: 'endX',   ty: 'f32' },
      { name: 'endY',   ty: 'f32' },
      { name: 'wasHit', ty: 'u8'  },
      { name: 'author', ty: 'u8'  },   // author id — last field, by convention
    ],
  },
};
```

| Property | Values | Notes |
| --- | --- | --- |
| `id` | `u8`, unique | the key byte on the wire; validation checks **uniqueness only** |
| `kind` | `indexed8` · `indexed32` · `list16` · `indexedNoNull8` | wire shape, see below |
| `class` | `hot` · `event` | `hot` = continuous state, `event` = one-shot |
| `fields[].ty` | `f32` · `u8` · `u16` · `u32` | big-endian |
| `fields[].interp` | `lerp` · `lerpAngle` · `discrete` (default) | only `f32` fields interpolate; only `hot` blocks interpolate |

**The field order is positionally bound to your Rust `Row` construction.**
Nothing validates the correspondence: swapping two fields in the JS schema
without swapping them in Rust silently produces garbage.

## The four kinds

All integers are **big-endian**. `hasData` is a `u8` null marker: `0` = the
entity is gone (JSON `null`), `1` = a field row follows.

| Kind | Count prefix | Per row | Use for |
| --- | --- | --- | --- |
| `indexed8` | `u8` count | `u8 id`, `u8 hasData`, fields | up to 255 addressable entities (players) |
| `indexed32` | `u16` count | `u32 id`, `u8 hasData`, fields | many short-lived entities (projectiles) |
| `list16` | `u16` count | fields | anonymous events (tracers, explosions) |
| `indexedNoNull8` | `u8` count | `u8 index`, fields | fixed-slot data that never disappears (dynamic map objects) |

The body is a concatenation of `[u8 keyId][block]` for every key that has
content this tick.

## Frame v3 layout

```
offset  size  field
0       1     port          (5 = SHOT_DATA)
1       1     version       (3)
2       4     seq           u32
6       8     serverTime    f64
14      1     flags         1 = camera, 2 = forceReset, 4 = shake, 8 = player
--- if flags & 1 ---
        4     cameraX       f32
        4     cameraY       f32
--- if flags & 4 ---
        1     shakeLen      u8
        n     shake         ASCII "intensity:duration"
--- if flags & 8 ---
        1     gameId        u8
        4     inputSeq      u32
        32    state         8 × f32   (PLAYER_STATE_LEN)
        1     centering     u8
--- always ---
        …     body          [u8 keyId][block] …
```

The **body is packed once per tick** and shared; only the header is per-user
(camera, shake and the player block differ per recipient). That is why
`pack_body()` and `pack_frame()` are separate calls.

Channel selection:

```
reliable (meta) = body_has_events() || forceReset || shake
```

## Interpolation

The client renders the world at `serverNow − delay`, with engine defaults
`delay = 100 ms` and `maxFrameAge = 1000 ms`. At 30 frames/s (the default
`networkSendRate: 4`) that is ~3 frames of buffer.

`f32` fields marked `lerp` are linearly interpolated; `lerpAngle` interpolates
the short way around the circle; everything else snaps.

## The hot buffer

Each render tick, `ClientCore.sample(now)` fills a flat `f32` buffer which JS
reads zero-copy from WASM memory:

```
[0]                 flags   (1 GAME | 2 CAMERA | 4 PREDICTED | 8 FRAMES)
[1], [2]            camera x, y
[3]                 N       — number of indexed8 rows
N × (keyId, id, …fields)
                    M       — number of indexedNoNull8 rows
M × (keyId, index, …fields)
                    predicted tail (one record, game-defined layout)
                    P × (keyId, id, …fields)  — rows the game predicts itself
```

Record width is `2 + fields.length` — the engine derives it from the schema
it received in `CONFIG_DATA`. The tail has no count of its own: the reader
consumes records until the buffer ends, and every record lands in
`game[key][id]`, so a trailing record overrides the interpolated row of the
same entity (that is how both the predicted tail and `render_rows()` work).

> **Constraint:** the hot buffer carries **only `indexed8` and
> `indexedNoNull8`** blocks. Anything you want animated smoothly at render
> rate must use one of those two kinds. `indexed32` and `list16` are delivered
> through `take_frames()` instead — fine for events, wrong for continuous
> motion.

## `take_frames()` — the JSON path

Returns queued event frames. Per kind, a block becomes:

| Kind | JSON |
| --- | --- |
| `indexed8` | `{ "<id>": [fields] | null }` |
| `indexed32` | `{ "<id in base36>": [fields] | null }` |
| `list16` | `[[fields], …]` — an array means *effects* to the client factory |
| `indexedNoNull8` | `{ "d<index>": [fields] }` |

Base-36 ids match JS `id.toString(36)`.

## Rounding

Every transmitted `f32` is effectively carried at **2 decimal places**, except
the per-user player block (prediction needs full precision). Do not design
mechanics that depend on sub-centimetre transmitted precision.

**The rounding is yours to apply, not the packer's.** The packer writes the
`f32` you give it verbatim; the decoder passes every field through `round2`
on the way out. So a value packed unrounded reaches the client as a different
number than the one the host kept — call
`vimp_engine_core::physics::round2` on the floats you put into
`build_snapshot_blocks`. (The engine does this for the dynamic-map-object
block it owns; the player block is packed *and* decoded raw.)

## Port table

Host → client (`wsports.server`):

| Port | Name | Payload |
| --- | --- | --- |
| 0 | `CONFIG_DATA` | full client config (engine defaults + your client config + `prediction` + `snapshot`) |
| 1 | `AUTH_DATA` | `authSchema` (without validators) |
| 2 | `AUTH_RESULT` | accepted / rejected |
| 3 | `MAP_DATA` | scaled map JSON + `setId` |
| 4 | `FIRST_SHOT_DATA` | first full frame |
| 5 | `SHOT_DATA` | **binary** state frame |
| 6 | `SOUND_DATA` | system sound cue |
| 7 | `GAME_INFORM_DATA` | `[codeIndex, params?]` → `gameInform.list` |
| 8 | `TECH_INFORM_DATA` | `[codeIndex, params?]` → `techInformList` |
| 9 | `MISC` | miscellaneous (e.g. nickname replacement) |
| 10 | `PING` | latency probe |
| 11 | `CLEAR` | destroy parts of a `setId`, or everything |
| 12 | `CONSOLE` | forwarded console output |
| 13 | `PANEL_DATA` | array of `'key:value'` (a bare `'key'` hides the cell) |
| 14 | `STAT_DATA` | `[bodyRows, headRows, full?]` |
| 15 | `CHAT_DATA` | `'group:index[:p0,p1]'` or `[text, name?, teamId?]` |
| 16 | `VOTE_DATA` | vote payload |
| 17 | `KEYSET_DATA` | `0` (spectator) or `1` (player) |
| 18 | `ACCOLADES_DATA` | `{ [gameId]: { daily, monthly } }` — places in the global top, sent only when they change |

Client → host (`wsports.client`):

| Port | Name | Payload |
| --- | --- | --- |
| 0 | `CONFIG_READY` | — |
| 1 | `AUTH_RESPONSE` | `{ …authFields, token }` |
| 2 | `MODULES_READY` | — |
| 3 | `MAP_READY` | — |
| 4 | `FIRST_SHOT_READY` | — |
| 5 | `KEYS_DATA` | `"seq:action:name"` |
| 6 | `CHAT_DATA` | message text |
| 7 | `VOTE_DATA` | chosen option |
| 8 | `PONG` | latency reply |

## Stat wire format

`STAT_DATA` is `[bodyRows, headRows, full?]`, where a body row is
`[gameId, teamId, cells | null, tbody]` — `cells: null` removes the row. Head
rows carry the aggregate values computed by `headMethod`.

## Designing a schema

1. One `hot` `indexed8` key per persistent actor type (players, vehicles).
2. `indexedNoNull8` for fixed-slot world state (dynamic map objects).
3. `event` `list16` for anonymous one-shot effects.
4. `event` `indexed32` for identified short-lived entities that need updates
   (grenades in flight).
5. Keep hot field counts small: every field costs bytes 30×/s per entity.
6. Put the author id last in every weapon event block — the client-side
   duplicate suppression relies on it.
