import { Container, Graphics } from 'pixi.js';

// The map, drawn procedurally. The engine splits MAP_DATA into one instance
// per render layer of `layers` (src/data/maps/arena.js) and hands each one:
//
//   { type: 'static', map, step, layer, tiles, physicsStatic, spriteSheet,
//     scale }
//
// `tiles` are the tile values THIS layer draws — a map with several layers
// gets several instances of this class, each drawing its own subset.
//
// A map with `physicsDynamic` also gets one instance per movable body, with
// `type: 'dynamic'`; the template has none, and the branch below says so
// rather than pretending the case cannot happen.
//
// Note what is NOT here: the step arrives ALREADY multiplied by the map
// scale, so scaling the container again would draw the world twice as large
// as the physics.
const WALL_COLOR = 0x33384a;
const WALL_EDGE = 0x4a5168;

export default class Map extends Container {
  constructor(data) {
    super();

    // an ARRAY is a row of the `c1` snapshot block — a movable body of the
    // map, live position included ([x, y, angle]). The template declares no
    // physicsDynamic, so no such row is ever packed; the branch exists so that
    // adding one is a drawing problem, not a crash inside the render tick.
    if (Array.isArray(data)) {
      this.zIndex = 2;

      return;
    }

    // under the actors and the tracers
    this.zIndex = Number(data.layer) || 1;

    if (data.type === 'dynamic') {
      // the map payload of a movable body (image, size, angle) — same story
      return;
    }

    this._draw(data);
  }

  _draw({ map, step, tiles }) {
    const drawn = new Set(tiles ?? []);
    const graphics = new Graphics();

    for (let row = 0; row < map.length; row += 1) {
      for (let col = 0; col < map[row].length; col += 1) {
        if (!drawn.has(map[row][col])) {
          continue;
        }

        graphics.rect(col * step, row * step, step, step);
      }
    }

    graphics.fill(WALL_COLOR);
    graphics.stroke({ color: WALL_EDGE, width: 2, alignment: 0 });

    this.addChild(graphics);
  }

  // the static map never changes between two MAP_DATA payloads: a new map
  // arrives as a CLEAR of this setId followed by fresh instances
  update() {}

  destroy() {
    super.destroy({ children: true });
  }
}
