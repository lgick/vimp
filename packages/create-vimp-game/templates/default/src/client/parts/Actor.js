import { Container, Sprite } from 'pixi.js';

// One actor on the main canvas. The engine builds it from the `a1` snapshot
// block (src/config/client.js -> parts.gameSets) and feeds it the field array
// of that block, in the order of src/config/snapshot.js:
//
//   [x, y, angle, vx, vy, health, team]
//
// The very same layout also arrives from the local prediction (the predicted
// tail of the hot buffer), so this class never learns whether the row it got
// is authoritative or a guess — and must not care.
const FIELD = {
  X: 0,
  Y: 1,
  ANGLE: 2,
  HEALTH: 5,
  TEAM: 6,
};

// white texture + tint: one baked asset serves both teams
const TEAM_TINT = {
  1: 0x4fa3ff,
  2: 0xff7a4f,
};

const NEUTRAL_TINT = 0xb0b0b0;

export default class Actor extends Container {
  constructor(data, assets) {
    super();

    // Paint order is `zIndex` and nothing else: the engine marks the stage
    // sortable and calls stage.sortChildren() on every addChild, and PixiJS v8
    // sorts by zIndex there. A `layer` property alone does nothing at all.
    this.zIndex = 3;

    this._sprite = new Sprite(assets.actorTexture);
    this._sprite.anchor.set(0.5);

    this.addChild(this._sprite);

    this.update(data);
  }

  update(data) {
    this.x = data[FIELD.X] || 0;
    this.y = data[FIELD.Y] || 0;
    this._sprite.rotation = data[FIELD.ANGLE] || 0;

    const team = data[FIELD.TEAM];

    if (team !== this._team) {
      this._team = team;
      this._sprite.tint = TEAM_TINT[team] ?? NEUTRAL_TINT;
    }

    // A dead actor never arrives here: the core sends a null row for it and
    // the engine destroys the instance. Health is kept anyway — the first
    // thing a game grows is a bar over the head, and this is where it reads
    // its value.
    this._health = data[FIELD.HEALTH];
  }

  destroy() {
    // `true` destroys the children as well; the baked texture is NOT ours to
    // destroy — the engine re-uses it for every actor on this canvas
    super.destroy({ children: true });
  }
}
