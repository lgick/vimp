import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Membership from '../../../packages/engine/src/client/session/Membership.js';
import { createRoomContext } from '../../../packages/engine/src/client/session/roomContext.js';
import { makeConfig, makeSignaling } from './sessionFakes.js';

// Членство вкладки в комнате: join_room, его повтор (этап 6 ревью), caps
// для выбора беты и их пересылка по сроку входа.

const NOW = 1_000_000;

let signaling;
let ctx;
let isHost;
let expiresAt;

const create = (extra = {}) =>
  new Membership({
    signaling,
    ctx,
    memberId: 'm1',
    getToken: () => 'jwt',
    getTokenExpiresAt: () => expiresAt,
    isHost: () => isHost,
    config: makeConfig(),
    canHost: () => true,
    now: () => Date.now(),
    ...extra,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  signaling = makeSignaling();
  ctx = createRoomContext();
  ctx.roomId = 'room1';
  isHost = false;
  expiresAt = NOW + 3_600_000;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Membership: join_room', () => {
  it('объявляет членство с токеном и возможностями вкладки', () => {
    const membership = create();

    membership.sendJoinRoom();

    expect(ctx.memberJoined).toBe(true);
    expect(signaling.joinRoom).toHaveBeenCalledWith({
      roomId: 'room1',
      memberId: 'm1',
      token: 'jwt',
      caps: expect.objectContaining({ canHost: true }),
    });
  });

  it('повторяет join_room по schedule, пока не остановлен', () => {
    const membership = create();

    membership.sendJoinRoom();
    membership.scheduleJoinRetry();
    vi.advanceTimersByTime(1000);

    expect(signaling.joinRoom).toHaveBeenCalledTimes(2);

    membership.stopJoinRetry();
    membership.scheduleJoinRetry();
    membership.forget();
    vi.advanceTimersByTime(10_000);

    expect(signaling.joinRoom).toHaveBeenCalledTimes(2);
    expect(ctx.memberJoined).toBe(false);
  });
});

describe('Membership: caps', () => {
  it('короткий вход гасит canHost', () => {
    expiresAt = NOW + 30_000;

    expect(create().caps().canHost).toBe(false);
  });

  it('у хоста нет ни типа кандидата, ни FPS гостя', () => {
    const membership = create();

    membership.setIceType('host');
    membership.setFps(55);

    expect(membership.caps()).toMatchObject({ iceType: 'host', fps: 55 });

    isHost = true;

    expect(membership.caps().iceType ?? null).toBeNull();
    expect(membership.caps().fps ?? null).toBeNull();
  });

  it('проба модульного Worker считается один раз', () => {
    const canHost = vi.fn(() => true);
    const membership = create({ canHost });

    membership.caps();
    membership.caps();

    expect(canHost).toHaveBeenCalledTimes(1);
  });
});

describe('Membership: member_update', () => {
  it('тип кандидата уходит мастеру только из комнаты', () => {
    const membership = create();

    membership.setIceType('relay');
    expect(signaling.memberUpdate).toHaveBeenCalledWith(
      'room1',
      expect.objectContaining({ iceType: 'relay' }),
    );

    ctx.roomId = null;
    membership.setIceType('host');
    expect(signaling.memberUpdate).toHaveBeenCalledTimes(1);
  });

  it('FPS хоста мастеру не шлётся', () => {
    isHost = true;
    create().setFps(30);

    expect(signaling.memberUpdate).not.toHaveBeenCalled();
  });

  it('срок входа: caps пересылаются, когда его станет мало для хоста', () => {
    expiresAt = NOW + 100_000;

    const membership = create();

    membership.armTokenCapsTimer();
    vi.advanceTimersByTime(39_999);
    expect(signaling.memberUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(signaling.memberUpdate).toHaveBeenCalledWith(
      'room1',
      expect.objectContaining({ canHost: false }),
    );
  });

  it('снятый таймер срока не срабатывает', () => {
    expiresAt = NOW + 100_000;

    const membership = create();

    membership.armTokenCapsTimer();
    membership.clearTokenCapsTimer();
    vi.advanceTimersByTime(100_000);

    expect(signaling.memberUpdate).not.toHaveBeenCalled();
  });
});
