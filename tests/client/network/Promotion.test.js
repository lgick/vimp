import { describe, it, expect, vi } from 'vitest';
import Promotion, {
  PROMOTION_STORAGE_KEY,
  savePendingPromotion,
  takePendingPromotion,
} from '../../../packages/engine/src/client/network/Promotion.js';

// Промоушен преемника (host-migration этап 7.4): режим checkpoint поднимает
// матч из последней точки беты — в прогретом Worker'е той же версии игры или
// в новом; режим cold — отложенный промоушен в sessionStorage. Worker,
// точка и подготовка комнаты — фейки.

const TOKEN = 'ab'.repeat(16);

const PROMOTE = {
  type: 'promote',
  roomId: 'r1',
  epoch: 3,
  promotionToken: TOKEN,
  mode: 'checkpoint',
  reason: 'disconnected',
};

const meta = (version = '1.0.0') => ({
  room: {
    settings: { map: 'arena', maxPlayers: 8 },
    game: { id: 'tanks', version },
  },
});

const makeReceiver = (latest = { bytes: new Uint8Array([1, 2]), seq: 50 }) => ({
  latest: () => latest,
  lastSeenSeq: 60,
});

const makeController = () => ({
  initFromCheckpoint: vi.fn(),
  destroy: vi.fn(),
});

const create = (overrides = {}) => {
  const created = [];
  const hooks = { onReady: vi.fn(), onFailed: vi.fn() };
  const prepareRoom = vi.fn(async settings => ({
    room: { ...settings, game: { id: 'tanks', version: '1.0.0' } },
    workerUrl: '/worker.js',
    mapsVersion: 'm1',
    codeVersion: null,
  }));
  const promotion = new Promotion({
    promote: PROMOTE,
    receiver: makeReceiver(),
    prepareRoom,
    hostSocketId: 'local',
    decode: async () => ({ meta: meta(), core: null }),
    createController: (room, opts) => {
      const controller = { ...makeController(), room, opts };

      created.push(controller);

      return controller;
    },
    ...hooks,
    ...overrides,
  });

  return { promotion, prepareRoom, created, hooks };
};

describe('Promotion: режим checkpoint', () => {
  it('без прогрева — новый Worker с точкой, seqFloor и комнатой эпохи', async () => {
    const { promotion, prepareRoom, created, hooks } = create();

    await promotion.start();

    expect(prepareRoom).toHaveBeenCalledWith(
      { map: 'arena', maxPlayers: 8 },
      { id: 'tanks', version: '1.0.0' },
    );
    expect(created).toHaveLength(1);
    expect(created[0].room).toMatchObject({
      map: 'arena',
      hostSocketId: 'local',
      roomId: 'r1',
      epoch: 3,
    });
    expect(created[0].opts).toMatchObject({
      workerUrl: '/worker.js',
      seqFloor: 60,
    });
    expect(created[0].opts.checkpoint).toEqual(new Uint8Array([1, 2]));

    created[0].opts.onReady({ lobbyInfo: 'arena' });

    expect(promotion.state).toBe('ready');
    expect(hooks.onReady).toHaveBeenCalledWith(
      expect.objectContaining({
        controller: created[0],
        lobbyInfo: 'arena',
      }),
    );
  });

  it('прогретый Worker той же версии — матч поднимается в нём', async () => {
    const warm = makeController();
    const prewarm = {
      take: () => ({
        controller: warm,
        prepared: {
          room: { game: { id: 'tanks', version: '1.0.0' } },
          gameRef: { id: 'tanks', version: '1.0.0' },
        },
      }),
    };
    const { promotion, prepareRoom, created } = create({ prewarm });

    await promotion.start();

    expect(prepareRoom).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(warm.initFromCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'r1', epoch: 3 }),
      new Uint8Array([1, 2]),
      expect.objectContaining({ seqFloor: 60 }),
    );
  });

  it('прогрев другой версии гасится, комната готовится заново', async () => {
    const warm = makeController();
    const prewarm = {
      take: () => ({
        controller: warm,
        prepared: { room: {}, gameRef: { id: 'tanks', version: '0.9.0' } },
      }),
    };
    const { promotion, prepareRoom, created } = create({ prewarm });

    await promotion.start();

    expect(warm.destroy).toHaveBeenCalled();
    expect(prepareRoom).toHaveBeenCalled();
    expect(created).toHaveLength(1);
  });

  it('точки нет — сбой без Worker’а', async () => {
    const { promotion, created, hooks } = create({
      receiver: makeReceiver(null),
    });

    await promotion.start();

    expect(created).toHaveLength(0);
    expect(promotion.state).toBe('failed');
    expect(hooks.onFailed).toHaveBeenCalledWith(expect.any(Error));
  });

  it('точка старше maxRestoreAgeMs — сбой без Worker’а (ревью F8)', async () => {
    const { promotion, created, prepareRoom, hooks } = create({
      receiver: makeReceiver({
        bytes: new Uint8Array([1, 2]),
        seq: 50,
        receivedAt: 1000,
      }),
      maxRestoreAgeMs: 15000,
      now: () => 16001,
    });

    await promotion.start();

    expect(created).toHaveLength(0);
    expect(prepareRoom).not.toHaveBeenCalled();
    expect(promotion.state).toBe('failed');
    expect(hooks.onFailed).toHaveBeenCalledWith(expect.any(Error));
  });

  it('точка ровно maxRestoreAgeMs — промоушен идёт', async () => {
    const { promotion, created, hooks } = create({
      receiver: makeReceiver({
        bytes: new Uint8Array([1, 2]),
        seq: 50,
        receivedAt: 1000,
      }),
      maxRestoreAgeMs: 15000,
      now: () => 16000,
    });

    await promotion.start();
    created[0].opts.onReady?.();

    expect(created).toHaveLength(1);
    expect(hooks.onFailed).not.toHaveBeenCalled();
  });

  it('без секрета места своего игрока — отказ до подготовки комнаты', async () => {
    const { promotion, prepareRoom, created, hooks } = create({
      hasSession: () => false,
    });

    await promotion.start();

    expect(prepareRoom).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(promotion.state).toBe('failed');
    expect(hooks.onFailed).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/session/) }),
    );
  });

  it('сбой init Worker’а — сбой промоушена, Worker погашен', async () => {
    const { promotion, created, hooks } = create();

    await promotion.start();
    created[0].opts.onError({ message: 'wasm failed' });

    expect(created[0].destroy).toHaveBeenCalled();
    expect(hooks.onFailed).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'wasm failed' }),
    );
  });

  it('отмена гасит Worker, опоздавший ready игнорируется', async () => {
    const { promotion, created, hooks } = create();

    await promotion.start();
    promotion.cancel();
    created[0].opts.onReady({});

    expect(created[0].destroy).toHaveBeenCalled();
    expect(promotion.state).toBe('cancelled');
    expect(hooks.onReady).not.toHaveBeenCalled();
  });

  it('promotion — поля для register_host и promote_failed', () => {
    const { promotion } = create();

    expect(promotion.promotion).toEqual({
      roomId: 'r1',
      epoch: 3,
      promotionToken: TOKEN,
    });
  });
});

describe('Promotion: точка — недоверенные данные (ревью F1)', () => {
  const EVIL_SETTINGS = {
    map: 'm2',
    isDevMode: true,
    game: { id: 'evil', hostEntryUrl: 'https://evil.test/x.js' },
    maps: { evil: {} },
    seed: 7,
  };
  const OWN_GAME = { id: 'tanks', version: '1.0.0', hostEntryUrl: '/own.js' };
  const OWN_MAPS = { arena: {} };

  const evilDecode = async () => ({
    meta: {
      room: {
        settings: EVIL_SETTINGS,
        game: { id: 'tanks', version: '1.0.0' },
      },
    },
    core: null,
  });

  // как prepareHostRoom в main.js: мутирует аргумент и кладёт своё
  const ownPrepareRoom = () =>
    vi.fn(async settings => {
      settings.isDevMode = false;
      settings.game = OWN_GAME;
      settings.maps = OWN_MAPS;

      return { room: settings, workerUrl: '/worker.js', mapsVersion: 'm1' };
    });

  const expectOwnRoom = room => {
    expect(room.map).toBe('m2');
    expect(room.isDevMode).toBe(false);
    expect(room.game).toBe(OWN_GAME);
    expect(room.maps).toBe(OWN_MAPS);
    expect(room).not.toHaveProperty('seed');
  };

  it('холодный путь: в prepareRoom и Worker идут только известные настройки', async () => {
    const prepareRoom = ownPrepareRoom();
    const { promotion, created } = create({ decode: evilDecode, prepareRoom });

    await promotion.start();

    expect(created).toHaveLength(1);
    expectOwnRoom(created[0].room);
  });

  it('холодный путь: prepareRoom получает { map } без чужих ключей', async () => {
    let received = null;
    const prepareRoom = vi.fn(async settings => {
      received = { ...settings };

      return { room: { ...settings, game: OWN_GAME }, workerUrl: null };
    });
    const { promotion } = create({ decode: evilDecode, prepareRoom });

    await promotion.start();

    expect(received).toEqual({ map: 'm2' });
  });

  it('прогретый путь: точка не перекрывает игру, карты и dev-режим', async () => {
    const warm = makeController();
    const prewarm = {
      take: () => ({
        controller: warm,
        prepared: {
          room: { isDevMode: false, game: OWN_GAME, maps: OWN_MAPS },
          gameRef: { id: 'tanks', version: '1.0.0' },
        },
      }),
    };
    const { promotion } = create({ decode: evilDecode, prewarm });

    await promotion.start();

    expectOwnRoom(warm.initFromCheckpoint.mock.calls[0][0]);
  });

  it('версия игры, не подтверждённая мастером, — отказ без Worker’а', async () => {
    const { promotion, created, hooks } = create({
      promote: { ...PROMOTE, game: { id: 'tanks', versions: ['1.0.0'] } },
      decode: async () => ({ meta: meta('9.9.9'), core: null }),
    });

    await promotion.start();

    expect(created).toHaveLength(0);
    expect(promotion.state).toBe('failed');
    expect(hooks.onFailed).toHaveBeenCalledWith(expect.any(Error));
  });

  it('чужая игра — отказ без Worker’а', async () => {
    const { promotion, created, hooks } = create({
      promote: { ...PROMOTE, game: { id: 'snakes', versions: ['1.0.0'] } },
    });

    await promotion.start();

    expect(created).toHaveLength(0);
    expect(hooks.onFailed).toHaveBeenCalledWith(expect.any(Error));
  });

  it('подтверждённая версия — промоушен идёт', async () => {
    const { promotion, created } = create({
      promote: {
        ...PROMOTE,
        game: { id: 'tanks', versions: ['0.9.0', '1.0.0'] },
      },
    });

    await promotion.start();

    expect(created).toHaveLength(1);
  });

  it('мастер без поля game — проверка пропускается', async () => {
    const { promotion, created } = create({
      decode: async () => ({ meta: meta('9.9.9'), core: null }),
    });

    await promotion.start();

    expect(created).toHaveLength(1);
  });
});

describe('Promotion: режим planned (плановая передача, этап 8)', () => {
  const PLANNED = { ...PROMOTE, mode: 'planned', reason: 'handover' };
  const FINAL = { bytes: new Uint8Array([9]), seq: 70, final: true };
  const PERIODIC = { bytes: new Uint8Array([1]), seq: 50, final: false };

  // приёмник, чья финальная точка приходит, когда тест решит
  const makeWaitingReceiver = () => {
    let latest = PERIODIC;
    let settle = null;
    const receiver = {
      latest: () => latest,
      lastSeenSeq: 60,
      waitForFinal: vi.fn(
        () =>
          new Promise((resolve, reject) => {
            settle = { resolve, reject };
          }),
      ),
      deliverFinal() {
        latest = FINAL;
        settle.resolve(FINAL);
      },
      timeOut() {
        settle.reject(new Error('final checkpoint timed out'));
      },
    };

    return receiver;
  };

  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  it('ждёт финальную точку и поднимает матч из неё', async () => {
    const receiver = makeWaitingReceiver();
    const { promotion, created } = create({
      promote: PLANNED,
      receiver,
      finalWaitMs: 1234,
    });
    const started = promotion.start();

    await flush();
    expect(receiver.waitForFinal).toHaveBeenCalledWith(0, 1234);
    expect(created).toHaveLength(0);

    receiver.deliverFinal();
    await started;

    expect(created).toHaveLength(1);
    expect(created[0].opts.checkpoint).toEqual(new Uint8Array([9]));
    expect(created[0].opts.seqFloor).toBe(70);
  });

  it('не дождалась — берёт последнюю периодическую', async () => {
    const receiver = makeWaitingReceiver();
    const { promotion, created } = create({ promote: PLANNED, receiver });
    const started = promotion.start();

    await flush();
    receiver.timeOut();
    await started;

    expect(created[0].opts.checkpoint).toEqual(new Uint8Array([1]));
  });

  it('повтор promote режимом checkpoint бросает ожидание', async () => {
    const receiver = makeWaitingReceiver();
    const { promotion, created } = create({ promote: PLANNED, receiver });
    const started = promotion.start();

    await flush();

    expect(promotion.degrade({ ...PLANNED, epoch: 4 })).toBe(false);
    expect(promotion.degrade({ ...PLANNED, mode: 'checkpoint' })).toBe(true);
    await started;

    expect(created[0].opts.checkpoint).toEqual(new Uint8Array([1]));
  });

  it('отмена во время ожидания — Worker не поднимается', async () => {
    const receiver = makeWaitingReceiver();
    const { promotion, created, prepareRoom, hooks } = create({
      promote: PLANNED,
      receiver,
    });
    const started = promotion.start();

    await flush();
    promotion.cancel();
    await started;

    expect(promotion.state).toBe('cancelled');
    expect(prepareRoom).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(hooks.onFailed).not.toHaveBeenCalled();
  });

  it('режим checkpoint финальную не ждёт', async () => {
    const receiver = makeWaitingReceiver();
    const { promotion, created } = create({ receiver });

    await promotion.start();

    expect(receiver.waitForFinal).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
  });

  // ревью F2: финальная точка идёт по каналу standby поверх соединения
  // с замороженным хостом — бета ставит сессию на паузу, не закрывая его
  it('holdSession — до ожидания финальной точки', async () => {
    const receiver = makeWaitingReceiver();
    const holdSession = vi.fn();
    const { promotion } = create({ promote: PLANNED, receiver, holdSession });
    const started = promotion.start();

    await flush();
    expect(holdSession).toHaveBeenCalledTimes(1);
    expect(holdSession.mock.invocationCallOrder[0]).toBeLessThan(
      receiver.waitForFinal.mock.invocationCallOrder[0],
    );

    receiver.deliverFinal();
    await started;

    expect(holdSession).toHaveBeenCalledTimes(1);
  });

  it('режим checkpoint holdSession не зовёт', async () => {
    const holdSession = vi.fn();
    const { promotion } = create({ holdSession });

    await promotion.start();

    expect(holdSession).not.toHaveBeenCalled();
  });
});

describe('Promotion: отложенный холодный промоушен', () => {
  const makeStorage = () => {
    const data = new Map();

    return {
      data,
      getItem: key => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => data.set(key, value),
      removeItem: key => data.delete(key),
    };
  };

  it('сохраняется и забирается один раз', () => {
    const storage = makeStorage();

    expect(
      savePendingPromotion(
        storage,
        { ...PROMOTE, mode: 'cold', settings: { map: 'dust' } },
        'tanks',
      ),
    ).toBe(true);

    expect(takePendingPromotion(storage)).toEqual({
      roomId: 'r1',
      epoch: 3,
      promotionToken: TOKEN,
      gameId: 'tanks',
      settings: { map: 'dust' },
    });
    expect(takePendingPromotion(storage)).toBeNull();
  });

  it('битая запись снимается и не возвращается', () => {
    const storage = makeStorage();

    storage.setItem(PROMOTION_STORAGE_KEY, '{"roomId":1}');

    expect(takePendingPromotion(storage)).toBeNull();
    expect(storage.data.has(PROMOTION_STORAGE_KEY)).toBe(false);

    storage.setItem(PROMOTION_STORAGE_KEY, 'not json');

    expect(takePendingPromotion(storage)).toBeNull();
  });

  it('недоступное хранилище — false/null, без исключений', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {},
    };

    expect(savePendingPromotion(broken, PROMOTE, 'tanks')).toBe(false);
    expect(takePendingPromotion(broken)).toBeNull();
    expect(savePendingPromotion(null, PROMOTE, 'tanks')).toBe(false);
    expect(
      savePendingPromotion(
        makeStorage(),
        { ...PROMOTE, promotionToken: 'x' },
        'tanks',
      ),
    ).toBe(false);
  });
});
