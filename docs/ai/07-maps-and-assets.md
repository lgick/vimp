# 07 — Maps and assets

## Map format

Maps are authored as JS modules under `src/data/maps/` and exported to
`dist/maps/<name>.json` by a build script. **The file name is the map name**
and may contain spaces (`pool mini.json`).

```js
export default {
  setId: 'c1',              // which gameSets entry builds this map's parts
  scale: 0.6,               // per-map scale; falls back to gameConfig.mapScale

  spriteSheet: {            // CLIENT-ONLY (the core ignores it)
    img: 'tiles.png',
    frames: [[480, 64, 32, 32], [128, 224, 32, 32], …],   // [x, y, w, h]
  },
  layers: {                 // CLIENT-ONLY: renderLayer → tile indexes
    1: [0, 2, 4],
    2: [1],
    4: [3],
  },

  physicsStatic: [1],       // tile indexes that become static colliders
  physicsDynamic: [
    { position: [640, 480], angle: 0, width: 64, height: 64,
      density: 1.0, img: 'b1.png', layer: 2,
      linearDamping: 0.2, angularDamping: 0.05 },
  ],

  step: 32,                 // tile size in world units
  map: [                    // grid of tile indexes; 0 = empty
    [1, 1, 1, 1],
    [1, 0, 0, 1],
    [1, 1, 1, 1],
  ],

  respawns: {
    // [x, y, angleDeg] or [x, y, angleDeg, level] on a layered map
    team1: [[130, 520, 0], [130, 620, 0], …],
    team2: [[1600, 520, 180], …],
  },
};
```

| Field | Consumer | Notes |
| --- | --- | --- |
| `setId` | client | selects `parts.gameSets[setId]` to build the map; falls back to `gameConfig.mapSetId` |
| `scale` | host + core | per-map override of `gameConfig.mapScale` |
| `spriteSheet`, `layers` | client only | the core never sees them |
| `physicsStatic` | core | tile indexes that generate static bodies |
| `physicsDynamic` | core + client | movable props |
| `step` | both | tile edge length before scaling |
| `map` | both | row-major grid of tile indexes |
| `respawns` | host | spawn points per team |
| `levels` | core + client | above-ground levels (2.5D); absent = flat map |
| `ramps` | core + client | level transitions |

### Levels and ramps (2.5D)

Level 0 is `map` / `physicsStatic` / `layers` and never moves. A second
level is additive — a map without these fields loads exactly as before:

```js
  levels: {
    '1': {                    // key = level number as a string, from 1
      map: [[0, 9, 9, 0]],    // same dimensions as `map`; 0 = no level here
      floor: [9],             // tiles you can drive on (the bridge slab)
      walls: [7],             // railings: block movement and the ray on L1
      layers: { 5: [9] },     // CLIENT-ONLY, same meaning as top-level layers
    },
  },
  ramps: [
    { tile: 3, dir: 'east', from: 0, to: 1 },   // dir = direction of the CLIMB
  ],
```

| Field | Consumer | Notes |
| --- | --- | --- |
| `levels.<n>.map` | core + client | grid of level `n`; dimensions must match `map` |
| `levels.<n>.floor` | core + client | drivable tiles of the level |
| `levels.<n>.walls` | core + client | railings; **must be a subset of `floor`** |
| `levels.<n>.layers` | client only | renderLayer → tile indexes of this grid |
| `ramps[].tile` | core + client | tile index in the grid of level `from` |
| `ramps[].dir` | core + client | `north` = `-y`, `south` = `+y`, `west` = `-x`, `east` = `+x` |
| `ramps[].from` / `.to` | core + client | default `0` / `1` |
| `physicsDynamic[].level` | core | level the prop stands on; default `0` |
| `respawns[team][i][3]` | host + core | optional level of the spawn point |

`MapConfig::validate` rejects a map with mismatched grid dimensions, a
railing outside `floor`, an unknown ramp tile, or a level number out of
range — `load_map` returns the error before a single body is created.
Contract rule **E4** (`vimp-contract`) runs the same checks statically,
before the build and without the core.

What reaches the client: `MAP_DATA` carries `levels` and `ramps` untouched,
`applyMapData` forwards both to the client core's `set_map` (it builds the
same layered geometry as the host — otherwise level prediction drifts in
silence) and assembles the static render data **per level**. The keys
`s0..sN` run across all levels, and each part instance receives its own
`level`, `solid` (blocking tiles: `physicsStatic` on level 0,
`levels.<n>.walls` above) and `floor` (`levels.<n>.floor`, empty on level
0). A game that cannot run without any of this declares `requires:
['map.layers']` in its manifest.

### Scaling cascade

The host scales the map before handing it to the core and to clients:

```
effectiveScale = map.scale ?? gameConfig.mapScale
step        *= effectiveScale
dynamic position/width/height *= effectiveScale
respawns x, y                 *= effectiveScale
```

Angles are not scaled. Clients receive the already-scaled map — do not scale
again in a part.

### Dynamic body defaults

| Property | Default |
| --- | --- |
| `linearDamping` | `0.0` |
| `angularDamping` | `0.01` |
| friction | `0.2` (fixed by the engine) |
| restitution | `0.0` (fixed by the engine) |

`density` is required; `img` and `layer` are for the client renderer.

### Respawns define team capacity

> **The number of respawn points for a team is the hard capacity of that
> team on that map.** The engine hands out spawn points sequentially from
> index 0; when they run out, no further participant can join that team.
> A map with 10 points per team caps a 2-team match at 20 players regardless
> of `maxPlayers`.

Give every team the same number of points unless asymmetry is intended, and
make sure the total covers `roomDefaults.maxPlayers`.

## Images — you ship them

> Tile sheets and dynamic-object images are **yours**. The engine serves no
> game images at all; every file a map names must exist in your own package.

`spriteSheet.img` and `physicsDynamic[].img` are bare file names. Your `Map`
part turns them into URLs, and the base it uses comes from the engine as the
**`assetsBase` service** — the same base the sounds resolve against:

```js
// src/config/client.js — declare the service for the part that needs it
componentDependencies: {
  renderer:   ['Map'],
  assetsBase: ['Map'],
}

// src/client/parts/Map.js — build the URL
constructor(data, _assets, dependencies) {
  // '/games/<id>/img/' in the lobby and on a dedicated server,
  // whatever `startStandaloneGame({ assetsBase })` was given in dev
  this._imageBase = `${dependencies.assetsBase}img/`;

  Assets.load(`${this._imageBase}${data.spriteSheet.img}`);
}
```

The available service pool is `renderer`, `soundManager` and `assetsBase`; a
part that asks for a service it did not declare simply gets `undefined`.
Guard against that explicitly — a missing base produces a request for
`undefinedimg/tiles.png`, which is a blank canvas with no error at all.

## Image pipeline

1. Keep the source files under `assets/img/` (tracked in git — unlike sounds
   they need no processing step).
2. A copy script (`copy-game-images.js`, mirroring `copy-game-sounds.js`)
   copies them to `build/img/` — the dev root of the standalone launch — and
   to `dist/img/`, the packaged asset.
3. Run it from `build:assets` and from `predev`, so `npm run dev` shows the
   map even before ffmpeg has ever been installed.
4. Make the manifest build **fail** when a map names an image that is not in
   `dist/img/`: the engine cannot diagnose this — the part just never gets its
   texture and the map renders empty.
5. Add the images to the `check-pack.js` required list: `dist/` is usually
   gitignored, and npm applies ignore rules inside directories listed in
   `files`.

## Sound pipeline

1. Author raw sources under `assets/audio-raw/`.
2. `npm run audio:process` runs ffmpeg: loudness normalisation to EBU R128 and
   encoding to **both** `.webm` and `.mp3` into `build/sounds/`
   (an intermediate, gitignored directory).
3. `copy-game-sounds.js` wipes `dist/sounds/` and copies `build/sounds/` into
   it.
4. `manifest.assetsBase` points the client at `/games/<id>/sounds/`.

Both codecs are mandatory: the client's `codecList` is `['webm', 'mp3']` and
it picks the first the browser supports. A missing `.mp3` breaks Safari.

Declare each sound in your client config:

```js
sounds: {
  codecList: ['webm', 'mp3'],
  sounds: {
    shot:   { file: 'shot',   priority: 60, volume: 0.6 },
    engine: { file: 'engine', loop: true,   volume: 0.3 },
  },
}
```

`file` is the base name without extension. Do not set `path` — the engine
overwrites it with `${assetsBase}sounds/`.

## Baked assets

Procedural textures are generated once per canvas at startup instead of being
shipped as images:

```js
bakedAssets: {
  vimp: [
    { name: 'explosionTexture', component: 'ExplosionEffect',
      params: { radius: 50, blur: 2, color: 0xffffff } },
  ],
}
```

- `name` must exist in `ClientPlugin.bakers`; otherwise the entry is silently
  ignored.
- `component` is the part class that receives the result in its `assets`
  argument.
- Bake white/greyscale shapes and `tint` them at runtime — one baked texture
  serves every colour variant and keeps draw calls batched.

## Asset checklist for a new game

- [ ] Every map has `respawns` for every playing team, with enough points.
- [ ] Every tile index used in `map` exists in `spriteSheet.frames`.
- [ ] Every tile index in `physicsStatic` is one you actually want solid.
- [ ] `setId` of each map has a `gameSets` entry listing the map part(s).
- [ ] Every sound name used in code exists in the sound config **and** as a
      `webm` + `mp3` pair in `dist/sounds/`.
- [ ] `soundCues` names resolve to declared sounds.
- [ ] Every baker name referenced in `bakedAssets` exists in `bakers`.
