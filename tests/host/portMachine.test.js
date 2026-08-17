import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import PortMachine from '../../packages/engine/src/host/PortMachine.js';
import { createGuestIdentity } from '../../packages/engine/src/host/identity.js';
import { inspectHost } from '../../packages/engine/src/devtools/inspectHost.js';
import wsports from '../../packages/engine/src/config/wsports.js';
import { createFixtureHost, flushMicro } from './fixtureHarness.js';

// Порт-машина хоста (Этап 1 плана standalone-sdk): изоморфный автомат
// хендшейка, вынутый из host.worker.js. Тесты гоняют его поверх фикстурной
// миниигры — ни Worker'а, ни сети, ни кода игры сверх её authSchema.

const PC = wsports.client;

// resolve стратегии идентичности и queueMicrotask из createUser — обе
// микрозадачи, порядок между ними для теста не важен
const settle = async () => {
  for (let i = 0; i < 5; i += 1) {
    await flushMicro();
  }
};

describe('PortMachine', () => {
  let host;
  let socket;
  let hostPlugin;
  let machine;
  let closed;

  const makeMachine = (identity, deps = {}) =>
    new PortMachine({
      host,
      socketManager: socket,
      clientCfg: { fake: 'clientCfg' },
      authSchema: hostPlugin.authSchema,
      makeSocket: socketId => ({
        send: () => {},
        sendBinary: () => {},
        close: (code, data) => closed.push({ socketId, code, data }),
      }),
      identity,
      ...deps,
    });

  // полный гостевой хендшейк до созданного участника
  const handshake = async (socketId, data = { name: 'Guest', model: 'm1' }) => {
    machine.connect(socketId);
    machine.message(socketId, JSON.stringify([PC.CONFIG_READY, null]));
    machine.message(socketId, JSON.stringify([PC.AUTH_RESPONSE, data]));

    await settle();
  };

  const frame = (method, socketId) =>
    socket.framesOf(method).find(item => item.socketId === socketId);

  beforeEach(async () => {
    closed = [];
    ({ host, socket, hostPlugin } = await createFixtureHost());
    machine = makeMachine(createGuestIdentity());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('гостевой путь доводит клиента до участника матча', async () => {
    machine.connect('s1');

    expect(frame('sendConfig', 's1').args[0]).toEqual({ fake: 'clientCfg' });
    expect(machine.has('s1')).toBe(true);

    machine.message('s1', JSON.stringify([PC.CONFIG_READY, null]));

    const authData = frame('sendAuthData', 's1').args[0];

    // поле ника доезжает до формы клиента тем же каналом, что игровые поля
    expect(authData.params.map(param => param.name)).toEqual(['model', 'name']);
    expect(authData.elems).toBe(hostPlugin.authSchema.elems);
    expect(authData.texts).toBe(hostPlugin.authSchema.texts);

    machine.message(
      's1',
      JSON.stringify([PC.AUTH_RESPONSE, { name: 'Guest', model: 'm1' }]),
    );

    await settle();

    expect(inspectHost(host).humans).toHaveLength(1);
    expect(frame('sendAuthResult', 's1').args[0]).toBeUndefined();
    expect(frame('sendTechInform', 's1').args[0]).toBe('loading');
  });

  it('невалидный ник отбивается валидацией схемы, участник не создан', async () => {
    await handshake('s1', { name: '#!', model: 'm1' });

    expect(frame('sendAuthResult', 's1').args[0]).toEqual([
      { name: 'name', error: 'not valid' },
    ]);
    expect(inspectHost(host).humans).toHaveLength(0);
  });

  it('гостевая стратегия даёт участнику ник-заглушку, если ник не дошёл', async () => {
    // authSchema без поля ника: валидация схемы гостевой ник не увидит, и
    // единственная защита от безымянного участника — fallback стратегии
    machine = makeMachine({
      params: [],
      errorField: 'name',
      resolve: createGuestIdentity().resolve,
    });

    await handshake('sock-abcdef', { model: 'm1' });

    expect(inspectHost(host).humans).toHaveLength(1);
    expect(host._participants.getHumans()[0].name).toBe('Player_sock');
  });

  it('отказ стратегии идентичности отбивает вход', async () => {
    machine = makeMachine({
      params: [],
      errorField: 'token',
      resolve: async () => {
        throw new Error('invalid token');
      },
    });

    await handshake('s1', { model: 'm1' });

    expect(frame('sendAuthResult', 's1').args[0]).toEqual([
      { name: 'token', error: 'invalid' },
    ]);
    expect(inspectHost(host).humans).toHaveLength(0);
  });

  it('сообщение на выключенном порту игнорируется', async () => {
    machine.connect('s1');

    // AUTH_RESPONSE открывается только после CONFIG_READY
    machine.message(
      's1',
      JSON.stringify([PC.AUTH_RESPONSE, { name: 'Guest', model: 'm1' }]),
    );

    await settle();

    expect(frame('sendAuthData', 's1')).toBeUndefined();
    expect(inspectHost(host).humans).toHaveLength(0);
  });

  it('заполненная комната отказывает без порт-машины', async () => {
    ({ host, socket, hostPlugin } = await createFixtureHost({
      game: { maxPlayers: 1 },
    }));
    machine = makeMachine(createGuestIdentity());

    await handshake('s1');

    expect(inspectHost(host).humans).toHaveLength(1);

    machine.connect('s2');

    expect(machine.has('s2')).toBe(false);
    expect(frame('close', 's2').args).toEqual([4006, 'roomFull', [1]]);
    expect(frame('sendConfig', 's2')).toBeUndefined();
  });

  it('disconnect снимает участника и чистит SocketManager', async () => {
    const removeUser = vi.spyOn(socket, 'removeUser');

    await handshake('s1');
    expect(inspectHost(host).humans).toHaveLength(1);

    machine.disconnect('s1');

    expect(machine.has('s1')).toBe(false);
    expect(removeUser).toHaveBeenCalledWith('s1');
    expect(inspectHost(host).humans).toHaveLength(0);
    expect([...machine.socketIds]).toEqual([]);
  });

  it('restore поднимает порт-машину сразу в игровом состоянии', async () => {
    await handshake('s1');

    const gameId = host._participants.getHumans()[0].gameId;

    // новый Worker эстафеты: участник уже восстановлен в HostGame, порт-машина
    // поднимается поверх него без повторного хендшейка
    machine = makeMachine(createGuestIdentity());
    socket.clearFrames();
    machine.restore('s2', gameId);

    expect(frame('sendConfig', 's2')).toBeUndefined();
    expect([...machine.socketIds]).toEqual(['s2']);

    // игровые порты открыты сразу, хендшейковые — закрыты
    const pushMessage = vi.spyOn(host, 'pushMessage');

    machine.message('s2', JSON.stringify([PC.CHAT_DATA, 'hi']));
    machine.message('s2', JSON.stringify([PC.CONFIG_READY, null]));

    expect(pushMessage).toHaveBeenCalledWith(gameId, 'hi');
    expect(frame('sendAuthData', 's2')).toBeUndefined();
  });

  it('битый wire-кадр не роняет автомат', () => {
    machine.connect('s1');

    expect(() => machine.message('s1', 'not json')).not.toThrow();
    expect(() => machine.message('unknown', '[0,null]')).not.toThrow();
  });

  it('не отвечает на порт, если клиент отключился во время resolve', async () => {
    let release;

    machine = makeMachine({
      params: [],
      errorField: 'name',
      resolve: () =>
        new Promise(resolve => {
          release = () => resolve('Guest');
        }),
    });

    machine.connect('s1');
    machine.message('s1', JSON.stringify([PC.CONFIG_READY, null]));
    machine.message(
      's1',
      JSON.stringify([PC.AUTH_RESPONSE, { model: 'm1' }]),
    );

    machine.disconnect('s1');
    release();

    await settle();

    expect(inspectHost(host).humans).toHaveLength(0);
    expect(frame('sendAuthResult', 's1')).toBeUndefined();
  });

});
