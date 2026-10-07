import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Publisher from '../../../packages/engine/src/lib/Publisher.js';
import GuestSession from '../../../packages/engine/src/client/session/GuestSession.js';
import Membership from '../../../packages/engine/src/client/session/Membership.js';
import { createRoomContext } from '../../../packages/engine/src/client/session/roomContext.js';
import { makeConfig, makeSignaling } from './sessionFakes.js';

// Сессия гостя: вход и переподключение, смена хоста, реконнект сигналинга,
// «Change host», отказы мастера. Сценарии F4 (офферы во время миграции) и
// F9 (членство после рестарта мастера) — целиком на фейковом сигналинге и
// транспорте.

let signaling;
let ctx;
let membership;
let hostRole;
let standby;
let promotion;
let supervisor;
let ui;
let transports;
let logout;
let diagnostics;

const makeTransport = (sig, options) => {
  const transport = {
    options,
    publisher: new Publisher(),
    epoch: null,
    isOpen: false,
    connect: vi.fn(async () => {}),
    close: vi.fn(),
  };

  transports.push(transport);

  return transport;
};

const create = () => {
  const guest = new GuestSession({
    signaling,
    ctx,
    membership,
    hostRole,
    standby,
    getPromotion: () => promotion,
    getSupervisor: () => supervisor,
    getToken: () => 'jwt',
    logout,
    config: makeConfig(),
    diagnostics,
    ui,
    factories: { transport: makeTransport },
  });

  guest.bind();

  return guest;
};

const makeMembership = () =>
  new Membership({
    signaling,
    ctx,
    memberId: 'm1',
    getToken: () => 'jwt',
    getTokenExpiresAt: () => null,
    isHost: () => Boolean(hostRole.controller),
    config: makeConfig(),
    canHost: () => true,
  });

beforeEach(() => {
  vi.useFakeTimers();
  signaling = makeSignaling();
  ctx = createRoomContext();
  hostRole = {
    controller: null,
    room: null,
    promotion: null,
    reRegister: vi.fn(),
  };
  membership = makeMembership();
  standby = { attach: vi.fn() };
  promotion = { abandon: vi.fn(), demote: vi.fn() };
  supervisor = {
    state: 'inGame',
    transport: null,
    migrate: vi.fn(),
    extendMigration: vi.fn(),
    hostChanged: vi.fn(),
  };
  ui = {
    ensureWebRtc: () => true,
    showRoomLink: vi.fn(),
    startSession: vi.fn(transport => {
      supervisor.transport = transport;
    }),
    closeLobby: vi.fn(),
    leaveRoomWith: vi.fn(),
    chat: vi.fn(),
    getVote: () => vote,
  };
  transports = [];
  logout = vi.fn();
  diagnostics = { warn: vi.fn() };
  vote = { openEngineVote: vi.fn(), closeEngineVote: vi.fn() };
});

let vote;

afterEach(() => {
  vi.useRealTimers();
});

describe('GuestSession: вход и транспорт', () => {
  it('connectToRoom: комната, ссылка, сессия с переподключением', () => {
    const guest = create();

    ctx.epoch = 4;
    guest.connectToRoom('room1');

    expect(ctx).toMatchObject({ roomId: 'room1', entered: true });
    expect(ui.showRoomLink).toHaveBeenCalledWith('room1');
    expect(transports[0].options).toMatchObject({
      memberId: 'm1',
      resume: false,
      minEpoch: 4,
    });
    expect(transports[0].connect).toHaveBeenCalledWith('room1');

    const [transport, reconnect] = ui.startSession.mock.calls[0];

    expect(transport).toBe(transports[0]);
    expect(reconnect.getToken()).toBe('jwt');
    reconnect.createTransport();
    expect(transports[1].options.resume).toBe(true);
    expect(ui.closeLobby).toHaveBeenCalled();
  });

  it('без WebRTC в комнату не входит', () => {
    ui.ensureWebRtc = () => false;
    create().connectToRoom('room1');

    expect(ctx.roomId).toBeNull();
    expect(transports).toHaveLength(0);
  });

  it('открытый транспорт задаёт эпоху; iceType — мастеру; standby — бете', () => {
    const guest = create();

    guest.connectToRoom('room1');

    const [transport] = transports;
    const channel = {};

    transport.epoch = 7;
    transport.publisher.emit('open');
    transport.publisher.emit('iceType', 'relay');
    transport.publisher.emit('standby', channel);

    expect(ctx.epoch).toBe(7);
    expect(signaling.memberUpdate).toHaveBeenCalledWith(
      'room1',
      expect.objectContaining({ iceType: 'relay' }),
    );
    expect(standby.attach).toHaveBeenCalledWith(channel);
  });

  it('сбой connect закрывает транспорт', async () => {
    const guest = new GuestSession({
      signaling,
      ctx,
      membership,
      hostRole,
      standby,
      getPromotion: () => promotion,
      getSupervisor: () => supervisor,
      getToken: () => 'jwt',
      logout,
      config: makeConfig(),
      diagnostics,
      ui,
      factories: {
        transport: (sig, options) => {
          const transport = makeTransport(sig, options);

          transport.connect = vi.fn(async () => {
            throw new Error('offline');
          });

          return transport;
        },
      },
    });

    guest.openTransport('room1');

    await vi.waitFor(() => expect(transports[0].close).toHaveBeenCalled());
  });

  it('недоступность хоста — мастеру с эпохой транспорта', () => {
    const guest = create();

    guest.reportHostUnreachable();
    expect(signaling.hostUnreachable).not.toHaveBeenCalled();

    ctx.roomId = 'room1';
    ctx.epoch = 3;
    guest.reportHostUnreachable();
    expect(signaling.hostUnreachable).toHaveBeenCalledWith('room1', 3);

    hostRole.controller = {};
    guest.reportHostUnreachable();
    expect(signaling.hostUnreachable).toHaveBeenCalledTimes(1);
  });
});

describe('GuestSession: смена хоста', () => {
  beforeEach(() => {
    ctx.roomId = 'room1';
    ctx.epoch = 2;
  });

  it('host_migrating новой эпохи — пауза; повтор — дольше ждать', () => {
    create();
    signaling.emit('host_migrating', { roomId: 'room1', epoch: 3, waitMs: 5 });
    expect(supervisor.migrate).toHaveBeenCalledWith({ waitMs: 5 });

    supervisor.state = 'migrating';
    signaling.emit('host_migrating', { roomId: 'room1', epoch: 3, waitMs: 9 });
    expect(supervisor.extendMigration).toHaveBeenCalledWith(9);
  });

  it('host_migrating старой эпохи, чужой комнаты и у хоста — игнор', () => {
    create();
    signaling.emit('host_migrating', { roomId: 'room1', epoch: 2 });
    signaling.emit('host_migrating', { roomId: 'other', epoch: 9 });
    hostRole.controller = {};
    signaling.emit('host_migrating', { roomId: 'room1', epoch: 9 });

    expect(supervisor.migrate).not.toHaveBeenCalled();
  });

  it('host_changed: эпоха и возобновление у нового хоста', () => {
    create();
    signaling.emit('host_changed', {
      roomId: 'room1',
      epoch: 2,
      mode: 'resume',
    });

    expect(ctx.epoch).toBe(2);
    expect(supervisor.hostChanged).toHaveBeenCalledWith({ mode: 'resume' });

    signaling.emit('host_changed', { roomId: 'room1', epoch: 1, mode: 'cold' });
    expect(supervisor.hostChanged).toHaveBeenCalledTimes(1);
  });

  it('room_closed: повторы входа сняты, уход с причиной', () => {
    create();
    signaling.emit('room_closed', { roomId: 'room1' });

    expect(ui.leaveRoomWith).toHaveBeenCalledWith(
      'The host left — the room is closed. Finding another room…',
    );
  });
});

describe('GuestSession: F4 — unknownRoom во время офферов', () => {
  it('оффер к хосту, комнаты уже нет — уход', () => {
    const guest = create();

    guest.connectToRoom('room1');
    signaling.emit('error', {
      code: 'unknownRoom',
      re: 'webrtc_offer',
      roomId: 'room1',
    });

    expect(ui.leaveRoomWith).toHaveBeenCalledWith(
      'Room no longer exists. Finding another room…',
    );
  });

  it('тот же отказ во время смены хоста — комнату не бросаем', () => {
    const guest = create();

    guest.connectToRoom('room1');
    supervisor.state = 'migrating';
    signaling.emit('error', {
      code: 'unknownRoom',
      re: 'webrtc_offer',
      roomId: 'room1',
    });

    expect(ui.leaveRoomWith).not.toHaveBeenCalled();
  });

  it('открытый транспорт — оффера нет, отказ не про нас', () => {
    const guest = create();

    guest.connectToRoom('room1');
    transports[0].isOpen = true;
    signaling.emit('error', { code: 'unknownRoom', re: 'webrtc_offer' });

    expect(ui.leaveRoomWith).not.toHaveBeenCalled();
  });

  it('отказ про чужую комнату игнорируется', () => {
    const guest = create();

    guest.connectToRoom('room1');
    signaling.emit('error', { code: 'unknownRoom', roomId: 'other' });

    expect(ui.leaveRoomWith).not.toHaveBeenCalled();
  });
});

describe('GuestSession: F9 — членство после рестарта мастера', () => {
  it('welcome возвращает членство; unknownRoom — повтор до room_joined', () => {
    create();
    ctx.roomId = 'room1';
    membership.sendJoinRoom();
    signaling.joinRoom.mockClear();

    // мастер рестартовал: сигналинг переподключился раньше хоста
    signaling.emit('welcome');
    expect(signaling.joinRoom).toHaveBeenCalledTimes(1);

    signaling.emit('error', {
      code: 'unknownRoom',
      re: 'join_room',
      roomId: 'room1',
    });
    vi.advanceTimersByTime(1000);
    expect(signaling.joinRoom).toHaveBeenCalledTimes(2);

    // снова отказ, но хост вернул комнату раньше следующей попытки —
    // мастер принял членство, повтор снимается
    signaling.emit('error', {
      code: 'unknownRoom',
      re: 'join_room',
      roomId: 'room1',
    });
    signaling.emit('room_joined', { roomId: 'room1' });
    vi.advanceTimersByTime(60_000);

    expect(signaling.joinRoom).toHaveBeenCalledTimes(2);
    expect(ui.leaveRoomWith).not.toHaveBeenCalled();
  });

  it('хост после welcome возвращает комнату reclaim’ом', () => {
    create();
    hostRole.controller = {};
    signaling.emit('welcome');

    expect(hostRole.reRegister).toHaveBeenCalled();
    expect(signaling.joinRoom).not.toHaveBeenCalled();
  });

  it('обрыв сигналинга — переподключение с бэкоффом', () => {
    create();
    signaling.emit('close');
    vi.advanceTimersByTime(999);
    expect(signaling.connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(signaling.connect).toHaveBeenCalledTimes(1);

    signaling.emit('close');
    vi.advanceTimersByTime(1999);
    expect(signaling.connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(signaling.connect).toHaveBeenCalledTimes(2);
  });
});

describe('GuestSession: переподключение сигналинга хоста', () => {
  it('вкладка-хост: первая попытка сразу, дальше 1 с, 2 с; welcome сбрасывает', () => {
    create();
    hostRole.controller = {};

    signaling.emit('close');
    vi.advanceTimersByTime(0);
    expect(signaling.connect).toHaveBeenCalledTimes(1);

    signaling.emit('close');
    vi.advanceTimersByTime(999);
    expect(signaling.connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(signaling.connect).toHaveBeenCalledTimes(2);

    signaling.emit('close');
    vi.advanceTimersByTime(1999);
    expect(signaling.connect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(signaling.connect).toHaveBeenCalledTimes(3);

    signaling.emit('welcome');
    signaling.emit('close');
    vi.advanceTimersByTime(0);
    expect(signaling.connect).toHaveBeenCalledTimes(4);
  });
});

describe('GuestSession: прочие отказы мастера', () => {
  beforeEach(() => {
    ctx.roomId = 'room1';
  });

  it('invalidToken на join_room в матче — играем дальше', () => {
    create();
    signaling.emit('error', { code: 'invalidToken', re: 'join_room' });

    expect(diagnostics.warn).toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it('invalidToken в комнате — выход и уход', () => {
    create();
    signaling.emit('error', { code: 'invalidToken', re: 'host_vote_start' });

    expect(logout).toHaveBeenCalled();
    expect(ui.leaveRoomWith).toHaveBeenCalled();
  });

  it('invalidToken промоушена — роль снимается', () => {
    create();
    hostRole.promotion = { mode: 'cold' };
    signaling.emit('error', { code: 'invalidToken', re: 'register_host' });

    expect(promotion.abandon).toHaveBeenCalledWith({
      code: 'invalidToken',
      report: true,
    });
  });

  it('hostLimit у хоста — несостоявшийся старт', () => {
    create();
    hostRole.controller = {};
    signaling.emit('error', { code: 'hostLimit' });

    expect(ctx.startFailed).toBe(true);
    expect(ui.leaveRoomWith).toHaveBeenCalled();
  });

  it('roomTaken — новая регистрация', () => {
    create();
    hostRole.controller = {};
    signaling.emit('error', { code: 'roomTaken' });

    expect(hostRole.reRegister).toHaveBeenCalledWith({ fresh: true });
  });

  it('staleEpoch: преемник бросает промоушен, бывший хост — гость', () => {
    create();
    hostRole.controller = {};
    hostRole.room = { roomId: 'room1', epoch: 4 };
    signaling.emit('error', { code: 'staleEpoch' });
    expect(promotion.demote).toHaveBeenCalledWith(5);

    hostRole.promotion = { mode: 'checkpoint' };
    signaling.emit('error', { code: 'staleEpoch' });
    expect(promotion.abandon).toHaveBeenCalled();
  });

  it('voteRejected — системное сообщение', () => {
    create();
    signaling.emit('error', { code: 'voteRejected', reason: 'cooldown' });

    expect(ui.chat).toHaveBeenCalled();
  });
});

describe('GuestSession: «Change host»', () => {
  beforeEach(() => {
    ctx.roomId = 'room1';
  });

  it('окно голосования и его закрытие по результату', () => {
    const guest = create();

    signaling.emit('host_vote', {
      roomId: 'room1',
      voteId: 'v1',
      initiatorNick: 'bob',
      durationMs: 10_000,
    });

    expect(guest.hostVote).toEqual({ roomId: 'room1', voteId: 'v1' });
    expect(vote.openEngineVote).toHaveBeenCalledWith(
      expect.objectContaining({ deadline: Date.now() + 10_000 }),
    );

    signaling.emit('host_vote_result', { roomId: 'room1', voteId: 'v1' });

    expect(guest.hostVote).toBeNull();
    expect(vote.closeEngineVote).toHaveBeenCalled();
    expect(ui.chat).toHaveBeenCalled();
  });

  it('хосту окно не открывается', () => {
    const guest = create();

    hostRole.controller = {};
    signaling.emit('host_vote', { roomId: 'room1', voteId: 'v1' });

    expect(guest.hostVote).toBeNull();
    expect(vote.openEngineVote).not.toHaveBeenCalled();
  });

  it('started/accepted своей комнаты — в чат', () => {
    create();
    signaling.emit('host_vote_started', { roomId: 'room1' });
    signaling.emit('host_vote_accepted', { roomId: 'room1' });
    signaling.emit('host_vote_accepted', { roomId: 'other' });

    expect(ui.chat).toHaveBeenCalledTimes(2);
  });
});
