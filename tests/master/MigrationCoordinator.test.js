import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import RoomRegistry from '../../packages/engine/src/master/RoomRegistry.js';
import SignalingServer from '../../packages/engine/src/master/SignalingServer.js';
import RateLimiter from '../../packages/engine/src/lib/rateLimiter.js';

// Аварийная миграция хоста (host-migration этап 7): MigrationCoordinator
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
  clock = { now: Date.now() };
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
    ageMs: 0,
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

describe('хост потерян — промоушен беты с точкой', () => {
  it('обрыв WS хоста → host_migrating → promote(checkpoint) → register_host → host_changed', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.drop();

    expect(room.status).toBe('migrating');
    expect(room.pendingEpoch).toBe(2);
    expect(guest.ws.lastOf('host_migrating')).toEqual({
      type: 'host_migrating',
      roomId: room.roomId,
      epoch: 2,
      reason: 'disconnected',
      waitMs: 15000,
    });
    // комната в миграции не выдаётся в список
    expect(registry.getList().servers).toEqual([]);
    expect(registry.getPublic(room.roomId).status).toBe('migrating');

    const promote = beta.ws.lastOf('promote');

    expect(promote).toMatchObject({
      roomId: room.roomId,
      epoch: 2,
      mode: 'checkpoint',
      reason: 'disconnected',
      settings: SETTINGS,
    });
    expect(promote.promotionToken).toMatch(/^[0-9a-f]{32}$/);
    expect(guest.ws.typed('promote')).toEqual([]);

    await registerPromoted(beta, promote);

    const registered = beta.ws.lastOf('host_registered');

    expect(registered).toMatchObject({ roomId: room.roomId, epoch: 2 });
    expect(registered.roomSecret).not.toBe(host.roomSecret);
    expect(room).toMatchObject({ status: 'online', epoch: 2 });
    expect(room.host).toMatchObject({ memberId: beta.memberId, userId: 2 });
    expect(guest.ws.lastOf('host_changed')).toEqual({
      type: 'host_changed',
      roomId: room.roomId,
      epoch: 2,
      mode: 'checkpoint',
      reason: 'disconnected',
    });
    expect(beta.ws.typed('host_changed')).toEqual([]);
    expect(registry.getList().servers).toHaveLength(1);

    // офферы теперь идут новому хосту с новой эпохой
    guest.ws.message({ type: 'webrtc_offer', roomId: room.roomId, sdp: 'X' });
    expect(beta.ws.lastOf('webrtc_offer')).toMatchObject({ epoch: 2 });

    // новый хост получает бету: единственный кандидат — гость
    expect(room.successorMemberId).toBe(guest.memberId);
  });

  it('точка беты устарела — cold-промоушен', async () => {
    const { host, beta, room } = await setupRoom();

    clock.now += 12001;
    host.ws.drop();

    expect(beta.ws.lastOf('promote')).toMatchObject({ mode: 'cold' });
    expect(room.migration.mode).toBe('cold');
  });

  it('бета повторяет ту же точку — свежее она не становится (ревью F8)', async () => {
    const { host, beta, room } = await setupRoom();

    // поток точек встал: статус идёт, точка прежняя (бета без ageMs)
    for (let i = 0; i < 3; i += 1) {
      clock.now += 4500;
      beta.ws.message({
        type: 'standby_status',
        roomId: room.roomId,
        epoch: 1,
        checkpointId: 'cp-1',
        createdAt: 1,
      });
    }

    host.ws.drop();

    expect(beta.ws.lastOf('promote')).toMatchObject({ mode: 'cold' });
  });

  it('свежесть — по возрасту точки из standby_status.ageMs', async () => {
    const { host, beta, room } = await setupRoom();

    beta.ws.message({
      type: 'standby_status',
      roomId: room.roomId,
      epoch: 1,
      checkpointId: 'cp-2',
      createdAt: 2,
      ageMs: 20000,
    });
    host.ws.drop();

    expect(beta.ws.lastOf('promote')).toMatchObject({ mode: 'cold' });
  });

  it('свежий ageMs — промоушен с точкой', async () => {
    const { host, beta, room } = await setupRoom();

    clock.now += 11000;
    beta.ws.message({
      type: 'standby_status',
      roomId: room.roomId,
      epoch: 1,
      checkpointId: 'cp-1',
      createdAt: 1,
      ageMs: 100,
    });
    clock.now += 5000;
    host.ws.drop();

    expect(beta.ws.lastOf('promote')).toMatchObject({ mode: 'checkpoint' });
  });

  it('IP-лимит «одна комната на IP» на промоушен не действует', async () => {
    const { host, beta, room } = await setupRoom();
    // другой хост с IP беты уже держит свою комнату
    const other = await connect('5.5.5.2');

    other.ws.message({
      type: 'register_host',
      maxPlayers: 8,
      token: signToken(9),
      memberId: memberIdOf(9),
    });
    await signaling.idle();
    expect(other.ws.lastOf('host_registered')).toBeDefined();

    host.ws.drop();
    await registerPromoted(beta, beta.ws.lastOf('promote'));

    expect(beta.ws.lastOf('host_registered')).toMatchObject({ epoch: 2 });
    expect(room.host.memberId).toBe(beta.memberId);
  });

  it('cold: преемник перезагрузил страницу (новая сессия и memberId) — занимает по токену', async () => {
    const { host, beta, room } = await setupRoom();

    clock.now += 12001;
    host.ws.drop();

    const promote = beta.ws.lastOf('promote');

    beta.ws.drop();

    const reloaded = await connect('5.5.5.2');

    reloaded.userId = 2;
    reloaded.memberId = memberIdOf(22);
    await registerPromoted(reloaded, promote, { settings: { map: 'mill' } });

    expect(reloaded.ws.lastOf('host_registered')).toMatchObject({ epoch: 2 });
    expect(room.host.memberId).toBe(memberIdOf(22));
    expect(room.members.has(beta.memberId)).toBe(false);
    expect(room.settings).toEqual({ map: 'mill' });
  });

  // ревью F4: гость заметил обрыв почти одновременно с мастером и сразу
  // шлёт оффер с resume — комната жива, хоста просто ещё нет
  it('оффер в комнату migrating — error migrating, а не unknownRoom', async () => {
    const { host, guest, room } = await setupRoom();

    host.ws.drop();

    guest.ws.message({
      type: 'webrtc_offer',
      roomId: room.roomId,
      sdp: 'X',
      resume: true,
    });
    expect(guest.ws.lastOf('error')).toEqual({
      type: 'error',
      code: 'migrating',
      re: 'webrtc_offer',
      roomId: room.roomId,
    });
  });
});

describe('проверка register_host преемника', () => {
  it('неверный токен, чужой пользователь — invalidPromotion; устаревшая эпоха — staleEpoch', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.drop();

    const promote = beta.ws.lastOf('promote');

    await registerPromoted(beta, {
      ...promote,
      promotionToken: 'f'.repeat(32),
    });
    expect(beta.ws.lastOf('error')).toEqual({
      type: 'error',
      code: 'invalidPromotion',
      re: 'register_host',
      roomId: room.roomId,
    });

    // токен утёк гостю — но он не тот пользователь
    await registerPromoted(guest, promote);
    expect(guest.ws.lastOf('error')).toMatchObject({
      code: 'invalidPromotion',
    });

    await registerPromoted(beta, { ...promote, epoch: 1 });
    expect(beta.ws.lastOf('error')).toMatchObject({ code: 'staleEpoch' });

    expect(room.status).toBe('migrating');

    // после успешного промоушена тот же токен — staleEpoch
    await registerPromoted(beta, promote);

    const late = await connect('5.5.5.77');

    late.userId = 2;
    late.memberId = memberIdOf(77);
    await registerPromoted(late, promote);
    expect(late.ws.lastOf('error')).toMatchObject({ code: 'staleEpoch' });
  });

  it('токен не из hex-символов (той же длины в символах) не роняет мастер', async () => {
    const { host, beta, room } = await setupRoom();

    host.ws.drop();

    const evil = 'é'.repeat(32);
    const stranger = await connect('7.7.7.7');

    expect(() =>
      stranger.ws.message({
        type: 'promote_failed',
        roomId: room.roomId,
        epoch: 2,
        promotionToken: evil,
      }),
    ).not.toThrow();

    stranger.userId = 2;
    stranger.memberId = memberIdOf(70);
    await registerPromoted(stranger, {
      roomId: room.roomId,
      epoch: 2,
      promotionToken: evil,
    });
    expect(stranger.ws.lastOf('error')).toMatchObject({
      code: 'invalidPromotion',
    });
    // кандидат прежний: чужой «токен» ничего не отменил
    expect(room.migration.candidateMemberId).toBe(beta.memberId);
  });

  it('сессия, занявшая свою комнату за время проверки токена, не занимает ещё и комнату в миграции (ревью C3)', async () => {
    const { host, beta, room } = await setupRoom();

    host.ws.drop();

    const promote = beta.ws.lastOf('promote');
    const verify = signaling._verifyToken.bind(signaling);
    let release;
    const held = new Promise(resolve => {
      release = resolve;
    });

    // проверка токена промоушена задерживается — своя комната успевает
    vi.spyOn(signaling, '_verifyToken').mockImplementationOnce(async token => {
      await held;

      return verify(token);
    });

    beta.ws.message({
      type: 'register_host',
      roomId: promote.roomId,
      epoch: promote.epoch,
      promotionToken: promote.promotionToken,
      memberId: beta.memberId,
      token: signToken(2),
      gameId: 'tanks',
      caps: CAN_HOST,
    });
    beta.ws.message({
      type: 'register_host',
      maxPlayers: 8,
      gameId: 'tanks',
      token: signToken(2),
      memberId: beta.memberId,
      caps: CAN_HOST,
      settings: SETTINGS,
    });

    // signaling.idle() ждал бы и задержанный промоушен
    const own = await vi.waitFor(() => {
      const reply = beta.ws.lastOf('host_registered');

      expect(reply).toBeDefined();

      return reply;
    });

    release();
    await signaling.idle();

    expect(beta.ws.lastOf('error')).toEqual({
      type: 'error',
      code: 'alreadyRegistered',
      re: 'register_host',
      roomId: room.roomId,
    });
    expect(beta.ws.typed('host_registered')).toHaveLength(1);
    expect(own.roomId).not.toBe(room.roomId);
    expect(signaling._sessions.get(beta.id).roomId).toBe(own.roomId);
    // комната в миграции по-прежнему ждёт кандидата, хоста у неё нет
    expect(room.host.sessionId).not.toBe(beta.id);
    expect(room.migration).not.toBeNull();
  });

  it('промоушен в несуществующую комнату — unknownRoom', async () => {
    const conn = await connect();

    conn.userId = 5;
    conn.memberId = memberIdOf(5);
    await registerPromoted(conn, {
      roomId: 'k7m2qx3a',
      epoch: 2,
      promotionToken: 'a'.repeat(32),
    });

    expect(conn.ws.lastOf('error')).toMatchObject({ code: 'unknownRoom' });
  });
});

describe('кандидаты', () => {
  it('таймаут промоушена → promote_cancelled, следующий кандидат в cold', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.drop();
    advance(9999);
    expect(guest.ws.typed('promote')).toEqual([]);

    advance(1);

    expect(beta.ws.lastOf('promote_cancelled')).toEqual({
      type: 'promote_cancelled',
      roomId: room.roomId,
      epoch: 2,
    });
    expect(guest.ws.lastOf('promote')).toMatchObject({
      mode: 'cold',
      epoch: 2,
    });

    // опоздавший первый кандидат уже не займёт комнату
    await registerPromoted(beta, beta.ws.lastOf('promote'));
    expect(beta.ws.lastOf('error')).toMatchObject({ code: 'invalidPromotion' });
  });

  // хост и бета закрыты разом (ручная проверка этапа 7): мёртвого
  // кандидата не ждут promotionTimeoutMs
  it('WS checkpoint-кандидата закрылся → сразу следующий кандидат в cold', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.drop();
    expect(beta.ws.lastOf('promote')).toMatchObject({ mode: 'checkpoint' });

    beta.ws.drop();

    expect(guest.ws.lastOf('promote')).toMatchObject({
      mode: 'cold',
      epoch: 2,
    });
    expect(room.migration.candidateMemberId).toBe(guest.memberId);

    // таймер ушедшего кандидата снят: cold-кандидат ждёт свои 25 с
    advance(10000);
    expect(guest.ws.typed('promote')).toHaveLength(1);
  });

  it('WS cold-кандидата закрылся — он перезагружается, ждём его таймаут', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.drop();
    beta.ws.drop();
    guest.ws.drop();

    expect(room.migration.candidateMemberId).toBe(guest.memberId);
    expect(registry.get(room.roomId)).toBeDefined();
  });

  it('WS не-кандидата во время миграции закрылся — кандидат прежний', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.drop();
    guest.ws.drop();

    expect(room.migration.candidateMemberId).toBe(beta.memberId);
    expect(beta.ws.typed('promote')).toHaveLength(1);
  });

  it('promote_failed → следующий кандидат; кандидаты кончились → room_closed noHost', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.drop();
    beta.ws.message({
      type: 'promote_failed',
      roomId: room.roomId,
      epoch: 2,
    });

    expect(guest.ws.lastOf('promote')).toMatchObject({ mode: 'cold' });

    // cold-кандидат перезагрузился и не смог: узнаётся по токену
    const { promotionToken } = guest.ws.lastOf('promote');
    const reloaded = await connect('5.5.5.33');

    reloaded.ws.message({
      type: 'promote_failed',
      roomId: room.roomId,
      epoch: 2,
      promotionToken,
    });

    expect(registry.get(room.roomId)).toBeUndefined();
    expect(beta.ws.lastOf('room_closed')).toEqual({
      type: 'room_closed',
      roomId: room.roomId,
      reason: 'noHost',
    });
  });

  it('promote_failed не от кандидата и с чужой эпохой игнорируется', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.drop();
    guest.ws.message({ type: 'promote_failed', roomId: room.roomId, epoch: 2 });
    beta.ws.message({ type: 'promote_failed', roomId: room.roomId, epoch: 3 });

    expect(room.migration.candidateMemberId).toBe(beta.memberId);
    expect(guest.ws.typed('promote')).toEqual([]);
  });

  it('cold: скрытая вкладка в аварии — кандидат', async () => {
    const host = await connectHost();
    const hidden = await join(host.roomId, 2, { ...CAN_HOST, hidden: true });

    host.ws.drop();

    expect(hidden.ws.lastOf('promote')).toMatchObject({ mode: 'cold' });
  });

  it('люди без возможности хостить: обрыв WS хоста — ждём reclaim, после grace room_closed', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 2, { canHost: false });

    host.ws.drop();

    expect(registry.get(host.roomId)).toMatchObject({ status: 'online' });
    expect(guest.ws.typed('host_migrating')).toEqual([]);
    expect(guest.ws.typed('room_closed')).toEqual([]);

    signaling.sweep(clock.now + 300);

    expect(guest.ws.lastOf('room_closed')).toMatchObject({ reason: 'noHost' });
    expect(registry.size).toBe(0);
  });

  it('повысить некого, хост вернулся в grace — комната цела', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 2, { canHost: false });

    host.ws.drop();

    const back = await connect('1.1.1.1');

    back.ws.message({
      type: 'reclaim_host',
      roomId: host.roomId,
      epoch: 1,
      roomSecret: host.roomSecret,
      memberId: host.memberId,
      token: signToken(1),
    });
    await signaling.idle();

    expect(back.ws.lastOf('host_registered')).toMatchObject({ epoch: 1 });
    expect(guest.ws.typed('room_closed')).toEqual([]);
    expect(registry.get(host.roomId).host.sessionId).toBe(back.id);
  });

  it('cold в комнате на двоих: кандидат перезагружается дольше memberGraceMs — комната не удаляется уборкой', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 2);

    host.ws.drop();

    const promote = guest.ws.lastOf('promote');

    expect(promote).toMatchObject({ mode: 'cold' });
    guest.ws.drop();
    // grace участников (500 мс) истёк: состав пуст, но промоушен идёт
    signaling.sweep(clock.now + 5000);

    expect(registry.get(host.roomId)).toMatchObject({ status: 'migrating' });

    const reloaded = await connect('5.5.5.2');

    reloaded.userId = 2;
    reloaded.memberId = memberIdOf(22);
    await registerPromoted(reloaded, promote);

    expect(reloaded.ws.lastOf('host_registered')).toMatchObject({ epoch: 2 });
  });

  it('cold-кандидат так и не пришёл — по дедлайну опустевшая комната закрыта', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 2);

    host.ws.drop();
    guest.ws.drop();
    signaling.sweep(clock.now + 5000);
    advance(25000);

    expect(registry.size).toBe(0);
  });
});

describe('reclaim_host во время миграции', () => {
  const reclaim = async (host, ip = '1.1.1.1') => {
    const conn = await connect(ip);

    conn.ws.message({
      type: 'reclaim_host',
      roomId: host.roomId,
      epoch: host.epoch,
      roomSecret: host.roomSecret,
      memberId: host.memberId,
      token: signToken(1),
      gameId: 'tanks',
    });
    await signaling.idle();

    return conn;
  };

  it('обрыв одного сигналинга: reclaim до регистрации беты отменяет миграцию', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.drop();

    const promote = beta.ws.lastOf('promote');
    const back = await reclaim(host);

    expect(back.ws.lastOf('host_registered')).toMatchObject({ epoch: 1 });
    expect(room).toMatchObject({ status: 'online', epoch: 1 });
    expect(beta.ws.lastOf('promote_cancelled')).toMatchObject({ epoch: 2 });
    expect(guest.ws.lastOf('host_changed')).toEqual({
      type: 'host_changed',
      roomId: room.roomId,
      epoch: 1,
      mode: 'reclaimed',
      reason: 'disconnected',
    });

    // промоушен отменён — бета комнату не займёт
    await registerPromoted(beta, promote);
    expect(beta.ws.lastOf('error')).toMatchObject({ code: 'staleEpoch' });

    // и дедлайн отменённого промоушена ничего не делает
    advance(30000);
    expect(room.status).toBe('online');
  });

  it('reclaim отвергнут проверкой hostLimit — миграция не отменена', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.drop();

    // хост вернулся с нового адреса, где уже хостится другая комната
    const other = await connect('3.3.3.3');

    other.ws.message({
      type: 'register_host',
      maxPlayers: 8,
      token: signToken(9),
      memberId: memberIdOf(9),
    });
    await signaling.idle();
    expect(other.ws.lastOf('host_registered')).toBeDefined();

    const back = await reclaim(host, '3.3.3.3');

    expect(back.ws.lastOf('error')).toMatchObject({ code: 'hostLimit' });
    expect(room.status).toBe('migrating');
    expect(beta.ws.typed('promote_cancelled')).toEqual([]);
    expect(guest.ws.typed('host_changed')).toEqual([]);
  });

  it('после регистрации беты reclaim старого хоста — staleEpoch', async () => {
    const { host, beta } = await setupRoom();

    host.ws.drop();
    await registerPromoted(beta, beta.ws.lastOf('promote'));

    const back = await reclaim(host);

    expect(back.ws.lastOf('error')).toMatchObject({ code: 'staleEpoch' });
  });
});

describe('отчёты клиентов и проба хоста (7.3)', () => {
  const unreachable = (conn, roomId, epoch = 1) =>
    conn.ws.message({ type: 'host_unreachable', roomId, epoch });

  it('хост не ответил на пробу — миграция unresponsive, старому хосту host_revoked после промоушена', async () => {
    const { host, beta, guest, room } = await setupRoom();

    unreachable(guest, room.roomId);

    const probe = host.ws.lastOf('probe');

    expect(probe).toMatchObject({ roomId: room.roomId });
    expect(room.status).toBe('online');

    advance(2000);

    expect(room.status).toBe('migrating');
    expect(guest.ws.lastOf('host_migrating')).toMatchObject({
      reason: 'unresponsive',
    });
    expect(host.ws.typed('host_migrating')).toEqual([]);

    // старый хост больше не хост: его ответы игнорируются, reclaim не
    // отменяет принудительную миграцию
    host.ws.message({ type: 'webrtc_answer', clientId: guest.id, sdp: 'Z' });
    expect(guest.ws.typed('webrtc_answer')).toEqual([]);
    host.ws.message({
      type: 'reclaim_host',
      roomId: room.roomId,
      epoch: 1,
      roomSecret: host.roomSecret,
      memberId: host.memberId,
      token: signToken(1),
    });
    await signaling.idle();
    expect(host.ws.lastOf('error')).toMatchObject({ code: 'staleEpoch' });

    await registerPromoted(beta, beta.ws.lastOf('promote'));

    expect(host.ws.lastOf('host_revoked')).toEqual({
      type: 'host_revoked',
      roomId: room.roomId,
      epoch: 2,
    });
    expect(host.ws.typed('host_changed')).toEqual([]);
  });

  it('хост ответил, кворум гостей не набран — миграции нет; набран — unreachable', async () => {
    const { host, beta, guest, room } = await setupRoom();
    const third = await join(room.roomId, 4);

    // 3 гостя → кворум 2
    unreachable(guest, room.roomId);
    host.ws.message({
      type: 'probe_ack',
      nonce: host.ws.lastOf('probe').nonce,
    });

    expect(room.status).toBe('online');
    advance(5000);
    expect(room.status).toBe('online');

    unreachable(third, room.roomId);
    // свежий ответ пробы ещё не получен — новая проба
    host.ws.message({
      type: 'probe_ack',
      nonce: host.ws.lastOf('probe').nonce,
    });

    expect(room.status).toBe('online');

    // второй отчёт в окне — кворум 2 из 3
    unreachable(beta, room.roomId);

    expect(room.status).toBe('migrating');
    expect(third.ws.lastOf('host_migrating')).toMatchObject({
      reason: 'unreachable',
    });
  });

  it('probe_ack с чужим nonce или не от хоста игнорируется', async () => {
    const { host, guest, room } = await setupRoom();

    unreachable(guest, room.roomId);

    const { nonce } = host.ws.lastOf('probe');

    host.ws.message({ type: 'probe_ack', nonce: 'nope' });
    guest.ws.message({ type: 'probe_ack', nonce });
    advance(2000);

    expect(room.status).toBe('migrating');
  });

  it('отчёт не чаще раза в 2 с, только от участника с текущей эпохой', async () => {
    const { host, guest, room } = await setupRoom();
    const stranger = await connect('7.7.7.7');

    // 3 гостя → кворум 2: одиночные отчёты миграцию не запускают
    await join(room.roomId, 4);

    unreachable(stranger, room.roomId);
    unreachable(guest, room.roomId, 5);
    expect(host.ws.typed('probe')).toEqual([]);

    unreachable(guest, room.roomId);
    host.ws.message({
      type: 'probe_ack',
      nonce: host.ws.lastOf('probe').nonce,
    });
    clock.now += 6000;
    unreachable(guest, room.roomId);
    expect(host.ws.typed('probe')).toHaveLength(2);

    host.ws.message({
      type: 'probe_ack',
      nonce: host.ws.lastOf('probe').nonce,
    });
    clock.now += 1000;
    unreachable(guest, room.roomId);
    expect(host.ws.typed('probe')).toHaveLength(2);
  });

  it('принудительная миграция, а повысить некого — хост остаётся, комната жива', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 2, { canHost: false });

    guest.ws.message({
      type: 'host_unreachable',
      roomId: host.roomId,
      epoch: 1,
    });
    // 1 гость: отчёты хоста не снимают (кворум не меньше 2 пользователей)
    host.ws.message({
      type: 'probe_ack',
      nonce: host.ws.lastOf('probe').nonce,
    });

    const room = registry.get(host.roomId);

    expect(room).toMatchObject({ status: 'online', epoch: 1 });
    expect(room.lastForcedMigrationAt).toBeNull();
    expect(guest.ws.typed('host_migrating')).toEqual([]);
    expect(guest.ws.typed('room_closed')).toEqual([]);

    // хост по-прежнему хост: его ответы доходят
    host.ws.message({ type: 'webrtc_answer', clientId: guest.id, sdp: 'Z' });
    expect(guest.ws.lastOf('webrtc_answer')).toMatchObject({ sdp: 'Z' });

    // и без ответа на пробу — то же
    clock.now += 3000;
    guest.ws.message({
      type: 'host_unreachable',
      roomId: host.roomId,
      epoch: 1,
    });
    advance(5000);
    expect(room.status).toBe('online');
  });

  // вторая вкладка того же пользователя: свой memberId, тот же userId
  const joinTab = async (roomId, userId, tab) => {
    const conn = await connect(`5.5.6.${userId}`);

    conn.userId = userId;
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
  const ackProbe = host =>
    host.ws.message({
      type: 'probe_ack',
      nonce: host.ws.lastOf('probe').nonce,
    });

  it('две вкладки одного пользователя — один голос кворума', async () => {
    const { host, beta, guest, room } = await setupRoom();
    const tab = await joinTab(room.roomId, guest.userId, 2);

    // гостей-пользователей 2 → кворум 2
    unreachable(guest, room.roomId);
    ackProbe(host);
    clock.now += 2001;
    unreachable(tab, room.roomId);

    expect(room.reports.size).toBe(1);
    expect(room.status).toBe('online');

    unreachable(beta, room.roomId);

    expect(room.status).toBe('migrating');
    expect(guest.ws.lastOf('host_migrating')).toMatchObject({
      reason: 'unreachable',
    });
  });

  it('один гость-пользователь (и в двух вкладках) не запускает unreachable', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 2);
    const tab = await joinTab(host.roomId, 2, 2);
    const room = registry.get(host.roomId);

    unreachable(guest, room.roomId);
    ackProbe(host);
    clock.now += 2001;
    unreachable(tab, room.roomId);

    expect(room.status).toBe('online');
    expect(guest.ws.typed('host_migrating')).toEqual([]);
  });

  it('вкладка пользователя хоста не отчитывается', async () => {
    const { host, room } = await setupRoom();
    const hostTab = await joinTab(room.roomId, 1, 2);

    unreachable(hostTab, room.roomId);

    expect(room.reports.size).toBe(0);
    expect(host.ws.typed('probe')).toEqual([]);
  });

  it('два пользователя из двух — unreachable', async () => {
    const { host, beta, guest, room } = await setupRoom();

    unreachable(guest, room.roomId);
    ackProbe(host);
    expect(room.status).toBe('online');

    unreachable(beta, room.roomId);

    expect(room.status).toBe('migrating');
  });

  it('неподтверждённый хостом участник не становится ни бетой, ни холодным кандидатом', async () => {
    const { host, beta, guest, room } = await setupRoom();

    // хост подключён по WebRTC только к гостю
    host.ws.message({
      type: 'room_peers',
      roomId: room.roomId,
      epoch: 1,
      memberIds: [guest.memberId],
    });

    expect(room.successorMemberId).toBe(guest.memberId);

    // устаревшее назначение со свежей точкой — ветка беты тоже проверяет
    // подтверждение
    room.successorMemberId = beta.memberId;
    reportStandby(beta, room.roomId);
    host.ws.drop();

    expect(beta.ws.typed('promote')).toEqual([]);
    expect(guest.ws.lastOf('promote')).toMatchObject({ mode: 'cold' });
  });

  it('кулдаун принудительных миграций: внутри него — только проба', async () => {
    const { host, beta, guest, room } = await setupRoom();

    unreachable(guest, room.roomId);
    advance(2000);
    await registerPromoted(beta, beta.ws.lastOf('promote'));
    expect(room.epoch).toBe(2);

    // новый хост (бета) тоже «недоступен» — но кулдаун 30 с
    clock.now += 2000;
    unreachable(guest, room.roomId, 2);

    expect(beta.ws.lastOf('probe')).toBeDefined();

    advance(2000);

    expect(room.status).toBe('online');
    expect(host.ws.typed('promote')).toEqual([]);

    clock.now += 30000;
    unreachable(guest, room.roomId, 2);
    advance(2000);

    expect(room.status).toBe('migrating');
  });

  it('хост молчит дольше heartbeatTimeout (sweep) — миграция timeout', async () => {
    const { beta, room } = await setupRoom();

    room.lastSeen = 0;
    signaling.sweep(clock.now + 5000);

    expect(room.status).toBe('migrating');
    expect(beta.ws.lastOf('promote')).toMatchObject({
      mode: 'checkpoint',
      reason: 'timeout',
    });
  });
});

describe('плановая передача (этап 8)', () => {
  const begin = (host, over = {}) => {
    host.ws.message({
      type: 'handoff_begin',
      roomId: host.roomId,
      epoch: 1,
      reason: 'handover',
      stay: true,
      ...over,
    });
  };

  it('handoff_begin → handoff_go, promote(planned), host_migrating → регистрация беты → host_released', async () => {
    const { host, beta, guest, room } = await setupRoom();

    begin(host);

    expect(room).toMatchObject({ status: 'handing_off', pendingEpoch: 2 });
    expect(host.ws.lastOf('handoff_go')).toEqual({
      type: 'handoff_go',
      roomId: room.roomId,
      epoch: 2,
    });

    const promote = beta.ws.lastOf('promote');

    expect(promote).toMatchObject({
      roomId: room.roomId,
      epoch: 2,
      mode: 'planned',
      reason: 'handover',
      settings: SETTINGS,
    });
    expect(guest.ws.lastOf('host_migrating')).toMatchObject({
      epoch: 2,
      reason: 'handover',
    });
    expect(host.ws.typed('host_migrating')).toEqual([]);
    // бета узнала о передаче из promote и держит соединение с замороженным
    // хостом до финальной точки (ревью F2)
    expect(beta.ws.typed('host_migrating')).toEqual([]);
    // комната в передаче не выдаётся в список
    expect(registry.getList().servers).toEqual([]);

    // хост остаётся хостом до регистрации беты
    expect(room.host.memberId).toBe(host.memberId);

    await registerPromoted(beta, promote);

    expect(room).toMatchObject({ status: 'online', epoch: 2 });
    expect(room.host.memberId).toBe(beta.memberId);
    expect(host.ws.lastOf('host_released')).toEqual({
      type: 'host_released',
      roomId: room.roomId,
      epoch: 2,
    });
    expect(host.ws.typed('host_revoked')).toEqual([]);
    expect(guest.ws.lastOf('host_changed')).toEqual({
      type: 'host_changed',
      roomId: room.roomId,
      epoch: 2,
      mode: 'planned',
      reason: 'handover',
    });

    // бывший хост с !stay уходит из комнаты как обычный участник
    host.ws.message({ type: 'leave_room', roomId: room.roomId });
    expect(room.members.has(host.memberId)).toBe(false);
  });

  it('незнакомая причина считается handover; leave передаётся как есть', async () => {
    const first = await setupRoom();

    begin(first.host, { reason: 'whatever' });
    expect(first.beta.ws.lastOf('promote').reason).toBe('handover');

    const host = await connectHost(4);
    const beta = await join(host.roomId, 5);

    reportStandby(beta, host.roomId);

    begin(host, { reason: 'leave', stay: false });
    expect(beta.ws.lastOf('promote').reason).toBe('leave');
  });

  it('не от хоста, не online, чужая эпоха, без беты — отказ', async () => {
    const { host, beta, guest, room } = await setupRoom();

    // гость не хост — сообщение игнорируется
    begin({ ...guest, roomId: room.roomId });
    expect(room.status).toBe('online');
    expect(guest.ws.typed('handoff_unavailable')).toEqual([]);

    begin(host, { epoch: 7 });
    expect(host.ws.lastOf('handoff_unavailable')).toMatchObject({
      reason: 'staleEpoch',
    });

    // точка беты устарела — канал standby не подтверждён
    clock.now += 12001;
    begin(host);
    expect(host.ws.lastOf('handoff_unavailable')).toMatchObject({
      roomId: room.roomId,
      epoch: 1,
      reason: 'noSuccessor',
    });
    expect(room.status).toBe('online');
    expect(beta.ws.typed('promote')).toEqual([]);

    reportStandby(beta, room.roomId);
    begin(host);
    expect(room.status).toBe('handing_off');

    begin(host);
    expect(host.ws.lastOf('handoff_unavailable')).toMatchObject({
      reason: 'busy',
    });
  });

  it('один хост без людей — noSuccessor', async () => {
    const host = await connectHost();

    begin(host);
    expect(host.ws.lastOf('handoff_unavailable')).toMatchObject({
      reason: 'noSuccessor',
    });
  });

  it('в handing_off офферы новых гостей получают error migrating', async () => {
    const { host, guest, room } = await setupRoom();

    begin(host);

    const offersBefore = host.ws.typed('webrtc_offer').length;

    guest.ws.message({ type: 'webrtc_offer', roomId: room.roomId, sdp: 'X' });
    expect(guest.ws.lastOf('error')).toEqual({
      type: 'error',
      code: 'migrating',
      re: 'webrtc_offer',
      roomId: room.roomId,
    });
    expect(host.ws.typed('webrtc_offer')).toHaveLength(offersBefore);
  });

  it('бета не зарегистрировалась за handoffTimeoutMs — handoff_aborted, promote_cancelled, эпоха прежняя', async () => {
    const { host, beta, guest, room } = await setupRoom();

    begin(host);

    const promote = beta.ws.lastOf('promote');

    advance(7999);
    expect(room.status).toBe('handing_off');

    advance(1);
    expect(room).toMatchObject({
      status: 'online',
      epoch: 1,
      pendingEpoch: null,
      migration: null,
    });
    expect(host.ws.lastOf('handoff_aborted')).toEqual({
      type: 'handoff_aborted',
      roomId: room.roomId,
      epoch: 1,
    });
    expect(beta.ws.lastOf('promote_cancelled')).toMatchObject({ epoch: 2 });
    // гости бросили транспорт по host_migrating — возобновляются к нему же
    expect(guest.ws.lastOf('host_changed')).toEqual({
      type: 'host_changed',
      roomId: room.roomId,
      epoch: 1,
      mode: 'reclaimed',
      reason: 'handover',
    });
    expect(host.ws.typed('host_changed')).toEqual([]);

    // опоздавшая регистрация не проходит
    await registerPromoted(beta, promote);
    expect(beta.ws.lastOf('error')).toMatchObject({ code: 'staleEpoch' });
    expect(room.host.memberId).toBe(host.memberId);
  });

  it('promote_failed беты и уход беты — отмена передачи', async () => {
    const first = await setupRoom();

    begin(first.host);
    first.beta.ws.message({
      type: 'promote_failed',
      roomId: first.room.roomId,
      epoch: 2,
    });
    expect(first.room.status).toBe('online');
    expect(first.host.ws.lastOf('handoff_aborted')).toBeDefined();

    reportStandby(first.beta, first.room.roomId);
    begin(first.host);
    expect(first.room.status).toBe('handing_off');

    first.beta.ws.drop();
    expect(first.room).toMatchObject({ status: 'online', epoch: 1 });
    expect(first.host.ws.typed('handoff_aborted')).toHaveLength(2);
  });

  it('WS хоста оборвался посреди передачи — аварийная миграция с той же бетой', async () => {
    const { host, beta, guest, room } = await setupRoom();

    begin(host);

    const promote = beta.ws.lastOf('promote');

    host.ws.drop();

    expect(room.status).toBe('migrating');
    // бета повышена повторно той же эпохой и токеном: финальной точки не
    // будет — берёт свою периодическую сразу
    expect(beta.ws.lastOf('promote')).toEqual({
      ...promote,
      mode: 'checkpoint',
    });
    // повтор с дедлайном аварийной попытки (ревью F12)
    expect(guest.ws.typed('host_migrating')).toHaveLength(2);

    // дедлайн — обычный promotionTimeoutMs, сбой беты ведёт к следующему
    // кандидату, а не к отмене
    advance(9999);
    expect(beta.ws.typed('promote_cancelled')).toEqual([]);
    advance(1);
    expect(beta.ws.lastOf('promote_cancelled')).toBeDefined();
    expect(guest.ws.lastOf('promote')).toMatchObject({ mode: 'cold' });
    expect(room.status).toBe('migrating');
    expect(promote.epoch).toBe(2);
  });

  it('WS хоста оборвался — регистрация беты завершает миграцию', async () => {
    const { host, beta, guest, room } = await setupRoom();

    begin(host);
    host.ws.drop();
    await registerPromoted(beta, beta.ws.lastOf('promote'));

    expect(room).toMatchObject({ status: 'online', epoch: 2 });
    expect(guest.ws.lastOf('host_changed')).toMatchObject({
      mode: 'checkpoint',
    });
  });

  it('преемник не пересчитывается посреди передачи', async () => {
    const { host, beta, guest, room } = await setupRoom();

    begin(host);

    const assignedBefore = host.ws.typed('successor_assigned').length;

    // вкладка беты спряталась — вне передачи это сменило бы преемника
    beta.ws.message({
      type: 'member_update',
      roomId: room.roomId,
      caps: { ...CAN_HOST, hidden: true },
    });
    signaling.reviewSuccessors();

    expect(room.successorMemberId).toBe(beta.memberId);
    expect(beta.ws.typed('standby_released')).toEqual([]);
    expect(guest.ws.typed('standby_assigned')).toEqual([]);
    expect(host.ws.typed('successor_assigned')).toHaveLength(assignedBefore);
    expect(room.standby).not.toBeNull();
  });

  it('reclaim_host посреди передачи — staleEpoch, передача идёт', async () => {
    const { host, room } = await setupRoom();

    begin(host);

    const conn = await connect('1.1.1.1');

    conn.ws.message({
      type: 'reclaim_host',
      roomId: host.roomId,
      epoch: 1,
      roomSecret: host.roomSecret,
      memberId: host.memberId,
      token: signToken(1),
      gameId: 'tanks',
    });
    await signaling.idle();

    expect(conn.ws.lastOf('error')).toMatchObject({ code: 'staleEpoch' });
    expect(room.status).toBe('handing_off');
  });
});

describe('host_leaving (этап 8.4)', () => {
  it('хост закрывает вкладку — миграция сразу, повторно не стартует', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.message({ type: 'host_leaving', roomId: room.roomId, epoch: 1 });

    expect(room.status).toBe('migrating');
    expect(room.migration.reason).toBe('leaving');
    expect(beta.ws.lastOf('promote')).toMatchObject({ mode: 'checkpoint' });
    expect(guest.ws.lastOf('host_migrating')).toMatchObject({
      reason: 'leaving',
    });

    // WS закрылся следом — миграция та же
    host.ws.drop();
    expect(beta.ws.typed('promote')).toHaveLength(1);
  });

  it('уход с вкладки хоста не отменяется reclaim_host', async () => {
    const { host, room } = await setupRoom();

    host.ws.message({ type: 'host_leaving', roomId: room.roomId, epoch: 1 });
    expect(signaling._migration.canCancelByReclaim(room)).toBe(false);
  });

  it('чужая эпоха и не от хоста — игнор; людей нет — комната закрыта', async () => {
    const { host, guest, room } = await setupRoom();

    host.ws.message({ type: 'host_leaving', roomId: room.roomId, epoch: 5 });
    guest.ws.message({ type: 'host_leaving', roomId: room.roomId, epoch: 1 });
    expect(room.status).toBe('online');

    const lonely = await connectHost(7);

    lonely.ws.message({
      type: 'host_leaving',
      roomId: lonely.roomId,
      epoch: 1,
    });
    expect(registry.get(lonely.roomId)).toBeUndefined();
  });

  it('host_leaving посреди плановой передачи — передача становится аварийной', async () => {
    const { host, beta, room } = await setupRoom();

    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'handover',
    });
    host.ws.message({ type: 'host_leaving', roomId: room.roomId, epoch: 1 });

    expect(room.status).toBe('migrating');
    expect(beta.ws.lastOf('promote')).toMatchObject({ mode: 'checkpoint' });
  });
});

describe('host_closing: одинокий хост закрывает комнату (ревью, этап 10)', () => {
  it('комната скрыта из списка и ссылки, вход и оффер — unknownRoom', async () => {
    const host = await connectHost();
    const room = registry.get(host.roomId);

    host.ws.message({ type: 'host_closing', roomId: room.roomId, epoch: 1 });
    expect(room.status).toBe('closing');
    expect(registry.getList().servers).toEqual([]);
    expect(registry.getPublic(room.roomId)).toBeNull();

    const late = await join(room.roomId, 4);

    expect(late.ws.lastOf('error')).toMatchObject({
      code: 'unknownRoom',
      re: 'join_room',
      roomId: room.roomId,
    });
    expect(late.ws.lastOf('room_joined')).toBeUndefined();
    expect(room.members.has(late.memberId)).toBe(false);

    late.ws.message({ type: 'webrtc_offer', roomId: room.roomId, sdp: 'x' });
    expect(late.ws.lastOf('error')).toMatchObject({
      code: 'unknownRoom',
      re: 'webrtc_offer',
    });
    expect(host.ws.lastOf('webrtc_offer')).toBeUndefined();
  });

  it('записи очков в закрывающейся комнате по-прежнему атрибутированы', async () => {
    const host = await connectHost();

    host.ws.message({ type: 'host_closing', roomId: host.roomId, epoch: 1 });

    expect(registry.verifiedAttribution(host.roomId, host.roomSecret)).toEqual({
      sessionId: host.roomId,
    });
  });

  it('после host_leaving комната закрывается как раньше', async () => {
    const host = await connectHost();

    host.ws.message({ type: 'host_closing', roomId: host.roomId, epoch: 1 });
    host.ws.message({ type: 'host_leaving', roomId: host.roomId, epoch: 1 });

    expect(registry.get(host.roomId)).toBeUndefined();
  });

  it('чужая эпоха, не от хоста, комната в миграции — без эффекта', async () => {
    const { host, guest, room } = await setupRoom();

    host.ws.message({ type: 'host_closing', roomId: room.roomId, epoch: 5 });
    guest.ws.message({ type: 'host_closing', roomId: room.roomId, epoch: 1 });
    expect(room.status).toBe('online');

    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'handover',
    });
    host.ws.message({ type: 'host_closing', roomId: room.roomId, epoch: 1 });
    expect(room.status).toBe('handing_off');
  });
});

describe('сетевой лаг хоста и общий кулдаун авто-смен (этап 9c)', () => {
  // score сессии = rttEma + 2 × jitterEma до мастера
  const setScore = (conn, rtt) => {
    const session = signaling._sessions.get(conn.id);

    session.rttEma = rtt;
    session.jitterEma = 0;
  };

  const health = (host, over = {}) => {
    host.ws.message({
      type: 'host_health',
      roomId: host.roomId,
      epoch: 1,
      tickRate: 120,
      peerRttMedian: 300,
      peerCount: 2,
      ...over,
    });
  };

  // count сэмплов раз в 2 с (первый — сейчас); поток точек беты свежий
  const feed = (host, beta, count, over = {}) => {
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        clock.now += 2000;
      }

      reportStandby(beta, host.roomId);
      health(host, over);
    }
  };

  const requests = host => host.ws.typed('request_handoff');

  // хост в роли дольше кулдауна, бета с живым потоком точек и сетью лучше
  const setupLagRoom = async () => {
    const setup = await setupRoom();

    clock.now += 90000;
    reportStandby(setup.beta, setup.host.roomId);
    setScore(setup.host, 100);
    setScore(setup.beta, 40);
    setScore(setup.guest, 50);

    return setup;
  };

  it('медиана RTT выше порога 10 с подряд — request_handoff (network, defer); повтор не раньше нового окна', async () => {
    const { host, beta, room } = await setupLagRoom();

    feed(host, beta, 5); // 0…8 с
    expect(requests(host)).toEqual([]);

    clock.now += 2000; // 10 с
    health(host);
    expect(requests(host)).toEqual([
      {
        type: 'request_handoff',
        roomId: room.roomId,
        epoch: 1,
        reason: 'network',
        defer: true,
      },
    ]);

    // хост просьбу не выполнил (старый клиент) — окно заново
    clock.now += 2000;
    feed(host, beta, 5);
    expect(requests(host)).toHaveLength(1);

    clock.now += 2000;
    feed(host, beta, 1);
    expect(requests(host)).toHaveLength(2);
  });

  it('непрерывность: сэмпл не выше порога, peerCount 0, медиана null или пауза > 5 с окно обнуляют', async () => {
    const { host, beta } = await setupLagRoom();

    for (const reset of [
      { peerRttMedian: 250 },
      { peerCount: 0 },
      { peerRttMedian: null },
    ]) {
      feed(host, beta, 5);
      clock.now += 2000;
      feed(host, beta, 1, reset);
      clock.now += 2000;
      feed(host, beta, 1);
      expect(requests(host)).toEqual([]);
    }

    // пауза между отчётами 6 с (матч заморожен) — окно заново
    feed(host, beta, 4);
    clock.now += 6000;
    feed(host, beta, 1);
    expect(requests(host)).toEqual([]);
    clock.now += 2000;
    feed(host, beta, 5); // 10 с от паузы
    expect(requests(host)).toHaveLength(1);
  });

  it('гистерезис 35 %: бета с score 66 при хосте 100 — нет, 65 — да', async () => {
    const { host, beta } = await setupLagRoom();

    setScore(beta, 66);
    feed(host, beta, 6);
    expect(requests(host)).toEqual([]);

    setScore(beta, 65);
    clock.now += 2000;
    feed(host, beta, 1);
    expect(requests(host)).toHaveLength(1);
  });

  it('нет замера score, точка беты устарела, чужая эпоха, сообщение не от хоста — просьбы нет', async () => {
    const { host, beta, guest, room } = await setupLagRoom();

    // гость выдаёт себя за хоста
    for (let i = 0; i < 6; i++) {
      health({ ...guest, roomId: room.roomId });
      clock.now += 2000;
    }

    feed(host, beta, 6, { epoch: 7 });
    expect(requests(host)).toEqual([]);

    signaling._sessions.get(host.id).rttEma = null;
    feed(host, beta, 6);
    expect(requests(host)).toEqual([]);

    setScore(host, 100);
    clock.now += 12001; // поток точек беты молчит
    for (let i = 0; i < 6; i++) {
      health(host);
      clock.now += 2000;
    }
    expect(requests(host)).toEqual([]);
    expect(guest.ws.typed('request_handoff')).toEqual([]);
  });

  it('хост в роли меньше autoMigrationCooldownMs — просьбы нет', async () => {
    const { host, beta } = await setupRoom();

    setScore(host, 100);
    setScore(beta, 40);
    feed(host, beta, 6);
    expect(requests(host)).toEqual([]);
  });

  it('handoff_begin с overload/hidden/network передаёт причину как есть', async () => {
    for (const [n, reason] of [
      [1, 'overload'],
      [4, 'hidden'],
      [7, 'network'],
    ]) {
      const host = await connectHost(n);
      const beta = await join(host.roomId, n + 1);

      reportStandby(beta, host.roomId);
      host.ws.message({
        type: 'handoff_begin',
        roomId: host.roomId,
        epoch: 1,
        reason,
        stay: true,
      });
      expect(beta.ws.lastOf('promote').reason).toBe(reason);
    }
  });

  // общий кулдаун: хост отдал роль из-за перегрузки — новый хост с плохой
  // сетью не получает request_handoff раньше autoMigrationCooldownMs
  it('успешная авто-смена (overload) ставит lastAutoMigrationAt и гасит правило лага у нового хоста', async () => {
    const { host, beta, guest, room } = await setupLagRoom();

    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'overload',
      stay: true,
    });
    await registerPromoted(beta, beta.ws.lastOf('promote'));

    expect(room).toMatchObject({ epoch: 2, lastAutoMigrationAt: clock.now });
    expect(room.hostSince).toBe(clock.now);
    // причина автоматической передачи доходит до гостей
    expect(guest.ws.lastOf('host_changed')).toMatchObject({
      mode: 'planned',
      reason: 'overload',
    });

    const newHost = { ...beta, roomId: room.roomId };
    const standby2 = () =>
      guest.ws.message({
        type: 'standby_status',
        roomId: room.roomId,
        epoch: 2,
        checkpointId: 'cp-2',
        createdAt: 2,
        ageMs: 0,
      });

    expect(room.successorMemberId).toBe(guest.memberId);
    setScore(beta, 100);
    setScore(guest, 40);

    const lagFor = count => {
      for (let i = 0; i < count; i++) {
        clock.now += 2000;
        standby2();
        health(newHost, { epoch: 2 });
      }
    };

    // 60 с лага — внутри общего кулдауна
    lagFor(30);
    expect(requests(beta)).toEqual([]);

    // кулдаун (90 с) истёк — просьба
    lagFor(15);
    expect(requests(beta)).toHaveLength(1);
  });

  it('ручная передача и сорванная авто-передача метку не ставят', async () => {
    const first = await setupLagRoom();

    first.host.ws.message({
      type: 'handoff_begin',
      roomId: first.room.roomId,
      epoch: 1,
      reason: 'handover',
      stay: true,
    });
    await registerPromoted(first.beta, first.beta.ws.lastOf('promote'));
    expect(first.room.lastAutoMigrationAt).toBeNull();

    const host = await connectHost(4);
    const beta = await join(host.roomId, 5);
    const room = registry.get(host.roomId);

    reportStandby(beta, host.roomId);
    host.ws.message({
      type: 'handoff_begin',
      roomId: host.roomId,
      epoch: 1,
      reason: 'hidden',
      stay: true,
    });
    advance(8000); // бета не заняла комнату — передача отменена
    expect(room).toMatchObject({ status: 'online', epoch: 1 });
    expect(room.lastAutoMigrationAt).toBeNull();
  });

  it('сорванная сетевая передача: правило лага молчит autoMigrationCooldownMs, общая метка не ставится', async () => {
    const { host, beta, room } = await setupLagRoom();

    feed(host, beta, 6);
    expect(requests(host)).toHaveLength(1);

    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'network',
      stay: true,
    });
    advance(8000); // бета не заняла комнату
    expect(room).toMatchObject({ status: 'online', epoch: 1 });
    expect(room.lastAutoMigrationAt).toBeNull();
    expect(room.lastLagHandoffFailedAt).toBe(clock.now);

    // лаг продолжается 80 с — просьб нет
    clock.now += 2000;
    feed(host, beta, 41);
    expect(requests(host)).toHaveLength(1);

    // кулдаун (90 с от срыва) истёк — снова просьба
    clock.now += 2000;
    feed(host, beta, 5);
    expect(requests(host)).toHaveLength(2);
  });

  it('сорванная передача с другой причиной кулдаун лага не ставит', async () => {
    const { host, beta, room } = await setupLagRoom();

    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'overload',
      stay: true,
    });
    advance(8000);
    expect(room.lastLagHandoffFailedAt).toBeNull();

    clock.now += 2000;
    feed(host, beta, 6);
    expect(requests(host)).toHaveLength(1);
  });

  it('авто-передача, деградировавшая в аварийную, тоже ставит метку', async () => {
    const { host, beta, room } = await setupLagRoom();

    host.ws.message({
      type: 'handoff_begin',
      roomId: room.roomId,
      epoch: 1,
      reason: 'hidden',
      stay: true,
    });
    host.ws.drop();
    await registerPromoted(beta, beta.ws.lastOf('promote'));

    expect(room.epoch).toBe(2);
    expect(room.lastAutoMigrationAt).toBe(clock.now);
  });
});

describe('игра комнаты в promote (ревью F1)', () => {
  const begin = host =>
    host.ws.message({
      type: 'handoff_begin',
      roomId: host.roomId,
      epoch: 1,
      reason: 'handover',
      stay: true,
    });

  const GAME = { id: 'tanks', versions: ['1.0.0'] };

  it('promote(checkpoint) несёт игру и версию комнаты', async () => {
    const { host, beta, room } = await setupRoom();

    room.gameVersion = '1.0.0';
    host.ws.drop();

    expect(beta.ws.lastOf('promote').game).toEqual(GAME);
  });

  it('promote(planned) и повтор после обрыва хоста несут игру', async () => {
    const { host, beta, room } = await setupRoom();

    room.gameVersion = '1.0.0';
    begin(host);

    expect(beta.ws.lastOf('promote')).toMatchObject({
      mode: 'planned',
      game: GAME,
    });

    host.ws.drop();

    expect(beta.ws.lastOf('promote')).toMatchObject({
      mode: 'checkpoint',
      game: GAME,
    });
  });

  it('игра неизвестна мастеру — game: null', async () => {
    const { host, beta, room } = await setupRoom();

    room.gameId = null;
    host.ws.drop();

    expect(beta.ws.lastOf('promote').game).toBeNull();
  });

  it('register_host преемника переводит комнату на версию каталога', async () => {
    const { host, beta, room } = await setupRoom();

    room.gameVersion = '1.0.0';
    signaling._gameCatalog = {
      getManifest: id =>
        id === 'tanks'
          ? { version: '1.1.0', maps: { version: 'm1' } }
          : undefined,
    };
    host.ws.drop();
    await registerPromoted(beta, beta.ws.lastOf('promote'), {
      gameVersion: '1.1.0',
    });

    expect(room.status).toBe('online');
    expect(room.gameVersion).toBe('1.1.0');
  });

  it('register_host преемника с посторонней версией её не меняет (ревью N2)', async () => {
    const { host, beta, room } = await setupRoom();

    room.gameVersion = '1.0.0';
    signaling._gameCatalog = {
      getManifest: id =>
        id === 'tanks'
          ? { version: '1.1.0', maps: { version: 'm1' } }
          : undefined,
    };
    host.ws.drop();
    await registerPromoted(beta, beta.ws.lastOf('promote'), {
      gameVersion: '9.9.9',
    });

    // отклоняется только смена версии, не регистрация
    expect(room.status).toBe('online');
    expect(room.gameVersion).toBe('1.0.0');
  });

  it('версия-мусор не затирает известную', async () => {
    const { host, beta, room } = await setupRoom();

    room.gameVersion = '1.0.0';
    host.ws.drop();
    await registerPromoted(beta, beta.ws.lastOf('promote'), {
      gameVersion: 'x'.repeat(65),
    });

    expect(room.status).toBe('online');
    expect(room.gameVersion).toBe('1.0.0');
  });
});

// гость ждёт host_changed столько, сколько мастер ещё ищет преемника: дедлайн
// текущей попытки + migrationNoticeMarginMs (по умолчанию 5000)
describe('host_migrating.waitMs (ревью F12)', () => {
  const beginHandoff = host =>
    host.ws.message({
      type: 'handoff_begin',
      roomId: host.roomId,
      epoch: 1,
      reason: 'handover',
      stay: true,
    });

  it('каждая попытка промоушена рассылает host_migrating со своим waitMs', async () => {
    const { host, beta, guest, room } = await setupRoom();

    host.ws.drop();

    expect(guest.ws.typed('host_migrating')).toEqual([
      {
        type: 'host_migrating',
        roomId: room.roomId,
        epoch: 2,
        reason: 'disconnected',
        waitMs: 15000,
      },
    ]);
    // кандидат тоже: в аварии он бросает транспорт к мёртвому хосту
    expect(beta.ws.lastOf('host_migrating')).toMatchObject({ waitMs: 15000 });
    expect(host.ws.typed('host_migrating')).toEqual([]);

    // бета не справилась — cold-кандидату 25 с, гостям повтор той же эпохи
    advance(10000);

    expect(guest.ws.lastOf('promote')).toMatchObject({ mode: 'cold' });
    expect(guest.ws.typed('host_migrating')).toHaveLength(2);
    expect(guest.ws.lastOf('host_migrating')).toEqual({
      type: 'host_migrating',
      roomId: room.roomId,
      epoch: 2,
      reason: 'disconnected',
      waitMs: 30000,
    });
    expect(beta.ws.lastOf('host_migrating')).toMatchObject({ waitMs: 30000 });
  });

  it('плановая передача: waitMs — handoffTimeoutMs с запасом', async () => {
    const { host, guest } = await setupRoom();

    beginHandoff(host);

    expect(guest.ws.lastOf('host_migrating')).toMatchObject({
      reason: 'handover',
      waitMs: 13000,
    });
  });

  it('передача деградировала в аварию — гостям повтор с promotionTimeoutMs, бете и хосту нет', async () => {
    const { host, beta, guest, room } = await setupRoom();

    beginHandoff(host);
    host.ws.drop();

    expect(room.status).toBe('migrating');
    expect(guest.ws.typed('host_migrating')).toHaveLength(2);
    expect(guest.ws.lastOf('host_migrating')).toEqual({
      type: 'host_migrating',
      roomId: room.roomId,
      epoch: 2,
      reason: 'handover',
      waitMs: 15000,
    });
    expect(beta.ws.typed('host_migrating')).toEqual([]);
    expect(host.ws.typed('host_migrating')).toEqual([]);
  });

  it('migrationNoticeMarginMs настраивается', async () => {
    signaling._migration._timings.migrationNoticeMarginMs = 1000;

    const { host, guest } = await setupRoom();

    host.ws.drop();
    expect(guest.ws.lastOf('host_migrating')).toMatchObject({ waitMs: 11000 });
  });
});
