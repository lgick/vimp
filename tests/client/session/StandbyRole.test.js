import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Publisher from '../../../packages/engine/src/lib/Publisher.js';
import StandbyRole from '../../../packages/engine/src/client/session/StandbyRole.js';
import { createRoomContext } from '../../../packages/engine/src/client/session/roomContext.js';
import { makeConfig, makeSignaling } from './sessionFakes.js';

// Роль беты: назначение мастера → приём точки → standby_status и прогрев;
// смена эпохи и освобождение сбрасывают роль.

const NOW = 5_000_000;
const GAME = { id: 'tanks', versions: ['1.0.0'] };

let signaling;
let ctx;
let isHost;
let receivers;
let prewarms;

const makeReceiver = () => {
  const receiver = {
    publisher: new Publisher(),
    checkpoint: null,
    latest: () => receiver.checkpoint,
    attach: vi.fn(),
    noteFrame: vi.fn(),
    discardFinal: vi.fn(),
    destroy: vi.fn(),
    // точка собрана: как StandbyReceiver после последнего чанка
    deliver(checkpoint) {
      receiver.checkpoint = checkpoint;
      receiver.publisher.emit('checkpoint', checkpoint);
    },
  };

  receivers.push(receiver);

  return receiver;
};

const makePrewarm = options => {
  const prewarm = { options, warm: vi.fn(), destroy: vi.fn() };

  prewarms.push(prewarm);

  return prewarm;
};

const checkpoint = (id = 1) => ({
  checkpointId: id,
  createdAt: NOW - 400,
  receivedAt: NOW - 300,
  bytes: new Uint8Array(10),
});

const create = () => {
  const role = new StandbyRole({
    signaling,
    ctx,
    isHost: () => isHost,
    prepareRoom: vi.fn(),
    diagnostics: { warn: vi.fn() },
    config: makeConfig().migration,
    createReceiver: makeReceiver,
    createPrewarm: makePrewarm,
    now: () => Date.now(),
  });

  role.bind();

  return role;
};

const assign = (msg = {}) =>
  signaling.emit('standby_assigned', {
    roomId: 'room1',
    epoch: 2,
    game: GAME,
    ...msg,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  signaling = makeSignaling();
  ctx = createRoomContext();
  ctx.roomId = 'room1';
  isHost = false;
  receivers = [];
  prewarms = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StandbyRole: назначение и точка', () => {
  it('назначение → точка → standby_status с возрастом точки и прогрев', () => {
    const role = create();

    assign();
    expect(signaling.standbyStatus).not.toHaveBeenCalled();

    receivers[0].deliver(checkpoint(7));

    expect(signaling.standbyStatus).toHaveBeenCalledWith({
      roomId: 'room1',
      epoch: 2,
      checkpointId: 7,
      createdAt: NOW - 400,
      ageMs: 300,
    });
    expect(prewarms).toHaveLength(1);
    expect(prewarms[0].warm).toHaveBeenCalledWith(receivers[0].checkpoint, {
      allowedGame: GAME,
    });
    expect(role.role).toEqual({ roomId: 'room1', epoch: 2, game: GAME });
  });

  it('статус повторяется по интервалу', () => {
    create();
    assign();
    receivers[0].deliver(checkpoint());
    vi.advanceTimersByTime(2000);

    expect(signaling.standbyStatus).toHaveBeenCalledTimes(3);
  });

  it('канал открылся раньше назначения: обязанности — с назначением', () => {
    const role = create();
    const channel = {};

    role.attach(channel);
    receivers[0].deliver(checkpoint());
    expect(signaling.standbyStatus).not.toHaveBeenCalled();

    assign();

    expect(receivers).toHaveLength(1);
    expect(receivers[0].attach).toHaveBeenCalledWith(channel);
    expect(signaling.standbyStatus).toHaveBeenCalledTimes(1);
    expect(prewarms).toHaveLength(1);
  });

  it('хост и чужая комната назначение игнорируют', () => {
    const role = create();

    assign({ roomId: 'other' });
    isHost = true;
    assign();

    expect(role.role).toBeNull();
    expect(receivers).toHaveLength(0);
  });
});

describe('StandbyRole: сброс', () => {
  it('смена эпохи сбрасывает приёмник и прогрев', () => {
    const role = create();

    assign();
    receivers[0].deliver(checkpoint());
    assign({ epoch: 3 });

    expect(receivers[0].destroy).toHaveBeenCalled();
    expect(prewarms[0].destroy).toHaveBeenCalled();
    expect(receivers).toHaveLength(2);
    expect(role.role.epoch).toBe(3);

    signaling.standbyStatus.mockClear();
    vi.advanceTimersByTime(5000);
    expect(signaling.standbyStatus).not.toHaveBeenCalled();
  });

  it('standby_released своей комнаты снимает роль', () => {
    const role = create();

    assign();
    receivers[0].deliver(checkpoint());
    signaling.emit('standby_released', { roomId: 'other' });
    expect(role.role).not.toBeNull();

    signaling.emit('standby_released', { roomId: 'room1' });

    expect(role.role).toBeNull();
    expect(role.receiver).toBeNull();
    expect(role.prewarm).toBeNull();
    expect(receivers[0].destroy).toHaveBeenCalled();
  });

  it('кадры и сброс финальной точки — приёмнику, если он есть', () => {
    const role = create();

    expect(() => role.noteFrame(new ArrayBuffer(4))).not.toThrow();

    role.ensureReceiver();
    role.noteFrame('frame');
    role.discardFinal();

    expect(receivers[0].noteFrame).toHaveBeenCalledWith('frame');
    expect(receivers[0].discardFinal).toHaveBeenCalled();
  });
});
