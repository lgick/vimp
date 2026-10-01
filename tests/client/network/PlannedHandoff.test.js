import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Publisher from '../../../packages/engine/src/lib/Publisher.js';
import PlannedHandoff, {
  controlsAfterAbort,
} from '../../../packages/engine/src/client/network/PlannedHandoff.js';

// Плановая передача хоста (host-migration этап 8.2): handoff_begin →
// handoff_go → заморозка и финальная точка → host_released; отказы и откат.
// Сигналинг и HostController — фейки.

const ROOM = { roomId: 'r1', epoch: 3 };

let signaling;
let controller;
let hooks;
let room;

const makeSignaling = () => ({
  publisher: new Publisher(),
  sent: [],
  handoffBegin(msg) {
    this.sent.push({ type: 'handoff_begin', ...msg });
  },
  hostLeaving(roomId, epoch) {
    this.sent.push({ type: 'host_leaving', roomId, epoch });
  },
});

const create = () =>
  new PlannedHandoff({
    signaling,
    getRoom: () => room,
    getController: () => controller,
    slowAfterMs: 3000,
    deadlineMs: 10000,
    ...hooks,
  });

const emit = (type, msg = {}) =>
  signaling.publisher.emit(type, { type, roomId: 'r1', ...msg });

const subscriptions = () =>
  ['handoff_go', 'handoff_unavailable', 'handoff_aborted', 'host_released']
    .map(type => signaling.publisher.subs[type]?.length ?? 0)
    .reduce((a, b) => a + b, 0);

beforeEach(() => {
  vi.useFakeTimers();
  signaling = makeSignaling();
  controller = {
    freeze: vi.fn(),
    unfreeze: vi.fn(),
    requestCheckpoint: vi.fn(),
    awaitRoundBoundary: vi.fn(cb => {
      controller.boundary = cb;
    }),
    cancelRoundBoundary: vi.fn(),
    boundary: null,
  };
  hooks = {
    onSlow: vi.fn(),
    onFrozen: vi.fn(),
    onReleased: vi.fn(),
    onAborted: vi.fn(),
    onLeave: vi.fn(),
  };
  room = { ...ROOM };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PlannedHandoff: счастливый путь', () => {
  it('stay: handoff_begin → go → заморозка и финальная точка → released', () => {
    const handoff = create();

    expect(handoff.start({ reason: 'handover', stay: true })).toBe(true);
    expect(signaling.sent).toEqual([
      {
        type: 'handoff_begin',
        roomId: 'r1',
        epoch: 3,
        reason: 'handover',
        stay: true,
      },
    ]);
    expect(controller.freeze).not.toHaveBeenCalled();

    emit('handoff_go', { epoch: 4 });

    expect(controller.freeze).toHaveBeenCalledTimes(1);
    expect(controller.requestCheckpoint).toHaveBeenCalledWith({ final: true });
    expect(controller.freeze.mock.invocationCallOrder[0]).toBeLessThan(
      controller.requestCheckpoint.mock.invocationCallOrder[0],
    );
    expect(hooks.onFrozen).toHaveBeenCalledWith({ epoch: 4 });

    emit('host_released', { epoch: 4 });

    expect(hooks.onReleased).toHaveBeenCalledWith({ stay: true, epoch: 4 });
    expect(handoff.active).toBe(false);
    expect(controller.unfreeze).not.toHaveBeenCalled();
    expect(subscriptions()).toBe(0);
  });

  it('!stay: released сообщает stay: false', () => {
    const handoff = create();

    handoff.start({ reason: 'leave', stay: false });
    expect(handoff.leaving).toBe(true);

    emit('handoff_go', { epoch: 4 });
    emit('host_released', { epoch: 4 });

    expect(hooks.onReleased).toHaveBeenCalledWith({ stay: false, epoch: 4 });
    expect(hooks.onLeave).not.toHaveBeenCalled();
    expect(signaling.sent.map(m => m.type)).toEqual(['handoff_begin']);
  });

  it('handoff_go до slowAfterMs — без onSlow', () => {
    create().start({ reason: 'handover' });

    emit('handoff_go', { epoch: 4 });
    vi.advanceTimersByTime(3000);

    expect(hooks.onSlow).not.toHaveBeenCalled();
  });
});

describe('PlannedHandoff: отказы', () => {
  it('handoff_unavailable при stay — хост остаётся, без заморозки', () => {
    const handoff = create();

    handoff.start({ reason: 'handover', stay: true });
    emit('handoff_unavailable', { reason: 'noSuccessor' });

    expect(hooks.onAborted).toHaveBeenCalledWith({
      reason: 'noSuccessor',
      frozen: false,
    });
    expect(controller.freeze).not.toHaveBeenCalled();
    expect(handoff.active).toBe(false);
    expect(subscriptions()).toBe(0);
  });

  it('handoff_unavailable при leave — host_leaving и уход всё равно', () => {
    create().start({ reason: 'leave', stay: false });
    emit('handoff_unavailable', { reason: 'noSuccessor' });

    expect(signaling.sent.at(-1)).toEqual({
      type: 'host_leaving',
      roomId: 'r1',
      epoch: 3,
    });
    expect(hooks.onLeave).toHaveBeenCalledWith({ reason: 'noSuccessor' });
    expect(hooks.onAborted).not.toHaveBeenCalled();
  });

  it('нет handoff_go за slowAfterMs — onSlow, но не отказ', () => {
    const handoff = create();

    handoff.start({ reason: 'handover' });
    vi.advanceTimersByTime(2999);
    expect(hooks.onSlow).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(hooks.onSlow).toHaveBeenCalledTimes(1);
    expect(hooks.onAborted).not.toHaveBeenCalled();
    // передача ещё идёт: повтор заблокирован
    expect(handoff.active).toBe(true);
    expect(handoff.start({ reason: 'handover' })).toBe(false);
  });

  it('поздний handoff_go до дедлайна — заморозка и финальная точка', () => {
    const handoff = create();

    handoff.start({ reason: 'handover' });
    vi.advanceTimersByTime(5000);
    emit('handoff_go', { epoch: 4 });

    expect(controller.freeze).toHaveBeenCalledTimes(1);
    expect(controller.requestCheckpoint).toHaveBeenCalledWith({ final: true });
    expect(hooks.onFrozen).toHaveBeenCalledWith({ epoch: 4 });

    emit('host_released', { epoch: 4 });
    expect(hooks.onReleased).toHaveBeenCalledWith({ stay: true, epoch: 4 });
    expect(hooks.onAborted).not.toHaveBeenCalled();
  });

  it('дедлайн без ответа — окончательная отмена timeout', () => {
    const handoff = create();

    handoff.start({ reason: 'handover' });
    vi.advanceTimersByTime(9999);
    expect(hooks.onAborted).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(hooks.onAborted).toHaveBeenCalledWith({
      reason: 'timeout',
      frozen: false,
    });
    expect(controller.unfreeze).not.toHaveBeenCalled();
    expect(handoff.active).toBe(false);
    expect(subscriptions()).toBe(0);
  });

  it('дедлайн замороженным (нет ни released, ни aborted) — unfreeze', () => {
    create().start({ reason: 'handover' });
    vi.advanceTimersByTime(2000);
    emit('handoff_go', { epoch: 4 });
    vi.advanceTimersByTime(8000);

    expect(controller.unfreeze).toHaveBeenCalledTimes(1);
    expect(hooks.onAborted).toHaveBeenCalledWith({
      reason: 'timeout',
      frozen: true,
    });
  });

  it('дедлайн при leave — host_leaving и уход; до дедлайна ждёт', () => {
    create().start({ reason: 'leave', stay: false });
    vi.advanceTimersByTime(3000);
    expect(hooks.onLeave).not.toHaveBeenCalled();

    vi.advanceTimersByTime(7000);
    expect(hooks.onLeave).toHaveBeenCalledWith({ reason: 'timeout' });
    expect(signaling.sent.at(-1).type).toBe('host_leaving');
  });

  it('handoff_aborted после заморозки — unfreeze, матч продолжается', () => {
    const handoff = create();

    handoff.start({ reason: 'handover' });
    emit('handoff_go', { epoch: 4 });
    emit('handoff_aborted', { epoch: 3 });

    expect(controller.unfreeze).toHaveBeenCalledTimes(1);
    expect(hooks.onAborted).toHaveBeenCalledWith({
      reason: 'aborted',
      frozen: true,
    });
    expect(handoff.active).toBe(false);

    // поздний host_released сорванной передачи — не наш
    emit('host_released', { epoch: 4 });
    expect(hooks.onReleased).not.toHaveBeenCalled();
  });

  it('handoff_aborted при leave — без разморозки, host_leaving и уход', () => {
    create().start({ reason: 'leave', stay: false });
    emit('handoff_go', { epoch: 4 });
    emit('handoff_aborted', { epoch: 3 });

    expect(controller.unfreeze).not.toHaveBeenCalled();
    expect(signaling.sent.at(-1).type).toBe('host_leaving');
    expect(hooks.onLeave).toHaveBeenCalledWith({ reason: 'aborted' });
  });

  it('обрыв сигналинга замороженным — unfreeze без host_leaving', () => {
    create().start({ reason: 'handover' });
    emit('handoff_go', { epoch: 4 });
    signaling.publisher.emit('close', {});

    expect(controller.unfreeze).toHaveBeenCalledTimes(1);
    expect(hooks.onAborted).toHaveBeenCalledWith({
      reason: 'signalingLost',
      frozen: true,
    });
  });

  it('обрыв сигналинга уходящим — уход без host_leaving', () => {
    create().start({ reason: 'leave', stay: false });
    signaling.publisher.emit('close', {});

    expect(hooks.onLeave).toHaveBeenCalledWith({ reason: 'signalingLost' });
    expect(signaling.sent.map(m => m.type)).toEqual(['handoff_begin']);
  });
});

describe('PlannedHandoff: ограждения', () => {
  it('повторный start во время передачи игнорируется', () => {
    const handoff = create();

    expect(handoff.start({ reason: 'handover' })).toBe(true);
    expect(handoff.start({ reason: 'leave', stay: false })).toBe(false);
    expect(signaling.sent).toHaveLength(1);

    emit('handoff_go', { epoch: 4 });
    expect(handoff.start({ reason: 'handover' })).toBe(false);
  });

  it('не хост (нет комнаты или Worker’а) — start отклонён', () => {
    room = null;
    expect(create().start({ reason: 'handover' })).toBe(false);

    room = { ...ROOM };
    controller = null;
    expect(create().start({ reason: 'handover' })).toBe(false);
    expect(signaling.sent).toEqual([]);
  });

  it('сообщения чужой комнаты и до start игнорируются', () => {
    const handoff = create();

    emit('handoff_go', { epoch: 4 });
    expect(controller.freeze).not.toHaveBeenCalled();

    handoff.start({ reason: 'handover' });
    signaling.publisher.emit('handoff_go', { roomId: 'other', epoch: 4 });
    signaling.publisher.emit('host_released', { roomId: 'other', epoch: 4 });

    expect(controller.freeze).not.toHaveBeenCalled();
    expect(hooks.onReleased).not.toHaveBeenCalled();
    expect(handoff.active).toBe(true);
  });

  it('повторный handoff_go не замораживает дважды', () => {
    create().start({ reason: 'handover' });
    emit('handoff_go', { epoch: 4 });
    emit('handoff_go', { epoch: 4 });

    expect(controller.freeze).toHaveBeenCalledTimes(1);
    expect(controller.requestCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('abort — тихо: без колбэков, подписки и таймер сняты', () => {
    const handoff = create();

    handoff.start({ reason: 'leave', stay: false });
    handoff.abort();
    vi.advanceTimersByTime(3000);
    emit('handoff_go', { epoch: 4 });

    expect(handoff.active).toBe(false);
    expect(controller.freeze).not.toHaveBeenCalled();
    expect(hooks.onLeave).not.toHaveBeenCalled();
    expect(subscriptions()).toBe(0);
    expect(signaling.publisher.subs.close).toHaveLength(0);
  });
});

describe('PlannedHandoff: ожидание границы раунда (defer)', () => {
  it('handoff_begin уходит на границе раунда; дедлайн — от него', () => {
    const handoff = create();

    expect(handoff.start({ reason: 'handover', stay: true, defer: true })).toBe(
      true,
    );
    expect(handoff.active).toBe(true);
    expect(handoff.deferred).toBe(true);
    expect(signaling.sent).toEqual([]);

    // ожидание границы не считается медленным ответом мастера
    vi.advanceTimersByTime(20000);
    expect(hooks.onSlow).not.toHaveBeenCalled();
    expect(handoff.start({ reason: 'handover' })).toBe(false);

    controller.boundary();
    expect(handoff.deferred).toBe(false);
    expect(signaling.sent).toEqual([
      {
        type: 'handoff_begin',
        roomId: 'r1',
        epoch: 3,
        reason: 'handover',
        stay: true,
      },
    ]);

    vi.advanceTimersByTime(3000);
    expect(hooks.onSlow).toHaveBeenCalledOnce();
    emit('handoff_go', { epoch: 4 });
    expect(controller.freeze).toHaveBeenCalledOnce();
  });

  it('потолок deferMaxMs: граница не наступила — передача всё равно', () => {
    const handoff = new PlannedHandoff({
      signaling,
      getRoom: () => room,
      getController: () => controller,
      deferMaxMs: 30000,
      ...hooks,
    });

    handoff.start({ reason: 'handover', stay: true, defer: true });
    vi.advanceTimersByTime(29999);
    expect(signaling.sent).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(controller.cancelRoundBoundary).toHaveBeenCalledOnce();
    expect(signaling.sent.map(m => m.type)).toEqual(['handoff_begin']);

    // поздняя граница после потолка — не второй handoff_begin
    controller.boundary();
    expect(signaling.sent).toHaveLength(1);
  });

  it('handoff_aborted во время ожидания — не про эту передачу', () => {
    const handoff = create();

    handoff.start({ reason: 'handover', stay: true, defer: true });
    emit('handoff_aborted', { epoch: 3 });

    expect(handoff.deferred).toBe(true);
    expect(hooks.onAborted).not.toHaveBeenCalled();
  });

  it('abort во время ожидания снимает его в Worker’е', () => {
    const handoff = create();

    handoff.start({ reason: 'handover', stay: true, defer: true });
    handoff.abort();
    vi.advanceTimersByTime(60000);

    expect(controller.cancelRoundBoundary).toHaveBeenCalledOnce();
    expect(signaling.sent).toEqual([]);
    expect(subscriptions()).toBe(0);
  });

  it('обрыв сигналинга во время ожидания — отмена, вкладка остаётся хостом', () => {
    const handoff = create();

    handoff.start({ reason: 'handover', stay: true, defer: true });
    signaling.publisher.emit('close');

    expect(hooks.onAborted).toHaveBeenCalledWith({
      reason: 'signalingLost',
      frozen: false,
    });
    expect(controller.cancelRoundBoundary).toHaveBeenCalledOnce();
    expect(controller.unfreeze).not.toHaveBeenCalled();
  });
});

describe('PlannedHandoff: автотриггеры над ожиданием границы (этап 9b)', () => {
  it('hurry: ожидание снято, handoff_begin сразу с новой причиной', () => {
    const handoff = create();

    handoff.start({ reason: 'overload', stay: true, defer: true });
    expect(handoff.reason).toBe('overload');

    expect(handoff.hurry('hidden')).toBe(true);
    expect(controller.cancelRoundBoundary).toHaveBeenCalledOnce();
    expect(handoff.deferred).toBe(false);
    expect(signaling.sent).toEqual([
      {
        type: 'handoff_begin',
        roomId: 'r1',
        epoch: 3,
        reason: 'hidden',
        stay: true,
      },
    ]);

    // потолок ожидания снят вместе с ним
    controller.boundary();
    vi.advanceTimersByTime(30000);
    expect(signaling.sent).toHaveLength(1);
  });

  it('hurry вне ожидания — false, ничего не шлёт', () => {
    const handoff = create();

    expect(handoff.hurry('overload')).toBe(false);
    handoff.start({ reason: 'handover', stay: true });
    expect(handoff.hurry('overload')).toBe(false);
    expect(signaling.sent).toHaveLength(1);
  });

  it('cancelDeferred: тихо снимает ожидание в Worker’е', () => {
    const handoff = create();

    handoff.start({ reason: 'overload', stay: true, defer: true });

    expect(handoff.cancelDeferred()).toBe(true);
    expect(controller.cancelRoundBoundary).toHaveBeenCalledOnce();
    expect(handoff.active).toBe(false);
    expect(handoff.reason).toBe(null);
    expect(subscriptions()).toBe(0);
    expect(hooks.onAborted).not.toHaveBeenCalled();

    // ни граница, ни потолок не запускают снятую передачу
    controller.boundary();
    vi.advanceTimersByTime(60000);
    expect(signaling.sent).toEqual([]);
    expect(handoff.start({ reason: 'overload', defer: true })).toBe(true);
  });

  it('cancelDeferred после handoff_begin — false, передача идёт', () => {
    const handoff = create();

    handoff.start({ reason: 'overload', stay: true, defer: true });
    controller.boundary();

    expect(handoff.cancelDeferred()).toBe(false);
    expect(handoff.active).toBe(true);
    expect(controller.cancelRoundBoundary).not.toHaveBeenCalled();
  });
});

describe('controlsAfterAbort', () => {
  it('живому месту — оверлей снят, ввод и звук возвращены', () => {
    expect(
      controlsAfterAbort({ frozen: true, sessionState: 'inGame' }),
    ).toEqual({ hideOverlay: true, restoreInput: true });
  });

  it('потерянному своему игроку — только оверлей, ввод не включается', () => {
    expect(
      controlsAfterAbort({ frozen: true, sessionState: 'closed' }),
    ).toEqual({ hideOverlay: true, restoreInput: false });
    expect(controlsAfterAbort({ frozen: true, sessionState: null })).toEqual({
      hideOverlay: true,
      restoreInput: false,
    });
  });

  it('матч не замораживался — трогать нечего', () => {
    expect(
      controlsAfterAbort({ frozen: false, sessionState: 'inGame' }),
    ).toEqual({ hideOverlay: false, restoreInput: false });
  });
});
