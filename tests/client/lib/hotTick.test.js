/* eslint-disable camelcase -- фейк ядра повторяет snake_case ABI ClientCore */
import { describe, it, expect, vi } from 'vitest';
import runHotTick from '../../../packages/engine/src/client/lib/hotTick.js';
import { buildSnapshotKeysById } from '../../../packages/engine/src/lib/reconstructHot.js';
import { HOT_FLAGS } from '../../../packages/engine/src/config/opcodes.js';

const keysById = buildSnapshotKeysById({
  a1: { id: 1, kind: 'indexed8', fields: [{ name: 'x' }, { name: 'y' }] },
});

// [flags, camX, camY, N, keyId, id, x, y, M]: одна запись Indexed8, без
// динамики и хвоста
const ALL = HOT_FLAGS.GAME | HOT_FLAGS.CAMERA | HOT_FLAGS.FRAMES;
const makeHot = (flags = ALL) => [flags, 120, -40, 1, 1, 5, 10, 20, 0];

// настоящая память WASM и ядро, которое растит её на названном вызове —
// так же, как это делает аллокация в куче ядра
function makeCore({ hot = makeHot(), growOn = null } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 16 });

  new Float32Array(memory.buffer, 0, hot.length).set(hot);

  const grow = name => {
    if (growOn === name) {
      memory.grow(1);
    }
  };
  const core = {
    sample: vi.fn(() => hot.length),
    hot_ptr: vi.fn(() => {
      grow('hot_ptr');
      return 0;
    }),
    take_frames: vi.fn(() => {
      grow('take_frames');
      return JSON.stringify([{ game: { a1: {} }, camera: 0 }]);
    }),
  };

  return { core, memory };
}

const run = (core, memory, overrides = {}) => {
  const deps = {
    applyShot: vi.fn(),
    applyGameData: vi.fn(),
    applyCamera: vi.fn(),
    ...overrides,
  };

  runHotTick({ core, memory, snapshotKeysById: keysById, now: 1000, ...deps });

  return deps;
};

describe('runHotTick', () => {
  it('рост памяти в take_frames не портит камеру и горячие данные', () => {
    const { core, memory } = makeCore({ growOn: 'take_frames' });
    const deps = run(core, memory);

    expect(deps.applyCamera).toHaveBeenCalledWith([120, -40]);
    expect(deps.applyGameData).toHaveBeenCalledWith({ a1: { 5: [10, 20] } });
  });

  it('рост памяти в парте при разборе кадра — то же', () => {
    const { core, memory } = makeCore();
    const deps = run(core, memory, {
      applyShot: vi.fn(() => memory.grow(1)),
    });

    expect(deps.applyCamera).toHaveBeenCalledWith([120, -40]);
    expect(deps.applyGameData).toHaveBeenCalledWith({ a1: { 5: [10, 20] } });
  });

  it('рост памяти в hot_ptr — буфер читается уже новой памяти', () => {
    const { core, memory } = makeCore({ growOn: 'hot_ptr' });
    const deps = run(core, memory);

    expect(deps.applyCamera).toHaveBeenCalledWith([120, -40]);
    expect(deps.applyGameData).toHaveBeenCalledWith({ a1: { 5: [10, 20] } });
  });

  it('порядок применения: кадры → горячие данные → камера', () => {
    const { core, memory } = makeCore();
    const deps = run(core, memory);
    const [shot] = deps.applyShot.mock.invocationCallOrder;
    const [game] = deps.applyGameData.mock.invocationCallOrder;
    const [camera] = deps.applyCamera.mock.invocationCallOrder;

    expect(deps.applyShot).toHaveBeenCalledWith({ a1: {} }, 0);
    expect(shot).toBeLessThan(game);
    expect(game).toBeLessThan(camera);
  });

  it('без флагов ничего не применяется', () => {
    const { core, memory } = makeCore({ hot: makeHot(0) });
    const deps = run(core, memory);

    expect(deps.applyShot).not.toHaveBeenCalled();
    expect(deps.applyGameData).not.toHaveBeenCalled();
    expect(deps.applyCamera).not.toHaveBeenCalled();
    expect(core.take_frames).not.toHaveBeenCalled();
  });

  it('только PREDICTED (без GAME) — горячие данные всё равно разбираются', () => {
    const { core, memory } = makeCore({
      hot: makeHot(HOT_FLAGS.PREDICTED | HOT_FLAGS.CAMERA),
    });
    const deps = run(core, memory);

    expect(deps.applyGameData).toHaveBeenCalledWith({ a1: { 5: [10, 20] } });
    expect(deps.applyCamera).toHaveBeenCalledWith([120, -40]);
    expect(core.take_frames).not.toHaveBeenCalled();
  });

  it('без CAMERA камера не применяется', () => {
    const { core, memory } = makeCore({ hot: makeHot(HOT_FLAGS.GAME) });
    const deps = run(core, memory);

    expect(deps.applyGameData).toHaveBeenCalledTimes(1);
    expect(deps.applyCamera).not.toHaveBeenCalled();
  });

  it('sample получает now', () => {
    const { core, memory } = makeCore();

    run(core, memory);

    expect(core.sample).toHaveBeenCalledWith(1000);
  });
});
