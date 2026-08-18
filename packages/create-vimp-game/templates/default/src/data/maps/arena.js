// The single map of the game: a walled rectangle with four pillars, drawn
// procedurally by `src/client/parts/Map.js` — no `spriteSheet`, so the package
// ships no images at all (docs/ai/07-maps-and-assets.md).
//
// `map` is the grid of tiles (0 — empty, 1 — wall), `step` its cell size in
// world units; `physicsStatic` lists the tile values the core turns into
// colliders, and `layers` maps a render layer to the tile values drawn on it —
// WITHOUT it the client builds no map parts at all (the engine derives the
// static map data from `layers`, one entry per layer).
//
// `respawns` holds one entry per playing team, and the length of a list is the
// hard capacity of that team on this map: the engine hands the points out
// sequentially and refuses the next joiner when they run out. Keep every
// point on an EMPTY cell — the engine does not check, and an actor spawned
// inside a wall is stuck there for the round.
const W = 1;

export default {
  // which parts.gameSets entry builds this map (src/config/client.js)
  setId: 'c1',
  scale: 1,
  step: 64,
  physicsStatic: [W],
  physicsDynamic: [],

  // render layer -> tile values drawn on it
  layers: { 1: [W] },

  map: [
    [W, W, W, W, W, W, W, W, W, W, W, W],
    [W, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, W],
    [W, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, W],
    [W, 0, 0, W, W, 0, 0, W, W, 0, 0, W],
    [W, 0, 0, W, 0, 0, 0, 0, W, 0, 0, W],
    [W, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, W],
    [W, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, W],
    [W, 0, 0, W, 0, 0, 0, 0, W, 0, 0, W],
    [W, 0, 0, W, W, 0, 0, W, W, 0, 0, W],
    [W, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, W],
    [W, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, W],
    [W, W, W, W, W, W, W, W, W, W, W, W],
  ],

  // [x, y, angleDeg] — DEGREES, not radians: the core converts them itself.
  // The two teams start along the opposite short walls, in the two columns
  // that are empty on every row (x = 96/160 and x = 608/672).
  respawns: {
    team1: [
      [96, 96, 0],
      [96, 224, 0],
      [96, 352, 0],
      [96, 480, 0],
      [160, 160, 0],
      [160, 288, 0],
      [160, 416, 0],
      [160, 544, 0],
    ],
    team2: [
      [672, 96, 180],
      [672, 224, 180],
      [672, 352, 180],
      [672, 480, 180],
      [608, 160, 180],
      [608, 288, 180],
      [608, 416, 180],
      [608, 544, 180],
    ],
  },
};
