import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import RoomRegistry from '../../packages/engine/src/master/RoomRegistry.js';
import SignalingServer from '../../packages/engine/src/master/SignalingServer.js';
import RateLimiter from '../../packages/engine/src/lib/rateLimiter.js';

// Голосование «Change host» (host-migration этап 10): HostVoteManager
// проверяется через SignalingServer — тем же путём, каким его зовёт мастер.

class FakeWs {
  constructor() {
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.handlers = {};
  }

  on(event, fn) {
    this.handlers[event] = fn;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.handlers.close?.();
  }

  terminate() {}

  message(obj) {
    this.handlers.message(JSON.stringify(obj));
  }

  // разрыв сокета со стороны клиента
  drop() {
    this.readyState = 3;
    this.handlers.close?.();
  }

  typed(type) {
    return this.sent.filter(msg => msg.type === type);
  }

  lastOf(type) {
    return this.typed(type).at(-1);
  }
}

const nextTick = () => new Promise(resolve => process.nextTick(resolve));

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const KID = 'test-key-1';
const ISSUER = 'vimp-auth-test';
const jwks = {
  keys: [
    {
      ...publicKey.export({ format: 'jwk' }),
      kid: KID,
      use: 'sig',
      alg: 'RS256',
    },
  ],
};

const signToken = sub =>
  jwt.sign({ nick: `user${sub}` }, privateKey, {
    subject: String(sub),
    algorithm: 'RS256',
    keyid: KID,
    issuer: ISSUER,
    expiresIn: '15m',
  });

const memberIdOf = n =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const CAN_HOST = { canHost: true, mobile: false, hidden: false };
const SETTINGS = { map: 'dust', roundTime: 120000, friendlyFire: true };

let clock;
let timers;
let registry;
let signaling;

// ручной планировщик: таймеры координатора срабатывают только в advance()
const setTimer = (fn, ms) => {
  const timer = { fn, at: clock.now + ms, done: false };

  timers.push(timer);

  return timer;
};
const clearTimer = timer => {
  timer.done = true;
};
const advance = ms => {
  clock.now += ms;

  for (const timer of [...timers]) {
    if (!timer.done && timer.at <= clock.now) {
      timer.done = true;
      timer.fn();
    }
  }
};

beforeEach(() => {
  // часы сервера впереди Date.now() реестра (joinedAt участников)
  clock = { now: Date.now() + 60000 };
  timers = [];
  registry = new RoomRegistry({
    maxPlayersLimit: 8,
    secretKey: 'k'.repeat(32),
    heartbeatTimeout: 1000,
    memberGraceMs: 500,
    hostReclaimGraceMs: 300,
  });
  signaling = new SignalingServer(registry, {
    iceServers: [],
    regionHeader: 'x-region',
    pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
    checkOrigin: (origin, cb) => process.nextTick(() => cb(null)),
    jwksProxy: { get: vi.fn(async () => jwks) },
    issuer: ISSUER,
    now: () => clock.now,
    setTimer,
    clearTimer,
    successor: { minMemberAgeMs: 0, switchRatio: 0.65, switchSustainMs: 30000 },
    migration: {
      checkpointMaxAgeMs: 12000,
      promotionTimeoutMs: 10000,
      coldPromotionTimeoutMs: 25000,
      probeTimeoutMs: 2000,
      reportWindowMs: 5000,
      forcedMigrationCooldownMs: 30000,
      handoffTimeoutMs: 8000,
    },
    vote: {
      hostVoteDurationMs: 15000,
      roomVoteCooldownMs: 120000,
      userStartCooldownMs: 60000,
      voteForceAfterMs: 5000,
      demotedCooldownMs: 600000,
    },
  });
});

const connect = async (ip = '9.9.9.9') => {
  const ws = new FakeWs();

  signaling.handleConnection(ws, {
    headers: { origin: 'https://localhost:3001', 'x-region': 'EU' },
    socket: { remoteAddress: ip },
  });
  await nextTick();

  return { ws, id: ws.sent[0]?.id };
};

const connectHost = async (userId = 1) => {
  const conn = await connect(`1.1.1.${userId}`);

  conn.memberId = memberIdOf(userId);
  conn.ws.message({
    type: 'register_host',
    maxPlayers: 8,
    gameId: 'tanks',
    token: signToken(userId),
    memberId: conn.memberId,
    caps: CAN_HOST,
    settings: SETTINGS,
  });
  await signaling.idle();

  const reply = conn.ws.lastOf('host_registered');

  if (!reply) {
    throw new Error(`register_host failed: ${JSON.stringify(conn.ws.sent)}`);
  }

  Object.assign(conn, reply);

  return conn;
};

const join = async (roomId, userId, caps = CAN_HOST) => {
  const conn = await connect(`5.5.5.${userId}`);

  conn.userId = userId;
  conn.memberId = memberIdOf(userId);
  conn.ws.message({
    type: 'join_room',
    roomId,
    memberId: conn.memberId,
    token: signToken(userId),
    caps,
  });
  await signaling.idle();

  return conn;
};

// бета сообщает свежую точку
const reportStandby = (beta, roomId) => {
  beta.ws.message({
    type: 'standby_status',
    roomId,
    epoch: 1,
    checkpointId: 'cp-1',
    createdAt: 1,
  });
};

// преемник занимает комнату по promote
const registerPromoted = async (conn, promote, over = {}) => {
  conn.ws.message({
    type: 'register_host',
    roomId: promote.roomId,
    epoch: promote.epoch,
    promotionToken: promote.promotionToken,
    memberId: conn.memberId,
    token: signToken(conn.userId),
    gameId: 'tanks',
    caps: CAN_HOST,
    ...over,
  });
  await signaling.idle();
};

// комната: хост + бета (со свежей точкой) + обычный гость
const setupRoom = async () => {
  const host = await connectHost();
  const beta = await join(host.roomId, 2);
  const guest = await join(host.roomId, 3);

  expect(registry.get(host.roomId).successorMemberId).toBe(beta.memberId);
  reportStandby(beta, host.roomId);

  return { host, beta, guest, room: registry.get(host.roomId) };
};

const startVote = conn =>
  conn.ws.message({ type: 'host_vote_start', roomId: conn.roomId });

const answer = (conn, voteId, value) =>
  conn.ws.message({
    type: 'host_vote_answer',
    roomId: conn.roomId,
    voteId,
    value,
  });

// комната: хост + бета + n гостей (у каждого conn.roomId)
const setupVoteRoom = async (guests = 1) => {
  const { host, beta, guest, room } = await setupRoom();
  const others = [guest];

  for (let i = 1; i < guests; i += 1) {
    others.push(await join(host.roomId, 3 + i));
  }

  for (const conn of [beta, ...others]) {
    conn.roomId = host.roomId;
  }

  return { host, beta, guests: others, room };
};

describe('старт голосования', () => {
  it('гость начинает: окно всем eligible, кроме инициатора и хоста', async () => {
    const { host, beta, guests, room } = await setupVoteRoom(2);
    const [initiator, other] = guests;

    startVote(initiator);

    const vote = beta.ws.lastOf('host_vote');

    expect(vote).toMatchObject({
      type: 'host_vote',
      roomId: room.roomId,
      initiatorNick: 'user3',
      endsAt: clock.now + 15000,
      durationMs: 15000,
      eligibleCount: 3,
    });
    expect(vote.voteId).toMatch(/^[0-9a-f]{16}$/);
    expect(other.ws.lastOf('host_vote')).toEqual(vote);
    expect(initiator.ws.typed('host_vote')).toEqual([]);
    expect(host.ws.typed('host_vote')).toEqual([]);
    // инициатору — подтверждение старта, остальным его нет
    expect(initiator.ws.lastOf('host_vote_started')).toEqual({
      type: 'host_vote_started',
      roomId: room.roomId,
      voteId: vote.voteId,
      endsAt: vote.endsAt,
      durationMs: 15000,
      eligibleCount: 3,
    });
    expect(beta.ws.typed('host_vote_started')).toEqual([]);
    expect(host.ws.typed('host_vote_started')).toEqual([]);
  });

  it('хост не может начать', async () => {
    const { host, room } = await setupVoteRoom();

    startVote(host);

    expect(host.ws.lastOf('error')).toEqual({
      type: 'error',
      code: 'voteRejected',
      re: 'host_vote_start',
      roomId: room.roomId,
      reason: 'host',
    });
    expect(host.ws.typed('host_vote_started')).toEqual([]);
  });

  it('не участник комнаты — тишина', async () => {
    const { room } = await setupVoteRoom();
    const stranger = await connect('7.7.7.7');

    stranger.ws.message({ type: 'host_vote_start', roomId: room.roomId });

    expect(stranger.ws.typed('error')).toEqual([]);
  });

  it('второе голосование, пока идёт первое, — active', async () => {
    const { beta, guests } = await setupVoteRoom(2);

    startVote(guests[0]);
    startVote(beta);

    expect(beta.ws.lastOf('error')).toMatchObject({
      code: 'voteRejected',
      reason: 'active',
    });
  });

  it('кулдаун комнаты и кулдаун пользователя', async () => {
    const { beta, guests } = await setupVoteRoom(2);
    const [initiator, other] = guests;

    startVote(initiator);
    answer(beta, beta.ws.lastOf('host_vote').voteId, 'no');
    answer(other, other.ws.lastOf('host_vote').voteId, 'no');
    expect(initiator.ws.lastOf('host_vote_result').passed).toBe(false);

    advance(119999);
    startVote(other);
    expect(other.ws.lastOf('error')).toMatchObject({ reason: 'roomCooldown' });

    advance(1);
    startVote(other);
    expect(beta.ws.typed('host_vote')).toHaveLength(2);
  });

  it('кулдаун пользователя короче кулдауна комнаты проверяется отдельно', async () => {
    signaling._votes._timings.roomVoteCooldownMs = 1000;

    const { beta, guests } = await setupVoteRoom(2);
    const [initiator, other] = guests;

    startVote(initiator);
    answer(beta, beta.ws.lastOf('host_vote').voteId, 'no');
    answer(other, other.ws.lastOf('host_vote').voteId, 'no');

    advance(59999);
    startVote(initiator);
    expect(initiator.ws.lastOf('error')).toMatchObject({
      reason: 'userCooldown',
    });

    advance(1);
    startVote(initiator);
    expect(beta.ws.typed('host_vote')).toHaveLength(2);
  });

  it('нет способного преемника — noSuccessor', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 2, { ...CAN_HOST, canHost: false });

    guest.roomId = host.roomId;
    startVote(guest);

    expect(guest.ws.lastOf('error')).toEqual({
      type: 'error',
      code: 'noSuccessor',
      re: 'host_vote_start',
      roomId: host.roomId,
    });
  });
});

describe('голос — по пользователю', () => {
  // вторая вкладка того же пользователя: свой memberId, тот же userId
  const joinTab = async (roomId, userId, tab) => {
    const conn = await connect(`5.5.6.${userId}`);

    conn.userId = userId;
    conn.roomId = roomId;
    conn.memberId = memberIdOf(userId * 100 + tab);
    conn.ws.message({
      type: 'join_room',
      roomId,
      memberId: conn.memberId,
      token: signToken(userId),
      caps: CAN_HOST,
    });
    await signaling.idle();

    return conn;
  };

  it('две вкладки одного пользователя — один eligible и один голос', async () => {
    const { beta, guests, room } = await setupVoteRoom(3);
    const [initiator, other] = guests;
    const otherTab = await joinTab(room.roomId, other.userId, 2);

    startVote(initiator);

    const vote = beta.ws.lastOf('host_vote');

    // пользователи: бета, инициатор, other (в двух вкладках), третий гость
    expect(vote.eligibleCount).toBe(4);
    expect(otherTab.ws.lastOf('host_vote')).toEqual(vote);

    // обе вкладки other — «за»: это один голос, 2 из 4 — не большинство
    answer(other, vote.voteId, 'yes');
    answer(otherTab, vote.voteId, 'yes');
    expect(initiator.ws.typed('host_vote_result')).toEqual([]);

    answer(beta, vote.voteId, 'yes');

    expect(initiator.ws.lastOf('host_vote_result')).toMatchObject({
      passed: true,
      yes: 3,
      no: 1,
      eligibleCount: 4,
    });
  });

  it('повторный ответ с другой вкладки меняет голос пользователя', async () => {
    const { beta, guests, room } = await setupVoteRoom(3);
    const [initiator, second] = guests;
    const secondTab = await joinTab(room.roomId, second.userId, 2);

    startVote(initiator);

    const vote = beta.ws.lastOf('host_vote');

    expect(vote.eligibleCount).toBe(4);
    answer(second, vote.voteId, 'no');
    answer(secondTab, vote.voteId, 'yes');
    answer(beta, vote.voteId, 'yes');

    expect(initiator.ws.lastOf('host_vote_result')).toMatchObject({
      passed: true,
      yes: 3,
      eligibleCount: 4,
    });
  });

  it('вторая вкладка пользователя хоста не начинает и не голосует', async () => {
    const { beta, guests, room } = await setupVoteRoom(1);
    const hostTab = await joinTab(room.roomId, 1, 2);
    const [initiator] = guests;

    startVote(hostTab);

    expect(hostTab.ws.lastOf('error')).toMatchObject({
      code: 'voteRejected',
      reason: 'host',
    });

    startVote(initiator);

    const vote = beta.ws.lastOf('host_vote');

    expect(vote.eligibleCount).toBe(2);
    expect(hostTab.ws.typed('host_vote')).toEqual([]);

    answer(hostTab, vote.voteId, 'no');
    expect(hostTab.ws.typed('host_vote_accepted')).toEqual([]);
  });

  it('участник моложе minVoterAgeMs не начинает (tooNew) и не голосует', async () => {
    const { beta, guests, room } = await setupVoteRoom(2);
    const [initiator, fresh] = guests;

    room.members.get(fresh.memberId).joinedAt = clock.now - 29999;

    startVote(fresh);

    expect(fresh.ws.lastOf('error')).toMatchObject({
      code: 'voteRejected',
      reason: 'tooNew',
    });

    startVote(initiator);

    const vote = beta.ws.lastOf('host_vote');

    expect(vote.eligibleCount).toBe(2);
    expect(fresh.ws.typed('host_vote')).toEqual([]);
  });
});

describe('ответы и исход', () => {
  it('ответы — только от eligible; повтор меняет мнение; досрочный исход', async () => {
    const { host, beta, guests, room } = await setupVoteRoom(3);
    const [initiator, second, third] = guests;

    startVote(initiator);

    const vote = beta.ws.lastOf('host_vote');

    // хост не голосует, неизвестный voteId и мусорное значение не считаются
    answer({ ...host, roomId: room.roomId }, vote.voteId, 'yes');
    answer(beta, 'ffffffffffffffff', 'yes');
    answer(beta, vote.voteId, 'maybe');
    // 4 eligible: за — инициатор и second, бета против
    answer(beta, vote.voteId, 'no');
    answer(second, vote.voteId, 'yes');
    expect(initiator.ws.typed('host_vote_result')).toEqual([]);
    // засчитанный ответ подтверждается отвечавшему; отвергнутые — нет
    expect(beta.ws.typed('host_vote_accepted')).toEqual([
      { type: 'host_vote_accepted', roomId: room.roomId, voteId: vote.voteId },
    ]);
    expect(second.ws.typed('host_vote_accepted')).toHaveLength(1);
    expect(host.ws.typed('host_vote_accepted')).toEqual([]);

    // бета передумала — 3 из 4, молчание third — «против»
    answer(beta, vote.voteId, 'yes');

    const result = {
      type: 'host_vote_result',
      roomId: room.roomId,
      voteId: vote.voteId,
      passed: true,
      yes: 3,
      no: 1,
      eligibleCount: 4,
    };

    // итог — всем участникам, и хосту
    for (const conn of [host, beta, initiator, second, third]) {
      expect(conn.ws.lastOf('host_vote_result')).toEqual(result);
    }

    // смена мнения — тоже засчитанный ответ, подтверждение до итога
    expect(beta.ws.typed('host_vote_accepted')).toHaveLength(2);
    expect(
      beta.ws.sent
        .map(msg => msg.type)
        .filter(type => type.startsWith('host_vote_'))
        .slice(-2),
    ).toEqual(['host_vote_accepted', 'host_vote_result']);
  });

  it('исход «против» определён досрочно', async () => {
    const { beta, guests } = await setupVoteRoom(2);

    startVote(guests[0]);
    answer(beta, beta.ws.lastOf('host_vote').voteId, 'no');
    expect(guests[0].ws.typed('host_vote_result')).toEqual([]);

    answer(guests[1], beta.ws.lastOf('host_vote').voteId, 'no');
    expect(guests[0].ws.lastOf('host_vote_result')).toMatchObject({
      passed: false,
      yes: 1,
      no: 2,
    });
  });

  it('большинство «за» — досрочно прошло, хосту request_handoff', async () => {
    const { host, beta, guests } = await setupVoteRoom(2);

    startVote(guests[0]);
    answer(beta, beta.ws.lastOf('host_vote').voteId, 'yes');
    // 2 из 3 — уже большинство
    expect(guests[0].ws.typed('host_vote_result')).toHaveLength(1);
    expect(guests[0].ws.lastOf('host_vote_result').passed).toBe(true);
    expect(host.ws.lastOf('request_handoff')).toBeDefined();
  });

  it('по таймауту молчание — «против»', async () => {
    const { host, guests } = await setupVoteRoom(2);

    startVote(guests[0]);
    advance(14999);
    expect(guests[0].ws.typed('host_vote_result')).toEqual([]);

    advance(1);
    expect(guests[0].ws.lastOf('host_vote_result')).toMatchObject({
      passed: false,
      yes: 1,
      no: 2,
      eligibleCount: 3,
    });
    expect(host.ws.typed('request_handoff')).toEqual([]);
  });

  it('комната из хоста и одного гостя: голос гостя решает сразу', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 2);

    guest.roomId = host.roomId;
    startVote(guest);

    // сначала «началось», затем итог
    expect(
      guest.ws.sent
        .map(msg => msg.type)
        .filter(type => type.startsWith('host_vote')),
    ).toEqual(['host_vote_started', 'host_vote_result']);
    expect(guest.ws.lastOf('host_vote_result')).toMatchObject({
      passed: true,
      yes: 1,
      no: 0,
      eligibleCount: 1,
    });
    expect(host.ws.lastOf('request_handoff')).toEqual({
      type: 'request_handoff',
      roomId: host.roomId,
      epoch: 1,
      reason: 'vote',
      defer: false,
    });
  });

  it('ушедший не голосует, большинство — от оставшихся', async () => {
    const { beta, guests } = await setupVoteRoom(3);
    const [initiator, second, third] = guests;

    startVote(initiator);

    const { voteId } = beta.ws.lastOf('host_vote');

    // 4 eligible, «за» 2 — ещё не большинство
    answer(second, voteId, 'yes');
    expect(initiator.ws.typed('host_vote_result')).toEqual([]);

    third.ws.message({ type: 'leave_room', roomId: third.roomId });
    expect(initiator.ws.lastOf('host_vote_result')).toMatchObject({
      passed: true,
      yes: 2,
      eligibleCount: 3,
    });
  });

  it('истёкший grace отсоединённого — тоже уход', async () => {
    const { beta, guests } = await setupVoteRoom(3);
    const [initiator, second, third] = guests;

    startVote(initiator);
    answer(second, beta.ws.lastOf('host_vote').voteId, 'yes');

    third.ws.drop();
    signaling.sweep(Date.now());
    expect(initiator.ws.typed('host_vote_result')).toEqual([]);

    signaling.sweep(Date.now() + 501);
    expect(initiator.ws.lastOf('host_vote_result')).toMatchObject({
      passed: true,
      eligibleCount: 3,
    });
  });

  it('eligible опустело — отмена', async () => {
    const { beta, guests } = await setupVoteRoom(2);
    const [initiator, other] = guests;

    startVote(initiator);
    // голосов «против» нет: исход не определён, пока кто-то остаётся
    for (const conn of [initiator, other]) {
      conn.ws.message({ type: 'leave_room', roomId: conn.roomId });
    }
    expect(beta.ws.typed('host_vote_result')).toEqual([]);

    beta.ws.message({ type: 'leave_room', roomId: beta.roomId });
    expect(beta.ws.typed('host_vote_result')).toEqual([]);
    expect(signaling._votes._votes.size).toBe(0);
  });
});

describe('прошедшее голосование снимает хоста', () => {
  const pass = async () => {
    const setup = await setupVoteRoom(1);
    const { beta, guests } = setup;

    startVote(guests[0]);
    answer(beta, beta.ws.lastOf('host_vote').voteId, 'yes');

    return setup;
  };

  it('хост отдаёт роль планово (vote) — бывший хост не бета demotedCooldownMs', async () => {
    const { host, beta, guests, room } = await pass();

    expect(room.members.get(host.memberId).demotedUntil).toBe(
      clock.now + 600000,
    );

    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'vote',
      stay: true,
    });

    const promote = beta.ws.lastOf('promote');

    expect(promote).toMatchObject({ mode: 'planned', reason: 'vote' });
    await registerPromoted(beta, promote);

    expect(room).toMatchObject({ status: 'online', epoch: 2 });
    expect(host.ws.lastOf('host_released')).toBeDefined();
    // бывший хост вошёл раньше гостя, но смещён — бета гость
    expect(room.successorMemberId).toBe(guests[0].memberId);

    advance(5000);
    expect(beta.ws.typed('promote')).toHaveLength(1);

    clock.now += 600000;
    room.members.delete(guests[0].memberId);
    signaling.reviewSuccessors();
    expect(room.successorMemberId).toBe(host.memberId);
  });

  it('хост не начал передачу за voteForceAfterMs — принудительная миграция', async () => {
    const { host, beta, guests, room } = await pass();

    advance(4999);
    expect(room.status).toBe('online');

    advance(1);
    expect(room).toMatchObject({ status: 'migrating', pendingEpoch: 2 });
    expect(beta.ws.lastOf('promote')).toMatchObject({
      mode: 'checkpoint',
      reason: 'vote',
    });
    expect(guests[0].ws.lastOf('host_migrating')).toMatchObject({
      reason: 'vote',
    });

    await registerPromoted(beta, beta.ws.lastOf('promote'));
    expect(host.ws.lastOf('host_revoked')).toMatchObject({ epoch: 2 });
  });

  it('передача по голосованию сорвалась — принудительная миграция', async () => {
    const { host, beta, guests, room } = await pass();

    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'vote',
      stay: true,
    });

    const planned = beta.ws.lastOf('promote');

    beta.ws.message({
      type: 'promote_failed',
      roomId: room.roomId,
      epoch: 2,
      promotionToken: planned.promotionToken,
    });

    expect(host.ws.lastOf('handoff_aborted')).toBeDefined();
    // гостям не «reclaimed»: хост не возвращается
    expect(guests[0].ws.typed('host_changed')).toEqual([]);
    expect(room).toMatchObject({ status: 'migrating', pendingEpoch: 2 });
    expect(room.migration.reason).toBe('vote');
    expect(room.host.memberId).toBe(host.memberId);
    expect(signaling._getHostSession(room.roomId)).toBeUndefined();
  });

  it('хост прислал иную причину и сорвал передачу — всё равно принудительно', async () => {
    const { host, beta, guests, room } = await pass();

    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'handover',
      stay: true,
    });

    const planned = beta.ws.lastOf('promote');

    // мастер помнит снятие: причина — vote, а не присланная
    expect(planned.reason).toBe('vote');
    expect(guests[0].ws.lastOf('host_migrating').reason).toBe('vote');

    // таймер принудительного снятия сработал посреди передачи — ждёт исхода
    advance(5000);
    expect(room.status).toBe('handing_off');

    // бета не заняла комнату за handoffTimeoutMs — срыв
    advance(3000);
    expect(host.ws.lastOf('handoff_aborted')).toBeDefined();
    expect(guests[0].ws.typed('host_changed')).toEqual([]);
    expect(room).toMatchObject({ status: 'migrating', pendingEpoch: 2 });
    expect(room.migration.reason).toBe('vote');
  });

  it('принять некому — хост остаётся, комната живёт', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 2);
    const room = registry.get(host.roomId);

    guest.roomId = host.roomId;
    startVote(guest);
    expect(guest.ws.lastOf('host_vote_result').passed).toBe(true);

    guest.ws.message({ type: 'leave_room', roomId: room.roomId });
    advance(5000);

    expect(registry.get(room.roomId)).toBe(room);
    expect(room).toMatchObject({ status: 'online', epoch: 1 });
    expect(room.host.memberId).toBe(host.memberId);
    expect(host.ws.closed).toBe(null);
  });

  it('сорванная передача без кандидатов — хост остаётся, без room_closed', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 2);
    const room = registry.get(host.roomId);

    guest.roomId = host.roomId;
    startVote(guest);
    reportStandby(guest, host.roomId);
    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'vote',
      stay: true,
    });
    expect(room.status).toBe('handing_off');

    // бета закрыла вкладку посреди передачи — больше некому
    guest.ws.drop();

    expect(host.ws.lastOf('handoff_aborted')).toBeDefined();
    expect(registry.get(room.roomId)).toBe(room);
    expect(room).toMatchObject({ status: 'online', epoch: 1 });
    expect(host.ws.closed).toBe(null);
  });

  it('запрет — по пользователю: новая вкладка снятого хоста тоже не бета', async () => {
    const { host, beta, guests, room } = await pass();

    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'vote',
      stay: true,
    });
    await registerPromoted(beta, beta.ws.lastOf('promote'));

    // бывший хост перезагрузил вкладку: тот же пользователь, новый memberId
    host.ws.message({ type: 'leave_room', roomId: room.roomId });

    const reloaded = await connect('1.1.1.9');

    reloaded.ws.message({
      type: 'join_room',
      roomId: room.roomId,
      memberId: memberIdOf(99),
      token: signToken(1),
      caps: CAN_HOST,
    });
    await signaling.idle();

    expect(room.members.get(memberIdOf(99)).demotedUntil).toBe(
      room.demotedUsers.get(1),
    );

    // единственный другой кандидат ушёл — бету взять некому
    guests[0].ws.message({ type: 'leave_room', roomId: room.roomId });
    expect(room.successorMemberId).toBe(null);
  });

  it('смещённый — единственный способный: аварийная миграция берёт его', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 2);
    const room = registry.get(host.roomId);

    guest.roomId = host.roomId;
    guest.userId = 2;
    startVote(guest);
    reportStandby(guest, host.roomId);
    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'vote',
      stay: true,
    });
    await registerPromoted(guest, guest.ws.lastOf('promote'));
    expect(room.host.memberId).toBe(guest.memberId);
    // смещённый не бета
    expect(room.successorMemberId).toBe(null);

    guest.ws.drop();

    expect(room.status).toBe('migrating');
    expect(host.ws.lastOf('promote')).toMatchObject({
      mode: 'cold',
      epoch: 3,
    });
  });
});

describe('отмена', () => {
  it('началась миграция — host_vote_result cancelled всем участникам', async () => {
    const { host, beta, guests, room } = await setupVoteRoom(2);

    startVote(guests[0]);

    const { voteId } = beta.ws.lastOf('host_vote');

    host.ws.drop();

    expect(room.status).toBe('migrating');
    expect(beta.ws.lastOf('host_vote_result')).toEqual({
      type: 'host_vote_result',
      roomId: room.roomId,
      voteId,
      passed: false,
      cancelled: true,
      yes: 1,
      no: 2,
      eligibleCount: 3,
    });

    // голосование снято: ответ уже ничего не решает
    answer(guests[1], voteId, 'yes');
    expect(beta.ws.typed('host_vote_result')).toHaveLength(1);
  });

  it('началась плановая передача — тоже отмена', async () => {
    const { host, beta, guests, room } = await setupVoteRoom(2);

    startVote(guests[0]);
    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'handover',
      stay: true,
    });

    expect(beta.ws.lastOf('host_vote_result')).toMatchObject({
      cancelled: true,
    });
  });

  it('во время миграции голосование не начинается', async () => {
    const { host, guests } = await setupVoteRoom(2);

    host.ws.drop();
    startVote(guests[0]);

    expect(guests[0].ws.lastOf('error')).toMatchObject({
      code: 'voteRejected',
      reason: 'migrating',
    });
  });
});
