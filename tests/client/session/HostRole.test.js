import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import HostRole, {
  codeVersionChanged,
} from '../../../packages/engine/src/client/session/HostRole.js';
import { createRoomContext } from '../../../packages/engine/src/client/session/roomContext.js';
import { makeConfig, makeSignaling } from './sessionFakes.js';

// Роль хоста: создание комнаты → 'ready' → register_host → host_registered;
// reclaim после реконнекта, roomTaken → новая регистрация, смена версии
// кода → эстафета Worker'ов, назначение беты, снятие роли.

const CODE = { engine: 'e1', game: { id: 'tanks', version: '1.0.0' } };
const ROOM = { hostSocketId: 'host', maxPlayers: 8, name: 'r' };
const ACTIVE = { id: 'tanks', version: '1.0.0' };

let signaling;
let ctx;
let membership;
let handoff;
let ui;
let prep;
let controllers;
let made;
let onPromotionRegistered;
let moduleWorker;

const makeController = (room, options) => {
  const controller = {
    room,
    options,
    onHealth: vi.fn(cb => {
      controller.health = cb;
    }),
    setRoom: vi.fn(),
    updateMaps: vi.fn(),
    swapWorker: vi.fn(async () => {}),
    cancelPendingSwap: vi.fn(() => true),
    destroy: vi.fn(),
  };

  controllers.push(controller);

  return controller;
};

const spyObject =
  (name, methods, extra = {}) =>
  options => {
    const obj = { options, ...extra };

    for (const method of methods) {
      obj[method] = vi.fn();
    }

    made[name] = obj;

    return obj;
  };

const create = () => {
  const role = new HostRole({
    signaling,
    ctx,
    membership,
    config: makeConfig(),
    diagnostics: { setContext: vi.fn(), warn: vi.fn() },
    prep,
    getActiveGame: () => ACTIVE,
    getToken: () => 'jwt',
    getHandoff: () => handoff,
    onPromotionRegistered,
    ui,
    factories: {
      supportsModuleWorker: () => moduleWorker,
      controller: makeController,
      connections: (sig, controller, options) => {
        made.connections = {
          options,
          peerCount: 0,
          connectedMemberIds: () => ['g1'],
          destroy: vi.fn(),
        };

        return made.connections;
      },
      peersReporter: spyObject('peers', ['notify', 'refresh', 'destroy']),
      standbySender: spyObject('sender', [
        'setSuccessor',
        'refresh',
        'destroy',
      ]),
      hiddenLog: spyObject('hiddenLog', ['add', 'setHidden', 'flush']),
      healthReporter: spyObject('healthReporter', ['add']),
      loopback: (controller, socketId, options) => {
        made.loopback = { controller, socketId, options, connect: vi.fn() };

        return made.loopback;
      },
    },
  });

  role.bind();

  return role;
};

// комната поднята и Worker сообщил 'ready'
const createReady = async options => {
  const role = create();

  await role.createRoom({ ...ROOM }, options);
  controllers[0].options.onReady({ lobbyInfo: 'info' });

  return role;
};

const registered = (msg = {}) =>
  signaling.emit('host_registered', {
    roomId: 'room1',
    epoch: 1,
    roomSecret: 's',
    ...msg,
  });

beforeEach(() => {
  vi.useFakeTimers();
  signaling = makeSignaling();
  ctx = createRoomContext();
  membership = {
    memberId: 'm1',
    caps: () => ({ canHost: true }),
    forget: vi.fn(),
    armTokenCapsTimer: vi.fn(),
  };
  handoff = {
    active: false,
    armTokenHandoff: vi.fn(),
    cancelTokenHandoff: vi.fn(),
    abort: vi.fn(),
    setHost: vi.fn(),
    setSuccessor: vi.fn(),
    addHealth: vi.fn(),
  };
  ui = {
    showRoomLink: vi.fn(),
    refreshRoomControls: vi.fn(),
    setHandoffMenu: vi.fn(),
    isHidden: () => false,
    informTech: vi.fn(),
    ensureWebRtc: () => true,
    startSession: vi.fn(),
    closeLobby: vi.fn(),
    onStartFailed: vi.fn(),
  };
  prep = {
    prepareHostRoom: vi.fn(async room => {
      room.game = { id: 'tanks', version: '1.0.0' };

      return { room, workerUrl: '/w.js', mapsVersion: 'm1', codeVersion: CODE };
    }),
    fetchMasterMaps: vi.fn(async () => ({ version: 'm2', maps: { a: {} } })),
    fetchWorkerManifest: vi.fn(async () => ({ version: 'e2', url: '/w2.js' })),
    fetchGameManifest: vi.fn(async () => ({
      id: 'tanks',
      version: '1.0.0',
      entries: { host: '/h.js', wasm: '/w.wasm' },
    })),
  };
  controllers = [];
  made = {};
  onPromotionRegistered = vi.fn();
  moduleWorker = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HostRole.createRoom', () => {
  it('браузер без модульного Worker хостом не становится', async () => {
    moduleWorker = false;

    const role = create();

    await role.createRoom({ ...ROOM });

    expect(ui.informTech).toHaveBeenCalled();
    expect(ctx.entered).toBe(false);
    expect(role.controller).toBeNull();
  });

  it('Worker, роль хоста и свой игрок по loopback', async () => {
    const role = create();

    await role.createRoom({ ...ROOM });

    expect(ctx.entered).toBe(true);
    expect(role.controller).toBe(controllers[0]);
    expect(controllers[0].options.workerUrl).toBe('/w.js');
    expect(membership.forget).toHaveBeenCalled();
    expect(handoff.armTokenHandoff).toHaveBeenCalled();
    expect(handoff.setHost).toHaveBeenCalledWith(true);
    expect(made.loopback.socketId).toBe('host');
    expect(made.loopback.connect).toHaveBeenCalled();
    expect(ui.startSession).toHaveBeenCalledWith(made.loopback);
    expect(ui.closeLobby).toHaveBeenCalled();
  });

  it('метрики Worker расходятся по журналу, политике и отчёту', async () => {
    await create().createRoom({ ...ROOM });

    controllers[0].health({ tickRate: 60 });

    expect(made.hiddenLog.add).toHaveBeenCalledWith({ tickRate: 60 });
    expect(handoff.addHealth).toHaveBeenCalledWith({ tickRate: 60 });
    expect(made.healthReporter.add).toHaveBeenCalledWith({ tickRate: 60 });
  });

  it('сбой Worker холодного преемника: promote_failed и уход', async () => {
    const promotion = { roomId: 'room1', epoch: 2, promotionToken: 't' };
    const role = create();

    await role.createRoom({ ...ROOM }, { promotion });
    controllers[0].options.onError({ message: 'boom' });

    expect(signaling.promoteFailed).toHaveBeenCalledWith(promotion);
    expect(role.promotion).toBeNull();
    expect(ui.onStartFailed).toHaveBeenCalledWith({ message: 'boom' });
  });
});

describe('HostRole: регистрация', () => {
  it("'ready' → register_host с настройками и heartbeat", async () => {
    await createReady();

    expect(signaling.registerHost).toHaveBeenCalledWith(
      expect.objectContaining({
        gameId: 'tanks',
        gameVersion: '1.0.0',
        maxPlayers: 8,
        info: 'info',
        token: 'jwt',
        memberId: 'm1',
        caps: { canHost: true },
      }),
    );

    vi.advanceTimersByTime(5000);
    expect(signaling.updateHost).toHaveBeenCalledWith({ info: 'info' });
  });

  it('host_registered: комната, эпоха, ссылка и секрет Worker’у', async () => {
    const role = await createReady();

    registered();

    expect(role.room).toEqual({ roomId: 'room1', epoch: 1, roomSecret: 's' });
    expect(ctx).toMatchObject({ roomId: 'room1', epoch: 1 });
    expect(ui.showRoomLink).toHaveBeenCalledWith('tanks', 'room1');
    expect(controllers[0].setRoom).toHaveBeenCalledWith(role.room);
    expect(made.peers.refresh).toHaveBeenCalled();
  });

  it('host_registered без роли игнорируется', () => {
    create();
    registered();

    expect(ctx.roomId).toBeNull();
  });

  it('реконнект сигналинга — reclaim_host той же комнаты', async () => {
    const role = await createReady();

    registered();
    role.reRegister();

    expect(signaling.reclaimHost).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room1', epoch: 1, roomSecret: 's' }),
    );
  });

  it('roomTaken → fresh: новая комната вместо reclaim', async () => {
    const role = await createReady();

    registered();
    role.reRegister({ fresh: true });

    expect(signaling.registerHost).toHaveBeenCalledTimes(2);
    expect(role.room).toBeNull();
  });

  it('преемник занимает комнату токеном, host_registered завершает промоушен', async () => {
    const promotion = { roomId: 'room1', epoch: 2, promotionToken: 't' };
    const role = await createReady({ promotion });

    expect(signaling.registerHost).toHaveBeenCalledWith(
      expect.objectContaining({ promotion }),
    );

    registered({ epoch: 2 });

    expect(onPromotionRegistered).toHaveBeenCalledWith({
      mode: 'cold',
      promotion,
    });
    expect(role.promotion).toBeNull();
  });

  it('lobby_info Worker’а сразу уходит мастеру', async () => {
    await createReady();

    controllers[0].options.onLobbyInfoChange('next');

    expect(signaling.updateHost).toHaveBeenCalledWith({ info: 'next' });
  });
});

describe('HostRole: версии карт и кода', () => {
  it('новая версия карт — каталог в Worker', async () => {
    await createReady();

    registered({ mapsVersion: 'm2' });
    await vi.waitFor(() =>
      expect(controllers[0].updateMaps).toHaveBeenCalledWith({ a: {} }),
    );
  });

  it('новая версия кода — эстафета Worker’ов', async () => {
    const role = await createReady();

    vi.spyOn(console, 'info').mockImplementation(() => {});
    registered({ codeVersion: { ...CODE, engine: 'e2' } });

    await vi.waitFor(() =>
      expect(controllers[0].swapWorker).toHaveBeenCalledWith('/w2.js', {
        id: 'tanks',
        version: '1.0.0',
        hostEntryUrl: '/h.js',
        wasmUrl: '/w.wasm',
      }),
    );
    await vi.waitFor(() => expect(role.swapInProgress).toBe(false));
    expect(role.codeVersion.engine).toBe('e2');
  });

  it('идущая передача хоста эстафету не запускает', async () => {
    const role = await createReady();

    handoff.active = true;
    await role.refreshWorker();

    expect(prep.fetchWorkerManifest).not.toHaveBeenCalled();
  });

  it('не удавшаяся версия не ретраится', async () => {
    const role = await createReady();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    controllers[0].swapWorker.mockRejectedValueOnce(new Error('boom'));
    await role.refreshWorker();
    await role.refreshWorker();

    expect(controllers[0].swapWorker).toHaveBeenCalledTimes(1);
  });

  it('codeVersionChanged сравнивает движок и игру', () => {
    expect(codeVersionChanged(CODE, { ...CODE })).toBe(false);
    expect(
      codeVersionChanged(CODE, {
        ...CODE,
        game: { id: 'tanks', version: '2' },
      }),
    ).toBe(true);
  });
});

describe('HostRole: бета и снятие роли', () => {
  it('successor_assigned: канал standby, политика и передача по сроку', async () => {
    const role = await createReady();

    registered();
    signaling.emit('successor_assigned', {
      roomId: 'room1',
      successorMemberId: 'g1',
    });

    expect(role.successorMemberId).toBe('g1');
    expect(made.sender.setSuccessor).toHaveBeenCalledWith('g1');
    expect(handoff.setSuccessor).toHaveBeenCalledWith(true);
    expect(handoff.armTokenHandoff).toHaveBeenCalledTimes(2);
  });

  it('probe своей комнаты — probe_ack', async () => {
    await createReady();

    registered();
    signaling.emit('probe', { roomId: 'room1', nonce: 'n' });
    signaling.emit('probe', { roomId: 'other', nonce: 'x' });

    expect(signaling.probeAck).toHaveBeenCalledTimes(1);
    expect(signaling.probeAck).toHaveBeenCalledWith('n');
  });

  it('teardown гасит Worker, пиров, поток точек и передачу', async () => {
    const role = await createReady();

    registered();
    role.teardown();

    expect(handoff.abort).toHaveBeenCalled();
    expect(handoff.cancelTokenHandoff).toHaveBeenCalled();
    expect(handoff.setHost).toHaveBeenLastCalledWith(false);
    expect(made.sender.destroy).toHaveBeenCalled();
    expect(made.connections.destroy).toHaveBeenCalled();
    expect(controllers[0].destroy).toHaveBeenCalled();
    expect(role.controller).toBeNull();
    expect(role.room).toBeNull();
    expect(ui.setHandoffMenu).toHaveBeenCalledWith(null);

    signaling.updateHost.mockClear();
    vi.advanceTimersByTime(20_000);
    expect(signaling.updateHost).not.toHaveBeenCalled();
  });
});
