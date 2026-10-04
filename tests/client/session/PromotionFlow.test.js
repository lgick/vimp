import { describe, it, expect, beforeEach, vi } from 'vitest';
import PromotionFlow from '../../../packages/engine/src/client/session/PromotionFlow.js';
import { createRoomContext } from '../../../packages/engine/src/client/session/roomContext.js';
import { PROMOTION_STORAGE_KEY } from '../../../packages/engine/src/client/network/Promotion.js';
import { makeConfig, makeSignaling } from './sessionFakes.js';

// Промоушен преемника и разжалование: planned → holdSession (этап 2
// ревью), checkpoint → регистрация → возврат своего игрока, cold →
// перезагрузка, отмена, staleEpoch/host_revoked → гостем к новому хосту.

const TOKEN = '0123456789abcdef0123456789abcdef';
const PROMOTE = {
  roomId: 'room1',
  epoch: 3,
  promotionToken: TOKEN,
  mode: 'checkpoint',
};

let signaling;
let ctx;
let hostRole;
let standby;
let membership;
let handoff;
let guest;
let supervisor;
let ui;
let promotions;
let loopbacks;
let storage;

const makeStorage = () => {
  const data = new Map();

  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  };
};

const create = (extra = {}) => {
  const flow = new PromotionFlow({
    signaling,
    ctx,
    hostRole,
    standby,
    membership,
    getHandoff: () => handoff,
    getGuest: () => guest,
    getSupervisor: () => supervisor,
    getActiveGameId: () => 'tanks',
    getToken: () => 'jwt',
    prepareRoom: vi.fn(),
    config: makeConfig(),
    diagnostics: { warn: vi.fn() },
    ui,
    getStorage: () => storage,
    factories: {
      promotion: options => {
        const promotion = {
          options,
          promotion: {
            roomId: options.promote.roomId,
            epoch: options.promote.epoch,
            promotionToken: options.promote.promotionToken,
          },
          start: vi.fn(),
          cancel: vi.fn(),
          degrade: vi.fn(() => false),
        };

        promotions.push(promotion);

        return promotion;
      },
      loopback: (controller, socketId, options) => {
        const loopback = { controller, socketId, options, connect: vi.fn() };

        loopbacks.push(loopback);

        return loopback;
      },
    },
    ...extra,
  });

  flow.bind();

  return flow;
};

beforeEach(() => {
  signaling = makeSignaling();
  ctx = createRoomContext();
  ctx.roomId = 'room1';
  ctx.epoch = 2;
  hostRole = {
    controller: null,
    room: null,
    promotion: null,
    adopt: vi.fn(),
    startRegistration: vi.fn(),
    handleLobbyInfo: vi.fn(),
    teardown: vi.fn(),
  };
  standby = {
    receiver: { id: 'receiver' },
    prewarm: { id: 'prewarm' },
    teardown: vi.fn(),
    discardFinal: vi.fn(),
  };
  membership = {
    tokenAllowsHostRole: vi.fn(() => true),
    sendJoinRoom: vi.fn(),
  };
  handoff = { leaving: false, leave: vi.fn() };
  guest = {
    reconnect: vi.fn(() => ({ id: 'reconnect' })),
    openTransport: vi.fn(() => ({ id: 'transport' })),
  };
  supervisor = {
    hasSession: true,
    migrate: vi.fn(),
    resumeWith: vi.fn(() => true),
  };
  ui = {
    reloadPage: vi.fn(),
    reloadToRoom: vi.fn(),
    showSessionOverlay: vi.fn(),
    disableControls: vi.fn(),
    mute: vi.fn(),
    informTech: vi.fn(),
    chat: vi.fn(),
  };
  promotions = [];
  loopbacks = [];
  storage = makeStorage();
});

describe('PromotionFlow: promote из контрольной точки', () => {
  it('Worker из точки беты; планированная передача держит сессию', () => {
    create();
    signaling.emit('promote', { ...PROMOTE, reason: 'handover' });

    const [promotion] = promotions;

    expect(promotion.start).toHaveBeenCalled();
    expect(promotion.options.receiver).toBe(standby.receiver);
    expect(promotion.options.prewarm).toBe(standby.prewarm);
    expect(promotion.options.hasSession()).toBe(true);

    promotion.options.holdSession();
    expect(supervisor.migrate).toHaveBeenCalledWith({ keepTransport: true });
  });

  it('готовый Worker — роль хоста и регистрация с причиной передачи', () => {
    const flow = create();

    signaling.emit('promote', { ...PROMOTE, reason: 'vote' });

    const [promotion] = promotions;
    const ready = {
      controller: { id: 'c' },
      room: { id: 'room' },
      prepared: { id: 'p' },
      lobbyInfo: 'info',
    };

    promotion.options.onReady(ready);

    expect(flow.inFlight).toBeNull();
    expect(hostRole.adopt).toHaveBeenCalledWith(
      ready.controller,
      ready.room,
      ready.prepared,
      {
        promotion: {
          mode: 'checkpoint',
          promotion: promotion.promotion,
          reason: 'vote',
        },
      },
    );
    expect(hostRole.startRegistration).toHaveBeenCalledWith('info');
  });

  it('сбой промоушена — promote_failed мастеру', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const flow = create();

    signaling.emit('promote', PROMOTE);
    promotions[0].options.onFailed(new Error('boom'));

    expect(flow.inFlight).toBeNull();
    expect(signaling.promoteFailed).toHaveBeenCalledWith(
      promotions[0].promotion,
    );
  });

  it('повтор checkpoint посреди передачи деградирует идущий промоушен', () => {
    create();
    signaling.emit('promote', PROMOTE);
    promotions[0].degrade.mockReturnValue(true);
    signaling.emit('promote', PROMOTE);

    expect(promotions).toHaveLength(1);
    expect(promotions[0].degrade).toHaveBeenCalled();
  });

  it('чужая комната, хост и короткий вход', () => {
    create();
    signaling.emit('promote', { ...PROMOTE, roomId: 'other' });
    expect(promotions).toHaveLength(0);

    membership.tokenAllowsHostRole.mockReturnValue(false);
    signaling.emit('promote', PROMOTE);
    expect(promotions).toHaveLength(0);
    expect(signaling.promoteFailed).toHaveBeenCalledTimes(1);

    membership.tokenAllowsHostRole.mockReturnValue(true);
    hostRole.controller = {};
    signaling.emit('promote', PROMOTE);
    expect(promotions).toHaveLength(0);
  });
});

describe('PromotionFlow: cold', () => {
  it('отложенный промоушен в sessionStorage и перезагрузка в комнату', () => {
    create();
    signaling.emit('promote', { ...PROMOTE, mode: 'cold' });

    expect(JSON.parse(storage.data.get(PROMOTION_STORAGE_KEY))).toMatchObject({
      roomId: 'room1',
      gameId: 'tanks',
    });
    expect(ui.reloadPage).toHaveBeenCalledWith('#/tanks/room1');
  });

  it('хранилище недоступно — promote_failed', () => {
    create({
      getStorage: () => {
        throw new Error('denied');
      },
    });
    signaling.emit('promote', { ...PROMOTE, mode: 'cold' });

    expect(signaling.promoteFailed).toHaveBeenCalled();
    expect(ui.reloadPage).not.toHaveBeenCalled();
  });
});

describe('PromotionFlow: регистрация и отмена', () => {
  it('finish checkpoint: матч после возврата людей, свой игрок по loopback', () => {
    const flow = create();

    hostRole.controller = { startAfterRestore: vi.fn() };
    flow.finish({ mode: 'checkpoint', reason: 'leave' });

    expect(standby.teardown).toHaveBeenCalled();
    expect(hostRole.controller.startAfterRestore).toHaveBeenCalledWith({
      waitForResume: true,
      reason: 'leave',
    });
    expect(loopbacks[0].options).toEqual({ resume: true });
    expect(loopbacks[0].connect).toHaveBeenCalled();

    const [transport, options] = supervisor.resumeWith.mock.calls[0];

    expect(transport).toBe(loopbacks[0]);
    expect(options.reconnect).toBeNull();
    expect(options.getToken()).toBe('jwt');

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    options.onFailed('rejected');
    expect(ui.informTech).toHaveBeenCalled();
    expect(ui.disableControls).toHaveBeenCalled();
  });

  it('finish cold — только сброс беты', () => {
    create().finish({ mode: 'cold' });

    expect(standby.teardown).toHaveBeenCalled();
    expect(loopbacks).toHaveLength(0);
  });

  it('promote_cancelled: Worker брошен, финальная точка сброшена, роль снята', () => {
    create();
    signaling.emit('promote', PROMOTE);
    hostRole.promotion = { mode: 'checkpoint', promotion: { roomId: 'room1' } };
    signaling.emit('promote_cancelled', { roomId: 'room1' });

    expect(promotions[0].cancel).toHaveBeenCalled();
    expect(standby.discardFinal).toHaveBeenCalled();
    expect(hostRole.teardown).toHaveBeenCalled();
    expect(ui.reloadToRoom).not.toHaveBeenCalled();
  });

  it('abandon cold с отчётом — promote_failed и чистый вход', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    hostRole.promotion = { mode: 'cold', promotion: { roomId: 'room1' } };

    create().abandon({ code: 'staleEpoch', report: true });

    expect(signaling.promoteFailed).toHaveBeenCalledWith({ roomId: 'room1' });
    expect(hostRole.teardown).toHaveBeenCalled();
    expect(ui.reloadToRoom).toHaveBeenCalled();
  });
});

describe('PromotionFlow.demote', () => {
  it('host_revoked: роль снята, гостем к новому хосту', () => {
    create();
    hostRole.controller = {};
    hostRole.room = { roomId: 'room1', epoch: 2 };
    signaling.emit('host_revoked', { roomId: 'room1', epoch: 5 });

    expect(hostRole.teardown).toHaveBeenCalled();
    expect(standby.teardown).toHaveBeenCalled();
    expect(ctx.epoch).toBe(5);
    expect(ui.chat).toHaveBeenCalled();
    expect(membership.sendJoinRoom).toHaveBeenCalled();
    expect(guest.openTransport).toHaveBeenCalledWith('room1', { resume: true });
    expect(supervisor.resumeWith).toHaveBeenCalledWith(
      { id: 'transport' },
      { reconnect: { id: 'reconnect' } },
    );
  });

  it('notice: false — без системного сообщения', () => {
    create().demote(5, { notice: false });

    expect(ui.chat).not.toHaveBeenCalled();
  });

  it('супервизор не принял транспорт — чистый вход в комнату', () => {
    supervisor.resumeWith.mockReturnValue(false);
    create().demote(5);

    expect(ui.reloadToRoom).toHaveBeenCalled();
  });

  it('уходящий хост уходит и при смене роли без него', () => {
    handoff.leaving = true;
    create().demote(5);

    expect(handoff.leave).toHaveBeenCalled();
    expect(hostRole.teardown).not.toHaveBeenCalled();
  });

  it('вне комнаты — в лобби', () => {
    ctx.roomId = null;
    create().demote(5);

    expect(ui.reloadPage).toHaveBeenCalledWith('');
    expect(membership.sendJoinRoom).not.toHaveBeenCalled();
  });
});
