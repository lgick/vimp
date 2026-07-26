import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import HostRegistry from '../../packages/engine/src/master/HostRegistry.js';
import SignalingServer from '../../packages/engine/src/master/SignalingServer.js';
import RateLimiter from '../../packages/engine/src/lib/rateLimiter.js';

// фейковый ws: собирает отправленные сообщения, позволяет эмитить события
class FakeWs {
  constructor() {
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.terminated = false;
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

  terminate() {
    this.terminated = true;
  }

  // входящее сигнальное сообщение
  message(obj) {
    this.handlers.message(JSON.stringify(obj));
  }

  lastSent() {
    return this.sent[this.sent.length - 1];
  }
}

const nextTick = () => new Promise(resolve => process.nextTick(resolve));

// register_host/like_host/unlike_host — асинхронные обработчики (проверка
// identity-токена по JWKS, запрос к hostRatingProxy); одного nextTick мало,
// crypto.subtle резолвится через реальный event loop
const flushAsync = async () => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

const allowAllOrigins = (requestOrigin, cb) => process.nextTick(() => cb(null));

const ICE_SERVERS = [{ urls: 'stun:stun.test:3478' }];

// identity-токены (server-rating этап 2): подписаны реальным RS256-ключом,
// проверяются verifyIdentityToken по jwks — как настоящий Worker хоста
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const ISSUER = 'vimp-auth-test';

const jwks = {
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }],
};

const signToken = (sub, { issuer = ISSUER } = {}) =>
  jwt.sign({ nick: `user${sub}` }, privateKey, {
    subject: String(sub),
    algorithm: 'RS256',
    keyid: KID,
    issuer,
    expiresIn: '15m',
  });

let registry;
let signaling;
let jwksProxy;
let hostRatingProxy;

beforeEach(() => {
  registry = new HostRegistry({ maxPlayersLimit: 8 });

  jwksProxy = { get: vi.fn(async () => jwks) };
  hostRatingProxy = {
    getRating: vi.fn(async () => ({ status: 200, json: { score: 0, blocked: false } })),
    vote: vi.fn(async () => ({ status: 200, json: { score: 1, blocked: false, counted: true } })),
    getPublic: vi.fn(async () => ({ status: 200, json: { score: 0, blocked: false } })),
  };

  signaling = new SignalingServer(registry, {
    iceServers: ICE_SERVERS,
    regionHeader: 'x-region',
    heartbeatTimeout: 1000,
    pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
    checkOrigin: allowAllOrigins,
    mapsVersion: 'v-test',
    codeVersion: 'code-test',
    jwksProxy,
    hostRatingProxy,
    issuer: ISSUER,
  });
});

// подключает фейковое соединение и возвращает { ws, id }
const connect = async ({ ip = '9.9.9.9', region = 'EU', origin = 'https://localhost:3001' } = {}) => {
  const ws = new FakeWs();
  const req = {
    headers: { origin, 'x-region': region },
    socket: { remoteAddress: ip },
  };

  signaling.handleConnection(ws, req);
  await nextTick();

  return { ws, id: ws.sent[0]?.id };
};

// подключает и регистрирует хоста; hosterUserId — subject identity-токена
const connectHost = async (options = {}) => {
  const { hosterUserId = 1, ...connectOptions } = options;
  const conn = await connect({ ip: '1.1.1.1', ...connectOptions });

  conn.ws.message({
    type: 'register_host',
    name: 'Room',
    maxPlayers: 8,
    mapName: 'arena',
    token: signToken(hosterUserId),
  });
  await flushAsync();

  conn.hostId = conn.ws.lastSent().hostId;
  conn.hosterUserId = hosterUserId;

  return conn;
};

describe('подключение', () => {
  it('шлёт welcome с id соединения и ICE-конфигом', async () => {
    const { ws } = await connect();

    expect(ws.sent[0].type).toBe('welcome');
    expect(ws.sent[0].id).toBeTypeOf('string');
    expect(ws.sent[0].iceServers).toEqual(ICE_SERVERS);
  });

  it('обрывает соединение без origin', async () => {
    const ws = new FakeWs();

    signaling.handleConnection(ws, {
      headers: {},
      socket: { remoteAddress: '1.1.1.1' },
    });

    expect(ws.terminated).toBe(true);
  });

  it('закрывает соединение с чужим origin кодом 4001', async () => {
    const blocking = new SignalingServer(registry, {
      iceServers: ICE_SERVERS,
      regionHeader: 'x-region',
      heartbeatTimeout: 1000,
      pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
      checkOrigin: (o, cb) => process.nextTick(() => cb('blocked')),
    });

    const ws = new FakeWs();

    blocking.handleConnection(ws, {
      headers: { origin: 'https://evil.test' },
      socket: { remoteAddress: '1.1.1.1' },
    });
    await nextTick();

    expect(ws.closed.code).toBe(4001);
    expect(ws.sent).toHaveLength(0);
  });

  it('игнорирует не-JSON и сообщения без известного type', async () => {
    const { ws } = await connect();

    ws.handlers.message('not json');
    ws.message({ type: 'hack_the_planet' });
    ws.message({ foo: 'bar' });

    expect(ws.sent).toHaveLength(1); // только welcome
  });
});

describe('register_host', () => {
  it('регистрирует комнату с регионом из заголовка и IP соединения', async () => {
    const { ws } = await connectHost({ region: 'US' });

    const reply = ws.lastSent();

    expect(reply.type).toBe('host_registered');
    // версии каталога карт и worker-бандла — для сверки хостом при
    // re-register (Этапы 5.1/5.2)
    expect(reply.mapsVersion).toBe('v-test');
    // составной codeVersion (Этап 6.5): движок + игра (без gameId/каталога —
    // игровая половина пуста)
    expect(reply.codeVersion).toEqual({
      engine: 'code-test',
      game: { id: null, version: null },
    });

    const host = registry.get(reply.hostId);

    expect(host).toMatchObject({ name: 'Room', region: 'US', ip: '1.1.1.1' });
  });

  it('атрибутирует комнату к hosterUserId из проверенного identity-токена', async () => {
    const { ws } = await connectHost({ hosterUserId: 7 });

    expect(registry.get(ws.lastSent().hostId).hosterUserId).toBe(7);
  });

  it('без токена — invalidToken, комната не создаётся', async () => {
    const { ws } = await connect({ ip: '1.1.1.1' });

    ws.message({ type: 'register_host', name: 'Room' });
    await flushAsync();

    expect(ws.lastSent()).toEqual({ type: 'error', code: 'invalidToken' });
    expect(registry.size).toBe(0);
  });

  it('с невалидной подписью токена — invalidToken', async () => {
    const { ws } = await connect({ ip: '1.1.1.1' });
    const forged = jwt.sign({ nick: 'x' }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, {
      algorithm: 'RS256',
      keyid: KID,
      issuer: ISSUER,
    });

    ws.message({ type: 'register_host', name: 'Room', token: forged });
    await flushAsync();

    expect(ws.lastSent()).toEqual({ type: 'error', code: 'invalidToken' });
  });

  // кодревью №3 (plan/server-rating/review.md): раньше сбой auth бросал
  // необработанным (пойман только логирующим диспетчером) — хост не получал
  // ни host_registered, ни error, и UI регистрации зависал
  it('недоступность auth при регистрации — явная ошибка клиенту, не тихое зависание', async () => {
    hostRatingProxy.getRating.mockRejectedValue(new Error('auth unreachable'));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws } = await connect({ ip: '1.1.1.1' });

    ws.message({ type: 'register_host', name: 'Room', token: signToken(1) });
    await flushAsync();

    expect(ws.lastSent()).toEqual({ type: 'error', code: 'authServiceUnavailable' });
    expect(registry.size).toBe(0);

    errSpy.mockRestore();
  });

  it('заблокированный по рейтингу хостер не может зарегистрировать комнату', async () => {
    hostRatingProxy.getRating.mockResolvedValue({ status: 200, json: { score: -10, blocked: true } });

    const { ws } = await connect({ ip: '1.1.1.1' });

    ws.message({ type: 'register_host', name: 'Room', token: signToken(1) });
    await flushAsync();

    expect(ws.lastSent()).toEqual({ type: 'error', code: 'blocked' });
    expect(registry.size).toBe(0);
  });

  it('отклоняет повторную регистрацию того же соединения', async () => {
    const { ws } = await connectHost();

    ws.message({ type: 'register_host', name: 'Second', token: signToken(1) });
    await flushAsync();

    expect(ws.lastSent()).toEqual({ type: 'error', code: 'alreadyRegistered' });
    expect(registry.size).toBe(1);
  });

  it('отклоняет вторую комнату с того же IP', async () => {
    await connectHost();
    const second = await connect({ ip: '1.1.1.1' });

    second.ws.message({ type: 'register_host', name: 'Second', token: signToken(2) });
    await flushAsync();

    expect(second.ws.lastSent()).toEqual({ type: 'error', code: 'hostLimit' });
  });

  it('gameId/gameVersion сохраняются и эхо gameId идёт в host_registered', async () => {
    const { ws } = await connect({ ip: '2.2.2.2' });

    ws.message({
      type: 'register_host',
      name: 'Room',
      gameId: 'tanks',
      gameVersion: 'v9',
      token: signToken(1),
    });
    await flushAsync();

    const reply = ws.lastSent();

    expect(reply.gameId).toBe('tanks');
    expect(registry.get(reply.hostId)).toMatchObject({
      gameId: 'tanks',
      gameVersion: 'v9',
    });
  });

  it('с gameCatalog — mapsVersion берётся из манифеста объявленной игры', async () => {
    const withCatalog = new SignalingServer(registry, {
      iceServers: ICE_SERVERS,
      regionHeader: 'x-region',
      heartbeatTimeout: 1000,
      pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
      checkOrigin: allowAllOrigins,
      mapsVersion: 'fallback-version',
      codeVersion: 'code-test',
      jwksProxy,
      hostRatingProxy,
      issuer: ISSUER,
      gameCatalog: {
        getManifest: id =>
          id === 'tanks'
            ? { version: 'tanks-v3', maps: { version: 'tanks-maps-v2' } }
            : undefined,
      },
    });

    const ws = new FakeWs();

    withCatalog.handleConnection(ws, {
      headers: { origin: 'https://localhost:3001', 'x-region': 'EU' },
      socket: { remoteAddress: '3.3.3.3' },
    });
    await nextTick();

    ws.message({ type: 'register_host', name: 'Room', gameId: 'tanks', token: signToken(1) });
    await flushAsync();

    const reply = ws.lastSent();

    expect(reply.mapsVersion).toBe('tanks-maps-v2');
    // codeVersion.game.version — из каталога (источник истины), не из
    // gameVersion, заявленного хостом
    expect(reply.codeVersion.game).toEqual({ id: 'tanks', version: 'tanks-v3' });
  });

  it('без gameId или для неизвестной игры — fallback на статичный mapsVersion', async () => {
    const { ws } = await connectHost();

    expect(ws.lastSent().mapsVersion).toBe('v-test');
  });

  it('кэширует рейтинг хостера из getRating в реестре (server-rating этап 3)', async () => {
    hostRatingProxy.getRating.mockResolvedValue({ status: 200, json: { score: 4, blocked: false } });

    const { ws } = await connectHost();

    expect(registry.get(ws.lastSent().hostId).rating).toBe(4);
  });
});

describe('update_host / heartbeat', () => {
  it('update_host актуализирует данные комнаты', async () => {
    const { ws, hostId } = await connectHost();

    ws.message({ type: 'update_host', currentPlayers: 3, mapName: 'dune' });

    expect(registry.get(hostId)).toMatchObject({
      currentPlayers: 3,
      mapName: 'dune',
    });
  });

  it('heartbeat обновляет lastSeen', async () => {
    const { ws, hostId } = await connectHost();
    const host = registry.get(hostId);

    host.lastSeen = 0;
    ws.message({ type: 'heartbeat' });

    expect(host.lastSeen).toBeGreaterThan(0);
  });
});

describe('маршрутизация WebRTC', () => {
  it('пересылает оффер хосту с clientId, ответ — клиенту с hostId', async () => {
    const host = await connectHost();
    const client = await connect();

    client.ws.message({ type: 'webrtc_offer', hostId: host.hostId, sdp: 'OFFER' });

    expect(host.ws.lastSent()).toEqual({
      type: 'webrtc_offer',
      clientId: client.id,
      sdp: 'OFFER',
    });

    host.ws.message({ type: 'webrtc_answer', clientId: client.id, sdp: 'ANSWER' });

    expect(client.ws.lastSent()).toEqual({
      type: 'webrtc_answer',
      hostId: host.hostId,
      sdp: 'ANSWER',
    });
  });

  it('оффер неизвестному хосту возвращает ошибку', async () => {
    const client = await connect();

    client.ws.message({ type: 'webrtc_offer', hostId: 'nope', sdp: 'OFFER' });

    expect(client.ws.lastSent()).toEqual({ type: 'error', code: 'unknownHost' });
  });

  it('пересылает ICE-кандидатов в обе стороны', async () => {
    const host = await connectHost();
    const client = await connect();

    client.ws.message({
      type: 'ice_candidate',
      targetId: host.hostId,
      candidate: 'C1',
    });

    expect(host.ws.lastSent()).toEqual({
      type: 'ice_candidate',
      fromId: client.id,
      candidate: 'C1',
    });

    host.ws.message({
      type: 'ice_candidate',
      targetId: client.id,
      candidate: 'C2',
    });

    expect(client.ws.lastSent()).toEqual({
      type: 'ice_candidate',
      fromId: host.hostId,
      candidate: 'C2',
    });
  });
});

describe('ping_host / pong_host', () => {
  it('пересылает пинг хосту и понг обратно клиенту', async () => {
    const host = await connectHost();
    const client = await connect();

    client.ws.message({ type: 'ping_host', hostId: host.hostId, pingId: 7 });

    expect(host.ws.lastSent()).toEqual({
      type: 'ping_host',
      clientId: client.id,
      pingId: 7,
    });

    host.ws.message({ type: 'pong_host', clientId: client.id, pingId: 7 });

    expect(client.ws.lastSent()).toEqual({
      type: 'pong_host',
      hostId: host.hostId,
      pingId: 7,
    });
  });

  it('ограничивает частоту пингов с одного IP', async () => {
    const host = await connectHost();
    const client = await connect();

    // лимит в тестовом конфиге — 2 за окно
    client.ws.message({ type: 'ping_host', hostId: host.hostId, pingId: 1 });
    client.ws.message({ type: 'ping_host', hostId: host.hostId, pingId: 2 });
    client.ws.message({ type: 'ping_host', hostId: host.hostId, pingId: 3 });

    expect(client.ws.lastSent()).toEqual({ type: 'error', code: 'rateLimited' });

    // третий пинг до хоста не дошёл
    const pings = host.ws.sent.filter(msg => msg.type === 'ping_host');
    expect(pings).toHaveLength(2);
  });
});

describe('like_host / unlike_host', () => {
  // сессия получает право голоса, только отправив оффер этой комнате
  const joinRoom = (client, hostId) => {
    client.ws.message({ type: 'webrtc_offer', hostId, sdp: 'offer' });
  };

  it('/like шлёт голос +1 в auth через hostRatingProxy', async () => {
    const host = await connectHost({ hosterUserId: 3 });
    const client = await connect({ ip: '5.5.5.5' });
    const token = signToken(9);

    joinRoom(client, host.hostId);
    client.ws.message({ type: 'like_host', hostId: host.hostId, reason: 'good game', token });
    await flushAsync();

    expect(hostRatingProxy.vote).toHaveBeenCalledWith(token, 3, 1, 'good game');
  });

  it('/unlike шлёт голос -1', async () => {
    const host = await connectHost({ hosterUserId: 3 });
    const client = await connect({ ip: '5.5.5.5' });
    const token = signToken(9);

    joinRoom(client, host.hostId);
    client.ws.message({ type: 'unlike_host', hostId: host.hostId, reason: 'aimbot', token });
    await flushAsync();

    expect(hostRatingProxy.vote).toHaveBeenCalledWith(token, 3, -1, 'aimbot');
  });

  it('отклоняет голос от сессии, не подключавшейся к комнате', async () => {
    const host = await connectHost();
    const stranger = await connect({ ip: '7.7.7.7' });

    stranger.ws.message({
      type: 'like_host',
      hostId: host.hostId,
      reason: 'aimbot',
      token: signToken(9),
    });
    await flushAsync();

    expect(stranger.ws.lastSent()).toEqual({ type: 'error', code: 'voteRejected' });
    expect(hostRatingProxy.vote).not.toHaveBeenCalled();
  });

  it('не учитывает голос без причины (причина обязательна)', async () => {
    const host = await connectHost();
    const client = await connect({ ip: '5.5.5.5' });

    joinRoom(client, host.hostId);
    client.ws.message({ type: 'like_host', hostId: host.hostId, token: signToken(9) });
    await flushAsync();

    expect(hostRatingProxy.vote).not.toHaveBeenCalled();
  });

  it('без валидного identity-токена голосующего — invalidToken', async () => {
    const host = await connectHost();
    const client = await connect({ ip: '5.5.5.5' });

    joinRoom(client, host.hostId);
    client.ws.message({ type: 'like_host', hostId: host.hostId, reason: 'good' });
    await flushAsync();

    expect(client.ws.lastSent()).toEqual({ type: 'error', code: 'invalidToken' });
    expect(hostRatingProxy.vote).not.toHaveBeenCalled();
  });

  it('голос комнате, отключившейся после оффера, возвращает unknownHost', async () => {
    const host = await connectHost();
    const client = await connect({ ip: '5.5.5.5' });

    joinRoom(client, host.hostId);
    host.ws.handlers.close(); // хост ушёл, комната удалена из реестра

    client.ws.message({ type: 'like_host', hostId: host.hostId, reason: 'x', token: signToken(9) });
    await flushAsync();

    expect(client.ws.lastSent()).toEqual({ type: 'error', code: 'unknownHost' });
  });

  it('при достижении blockAt закрывает сигнальный WS хоста', async () => {
    hostRatingProxy.vote.mockResolvedValue({ status: 200, json: { score: -10, blocked: true } });

    const host = await connectHost();
    const client = await connect({ ip: '5.5.5.5' });

    joinRoom(client, host.hostId);
    client.ws.message({ type: 'unlike_host', hostId: host.hostId, reason: 'cheat', token: signToken(9) });
    await flushAsync();

    // WS хоста закрыт кодом 4002; его close-хендлер убрал комнату из реестра
    expect(host.ws.closed.code).toBe(4002);
    expect(registry.get(host.hostId)).toBeUndefined();
  });

  // кодревью №3 (plan/server-rating/review.md): раньше сбой auth во время
  // голоса бросал необработанным — клиенту уже сказали "Vote sent", ошибка
  // никуда не долетала
  it('недоступность auth при голосе — явная ошибка, а не тихий провал', async () => {
    hostRatingProxy.vote.mockRejectedValue(new Error('auth unreachable'));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = await connectHost({ hosterUserId: 3 });
    const client = await connect({ ip: '5.5.5.5' });

    joinRoom(client, host.hostId);
    client.ws.message({ type: 'like_host', hostId: host.hostId, reason: 'good', token: signToken(9) });
    await flushAsync();

    expect(client.ws.lastSent()).toEqual({ type: 'error', code: 'authServiceUnavailable' });

    errSpy.mockRestore();
  });

  it('обновляет закэшированный рейтинг комнаты сразу после голоса', async () => {
    hostRatingProxy.vote.mockResolvedValue({ status: 200, json: { score: 5, blocked: false, counted: true } });

    const host = await connectHost();
    const client = await connect({ ip: '5.5.5.5' });

    joinRoom(client, host.hostId);
    client.ws.message({ type: 'like_host', hostId: host.hostId, reason: 'good', token: signToken(9) });
    await flushAsync();

    expect(registry.get(host.hostId).rating).toBe(5);
  });
});

describe('refreshRatings', () => {
  it('обновляет рейтинг активных хостеров периодическим опросом auth', async () => {
    const a = await connectHost({ hosterUserId: 1, ip: '10.0.0.1' });
    const b = await connectHost({ hosterUserId: 2, ip: '10.0.0.2' });

    hostRatingProxy.getPublic.mockImplementation(async hosterUserId => ({
      status: 200,
      json: { score: hosterUserId === 1 ? 3 : -2, blocked: false },
    }));

    await signaling.refreshRatings();

    expect(registry.get(a.hostId).rating).toBe(3);
    expect(registry.get(b.hostId).rating).toBe(-2);
  });

  it('без hostRatingProxy — no-op', async () => {
    const bare = new SignalingServer(registry, {
      iceServers: ICE_SERVERS,
      regionHeader: 'x-region',
      heartbeatTimeout: 1000,
      pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
      checkOrigin: allowAllOrigins,
    });

    await expect(bare.refreshRatings()).resolves.toBeUndefined();
  });

  it('ошибку опроса одного хостера логирует и не прерывает остальных', async () => {
    await connectHost({ hosterUserId: 1, ip: '10.0.0.3' });
    const b = await connectHost({ hosterUserId: 2, ip: '10.0.0.4' });

    hostRatingProxy.getPublic.mockImplementation(async hosterUserId => {
      if (hosterUserId === 1) {
        throw new Error('network fail');
      }

      return { status: 200, json: { score: 7, blocked: false } };
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await signaling.refreshRatings();

    expect(registry.get(b.hostId).rating).toBe(7);
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  // кодревью №2 (plan/server-rating/review.md): блок раньше применялся
  // только в register_host/_vote — хостер, забаненный на другом мастере
  // (или в прошлом, до рестарта), продолжал держать живую комнату здесь до
  // следующей попытки регистрации. refreshRatings теперь эвакуирует её.
  it('эвакуирует комнату хостера, заблокированного вне этого мастера', async () => {
    const host = await connectHost({ hosterUserId: 1, ip: '10.0.0.5' });

    hostRatingProxy.getPublic.mockResolvedValue({
      status: 200,
      json: { score: -10, blocked: true },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await signaling.refreshRatings();

    expect(host.ws.closed.code).toBe(4002);
    expect(registry.get(host.hostId)).toBeUndefined();

    warnSpy.mockRestore();
  });
});

describe('жизненный цикл хоста', () => {
  it('отключение хоста удаляет комнату из реестра', async () => {
    const host = await connectHost();

    host.ws.handlers.close();

    expect(registry.get(host.hostId)).toBeUndefined();

    // адресованные мёртвому хосту сообщения дают unknownHost
    const client = await connect();
    client.ws.message({ type: 'webrtc_offer', hostId: host.hostId, sdp: 'X' });

    expect(client.ws.lastSent()).toEqual({ type: 'error', code: 'unknownHost' });
  });

  it('sweepStaleHosts удаляет протухшую комнату и закрывает её сокет', async () => {
    const host = await connectHost();

    registry.get(host.hostId).lastSeen = 0;

    const removed = signaling.sweepStaleHosts(5000);

    expect(removed).toEqual([host.hostId]);
    expect(registry.get(host.hostId)).toBeUndefined();
    expect(host.ws.closed.code).toBe(4000);
  });
});
