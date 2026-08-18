import { describe, it, expect, vi } from 'vitest';
import { Texture } from 'pixi.js';
import parts from '../../src/client/parts/index.js';
import actorTexture from '../../src/client/bakers/actorTexture.js';
import mapData from '../../src/data/maps/arena.js';

// Parts are constructed inside the render tick, on a path with no try/catch
// anywhere: an exception in a constructor aborts the whole frame, so every
// entity of that frame is lost with it. These cases only build them — no
// WebGL context is created in happy-dom.
const { Map: MapPart, Actor, ShotEffect } = parts;

// [x, y, angle, vx, vy, health, team] — the a1 block of src/config/snapshot.js
const actorRow = [100, 200, 1.5, 0, 0, 100, 1];

describe('Actor', () => {
  const assets = { actorTexture: Texture.EMPTY };

  it('places itself by the snapshot row', () => {
    const actor = new Actor(actorRow, assets);

    expect(actor.x).toBe(100);
    expect(actor.y).toBe(200);
    expect(actor.zIndex).toBe(3);

    actor.update([10, 20, 0, 0, 0, 50, 2]);

    expect(actor.x).toBe(10);
    expect(actor.y).toBe(20);

    actor.destroy();
  });

  it('tints the two teams differently', () => {
    const one = new Actor(actorRow, assets);
    const two = new Actor([0, 0, 0, 0, 0, 100, 2], assets);

    expect(one.children[0].tint).not.toBe(two.children[0].tint);

    one.destroy();
    two.destroy();
  });
});

describe('Map', () => {
  it('draws the tiles of its own layer', () => {
    const [layer, tiles] = Object.entries(mapData.layers)[0];
    const part = new MapPart({
      type: 'static',
      map: mapData.map,
      step: mapData.step,
      layer,
      tiles,
      physicsStatic: mapData.physicsStatic,
      scale: mapData.scale,
    });

    expect(part.zIndex).toBe(Number(layer));
    expect(part.children.length).toBe(1);

    part.destroy();
  });

  it('survives a dynamic body it has nothing to draw for', () => {
    const part = new MapPart({ type: 'dynamic', layer: 2, angle: 0 });

    expect(part.children.length).toBe(0);

    part.destroy();
  });
});

describe('ShotEffect', () => {
  // [startX, startY, endX, endY, wasHit, author] — the e1 block
  const row = [0, 0, 100, 0, 1, 7];

  it('plays a positional sound and releases it on destroy', () => {
    const soundId = Symbol('shot');
    const soundManager = {
      registerSound: vi.fn(() => soundId),
      releaseSound: vi.fn(),
    };

    const effect = new ShotEffect(row, {}, { soundManager });

    effect.run();

    expect(soundManager.registerSound).toHaveBeenCalledWith('shot', {
      position: { x: 0, y: 0 },
    });

    effect.destroy();

    expect(soundManager.releaseSound).toHaveBeenCalledWith(soundId);
  });

  it('destroys itself once its lifetime is over', () => {
    const effect = new ShotEffect(row, {}, { soundManager: null });

    effect.run();
    // the engine drives this through Ticker.shared; a direct call keeps the
    // test free of real time
    effect._update(1000);

    expect(effect.destroyed).toBe(true);
  });

  // the effect destroys itself from the ticker, so the scene tearing down
  // afterwards calls destroy() a second time
  it('survives a second destroy()', () => {
    const effect = new ShotEffect(row, {}, { soundManager: null });

    effect.run();
    effect._update(1000);

    expect(() => effect.destroy()).not.toThrow();
  });
});

describe('actorTexture baker', () => {
  it('bakes through the renderer it is given', () => {
    const renderer = { generateTexture: vi.fn(() => Texture.EMPTY) };
    const texture = actorTexture({ size: 32, color: 0xffffff }, renderer);

    expect(renderer.generateTexture).toHaveBeenCalled();
    expect(texture).toBe(Texture.EMPTY);
  });
});
