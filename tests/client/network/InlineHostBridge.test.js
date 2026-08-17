import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import InlineHostBridge from '../../../packages/engine/src/client/network/InlineHostBridge.js';
import LoopbackTransport from '../../../packages/engine/src/client/network/LoopbackTransport.js';
import hostPlugin from '../../../packages/engine/tests/fixtures/miniGame/host/index.js';
import { resetHostSingletons } from '../../../packages/engine/src/devtools/resetHostSingletons.js';
import wsports from '../../../packages/engine/src/config/wsports.js';

// Solo-режим (Этап 2 плана standalone-sdk): авторитетный хост в главном
// потоке вместо Worker'а. Фикстурная миниигра — ни WASM, ни кода игры сверх
// её authSchema; проверяем, что хендшейк идёт тем же порт-автоматом.

const PS = wsports.server;
const PC = wsports.client;

const port = frame => JSON.parse(frame)[0];

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise(resolve => queueMicrotask(resolve));
  }
};

const makeBridge = () =>
  new InlineHostBridge(
    { name: 'solo', hostSocketId: 'local', game: { version: '0.0.0' } },
    { hostPlugin },
  );

describe('InlineHostBridge', () => {
  let bridge;

  beforeEach(() => {
    // мета-модули хоста синглтонны: без сброса второй тест унаследовал бы
    // таймеры первого
    resetHostSingletons();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await bridge?.destroy();
    vi.useRealTimers();
  });

  it('поднимает хост и ведёт хендшейк: CONFIG_DATA → AUTH_DATA', async () => {
    const received = [];

    bridge = makeBridge();
    await bridge.ready;

    bridge.open('local', {
      onMessage: data => received.push(data),
      onClose: () => {},
    });

    expect(received).toHaveLength(1);
    expect(port(received[0])).toBe(PS.CONFIG_DATA);

    bridge.send('local', JSON.stringify([PC.CONFIG_READY, null]));

    expect(port(received[1])).toBe(PS.AUTH_DATA);

    // гостевая идентичность доклеивает поле ника к схеме игры
    const authData = JSON.parse(received[1])[1];

    expect(authData.params.some(param => param.name === 'name')).toBe(true);
  });

  it('гостевой вход доводит участника до карты и первого кадра', async () => {
    const received = [];

    bridge = makeBridge();
    await bridge.ready;

    bridge.open('local', {
      onMessage: data => received.push(data),
      onClose: () => {},
    });

    bridge.send('local', JSON.stringify([PC.CONFIG_READY, null]));
    bridge.send(
      'local',
      JSON.stringify([PC.AUTH_RESPONSE, { name: 'Guest', model: 'm1' }]),
    );

    await flush();

    expect(received.map(port)).toContain(PS.AUTH_RESULT);

    bridge.send('local', JSON.stringify([PC.MODULES_READY, null]));

    expect(received.map(port)).toContain(PS.MAP_DATA);

    bridge.send('local', JSON.stringify([PC.MAP_READY, null]));

    expect(received.map(port)).toContain(PS.FIRST_SHOT_DATA);
  });

  it('работает как контроллер LoopbackTransport', async () => {
    const message = vi.fn();

    bridge = makeBridge();
    await bridge.ready;

    const transport = new LoopbackTransport(bridge, 'local');

    transport.publisher.on('message', message);
    transport.publisher.on('close', () => {});
    transport.connect();

    expect(port(message.mock.calls[0][0])).toBe(PS.CONFIG_DATA);

    transport.send(JSON.stringify([PC.CONFIG_READY, null]));

    expect(port(message.mock.calls[1][0])).toBe(PS.AUTH_DATA);

    transport.close();

    // после close мост не должен держать соединение
    expect(bridge._clients.size).toBe(0);
  });
});
