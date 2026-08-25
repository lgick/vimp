# 04 — Client plugin contract

`src/client/index.js` default-exports the `ClientPlugin`. It runs on each
player's main thread, alongside the engine's MVC client and a shared PixiJS
instance.

## The object

```js
import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import init, { ClientCore } from '../../core/pkg-web/my_game_core.js';
import styles from './my-game.css?inline';
import parts from './parts/index.js';
import bakers from './bakers/index.js';

export default {
  id: 'my-game',
  engineApi: ENGINE_API_VERSION,

  // wasmUrl has two shapes — .wasm asset in the browser, Node glue under
  // `npm run sim`; see 03-host-plugin.md § Two shapes of `wasmUrl`
  async createClientCore(clientConfigJson, { wasmUrl }) {
    if (isNodeCore(wasmUrl)) {
      const node = await loadNodeCore(wasmUrl);

      return { core: new node.ClientCore(clientConfigJson), memory: null };
    }

    const wasm = await init({ module_or_path: wasmUrl });
    return { core: new ClientCore(clientConfigJson), memory: wasm.memory };
  },

  parts,     // { ClassName: class }
  bakers,    // { assetName: (params, renderer) => Texture | dict }
  styles,    // CSS as a string; the engine injects it into the DOM

  hooks: {
    onAuth(core, authData) { core.set_model(authData.model); },
    onPanel(core, panelData) { core.sync_panel(JSON.stringify(panelData)); },
    onLocalAction(core, action, name, now) { return null; },
  },
};
```

- `createClientCore` **must** return `{ core, memory }`. `memory` is the
  WebAssembly memory object — the engine reads the core's hot buffer directly
  out of it every render tick.
- All three hooks are called unconditionally; a no-op body is fine, a missing
  hook is a crash.
- CSS is imported with `?inline` so Vite hands you a string instead of
  auto-injecting a `<style>` (the plugin build has no HTML entry).
- There is no `views` field. Panel and Stat rendering belong to the engine.

## Parts — the render classes

A "part" is a class the engine instantiates to represent one snapshot entity
on one canvas.

```js
export default class Tank {
  constructor(data, assets, dependencies, context) { … } // first frame values
  update(data) { … }                              // subsequent frames
  destroy() { … }                                 // entity disappeared
}
```

- `data` — the field array for this entity from the snapshot frame.
- `assets` — the baked assets registered for **this class** (see bakers).
- `dependencies` — the services declared for this class (see below).
- `context` — `{ id }`, the id of the entity this instance draws, as it
  appears in the frame (a **string**; `null` for an effect, which has no id).
  Paired with the `localPlayer` service it is what tells a part whether it is
  drawing the local player or somebody else — see below.
- A part that draws must be, or contain, a Pixi `Container` and add itself to
  the stage. The engine does not add it for you.

### Effects (self-destructing parts)

When a snapshot payload for a key is an **array of records**, each record
creates a short-lived *effect* instance instead of a persistent entity. An
effect class additionally implements `run()`; the engine wraps its `destroy()`
so that calling `destroy()` removes it from the effect registry. Effects are
expected to destroy themselves when their animation ends.

### Registration

```js
parts: {
  gameSets: {
    c1:  ['Map', 'MapRadar'],     // map construction set
    m1:  ['Tank', 'TankRadar', 'Smoke', 'Tracks'],
    w1:  ['ShotEffect'],
    w2:  ['Bomb'],
    w2e: ['ExplosionEffect'],
  },
  entitiesOnCanvas: {
    Map: 'vimp', MapRadar: 'radar', Tank: 'vimp', TankRadar: 'radar',
    ShotEffect: 'vimp', Bomb: 'vimp', ExplosionEffect: 'vimp',
    Smoke: 'vimp', Tracks: 'vimp',
  },
}
```

- `gameSets` maps a **snapshot key** (or a map `setId`) to the list of part
  classes built for it.
- `entitiesOnCanvas` maps a part class to the canvas it lives on.
- **Only classes listed in `entitiesOnCanvas` are registered with the
  factory.** A class present in `parts` and in `gameSets` but missing from
  `entitiesOnCanvas` is never constructible — you get
  `Constructor for X not found.` at the first frame.
- A frame key with no `gameSets` entry throws. Every snapshot key must have a
  set, even if the list has one class.
- The same entity can appear on several canvases by listing several classes
  (`Tank` on the main canvas, `TankRadar` on the radar).

## Bakers — procedural textures

```js
bakedAssets: {
  vimp: [                              // per canvas
    { name: 'explosionTexture', component: 'ExplosionEffect',
      params: { radius: 50, blur: 2, color: 0xffffff } },
  ],
}
```

```js
export default function explosionTexture(params, renderer) {
  // draw once, return a Texture (or a plain object of Textures)
  return renderer.generateTexture(graphics);
}
```

- A baker runs **once per canvas at startup**, before any part exists.
- The result lands in the `assets` argument of every instance of the
  `component` class, keyed by `name`.
- A baker whose `name` has no entry in `bakers` is silently skipped.
- A baker **owns what it returns**. Re-baking (WebGL context restore)
  destroys the previous result together with its `TextureSource`, so never
  return a view onto a shared atlas or a texture someone else also holds.

## Dependencies

```js
componentDependencies: {
  renderer:     ['Map'],
  assetsBase:   ['Map'],
  soundManager: ['ExplosionEffect', 'ShotEffect', 'Bomb', 'Tank'],
}
```

The available service pool is fixed, and it has four entries:

| Service | Value | Used for |
| --- | --- | --- |
| `renderer` | the canvas's Pixi renderer | `generateTexture`, baking a map into one sprite |
| `soundManager` | the engine's `SoundManager` | registering positional voices |
| `assetsBase` | the active game's asset base, a string | building URLs into **your own** package: `${assetsBase}img/<file>` |
| `localPlayer` | `{ id, is(id) }` | telling the local player's entity from everyone else's |

### `localPlayer` — is this entity mine?

```js
export default class Tank {
  constructor(data, assets, { soundManager, localPlayer }, { id }) {
    this._isLocal = () => localPlayer.is(id);
  }
}
```

- `localPlayer.id` is the client's own game id, or `null` until the first
  player block arrives.
- `localPlayer.is(id)` compares as strings, because frame ids are object keys.
- **Ask at the moment you need the answer, not in the constructor.** Entities
  are created from `FIRST_SHOT_DATA`, which precedes the first binary frame —
  the local player's own part is built while `localPlayer.id` is still `null`,
  so a flag computed once in the constructor is wrong exactly for the entity
  it matters for.

The typical use is sound: a cue that belongs to the player (a pickup, a hit,
the engine of the machine they drive) is registered only when
`this._isLocal()`, while the visual half of the same event stays on for every
entity. Without it a crowded arena plays everybody's cues at once.

Requesting anything else yields nothing — the key is silently absent from
`dependencies`. That is why a part depending on `assetsBase` should check it
and log a readable `console.error` when it is missing:
`${undefined}img/tiles.png` loads nothing and reports nothing (see
`07-maps-and-assets.md`). Log, never throw: part constructors run inside the
render tick, and nothing on that path catches — an exception aborts the whole
frame, so the other entities of that frame are never created either.

## Canvases

```js
modules: {
  canvasManager: {
    canvases: {
      vimp:  { width: 960, height: 600, aspectRatio: '16:9',
               baseScale: '5:1', dynamicCamera: true, shakeCamera: true },
      radar: { width: 150, height: 150, fixSize: '150', baseScale: '1:8' },
    },
  },
}
```

- The engine **creates the `<canvas>` elements** from this config; they do not
  exist in the HTML. `width`/`height` are the pre-resize starting size.
- `aspectRatio: 'W:H'` — the canvas keeps this ratio while filling the window.
- `fixSize: 'N'` — a fixed square/box size instead of responsive sizing.
- `baseScale: 'W:H'` — parsed as `W / H` rounded to 2 decimals; this is the
  world→screen scale at the design width.
- The live scale is
  `currentScale = (canvasWidth / 1920) * baseScale` — 1920 px is the design
  width at which scale equals `baseScale` exactly.
- `dynamicCamera: true` — the camera leads the player and zooms out with
  speed. Engine defaults: `lookAheadFactor 30`, `zoomOutFactor 0.5`,
  `maxZoomOut 0.6`, `smoothnessPosition 0.008`, `smoothnessZoom 0.005`,
  `smoothnessVelocity 0.15` (overridable under
  `modules.canvasManager.dynamicCamera`).
- `shakeCamera: true` — the canvas reacts to the frame's shake string
  `"intensity:duration"`.

The camera part of a frame is `[x, y, forceReset?, "intensity:duration"?]`.

> **Trap — draw order.** PixiJS v8's `stage.sortChildren()` **takes no
> comparator**: it sorts by `zIndex`, and only when the container is marked
> sortable and dirty. The engine sets `stage.sortableChildren = true` and
> calls `sortChildren()` after every `addChild`, so a `zIndex` assigned in
> a part's constructor (before it enters the scene) still takes effect.
>
> So: set **`zIndex`** on your part instances to control paint order. A
> `layer` property alone does nothing. Parts that never touch `zIndex` all
> share `zIndex 0` and are painted in insertion order — which you influence
> through the order of classes in `gameSets`.

## `initIdList`

```js
initIdList: ['vimp', 'radar', 'panel', 'chat'],
```

DOM ids that are hidden until authentication completes and then revealed.
`'panel'` is un-hidden as `display: flex`, everything else as
`display: block`.

## Panel (client half)

```js
modules: {
  panel: {
    keys: { h: 'health', w1: 'w1', w2: 'w2', wa: 'activeWeapon', t: 'time' },
    fields: [
      { name: 'health', elem: 'panel-health', type: 'bar', max: 100, blocks: 30 },
      { name: 'w1',     elem: 'panel-w1',     type: 'value' },
      { name: 'time',   elem: 'panel-time',   type: 'time' },
      { name: 'activeWeapon', elem: 'panel-active', type: 'weapon' },
    ],
  },
}
```

- `keys` maps the **wire key** (from the host's `panel.fields[*].key`) to the
  client field name. Both halves must agree.
- Cell types:
  - **`bar`** — block bar; `blocks` defaults to `30`, `max` defaults to `100`;
    colour ramp across blocks, low-value blink, animated refill at round
    start (500 ms).
  - **`value`** — plain number.
  - **`time`** — formatted `M:SS`.
  - **`weapon`** — receives the `.active` class when it is the active weapon.
- **The `t` key is hardcoded by the engine** as the remaining round time in
  seconds. Your client schema must contain a field of `type: 'time'` bound to
  `t`, and your host schema must **not** define a field with key `t`.
- `elem` is the DOM id of the cell; the engine's view creates cells inside the
  panel container (`#panel`).

## Stat (client half)

```js
modules: {
  stat: {
    params: {
      columns: ['names', 'status', 'score', 'deaths', 'latency'],
      heads:  { 1: 'team1', 2: 'team2' },
      bodies: { 1: 'team1', 2: 'team2', 3: 'spectators' },
      sortList: { team1: [[2, true], [3, false]] },
    },
  },
}
```

- `columns` — header labels, positionally matched to the host's `key`
  indexes.
- `heads` / `bodies` — team id → table id. A team present in `bodies` but not
  `heads` (spectators) gets rows but no aggregate header.
- `sortList` — per table, a list of `[columnIndex, descending]` pairs. Sorting
  is **numeric** (`~~textContent`), so a text column sorts as `0`.
- How many columns there are is your call — the engine writes its own five
  names (`name`, `status`, `score`, `deaths`, `latency`) into the columns you
  declare and drops the rest, and anything past them you populate yourself.
  But its CSS only lays out five (`#stat …:nth-child(1)…(5)`, plus the
  `.line1`–`.line3` row classes): a further column has no width until you
  restate the layout in `styles`. Contract rule `C6` warns about exactly
  that gap.

## Chat

```js
modules: {
  chat: {
    params: {
      messages: {
        s: ['Team {0} is full. Your current team: {1}', 'Your team: {0}', …],
        v: […], m: […], c: […], n: […],
        g: ['{0} bot(s) spawned'],       // your own group
      },
    },
  },
}
```

Engine defaults you inherit: `listLimit 5` visible lines, `lineTime 15000` ms
before a line fades, cache `200..300` lines, input element `#cmd`, box
`#chat-box`. The message wire is either a system code string
`'group:index[:p0,p1]'` or a user line `[text, name?, teamId?]`.

The chat input's `maxlength` must match the host's `chatMaxLength` (60).

## Vote UI

```js
modules: {
  vote: {
    params: {
      templates: {
        teamChange:        ['Choose a team', 'teams', true],
        mapChangeBySystem: ['Choose the next map'],
        mapChangeByUser:   ['{0} suggested the map: {1}', ['Yes', 'No']],
      },
      menu: [
        ['teamChange', ['Switch team', 'teams']],
        ['mapChange',  ['Suggest map', 'maps']],
      ],
    },
  },
}
```

- Template = `[title, values?, timeOff?]`. `values` is an array of option
  labels, or the string `'teams'` / `'maps'` for engine-substituted lists.
- `timeOff: true` hides the countdown (used for the initial team choice).
- `menu` is the player-initiated vote list.
- `params.time` is injected by the engine from `timers.voteTime`.

## Keyboard

```js
modules: {
  controls: {
    keySetList: [
      { 78: 'nextPlayer', 80: 'prevPlayer' },        // [0] spectator
      { 87: 'forward', 83: 'back', 74: 'fire', … },  // [1] player
    ],
  },
}
```

- Index `0` is the **spectator** key set — it must contain the two spectator
  actions named in `hostDefaults.spectatorKeys` (`nextPlayer`, `prevPlayer`).
- Index `1` is the **player** key set. The engine switches between them with
  the `KEYSET_DATA` port (payload `0` or `1`).
- Engine-owned keys you cannot reuse: `67` chat, `77` vote, `9` stat,
  `27` escape, `13` enter.

The wire format sent to the host is `"seq:action:name"` where `action` is
`down` or `up` and `seq` is a monotonically increasing input sequence used for
prediction reconciliation.

### Pointer input (mouse, finger, stylus)

The keyboard is discrete; a game that wants «steer towards this point» needs
a value the `action:name` string cannot hold. That is a **second, optional
channel**, declared by the game and nothing else:

```js
modules: {
  controls: {
    keySetList: [ … ],
    pointer: {
      keySets: [1],       // key-set indices the pointer is live in
      doubleTapMs: 300,   // second press within this — a double tap
      doubleTapPx: 40,    // …and within this distance
      sendIntervalMs: 50, // `move` is not sent to the host more often
    },
  },
}
```

- **Omit `pointer` and nothing changes**: no listener, no wire traffic, no
  core call. Every existing game keeps working untouched.
- The engine listens to **Pointer Events** (`pointerdown`/`pointermove`/
  `pointerup`/`pointercancel`), which covers mouse, finger and stylus in one
  set — this is what makes a game playable on a phone. `dblclick` is not
  used: touch devices do not guarantee it, so the double tap is recognised
  from the two thresholds above.
- The channel lives by the **same rules as the keys**: it is muted while
  input is disabled, while `chat`/`stat`/`vote` is open, and outside the
  declared key sets. Muting a held pointer emits a release, so a snake does
  not keep driving while its player types in the chat.
- The channel runs **from press to release**: a `move` with no button/finger
  down is not sent. It is a second way to play, not a replacement — the
  keyboard keeps working, and it is the game core that decides which source
  wins on a step where both spoke.
- **Coordinates are world coordinates.** The engine converts them itself
  (`CanvasManagerView.toWorld` — the camera and the canvas scale are the
  engine's), so the plugin gets a point in the same space as
  `actor_position`. The canvas used for the conversion is the first one
  declared, or `modules.canvasManager.pointerCanvas`.

The wire format is `"seq:aim:x:y:flags"`, next to the unchanged
`"seq:action:name"`. `flags` is a bit mask: **bit 0** — the pointer is
pressed, **bit 1** — the press was the second of a double tap (it stays set
for as long as that press is held). Both cores receive it through a trait
method with a **default empty implementation**:

```rust
// host: vimp_engine_core::sim::GameSim
fn apply_aim(&mut self, game_id: u32, seq: u32, x: f32, y: f32, flags: u32) {}
// client: vimp_engine_core::client::game::GameClientDef
fn apply_aim(&mut self, x: f32, y: f32, flags: u32, local_now: f64) {}
```

> **Prediction:** the pointer target has to reach the predictor by the same
> path as the keys and enter the same input history. A replay that knows the
> key mask but not the point being steered towards predicts a different
> curve than the host simulates.

Action **names** are bound to bits on the host side:

```js
playerKeys: {
  forward: { key: 1 << 0 },
  back:    { key: 1 << 1 },
  fire:    { key: 1 << 2, type: 1 },
}
```

- `type: 0` (default) — **held**: `down` sets the bit, `up` clears it.
- `type: 1` — **trigger**: `up` is ignored, and the bit is consumed exactly
  once per simulation tick.

> **Ownership:** the engine never interprets `key` or `type` — it only ships
> `playerKeys` verbatim into both cores' init JSON and forwards the raw
> `down`/`up` events. The held/trigger semantics above are a convention
> **your Rust core implements** (and your predictor must mirror): tanks
> builds a one-shot mask from the `type: 1` keys — `down` sets a pending
> bit, the next fixed step consumes it exactly once, `up` is ignored.
> Declaring `type: 1` without that core logic gives you whatever your core
> does by default — usually autofire. See `05-wasm-core.md`.

Note the two mappings are separate: `keySetList` maps *key code → action
name* (client), `playerKeys` maps *action name → bit* (host + core). Both must
list the same names.

## Sound

```js
parts: {
  sounds: {
    codecList: ['webm', 'mp3'],
    sounds: {
      shot:    { file: 'shot',    priority: 60, volume: 0.6 },
      engine:  { file: 'engine',  loop: true,   volume: 0.3 },
    },
  },
}
```

- `path` is **overwritten by the engine** to `${assetsBase}sounds/` — do not
  set it.
- Per-sound defaults: `priority: 50`, `volume: 0.5`, `loop: false`.
- Master volume is `0.7`.
- Spatial audio: HRTF panner, `refDistance 150 px` (full volume),
  `maxDistance 1000 px` (silence).
- At most **30 simultaneous world voices** (`WORLD_VOICE_LIMIT`). When more
  compete, they are ranked by `priority² / max(distance², 1)` and the top 30
  play.

Three ways a sound is produced:

| Path | Trigger | Bypasses voice limit? |
| --- | --- | --- |
| Spatial | a part calls `soundManager.registerSound(name, { position, rate?, volume? }, onEnd?)` → id, then `updateSoundData` / `unregisterSound` | no |
| System | the engine plays a UI sound via port `SOUND_DATA` | yes |
| Host-cued | `gameConfig.soundCues` maps `roundStart`/`victory`/`defeat`/`frag`/`death` to your sound names | yes |

## Auth screen

```js
export default {
  elems: {
    authId: 'auth', errorId: 'auth-error', enterId: 'auth-enter',
    fieldsId: 'auth-fields', titleId: 'auth-title', informsId: 'auth-informs',
  },
  texts: {
    title: 'My Game',
    sections: [
      { heading: 'Controls', lines: [
        { keys: 'W, S', text: 'move' },
        { separator: true },
        { keys: 'J', text: 'fire', last: true },
      ] },
    ],
  },
  params: [
    { name: 'model', value: 'm1', options: {
        control: 'select', label: 'Model',
        options: ['m1', 'm2'],
        validator: 'isValidModel', storage: 'model' } },
  ],
  validators: { isValidModel: m => m in gameConfig.parts.models },
};
```

- The element id the engine actually reads for the field container is
  **`fieldsId`** (not `formId`).
- `texts.title` is rendered into `#logo`.
- `validators` are functions and are **not serialised** — they run on the host
  when the client answers.
- `storage: '<key>'` persists the field in `localStorage`.
- **There is no nickname field.** Identity comes from the lobby JWT; the host
  reads the `nick` claim. Nicknames are validated globally against
  `^[a-zA-Z]([\w\s#]{0,13})[\w]{1}$`.

## Other client-visible ports

| Port | Effect |
| --- | --- |
| `MAP_DATA` (3) | resets the core, calls `set_map`, then builds map parts through `gameSets[setId]` |
| `CLEAR` (11) | destroys parts of one `setId` (or everything) and resets core + sound |
| `MISC` (9) | miscellaneous, e.g. localStorage name replacement |
| `PING` (10) / `PONG` (8) | latency probe, sent unreliably |
| `CONSOLE` (12) | host-side console output forwarded for debugging |
