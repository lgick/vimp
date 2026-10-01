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

  // C10 говорит это статически, но контракт-чекер запускают не все:
  // нерезолвнутое имя означает поле, которое не проверяет никто
  it('нерезолвнутое имя валидатора в схеме — console.error при сборке машины', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    makeMachine(createGuestIdentity());
    expect(spy).not.toHaveBeenCalled();

    hostPlugin.authSchema = {
      ...hostPlugin.authSchema,
      params: [{ name: 'model', options: { validator: 'isValidMdoel' } }],
      validators: { isValidModel: () => true },
    };
    makeMachine(createGuestIdentity());

    expect(spy.mock.calls[0][0]).toMatch(/names validator "isValidMdoel"/);
    spy.mockRestore();
  });

  it('гостевой путь доводит клиента до участника матча', async () => {
    machine.connect('s1');

    expect(frame('sendConfig', 's1').args[0]).toEqual({ fake: 'clientCfg' });
    expect(machine.has('s1')).toBe(true);

    machine.message('s1', JSON.stringify([PC.CONFIG_READY, null]));

    const authData = frame('sendAuthData', 's1').args[0];

    // поле ника доезжает до формы клиента тем же каналом, что игровые поля,
    // и идёт первым: ник — первое, что заполняет игрок
    expect(authData.params.map(param => param.name)).toEqual(['name', 'model']);
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

  // адаптер dedicated закрывает по нему соединение, застрявшее в хендшейке
  it('hasParticipant отличает соединение в хендшейке от участника', async () => {
    machine.connect('s1');

    expect(machine.has('s1')).toBe(true);
    expect(machine.hasParticipant('s1')).toBe(false);

    machine.message('s1', JSON.stringify([PC.CONFIG_READY, null]));

    expect(machine.hasParticipant('s1')).toBe(false);

    machine.message(
      's1',
      JSON.stringify([PC.AUTH_RESPONSE, { name: 'Guest', model: 'm1' }]),
    );

    await settle();

    expect(machine.hasParticipant('s1')).toBe(true);
    // неизвестное соединение участником не считается
    expect(machine.hasParticipant('s2')).toBe(false);
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
    machine.message('s1', JSON.stringify([PC.AUTH_RESPONSE, { model: 'm1' }]));

    machine.disconnect('s1');
    release();

    await settle();

    expect(inspectHost(host).humans).toHaveLength(0);
    expect(frame('sendAuthResult', 's1')).toBeUndefined();
  });

  describe('возобновление сессии (host-migration этап 4)', () => {
    const GRACE = 20000;

    // лобби-стратегия в миниатюре: ник — по токену, чужой токен — отказ
    const tokenIdentity = {
      params: [],
      errorField: 'token',
      resolve: async data => {
        const nick = { 'tok-alice': 'Alice', 'tok-bob': 'Bob' }[data.token];

        if (!nick) {
          throw new Error('invalid token');
        }

        return nick;
      },
    };

    const send = (socketId, port, data = null) =>
      machine.message(socketId, JSON.stringify([port, data]));

    // вход до игрового состояния: хендшейк + карта + первый кадр
    const enterGame = async (socketId = 's1', token = 'tok-alice') => {
      machine.connect(socketId);
      send(socketId, PC.CONFIG_READY);
      send(socketId, PC.AUTH_RESPONSE, { token, model: 'm1' });
      await settle();
      send(socketId, PC.MODULES_READY);
      send(socketId, PC.MAP_READY);
      send(socketId, PC.FIRST_SHOT_READY);

      return host._participants.getHumans().find(p => p.token === token);
    };

    const lastFrame = (method, socketId) =>
      socket
        .framesOf(method)
        .filter(item => item.socketId === socketId)
        .at(-1);

    const resumeRequest = (user, overrides = {}) => ({
      v: 1,
      gameId: user.gameId,
      resumeKey: user.resumeKey,
      token: 'tok-alice',
      ...overrides,
    });

    beforeEach(() => {
      machine = makeMachine(tokenIdentity, { resumeGraceMs: GRACE });
    });

    it('после FIRST_SHOT_READY участник получает секрет места', async () => {
      const user = await enterGame();
      const session = frame('sendSessionData', 's1');

      expect(session.args[0].resumeKey).toMatch(/^[0-9a-f]{32}$/);
      expect(session.args[0].resumeKey).toBe(user.resumeKey);
      expect(session.args[0].gameId).toBe(user.gameId);

      // повторный FIRST_SHOT_READY (смена карты) ключ не перевыдаёт
      send('s1', PC.FIRST_SHOT_READY);
      expect(socket.framesOf('sendSessionData')).toHaveLength(1);
    });

    it('без resumeGraceMs секрет не выдаётся и обрыв снимает сразу', async () => {
      machine = makeMachine(tokenIdentity);
      await enterGame();

      expect(frame('sendSessionData', 's1')).toBeUndefined();

      machine.disconnect('s1');
      expect(inspectHost(host).humans).toHaveLength(0);
    });

    it('обрыв в игре держит место resumeGraceMs, затем снимает', async () => {
      const user = await enterGame();

      machine.disconnect('s1');

      expect(machine.has('s1')).toBe(false);
      expect(inspectHost(host).humans).toHaveLength(1);
      expect(host.isDetached(user.gameId)).toBe(true);

      vi.advanceTimersByTime(GRACE - 1);
      expect(inspectHost(host).humans).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(inspectHost(host).humans).toHaveLength(0);
    });

    it('обрыв до входа в матч снимает участника сразу', async () => {
      machine.connect('s1');
      send('s1', PC.CONFIG_READY);
      send('s1', PC.AUTH_RESPONSE, { token: 'tok-alice', model: 'm1' });
      await settle();

      machine.disconnect('s1');
      expect(inspectHost(host).humans).toHaveLength(0);
    });

    it('LEAVE снимает участника сразу и закрывает соединение', async () => {
      await enterGame();

      send('s1', PC.LEAVE);

      expect(machine.has('s1')).toBe(false);
      expect(inspectHost(host).humans).toHaveLength(0);
      expect(frame('close', 's1')).toBeDefined();
    });

    it('resume-соединение не начинает хендшейк и закрывается по таймауту', async () => {
      machine.connect('s2', { resume: true });

      expect(frame('sendConfig', 's2')).toBeUndefined();

      // хендшейковые порты закрыты
      send('s2', PC.CONFIG_READY);
      expect(frame('sendAuthData', 's2')).toBeUndefined();

      vi.advanceTimersByTime(5000);

      expect(machine.has('s2')).toBe(false);
      expect(frame('close', 's2').args[0]).toBe(4008);
    });

    it('без resumeGraceMs resume-флаг игнорируется: обычный хендшейк', () => {
      machine = makeMachine(tokenIdentity);
      machine.connect('s2', { resume: true });

      expect(frame('sendConfig', 's2')).toBeDefined();
    });

    it('успешный RESUME_REQUEST возвращает место и шлёт пакет входа', async () => {
      // ожидание короче интервала пингов: проверка «место не пропадёт» ниже
      // не должна упереться в RTT-кик молчащего в тесте клиента
      machine = makeMachine(tokenIdentity, { resumeGraceMs: 1000 });

      const user = await enterGame();
      const oldKey = user.resumeKey;

      machine.disconnect('s1');
      socket.clearFrames();

      machine.connect('s2', { resume: true });
      send('s2', PC.RESUME_REQUEST, resumeRequest(user));
      await settle();

      expect(frame('sendResumeResult', 's2').args[0]).toEqual({
        ok: true,
        gameId: user.gameId,
        epoch: null,
      });
      expect(frame('sendClear', 's2')).toBeDefined();
      expect(frame('sendFirstShot', 's2')).toBeDefined();
      expect(frame('sendStat', 's2')).toBeDefined();
      expect(frame('sendKeySet', 's2')).toBeDefined();

      // новый секрет — последним сообщением пакета
      const session = lastFrame('sendSessionData', 's2');

      expect(session.args[0].resumeKey).not.toBe(oldKey);
      expect(socket.frames.at(-1).method).toBe('sendSessionData');

      expect(host.isDetached(user.gameId)).toBe(false);
      expect(user.socketId).toBe('s2');
      expect(machine.hasParticipant('s2')).toBe(true);

      // ожидание возврата снято — место не пропадёт
      vi.advanceTimersByTime(2000);
      expect(inspectHost(host).humans).toHaveLength(1);

      // игровые порты нового соединения открыты
      const pushMessage = vi.spyOn(host, 'pushMessage');

      send('s2', PC.CHAT_DATA, 'back');
      expect(pushMessage).toHaveBeenCalledWith(user.gameId, 'back');
    });

    it('RESUME_RESULT несёт эпоху комнаты', async () => {
      host.setRoom({ roomId: 'r1', roomSecret: 'sec', epoch: 3 });

      const user = await enterGame();

      machine.disconnect('s1');
      machine.connect('s2', { resume: true });
      send('s2', PC.RESUME_REQUEST, resumeRequest(user));
      await settle();

      expect(frame('sendResumeResult', 's2').args[0].epoch).toBe(3);
    });

    it.each([
      ['version', user => resumeRequest(user, { v: 2 })],
      ['unknown', user => resumeRequest(user, { resumeKey: 'f'.repeat(32) })],
      ['unknown', user => resumeRequest(user, { gameId: user.gameId + 100 })],
      ['auth', user => resumeRequest(user, { token: 'tok-bob' })],
      ['auth', user => resumeRequest(user, { token: 'forged' })],
    ])(
      'отказ %s закрывает соединение, место ждёт дальше',
      async (reason, build) => {
        const user = await enterGame();

        machine.disconnect('s1');
        machine.connect('s2', { resume: true });
        send('s2', PC.RESUME_REQUEST, build(user));
        await settle();

        expect(frame('sendResumeResult', 's2').args[0]).toEqual({
          ok: false,
          reason,
        });
        expect(frame('close', 's2')).toBeDefined();
        expect(machine.has('s2')).toBe(false);
        expect(host.isDetached(user.gameId)).toBe(true);
      },
    );

    it('попытка одна на соединение', async () => {
      const user = await enterGame();

      machine.disconnect('s1');
      machine.connect('s2', { resume: true });
      send('s2', PC.RESUME_REQUEST, resumeRequest(user, { v: 0 }));
      send('s2', PC.RESUME_REQUEST, resumeRequest(user));
      await settle();

      expect(socket.framesOf('sendResumeResult')).toHaveLength(1);
    });

    it('перехват полуоткрытой сессии закрывает прежнее соединение', async () => {
      const user = await enterGame();

      // хост обрыва не заметил: s1 жив, а клиент уже пришёл с s2
      machine.connect('s2', { resume: true });
      send('s2', PC.RESUME_REQUEST, resumeRequest(user));
      await settle();

      expect(frame('sendResumeResult', 's2').args[0].ok).toBe(true);
      expect(frame('close', 's1')).toBeDefined();
      expect(machine.has('s1')).toBe(false);
      expect(user.socketId).toBe('s2');

      // поздний disconnect прежнего соединения участника не трогает
      machine.disconnect('s1');
      expect(inspectHost(host).humans).toHaveLength(1);
      expect(host.isDetached(user.gameId)).toBe(false);
    });

    it('место истекло, пока проверялась личность — unknown', async () => {
      let release;

      machine = makeMachine(
        {
          ...tokenIdentity,
          resolve: data =>
            data.v === 1
              ? new Promise(resolve => {
                  release = () => resolve('Alice');
                })
              : tokenIdentity.resolve(data),
        },
        { resumeGraceMs: GRACE },
      );

      const user = await enterGame();

      machine.disconnect('s1');
      machine.connect('s2', { resume: true });
      send('s2', PC.RESUME_REQUEST, resumeRequest(user));

      host.removeUser(user.gameId);
      release();
      await settle();

      expect(frame('sendResumeResult', 's2').args[0]).toEqual({
        ok: false,
        reason: 'unknown',
      });
    });
  });
});

describe('PortMachine.startGraceFor (host-migration этап 7.4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // люди, поднятые из точки отсоединёнными: таймера обрыва у них не было
  const makeWithHost = (resumeGraceMs, detached) => {
    const fakeHost = {
      isDetached: vi.fn(gameId => detached.has(gameId)),
      removeUser: vi.fn(gameId => detached.delete(gameId)),
    };
    const machine = new PortMachine({
      host: fakeHost,
      socketManager: {},
      clientCfg: {},
      authSchema: { params: [] },
      makeSocket: () => ({}),
      identity: { params: [] },
      resumeGraceMs,
    });

    return { machine, fakeHost };
  };

  it('не вернувшийся снимается по истечении resumeGraceMs', () => {
    vi.useFakeTimers();

    const detached = new Set([3, 4]);
    const { machine, fakeHost } = makeWithHost(1000, detached);

    machine.startGraceFor([3, 4, 5]);
    detached.delete(4); // вернулся, пока шло ожидание

    vi.advanceTimersByTime(999);
    expect(fakeHost.removeUser).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fakeHost.removeUser).toHaveBeenCalledTimes(1);
    expect(fakeHost.removeUser).toHaveBeenCalledWith(3);
  });

  it('без resumeGraceMs — снимаются сразу', () => {
    const { machine, fakeHost } = makeWithHost(0, new Set([3]));

    machine.startGraceFor([3]);

    expect(fakeHost.removeUser).toHaveBeenCalledWith(3);
  });
});
