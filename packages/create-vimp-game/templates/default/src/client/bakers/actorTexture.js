import { Graphics, Rectangle } from 'pixi.js';

// Procedural texture of the actor: a disc with a muzzle wedge pointing along
// the +X axis (angle 0 of the core). Baked ONCE per canvas at startup, before
// any part exists — this is why the package ships no images.
//
// It is drawn WHITE and tinted per team in the part: one baked texture serves
// every colour variant and keeps the draw calls batched.
//
// A baker owns what it returns. The engine re-bakes on a WebGL context
// restore and destroys the previous result together with its TextureSource, so
// never return a view onto a shared atlas or a texture someone else holds.
//
// `params` comes from parts.bakedAssets ({ size, color }); `renderer` is the
// Pixi renderer of the canvas being baked.
export default function actorTexture(params, renderer) {
  const { size, color } = params;
  const radius = size / 2;
  const graphics = new Graphics();

  graphics.circle(radius, radius, radius);
  graphics.fill(color);

  // the muzzle: a wedge from the centre to the +X edge, so a standing actor
  // still shows where it is aiming
  graphics.moveTo(radius, radius - radius * 0.35);
  graphics.lineTo(size, radius);
  graphics.lineTo(radius, radius + radius * 0.35);
  graphics.closePath();
  graphics.fill({ color, alpha: 0.55 });

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, size, size),
  });

  graphics.destroy(true);

  return texture;
}
