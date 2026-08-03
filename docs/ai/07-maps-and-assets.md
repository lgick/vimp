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
    team1: [[130, 520, 0], [130, 620, 0], …],   // [x, y, angleDeg]
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

## Images — the location trap

> Tile sheets and dynamic-object images are loaded from the **engine's**
> `public/img/` directory, as `/img/<name>`, **not** from your plugin's
> `assetsBase`.

The engine ships `tiles.png`, `tiles2.png`, `tiles3.png`, `b1.png` and a few
others. A map referencing `spriteSheet.img: 'my-tiles.png'` will 404 unless
that file exists in the engine's public directory.

Practical consequences:

- Prefer the tile sheets the engine already ships.
- If you need your own tiles, either load them from `assetsBase` in your own
  `Map` part (you control that code — the `/img/` prefix is a convention of
  the tanks `Map` part, not an engine API), or get the asset added to the
  engine's public directory.
- **Sounds are different**: they come from `${assetsBase}sounds/`, i.e. from
  your own package's `dist/sounds/`.

## Sound pipeline

1. Author raw sources under `assets/sounds/`.
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
