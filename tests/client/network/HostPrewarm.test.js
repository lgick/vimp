import { describe, it, expect, vi } from 'vitest';
import HostPrewarm from '../../../packages/engine/src/client/network/HostPrewarm.js';

const meta = (version = '1.0.0') => ({
  room: {
    settings: { map: 'arena', maxPlayers: 8 },
    game: { id: 'tanks', version },
  },
});

const create = (overrides = {}) => {
  const controllers = [];
  const prepareRoom = vi.fn(async settings => ({
    room: { ...settings, game: { id: 'tanks' } },
    workerUrl: '/worker.js',
    mapsVersion: 'm1',
    codeVersion: null,
  }));
  const prewarm = new HostPrewarm({
    prepareRoom,
    decode: async bytes => ({ meta: meta(bytes.version), core: null }),
    createController: (room, opts) => {
      const controller = { room, opts, destroy: vi.fn() };

      controllers.push(controller);

      return controller;
    },
    ...overrides,
  });

  return { prewarm, prepareRoom, controllers };
};

describe('HostPrewarm', () => {
  it('готовит комнату по точке и поднимает Worker в режиме preload', async () => {
    const onReady = vi.fn();
    const { prewarm, prepareRoom, controllers } = create({ onReady });

    await prewarm.warm({ version: '1.0.0' });

    expect(prepareRoom).toHaveBeenCalledWith(
      { map: 'arena', maxPlayers: 8 },
      { id: 'tanks', version: '1.0.0' },
    );
    expect(controllers[0].opts).toMatchObject({
      preload: true,
      workerUrl: '/worker.js',
    });
    expect(prewarm.state).toBe('warming');

    controllers[0].opts.onPreloaded();

    expect(prewarm.state).toBe('ready');
    expect(prewarm.controller).toBe(controllers[0]);
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({ gameRef: { id: 'tanks', version: '1.0.0' } }),
    );
  });

  it('та же версия повторно не греется; новая — заново', async () => {
    const { prewarm, prepareRoom, controllers } = create();

    await prewarm.warm({ version: '1.0.0' });
    controllers[0].opts.onPreloaded();
    await prewarm.warm({ version: '1.0.0' });

    expect(prepareRoom).toHaveBeenCalledTimes(1);

    await prewarm.warm({ version: '1.1.0' });

    expect(controllers[0].destroy).toHaveBeenCalled();
    expect(controllers).toHaveLength(2);
  });

  it("сбой Worker'а — failed; та же версия не ретраится", async () => {
    const onError = vi.fn();
    const { prewarm, prepareRoom, controllers } = create({ onError });

    await prewarm.warm({ version: '1.0.0' });
    controllers[0].opts.onError({ message: 'no wasm' });

    expect(prewarm.state).toBe('failed');
    expect(controllers[0].destroy).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    await prewarm.warm({ version: '1.0.0' });

    expect(prepareRoom).toHaveBeenCalledTimes(1);
  });

  it('точка без room.game — ошибка, но не провал версии', async () => {
    const onError = vi.fn();
    const { prewarm } = create({
      onError,
      decode: async () => ({ meta: {}, core: null }),
    });

    await prewarm.warm({});

    expect(prewarm.state).toBe('idle');
    expect(onError).toHaveBeenCalled();
  });

  it('битая точка не гасит прогретый Worker и не блокирует версию', async () => {
    const onError = vi.fn();
    let broken = false;
    const { prewarm, prepareRoom, controllers } = create({
      onError,
      decode: async bytes => {
        if (broken) {
          throw new Error('checkpoint is corrupted');
        }

        return { meta: meta(bytes.version), core: null };
      },
    });

    await prewarm.warm({ version: '1.0.0' });
    controllers[0].opts.onPreloaded();

    broken = true;
    await prewarm.warm({ version: '1.0.0' });
    broken = false;
    await prewarm.warm({ version: '1.0.0' });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(prewarm.state).toBe('ready');
    expect(prewarm.controller).toBe(controllers[0]);
    expect(controllers[0].destroy).not.toHaveBeenCalled();
    expect(prepareRoom).toHaveBeenCalledTimes(1);
  });

  it('destroy гасит прогретый Worker', async () => {
    const { prewarm, controllers } = create();

    await prewarm.warm({ version: '1.0.0' });
    controllers[0].opts.onPreloaded();
    prewarm.destroy();

    expect(controllers[0].destroy).toHaveBeenCalled();
    expect(prewarm.controller).toBeNull();
  });

  it('take() отдаёт прогретый Worker — destroy() его больше не гасит', async () => {
    const { prewarm, controllers } = create();

    expect(prewarm.take()).toBeNull();

    await prewarm.warm({ version: '1.0.0' });
    controllers[0].opts.onPreloaded();

    const taken = prewarm.take();

    expect(taken.controller).toBe(controllers[0]);
    expect(taken.prepared.gameRef).toEqual({ id: 'tanks', version: '1.0.0' });

    prewarm.destroy();

    expect(controllers[0].destroy).not.toHaveBeenCalled();
    expect(prewarm.take()).toBeNull();
  });
});
