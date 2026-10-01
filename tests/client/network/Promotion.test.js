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
