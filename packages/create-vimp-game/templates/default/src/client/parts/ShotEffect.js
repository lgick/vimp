import { Container, Graphics, Ticker } from 'pixi.js';

// The tracer of one shot. This part is an EFFECT, not an entity: the `e1`
// block is a list16, its payload is an ARRAY of rows, and for an array the
// engine creates one short-lived instance per row instead of an addressable
// object. An effect class implements `run()` on top of the usual contract —
// the engine calls it right after adding the instance to the stage — and is
// expected to destroy ITSELF when the animation ends.
//
// Row layout (src/config/snapshot.js -> e1):
//
//   [startX, startY, endX, endY, wasHit, author]
//
// The local prediction draws its own tracer the moment the trigger is pressed
// and the client core then drops the authoritative twin of it by `author`, so
// a row for the local player normally reaches this class once — from the
// prediction, one round trip earlier.
const LIFETIME = 140;
const HIT_COLOR = 0xffd166;
const MISS_COLOR = 0x9fb3c8;

export default class ShotEffect extends Container {
  constructor(data, assets, dependencies) {
    super();

    // above the map, below the actors
    this.zIndex = 2;

    this._startX = data[0];
    this._startY = data[1];
    this._endX = data[2];
    this._endY = data[3];
    this._wasHit = Boolean(data[4]);

    this._soundManager = dependencies.soundManager;
    this._soundId = null;
    this._tick = null;
    this._elapsed = 0;

    this._line = new Graphics();
    this.addChild(this._line);
  }

  run() {
    this._line
      .moveTo(this._startX, this._startY)
      .lineTo(this._endX, this._endY)
      .stroke({
        color: this._wasHit ? HIT_COLOR : MISS_COLOR,
        width: 2,
        alpha: 1,
      });

    if (this._wasHit) {
      this._line.circle(this._endX, this._endY, 4).fill(HIT_COLOR);
    }

    // spatial voice: the engine ranks voices by priority and distance and
    // plays the loudest 30, so a busy match stays audible
    this._soundId =
      this._soundManager?.registerSound('shot', {
        position: { x: this._startX, y: this._startY },
      }) ?? null;

    this._tick = ticker => this._update(ticker.deltaMS);
    Ticker.shared.add(this._tick);
  }

  _update(deltaMS) {
    this._elapsed += deltaMS;

    const left = 1 - this._elapsed / LIFETIME;

    if (left <= 0) {
      this.destroy();

      return;
    }

    this._line.alpha = left;
  }

  // an effect has no update path: every row is a new instance
  update() {}

  destroy() {
    if (this._tick) {
      Ticker.shared.remove(this._tick);
      this._tick = null;
    }

    // the flash is over long before the sample is: release, do not
    // unregister — unregistering cuts the sound off mid-shot
    if (this._soundId) {
      this._soundManager.releaseSound(this._soundId);
      this._soundId = null;
    }

    super.destroy({ children: true });
  }
}
