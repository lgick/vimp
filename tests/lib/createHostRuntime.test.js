import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHostRuntime } from '../../packages/engine/src/lib/createHostRuntime.js';
import RecordingSocketManager from '../../packages/engine/src/devtools/RecordingSocketManager.js';
import { resetHostSingletons } from '../../packages/engine/src/devtools/resetHostSingletons.js';
import clock from '../../packages/engine/src/lib/clock.js';
import hostPlugin from '../../packages/engine/tests/fixtures/miniGame/host/index.js';

const build = (room = {}, options = {}) =>
  createHostRuntime(
    { game: {}, ...room },
    {
      loadHostPlugin: () => hostPlugin,
      createSocketManager: () => new RecordingSocketManager(),
      ...options,
    },
  );

describe('createHostRuntime', () => {
  beforeEach(() => {
    resetHostSingletons();
    clock.reset();
  });

  it('собирает плагин, ядро, транспорт и HostGame', async () => {
    const runtime = await build();

    expect(runtime.hostPlugin).toBe(hostPlugin);
    expect(runtime.host).toBeTruthy();
    expect(runtime.host.currentMap).toBe('arena');
    expect(runtime.socketManager).toBeInstanceOf(RecordingSocketManager);
    expect(runtime.clientCfg.snapshot).toEqual(hostPlugin.gameConfig.snapshot);
  });

  it('room.seed используется как есть — прогон воспроизводим', async () => {
    const runtime = await build({ seed: 123456 });

    expect(runtime.seed).toBe(123456);
    expect(runtime.core._config.engine.seed).toBe(123456);
  });

  it('без room.seed seed берётся из clock.random()', async () => {
    clock.install({ random: () => 0.5 });

    const runtime = await build();

    expect(runtime.seed).toBe(2 ** 31);
  });

  it('переопределения комнаты применяются к конфигу игры', async () => {
    const runtime = await build({ maxPlayers: 2, friendlyFire: true });

    expect(runtime.game.maxPlayers).toBe(2);
    expect(runtime.game.parts.friendlyFire).toBe(true);
  });

  it('overrideGameConfig правит конфиг до создания ядра', async () => {
    const runtime = await build(
      {},
      {
        overrideGameConfig: game => {
          game.timers.networkSendRate = 1;
        },
      },
    );

    expect(runtime.game.timers.networkSendRate).toBe(1);
  });

  it('несовместимый плагин отклоняется до создания ядра', async () => {
    const broken = { ...hostPlugin, gameConfig: {} };
    const createCore = vi.fn();

    await expect(
      build({}, { loadHostPlugin: () => ({ ...broken, createCore }) }),
    ).rejects.toThrow();

    expect(createCore).not.toHaveBeenCalled();
  });

  it('room.hostId сразу включает атрибуцию rank/state', async () => {
    const runtime = await build({ hostId: 'h1', hostSecret: 's1' });

    expect(runtime.host._playerDataSync._hostId).toBe('h1');
  });
});
