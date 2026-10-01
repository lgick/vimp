import { describe, it, expect, beforeAll, vi } from 'vitest';

// Протокол главный поток → Worker (host-migration, этап 2): новый Worker
// обязан понимать сообщения главного потока, загруженного до деплоя. Рантайм
// комнаты подменён — проверяется только маршрутизация сообщений.

const host = {
  setRoom: vi.fn(),
  setCheckpointSink: vi.fn(),
  setHealthSink: vi.fn(),
  startCheckpoints: vi.fn(),
  stopCheckpoints: vi.fn(),
  requestCheckpoint: vi.fn(),
  startAfterRestore: vi.fn(),
  startAfterResume: vi.fn(),
  freeze: vi.fn(),
  unfreeze: vi.fn(),
  currentMap: 'arena',
  lobbyInfo: 'arena',
};

// опции HostGame, с которыми Worker поднял рантайм
let hostOptions = null;

vi.mock('../../packages/engine/src/lib/createHostRuntime.js', () => ({
  createHostRuntime: vi.fn(async (room, options) => {
    hostOptions = options.hostOptions;

    return {
      host,
      socketManager: {},
      clientCfg: {},
      hostPlugin: { authSchema: null },
      game: { resumeGraceMs: 20000, resumeRequestTimeoutMs: 5000 },
      seed: 1,
    };
  }),
}));

// порт-машина, с которой Worker поднял комнату (опции и connect'ы)
const machines = [];

vi.mock('../../packages/engine/src/host/PortMachine.js', () => ({
  default: class {
    constructor(deps) {
      this.deps = deps;
      this.connects = [];
      machines.push(this);
    }

    connect(socketId, opts) {
      this.connects.push([socketId, opts]);
    }

    startGraceFor(ids) {
      this.graceFor = ids;
    }
  },
}));

vi.mock('../../packages/engine/src/host/identity.js', () => ({
  createTokenIdentity: () => ({}),
}));

const posted = [];

const send = data => globalThis.self.onmessage({ data });

beforeAll(async () => {
  globalThis.self = {
    postMessage: msg => posted.push(msg),
    addEventListener: () => {},
    onmessage: null,
  };

  await import('../../packages/engine/src/host/host.worker.js');
  await send({ type: 'init', room: {} });
});

describe('host.worker: комната у мастера', () => {
  it('set_room передаёт roomId, секрет и эпоху', async () => {
    host.setRoom.mockClear();

    await send({
      type: 'set_room',
      roomId: 'abcd1234',
      roomSecret: 's',
      epoch: 2,
    });

    expect(host.setRoom).toHaveBeenCalledWith({
      roomId: 'abcd1234',
      roomSecret: 's',
      epoch: 2,
    });
  });

  it('set_host_id старого главного потока — алиас set_room', async () => {
    host.setRoom.mockClear();

    await send({ type: 'set_host_id', hostId: 'h1', hostSecret: 's1' });

    expect(host.setRoom).toHaveBeenCalledWith({
      roomId: 'h1',
      roomSecret: 's1',
    });
  });
});

describe('host.worker: строка карточки лобби', () => {
  it('ready несёт lobbyInfo (и mapName для старого главного потока)', () => {
    expect(posted.find(msg => msg.type === 'ready')).toMatchObject({
      mapName: 'arena',
      lobbyInfo: 'arena',
    });
  });

  it('смена строки уходит главному потоку сообщением lobby_info', () => {
    hostOptions.onLobbyInfoChange(null);

    expect(posted.at(-1)).toEqual({ type: 'lobby_info', info: null });
  });
});

describe('host.worker: возобновление сессии (host-migration этап 4)', () => {
  it('порт-машина лобби получает resumeGraceMs из конфига', () => {
    expect(machines[0].deps.resumeGraceMs).toBe(20000);
    expect(machines[0].deps.resumeRequestTimeoutMs).toBe(5000);
  });

  it('connect с resume доезжает до порт-машины, без флага — обычный', async () => {
    await send({ type: 'connect', socketId: 'c1', resume: true });
    await send({ type: 'connect', socketId: 'c2' });

    expect(machines[0].connects).toEqual([
      ['c1', { resume: true }],
      ['c2', { resume: false }],
    ]);
  });
});

describe('host.worker: контрольные точки (host-migration этап 5)', () => {
  it('сообщения главного потока доезжают до HostGame', async () => {
    await send({ type: 'checkpoint_start', intervalMs: 500 });
    await send({ type: 'checkpoint_request', final: true });
    await send({ type: 'checkpoint_stop' });
    await send({ type: 'freeze' });
    await send({ type: 'unfreeze' });
    await send({ type: 'start_after_restore' });

    expect(host.startCheckpoints).toHaveBeenCalledWith(500);
    expect(host.requestCheckpoint).toHaveBeenCalledWith({ final: true });
    expect(host.stopCheckpoints).toHaveBeenCalled();
    expect(host.freeze).toHaveBeenCalled();
    expect(host.unfreeze).toHaveBeenCalled();
    expect(host.startAfterRestore).toHaveBeenCalled();
  });

  it('метрики здоровья хоста уходят главному потоку сообщением health', () => {
    const sink = host.setHealthSink.mock.calls[0][0];
    const health = { tickRate: 119.5, maxGapMs: 12, lostMs: 0 };

    sink(health);

    expect(posted.at(-1)).toEqual({ type: 'health', health });
  });

  it('готовая точка уходит главному потоку сжатой, буфером переноса', async () => {
    const { decodeCheckpoint } =
      await import('../../packages/engine/src/lib/checkpointCodec.js');
    const sink = host.setCheckpointSink.mock.calls[0][0];
    const transfers = [];

    globalThis.self.postMessage = (msg, transfer) => {
      posted.push(msg);
      transfers.push(transfer);
    };

    sink({
      meta: { checkpointId: 'c-1', seq: 7, createdAt: 1, mode: 'soft' },
      core: null,
      final: true,
    });

    await vi.waitFor(() => {
      expect(posted.at(-1).type).toBe('checkpoint');
    });

    const msg = posted.at(-1);

    expect(msg).toMatchObject({
      checkpointId: 'c-1',
      seq: 7,
      final: true,
      mode: 'soft',
    });
    expect(transfers.at(-1)).toEqual([msg.bytes.buffer]);
    expect((await decodeCheckpoint(msg.bytes)).meta.checkpointId).toBe('c-1');
  });

  it('init с контрольной точкой распаковывает её и передаёт seqFloor', async () => {
    const { encodeCheckpoint } =
      await import('../../packages/engine/src/lib/checkpointCodec.js');
    const bytes = await encodeCheckpoint(
      { version: 4, seq: 5 },
      new Uint8Array([1, 2]),
    );

    await send({ type: 'init', room: {}, checkpoint: bytes, seqFloor: 40 });

    expect(hostOptions.checkpoint.meta.seq).toBe(5);
    expect([...hostOptions.checkpoint.core]).toEqual([1, 2]);
    expect(hostOptions.seqFloor).toBe(40);
    expect(hostOptions.handoff).toBeNull();
  });
});

describe('host.worker: старт у преемника (host-migration этап 7.4)', () => {
  it('start_after_restore с waitForResume ждёт возврата и заводит grace', async () => {
    host.startAfterRestore.mockClear();

    await send({ type: 'start_after_restore', waitForResume: true });

    expect(host.startAfterRestore).not.toHaveBeenCalled();
    expect(host.startAfterResume).toHaveBeenCalledTimes(1);

    // HostGame отдаёт не вернувшихся — порт-машина заводит им ожидание
    host.startAfterResume.mock.calls[0][0]([7, 9]);

    expect(machines.at(-1).graceFor).toEqual([7, 9]);
    expect(host.startAfterResume.mock.calls[0][1]).toEqual({ reason: null });
  });

  it('start_after_restore передаёт причину передачи в HostGame', async () => {
    host.startAfterResume.mockClear();

    await send({
      type: 'start_after_restore',
      waitForResume: true,
      reason: 'hidden',
    });

    expect(host.startAfterResume.mock.calls[0][1]).toEqual({
      reason: 'hidden',
    });
  });
});
