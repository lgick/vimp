// The wire layout of the game (gameConfig.snapshot): one block per entity
// kind. The engine never learns what a field means — only how many bytes it
// takes and whether it interpolates (docs/ai/06-snapshot-protocol.md).
//
// The KEY of a block is not free: the Rust core names the actor block after
// the model (`src/data/models.js`) and the tracer block after the weapon
// (`src/data/weapons.js`) that produced it, so `a1` and `e1` below are those
// two names. Renaming a model or a weapon renames its block. The third key is
// the `setId` of the map — see the comment on `c1`.
//
// The field ORDER is positionally bound to `core/src/game.rs` — `ActorRow`
// and `TracerRow` push their values in exactly this sequence. Nothing
// validates the correspondence: swapping two entries here without swapping
// them there produces garbage instead of an error.
export default {
  // the actor: continuous state, so `hot` — the only class the render-rate
  // buffer carries, and it carries only indexed8 / indexedNoNull8
  a1: {
    id: 1,
    kind: 'indexed8',
    class: 'hot',
    fields: [
      { name: 'x', ty: 'f32', interp: 'lerp' },
      { name: 'y', ty: 'f32', interp: 'lerp' },
      { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
      // velocity is not interpolated: the client only reads it to tell a
      // moving actor from a standing one, and a lerped copy of a value that
      // already changes every frame buys nothing
      { name: 'vx', ty: 'f32' },
      { name: 'vy', ty: 'f32' },
      { name: 'health', ty: 'u8' },
      { name: 'team', ty: 'u8' },
    ],
  },

  // the shot: an anonymous one-shot event, so `list16` + class 'event' —
  // a frame carrying it goes over the reliable channel
  e1: {
    id: 2,
    kind: 'list16',
    class: 'event',
    fields: [
      { name: 'startX', ty: 'f32' },
      { name: 'startY', ty: 'f32' },
      { name: 'endX', ty: 'f32' },
      { name: 'endY', ty: 'f32' },
      { name: 'wasHit', ty: 'u8' },
      // the author id is LAST by convention: the client drops the
      // authoritative twin of a tracer it already drew by this field
      { name: 'author', ty: 'u8' },
    ],
  },

  // The movable bodies of the map (`physicsDynamic`). This block belongs to
  // the ENGINE: it is packed by the engine half of the core, under the map's
  // `setId` as the key, and its row is fixed at [x, y, angle]. The template
  // has no dynamic bodies, and the block is still mandatory — the packer
  // refuses a key it does not know, and `npm run sim` dies on the first tick
  // with "unknown snapshot key 'c1'".
  c1: {
    id: 3,
    kind: 'indexedNoNull8',
    class: 'hot',
    fields: [
      { name: 'x', ty: 'f32', interp: 'lerp' },
      { name: 'y', ty: 'f32', interp: 'lerp' },
      { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
    ],
  },
};
