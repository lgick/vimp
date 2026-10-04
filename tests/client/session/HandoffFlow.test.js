import { describe, it, expect, beforeEach, vi } from 'vitest';
import HandoffFlow from '../../../packages/engine/src/client/session/HandoffFlow.js';
import { createRoomContext } from '../../../packages/engine/src/client/session/roomContext.js';
import { makeConfig, makeSignaling } from './sessionFakes.js';

// Плановая передача и уход из комнаты: «Hand over host», «Leave server»
// (один и с людьми, этап 10 ревью), request_handoff vote/network,
// вытеснение эстафеты Worker'ов (этап 8 ревью), исходы передачи.

const ROOM = { roomId: 'room1', epoch: 4 };

let signaling;
let ctx;
let hostRole;
let standby;
let membership;
let promotion;
let supervisor;
let ui;
let planned;
let policy;
let tokenTimer;
let config;

const create = ({ bind = true } = {}) => {
  const flow = new HandoffFlow({
    signaling,
    ctx,
    hostRole,
    standby,
    membership,
    getPromotion: () => promotion,
    getSupervisor: () => supervisor,
    getTokenExpiresAt: () => null,
    config: config.migration,
    ui,
    factories: {
      plannedHandoff: options => {
        planned = {
          options,
          active: false,
          deferred: false,
          leaving: false,
          reason: null,
          start: vi.fn(() => true),
          hurry: vi.fn(() => false),
          cancelDeferred: vi.fn(() => true),
          abort: vi.fn(),
        };

        return planned;
      },
      healthPolicy: options => {
        policy = {
          options,
          setHidden: vi.fn(),
          setHost: vi.fn(),
          setSuccessor: vi.fn(),
          addHealth: vi.fn(),
        };

        return policy;
      },
      tokenTimer: options => {
        tokenTimer = { options, arm: vi.fn(), retry: vi.fn(), cancel: vi.fn() };

        return tokenTimer;
      },
    },
  });

  if (bind) {
    flow.bind();
  }

  return flow;
};

beforeEach(() => {
  signaling = makeSignaling();
  ctx = createRoomContext();
  ctx.roomId = 'room1';
  config = makeConfig();
  hostRole = {
    controller: {
      shutdown: vi.fn(async () => {}),
      cancelPendingSwap: vi.fn(() => true),
    },
    room: { ...ROOM },
    promotion: null,
    swapInProgress: false,
    successorMemberId: 'g1',
    peerCount: 0,
    codeVersion: null,
    teardown: vi.fn(),
    refreshWorker: vi.fn(),
  };
  standby = { teardown: vi.fn() };
  membership = { forget: vi.fn() };
  promotion = { demote: vi.fn() };
  supervisor = { state: 'inGame' };
  ui = {
    showSessionOverlay: vi.fn(),
    disableControls: vi.fn(),
    enableControls: vi.fn(),
    mute: vi.fn(),
    unmute: vi.fn(),
    isHidden: () => false,
    setHandoffMenu: vi.fn(),
    sendLeave: vi.fn(),
    reloadPage: vi.fn(),
  };
});

describe('HandoffFlow.start', () => {
  it('«Hand over host»: передача с ожиданием границы раунда', () => {
    const flow = create();

    expect(flow.start({ reason: 'handover' })).toBe(true);
    expect(planned.start).toHaveBeenCalledWith({
      reason: 'handover',
      stay: true,
      defer: true,
    });
    expect(ui.setHandoffMenu).toHaveBeenCalledWith('pending');
  });

  it('до bind, без роли и во время промоушена — отказ', () => {
    expect(create({ bind: false }).start({ reason: 'handover' })).toBe(false);

    const flow = create();

    hostRole.promotion = { mode: 'cold' };
    expect(flow.start({ reason: 'handover' })).toBe(false);

    hostRole.promotion = null;
    hostRole.controller = null;
    expect(flow.start({ reason: 'handover' })).toBe(false);
    expect(planned.start).not.toHaveBeenCalled();
  });

  it('ожидающая эстафета Worker’ов уступает передаче (этап 8)', () => {
    const flow = create();

    hostRole.swapInProgress = true;

    expect(flow.start({ reason: 'handover' })).toBe(true);
    expect(hostRole.controller.cancelPendingSwap).toHaveBeenCalled();
  });

  it('своп, уже переносящий состояние, передачу не пускает', () => {
    const flow = create();

    hostRole.swapInProgress = true;
    hostRole.controller.cancelPendingSwap.mockReturnValue(false);

    expect(flow.start({ reason: 'handover' })).toBe(false);
    expect(planned.start).not.toHaveBeenCalled();
  });
});

describe('HandoffFlow: «Leave server»', () => {
  it('хост с людьми отдаёт роль без ожидания раунда', async () => {
    const flow = create();

    hostRole.peerCount = 2;
    await flow.leaveByUser();

    expect(planned.start).toHaveBeenCalledWith({
      reason: 'leave',
      stay: false,
      defer: false,
    });
    expect(ui.reloadPage).not.toHaveBeenCalled();
  });

  it('хост один: host_closing, запись очков, host_leaving, уход (этап 10)', async () => {
    const flow = create();
    const order = [];

    signaling.hostClosing.mockImplementation(() => order.push('closing'));
    hostRole.controller.shutdown.mockImplementation(async () =>
      order.push('shutdown'),
    );
    signaling.hostLeaving.mockImplementation(() => order.push('leaving'));
    signaling.leaveRoom.mockImplementation(() => order.push('leaveRoom'));

    await flow.leaveByUser();

    expect(order).toEqual(['closing', 'shutdown', 'leaving', 'leaveRoom']);
    expect(ui.showSessionOverlay).toHaveBeenCalledWith('Leaving…');
    expect(hostRole.controller.shutdown).toHaveBeenCalledWith({
      timeoutMs: config.migration.leaveFlushTimeoutMs,
    });
    expect(hostRole.teardown).toHaveBeenCalled();
    expect(standby.teardown).toHaveBeenCalled();
    expect(membership.forget).toHaveBeenCalled();
    expect(ui.reloadPage).toHaveBeenCalledWith('');
  });

  it('повторный клик во время записи очков ничего не делает', async () => {
    const flow = create();
    let release;

    hostRole.controller.shutdown.mockReturnValue(
      new Promise(resolve => {
        release = resolve;
      }),
    );

    const first = flow.leaveByUser();

    await flow.leaveByUser();
    expect(signaling.hostClosing).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(ui.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('гость: LEAVE хосту и leave_room мастеру', async () => {
    hostRole.controller = null;

    await create().leaveByUser();

    expect(ui.sendLeave).toHaveBeenCalled();
    expect(signaling.leaveRoom).toHaveBeenCalledWith('room1');
    expect(ui.reloadPage).toHaveBeenCalledWith('');
  });

  it('announceGuestLeave вне комнаты шлёт только LEAVE', () => {
    ctx.roomId = null;
    create().announceGuestLeave();

    expect(ui.sendLeave).toHaveBeenCalled();
    expect(signaling.leaveRoom).not.toHaveBeenCalled();
  });
});

describe('HandoffFlow: просьбы мастера', () => {
  it('vote — передача сразу, без ожидания границы раунда', () => {
    create();
    signaling.emit('request_handoff', { ...ROOM, reason: 'vote' });

    expect(planned.start).toHaveBeenCalledWith({
      reason: 'vote',
      stay: true,
      defer: false,
    });
  });

  it('vote при ждущей передаче её торопит', () => {
    create();
    planned.hurry.mockReturnValue(true);
    signaling.emit('request_handoff', { ...ROOM, reason: 'vote' });

    expect(planned.hurry).toHaveBeenCalledWith('vote');
    expect(planned.start).not.toHaveBeenCalled();
  });

  it('network — передача с ожиданием границы раунда', () => {
    create();
    signaling.emit('request_handoff', { ...ROOM, reason: 'network' });

    expect(planned.start).toHaveBeenCalledWith({
      reason: 'network',
      stay: true,
      defer: true,
    });
  });

  it('network при выключенных автотриггерах — отказ', () => {
    config.migration.auto.enabled = false;
    create();
    signaling.emit('request_handoff', { ...ROOM, reason: 'network' });

    expect(planned.start).not.toHaveBeenCalled();
  });

  it('чужая эпоха игнорируется', () => {
    create();
    signaling.emit('request_handoff', {
      roomId: 'room1',
      epoch: 3,
      reason: 'vote',
    });

    expect(planned.start).not.toHaveBeenCalled();
  });

  it('опоздавший host_released — разжалование гостем', () => {
    create();
    signaling.emit('host_released', { roomId: 'room1', epoch: 5 });

    expect(promotion.demote).toHaveBeenCalledWith(5, { notice: false });
  });
});

describe('HandoffFlow: исходы передачи', () => {
  it('заморозка — пауза у своего игрока', () => {
    create();
    planned.options.onFrozen();

    expect(ui.showSessionOverlay).toHaveBeenCalledWith('Switching host…');
    expect(ui.disableControls).toHaveBeenCalled();
    expect(ui.mute).toHaveBeenCalled();
  });

  it('сорвалась: меню, эстафета снова, повтор по сроку входа, ввод', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const flow = create();

    hostRole.codeVersion = { engine: 'e1' };
    flow.armTokenHandoff();
    planned.options.onAborted({ reason: 'timeout', frozen: true });

    expect(ui.setHandoffMenu).toHaveBeenCalledWith('failed');
    expect(hostRole.refreshWorker).toHaveBeenCalled();
    expect(tokenTimer.retry).toHaveBeenCalled();
    expect(ui.showSessionOverlay).toHaveBeenCalledWith(null);
    expect(ui.enableControls).toHaveBeenCalled();
    expect(ui.unmute).toHaveBeenCalled();
  });

  it('released со stay — гостем к новому хосту под тем же оверлеем', () => {
    create();
    supervisor.state = 'reconnecting';
    planned.options.onReleased({ stay: true, epoch: 5 });

    expect(promotion.demote).toHaveBeenCalledWith(5, { notice: false });
    expect(ui.showSessionOverlay).toHaveBeenCalledWith('Switching host…');
  });

  it('released без stay — уход в лобби', () => {
    create();
    planned.options.onReleased({ stay: false, epoch: 5 });

    expect(promotion.demote).not.toHaveBeenCalled();
    expect(ui.reloadPage).toHaveBeenCalledWith('');
  });

  it('передача по сроку входа: только при роли и назначенной бете', () => {
    const flow = create();

    flow.armTokenHandoff();
    expect(tokenTimer.options.tryStart()).toBe(true);

    hostRole.successorMemberId = null;
    expect(tokenTimer.options.tryStart()).toBe(false);
  });

  it('автотриггеры получают роль, бету, скрытость и метрики', () => {
    const flow = create();

    flow.setHost(true);
    flow.setSuccessor(true);
    flow.setHidden(true);
    flow.addHealth({ tickRate: 30 });

    expect(policy.setHost).toHaveBeenCalledWith(true);
    expect(policy.setSuccessor).toHaveBeenCalledWith(true);
    expect(policy.setHidden).toHaveBeenLastCalledWith(true);
    expect(policy.addHealth).toHaveBeenCalledWith({ tickRate: 30 });
  });
});
