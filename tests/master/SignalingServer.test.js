import crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import RoomRegistry from '../../packages/engine/src/master/RoomRegistry.js';
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

// register_host — асинхронный обработчик (проверка identity-токена по
// JWKS). Раньше ждали фиксированным
// циклом setImmediate — на full run изредка не хватало тиков (тредпул под
// нагрузкой много RSA-верификаций подряд). signaling.idle() ждёт реальный
// промис хендлера, а не гадает по числу тиков — детерминированно, без таймеров.
// ВНИМАНИЕ: целится в инстанс signaling из beforeEach; для другого инстанса
// (withCatalog, blocking, bare) вызывай <instance>.idle() напрямую
const flushAsync = () => signaling.idle();

const allowAllOrigins = (requestOrigin, cb) => process.nextTick(() => cb(null));

const ICE_SERVERS = [{ urls: 'stun:stun.test:3478' }];

// identity-токены: подписаны реальным RS256-ключом,
// проверяются verifyIdentityToken по jwks — как настоящий Worker хоста
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

const signToken = (sub, { issuer = ISSUER } = {}) =>
  jwt.sign({ nick: `user${sub}` }, privateKey, {
    subject: String(sub),
    algorithm: 'RS256',
    keyid: KID,
    issuer,
    expiresIn: '15m',
  });

const SECRET_KEY = 'k'.repeat(32);
const REGISTRY_OPTIONS = {
  maxPlayersLimit: 8,
  secretKey: SECRET_KEY,
  heartbeatTimeout: 1000,
  memberGraceMs: 500,
  hostReclaimGraceMs: 300,
};

// memberId вкладки — crypto.randomUUID() на клиенте
const memberIdOf = n =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let registry;
let signaling;
let jwksProxy;

beforeEach(() => {
  registry = new RoomRegistry(REGISTRY_OPTIONS);

  jwksProxy = { get: vi.fn(async () => jwks) };
  signaling = new SignalingServer(registry, {
    iceServers: ICE_SERVERS,
    regionHeader: 'x-region',
    hostReclaimGraceMs: 300,
    pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
    checkOrigin: allowAllOrigins,
    mapsVersion: 'v-test',
    codeVersion: 'code-test',
    jwksProxy,
    issuer: ISSUER,
  });
});

// подключает фейковое соединение и возвращает { ws, id }
const connect = async ({
  ip = '9.9.9.9',
  region = 'EU',
  origin = 'https://localhost:3001',
} = {}) => {
  const ws = new FakeWs();
  const req = {
    headers: { origin, 'x-region': region },
    socket: { remoteAddress: ip },
  };

  signaling.handleConnection(ws, req);
  await nextTick();

  return { ws, id: ws.sent[0]?.id };
};

// подключает и регистрирует хоста; hostUserId — subject identity-токена
const connectHost = async (options = {}) => {
  const { hostUserId = 1, ...connectOptions } = options;
  const conn = await connect({ ip: '1.1.1.1', ...connectOptions });

  conn.ws.message({
    type: 'register_host',
    maxPlayers: 8,
    info: 'arena',
    token: signToken(hostUserId),
    memberId: memberIdOf(hostUserId),
  });
  await flushAsync();

  // fail-fast: без этого сбой регистрации даёт каскад "Cannot read 'roomId' of
  // undefined" в далёких ассертах вместо внятной причины
  const reply = conn.ws.lastSent();

  if (reply?.type !== 'host_registered') {
    throw new Error(
      `register_host failed: ${reply?.type}${reply?.code ? ` (${reply.code})` : ''}`,
    );
  }

  conn.roomId = reply.roomId;
  conn.epoch = reply.epoch;
  conn.roomSecret = reply.roomSecret;
  conn.hostUserId = hostUserId;

  return conn;
};

describe('подключение', () => {
  it('шлёт welcome с id соединения и ICE-конфигом', async () => {
    const { ws } = await connect();

    expect(ws.sent[0].type).toBe('welcome');
    expect(ws.sent[0].id).toBeTypeOf('string');
    expect(ws.sent[0].iceServers).toEqual(ICE_SERVERS);
  });

  it('обрывает соединение без адреса сокета', () => {
    const ws = new FakeWs();

    signaling.handleConnection(ws, {
      headers: { origin: 'https://localhost:3001' },
      socket: {},
    });

    expect(ws.terminated).toBe(true);
  });

  // review-4.md (R4-3): ws эмитит 'error' на самом сокете, и без слушателя это
  // uncaughtException. Обе ветки досрочного отказа зовут terminate(), а ветка
  // «нет адреса» срабатывает как раз на уже разорванном сокете — самом
  // вероятном источнике позднего ECONNRESET
  it('слушатель error стоит и на отбитых соединениях', () => {
    const noAddress = new FakeWs();
    const noOrigin = new FakeWs();

    signaling.handleConnection(noAddress, {
      headers: { origin: 'https://localhost:3001' },
      socket: {},
    });
    signaling.handleConnection(noOrigin, { headers: {}, socket: {} });

    for (const ws of [noAddress, noOrigin]) {
      expect(ws.terminated).toBe(true);
      expect(typeof ws.handlers.error).toBe('function');
      // сам вызов не должен бросать: без слушателя это и был uncaughtException
      expect(() => ws.handlers.error(new Error('ECONNRESET'))).not.toThrow();
    }
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

  // причина close ограничена 123 байтами: полный текст ошибки (он содержит
  // origin запроса) отдавать клиенту нельзя — ws бросил бы RangeError,
  // и длинный Origin валил бы процесс
  it('шлёт короткую причину отказа независимо от длины origin', async () => {
    const longOrigin = `https://${'a'.repeat(300)}.test`;
    const blocking = new SignalingServer(registry, {
      iceServers: ICE_SERVERS,
      regionHeader: 'x-region',
      heartbeatTimeout: 1000,
      pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
      checkOrigin: (o, cb) =>
        process.nextTick(() =>
          cb(`Blocked connection from invalid origin: ${o}`),
        ),
    });

    const ws = new FakeWs();

    blocking.handleConnection(ws, {
      headers: { origin: longOrigin },
      socket: { remoteAddress: '1.1.1.1' },
    });
    await nextTick();

    expect(ws.closed.code).toBe(4001);
    expect(Buffer.byteLength(ws.closed.reason)).toBeLessThanOrEqual(123);
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

    const room = registry.get(reply.roomId);

    expect(room).toMatchObject({
      epoch: 1,
      region: 'US',
      host: { ip: '1.1.1.1', memberId: memberIdOf(1) },
    });
    expect(room).not.toHaveProperty('name');
    expect(reply.epoch).toBe(1);

    // секрет эпохи уходит только этой сессии — хост доказывает им владение
    // при атрибуции rank/state и в reclaim_host
    expect(reply.roomSecret).toBe(registry.roomSecret(room));
    // алиасы для страниц, загруженных до деплоя
    expect(reply.hostId).toBe(reply.roomId);
    expect(reply.hostSecret).toBe(reply.roomSecret);
  });

  it('хост — участник своей комнаты (ник из токена)', async () => {
    const { roomId } = await connectHost({ hostUserId: 4 });

    expect(registry.get(roomId).members.get(memberIdOf(4))).toMatchObject({
      userId: 4,
      nick: 'user4',
    });
  });

  it('без memberId (страница до этапа 2) участником становится соединение', async () => {
    const { ws, id } = await connect({ ip: '1.1.1.1' });

    ws.message({ type: 'register_host', name: 'Old', token: signToken(1) });
    await flushAsync();

    const room = registry.get(ws.lastSent().roomId);

    expect(room.host.memberId).toBe(id);
  });

  it('привязывает комнату к hostUserId из проверенного identity-токена', async () => {
    const { ws } = await connectHost({ hostUserId: 7 });

    expect(registry.get(ws.lastSent().roomId).host.userId).toBe(7);
  });

  it('без токена — invalidToken, комната не создаётся', async () => {
    const { ws } = await connect({ ip: '1.1.1.1' });

    ws.message({ type: 'register_host', name: 'Room' });
    await flushAsync();

    expect(ws.lastSent()).toEqual({
      type: 'error',
      code: 'invalidToken',
      re: 'register_host',
    });
    expect(registry.size).toBe(0);
  });

  it('с невалидной подписью токена — invalidToken', async () => {
    const { ws } = await connect({ ip: '1.1.1.1' });
    const forged = jwt.sign(
      { nick: 'x' },
      crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
      {
        algorithm: 'RS256',
        keyid: KID,
        issuer: ISSUER,
      },
    );

    ws.message({ type: 'register_host', name: 'Room', token: forged });
    await flushAsync();

    expect(ws.lastSent()).toEqual({
      type: 'error',
      code: 'invalidToken',
      re: 'register_host',
    });
  });

  // игра, помеченная каталогом недоступной (compat.ok === false, этап 5
  // плана plugin-forward-compat), в лобби показана disabled — но это решение
  // КЛИЕНТА. Хост со своей сборкой поднял бы по ней комнату, она попала бы в
  // список живой строкой, а присоединяющиеся упёрлись бы в loadClientPlugin
  describe('игра, помеченная каталогом недоступной', () => {
    const catalogWithUnavailable = () => ({
      getManifest: id =>
        id === 'snakes'
          ? { id, compat: { ok: false, text: 'needs accolades' } }
          : { id, version: 'v1', maps: { version: 'tanks-maps-v1' } },
    });

    const serverWithCatalog = () =>
      new SignalingServer(registry, {
        iceServers: ICE_SERVERS,
        regionHeader: 'x-region',
        heartbeatTimeout: 1000,
        pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
        checkOrigin: allowAllOrigins,
        mapsVersion: 'v-test',
        codeVersion: 'code-test',
        jwksProxy,
        issuer: ISSUER,
        gameCatalog: catalogWithUnavailable(),
      });

    const registerOn = async (server, gameId) => {
      const ws = new FakeWs();

      server.handleConnection(ws, {
        headers: { origin: 'https://localhost:3001', 'x-region': 'EU' },
        socket: { remoteAddress: '3.3.3.3' },
      });
      await nextTick();

      ws.message({
        type: 'register_host',
        name: 'Room',
        gameId,
        token: signToken(1),
      });
      await server.idle();

      return ws;
    };

    it('регистрация хоста отклоняется кодом gameUnavailable', async () => {
      const ws = await registerOn(serverWithCatalog(), 'snakes');

      expect(ws.lastSent()).toEqual({
        type: 'error',
        code: 'gameUnavailable',
        re: 'register_host',
      });
      expect(registry.size).toBe(0);
      // проверка стоит до проверки токена: она дешевле запроса JWKS
      expect(jwksProxy.get).not.toHaveBeenCalled();
    });

    it('доступная игра того же каталога регистрируется как обычно', async () => {
      const ws = await registerOn(serverWithCatalog(), 'tanks');

      expect(ws.lastSent().type).toBe('host_registered');
      expect(registry.size).toBe(1);
    });
  });

  it('отклоняет повторную регистрацию того же соединения', async () => {
    const { ws } = await connectHost();

    ws.message({ type: 'register_host', name: 'Second', token: signToken(1) });
    await flushAsync();

    expect(ws.lastSent()).toEqual({
      type: 'error',
      code: 'alreadyRegistered',
      re: 'register_host',
    });
    expect(registry.size).toBe(1);
  });

  it('отклоняет вторую комнату с того же IP', async () => {
    await connectHost();
    const second = await connect({ ip: '1.1.1.1' });

    second.ws.message({
      type: 'register_host',
      name: 'Second',
      token: signToken(2),
    });
    await flushAsync();

    expect(second.ws.lastSent()).toEqual({
      type: 'error',
      code: 'hostLimit',
      re: 'register_host',
    });
  });

  // review-3.md (R3-1): Nginx деплоя ставит X-Forwarded-For через
  // $proxy_add_x_forwarded_for, то есть ДОПИСЫВАЕТ реальный адрес к
  // клиентскому. Ключом лимитов он быть не может: иначе свой заголовок на
  // каждое соединение снимает и «одну комнату на IP», и лимит пингов
  it('X-Forwarded-For адрес не подменяет', async () => {
    await connectHost();

    const ws = new FakeWs();

    signaling.handleConnection(ws, {
      headers: {
        origin: 'https://localhost:3001',
        'x-region': 'EU',
        'x-forwarded-for': '8.8.8.8',
        // без trustProxy не считается и X-Real-IP
        'x-real-ip': '9.9.9.9',
      },
      socket: { remoteAddress: '1.1.1.1' },
    });
    await nextTick();

    ws.message({ type: 'register_host', name: 'Second', token: signToken(2) });
    await flushAsync();

    expect(ws.lastSent()).toEqual({
      type: 'error',
      code: 'hostLimit',
      re: 'register_host',
    });
  });

  // за прод-Nginx адрес приходит в X-Real-IP (его прокси перезаписывает), и
  // соединения с разными X-Real-IP — разные клиенты, хотя сокет один и тот же
  it('с trustProxy ключом становится X-Real-IP', async () => {
    const proxied = new SignalingServer(new RoomRegistry(REGISTRY_OPTIONS), {
      iceServers: ICE_SERVERS,
      regionHeader: 'x-region',
      heartbeatTimeout: 1000,
      pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
      checkOrigin: allowAllOrigins,
      trustProxy: true,
      jwksProxy,
      issuer: ISSUER,
    });

    const register = async (realIp, userId) => {
      const ws = new FakeWs();

      proxied.handleConnection(ws, {
        headers: {
          origin: 'https://localhost:3001',
          'x-region': 'EU',
          'x-real-ip': realIp,
        },
        socket: { remoteAddress: '1.1.1.1' },
      });
      await nextTick();

      ws.message({
        type: 'register_host',
        name: `Room ${userId}`,
        token: signToken(userId),
      });
      await proxied.idle();

      return ws.lastSent();
    };

    expect((await register('7.7.7.7', 1)).type).toBe('host_registered');
    expect((await register('8.8.8.8', 2)).type).toBe('host_registered');
    expect(await register('8.8.8.8', 3)).toEqual({
      type: 'error',
      code: 'hostLimit',
      re: 'register_host',
    });
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
    expect(registry.get(reply.roomId)).toMatchObject({
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

    ws.message({
      type: 'register_host',
      name: 'Room',
      gameId: 'tanks',
      token: signToken(1),
    });
    await withCatalog.idle();

    const reply = ws.lastSent();

    expect(reply.mapsVersion).toBe('tanks-maps-v2');
    // codeVersion.game.version — из каталога (источник истины), не из
    // gameVersion, заявленного хостом
    expect(reply.codeVersion.game).toEqual({
      id: 'tanks',
      version: 'tanks-v3',
    });
  });

  it('комната на застейдженной версии регистрируется скрытой (этап 3.5)', async () => {
    const staged = new SignalingServer(registry, {
      iceServers: ICE_SERVERS,
      regionHeader: 'x-region',
      heartbeatTimeout: 1000,
      pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
      checkOrigin: allowAllOrigins,
      mapsVersion: 'fallback-version',
      codeVersion: 'code-test',
      jwksProxy,
      issuer: ISSUER,
      gameCatalog: {
        getManifest: () => ({ version: 'tanks-v3', maps: { version: 'm1' } }),
        isStaged: (id, version) => id === 'tanks' && version === 'tanks-v4',
      },
    });

    const ws = new FakeWs();

    staged.handleConnection(ws, {
      headers: { origin: 'https://localhost:3001', 'x-region': 'EU' },
      socket: { remoteAddress: '4.4.4.4' },
    });
    await nextTick();

    ws.message({
      type: 'register_host',
      name: 'Test room',
      gameId: 'tanks',
      gameVersion: 'tanks-v4',
      token: signToken(1),
    });
    await staged.idle();

    const roomId = ws.lastSent().roomId;

    expect(registry.get(roomId).hidden).toBe(true);
    expect(registry.getList().servers).toEqual([]);
    expect(registry.getList({ includeHidden: true }).servers).toHaveLength(1);
  });

  it('без gameId или для неизвестной игры — fallback на статичный mapsVersion', async () => {
    const { ws } = await connectHost();

    expect(ws.lastSent().mapsVersion).toBe('v-test');
  });

  it('host_registered и публичный список не несут рейтинга', async () => {
    const { ws } = await connectHost();

    expect(ws.lastSent()).not.toHaveProperty('rating');
    expect(registry.getList().servers[0]).not.toHaveProperty('rating');
  });
});

describe('update_host / heartbeat', () => {
  it('update_host актуализирует строку карточки; самоотчёт currentPlayers игнорируется', async () => {
    const { ws, roomId } = await connectHost();

    ws.message({ type: 'update_host', currentPlayers: 3, info: 'dune' });

    expect(registry.get(roomId).info).toBe('dune');
    expect(registry.getList().servers[0].currentPlayers).toBe(1);
  });

  it('heartbeat обновляет lastSeen', async () => {
    const { ws, roomId } = await connectHost();
    const room = registry.get(roomId);

    room.lastSeen = 0;
    ws.message({ type: 'heartbeat' });

    expect(room.lastSeen).toBeGreaterThan(0);
  });

  it('update_host { info: null } очищает строку, без поля — не трогает', async () => {
    const { ws, roomId } = await connectHost();

    ws.message({ type: 'update_host' });
    expect(registry.get(roomId).info).toBe('arena');

    ws.message({ type: 'update_host', info: null });
    expect(registry.get(roomId).info).toBeNull();
  });

  // страница до host-migration этапа 2 присылает имя карты как mapName
  it('mapName старых страниц — алиас info', async () => {
    const { ws, roomId } = await connectHost();

    ws.message({ type: 'update_host', mapName: 'dune' });

    expect(registry.get(roomId).info).toBe('dune');

    const old = await connect({ ip: '2.2.2.2' });

    old.ws.message({
      type: 'register_host',
      name: 'Old',
      mapName: 'arena',
      token: signToken(2),
    });
    await flushAsync();

    expect(registry.get(old.ws.lastSent().roomId).info).toBe('arena');
  });

  it('register_host без info — строки карточки нет', async () => {
    const { ws } = await connect({ ip: '3.3.3.3' });

    ws.message({ type: 'register_host', token: signToken(3) });
    await flushAsync();

    expect(registry.get(ws.lastSent().roomId).info).toBeNull();
  });

  it('update_host/heartbeat не от хоста комнаты игнорируются', async () => {
    const { roomId } = await connectHost();
    const stranger = await connect();
    const room = registry.get(roomId);

    room.lastSeen = 0;
    stranger.ws.message({ type: 'update_host', info: 'hacked' });
    stranger.ws.message({ type: 'heartbeat' });

    expect(room).toMatchObject({ lastSeen: 0, info: 'arena' });
  });
});

describe('маршрутизация WebRTC', () => {
  it('пересылает оффер хосту комнаты с clientId/memberId/epoch, ответ — клиенту с roomId', async () => {
    const host = await connectHost();
    const client = await connect();

    client.ws.message({
      type: 'webrtc_offer',
      roomId: host.roomId,
      sdp: 'OFFER',
      memberId: memberIdOf(50),
      resume: true,
    });

    expect(host.ws.lastSent()).toEqual({
      type: 'webrtc_offer',
      clientId: client.id,
      sdp: 'OFFER',
      memberId: memberIdOf(50),
      resume: true,
      epoch: 1,
    });

    host.ws.message({
      type: 'webrtc_answer',
      clientId: client.id,
      sdp: 'ANSWER',
    });

    expect(client.ws.lastSent()).toEqual({
      type: 'webrtc_answer',
      roomId: host.roomId,
      hostId: host.roomId,
      epoch: 1,
      sdp: 'ANSWER',
    });
  });

  it('оффер участника комнаты несёт его зарегистрированный memberId, а не присланный', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);

    guest.ws.message({
      type: 'webrtc_offer',
      roomId: host.roomId,
      sdp: 'OFFER',
      memberId: memberIdOf(1),
    });

    expect(host.ws.lastSent()).toMatchObject({
      type: 'webrtc_offer',
      clientId: guest.id,
      memberId: guest.memberId,
    });
  });

  // ревью N4: иначе хост принял бы чужой пир за живого участника (канал
  // standby, подтверждение в room_peers)
  it('оффер не-участника с memberId живого участника уходит хосту без memberId', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);
    const stranger = await connect({ ip: '6.6.6.6' });

    stranger.ws.message({
      type: 'webrtc_offer',
      roomId: host.roomId,
      sdp: 'OFFER',
      memberId: guest.memberId,
    });

    const offer = host.ws.lastSent();

    expect(offer).toMatchObject({
      type: 'webrtc_offer',
      clientId: stranger.id,
    });
    expect(offer.memberId).toBeUndefined();
  });

  it('оффер не-участника со свободным memberId пересылается как есть', async () => {
    const host = await connectHost();
    await joinRoom(host.roomId);
    const client = await connect({ ip: '6.6.6.6' });

    client.ws.message({
      type: 'webrtc_offer',
      roomId: host.roomId,
      sdp: 'OFFER',
      memberId: memberIdOf(70),
    });

    expect(host.ws.lastSent()).toMatchObject({
      type: 'webrtc_offer',
      clientId: client.id,
      memberId: memberIdOf(70),
    });
  });

  it('оффер с memberId отсоединённого участника (grace) пересылается', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);

    guest.ws.handlers.close();

    // реконнект: оффер с resume обгоняет повторный join_room
    const again = await connect({ ip: '6.6.6.6' });

    again.ws.message({
      type: 'webrtc_offer',
      roomId: host.roomId,
      sdp: 'OFFER',
      memberId: guest.memberId,
      resume: true,
    });

    expect(host.ws.lastSent()).toMatchObject({
      type: 'webrtc_offer',
      clientId: again.id,
      memberId: guest.memberId,
    });
  });

  it('hostId в оффере — алиас roomId (страницы до этапа 2)', async () => {
    const host = await connectHost();
    const client = await connect();

    client.ws.message({ type: 'webrtc_offer', hostId: host.roomId, sdp: 'O' });

    expect(host.ws.lastSent()).toEqual({
      type: 'webrtc_offer',
      clientId: client.id,
      sdp: 'O',
      epoch: 1,
    });
  });

  it('оффер в неизвестную комнату — unknownRoom (алиас unknownHost)', async () => {
    const client = await connect();

    client.ws.message({ type: 'webrtc_offer', roomId: 'nope', sdp: 'OFFER' });

    expect(client.ws.lastSent()).toEqual({
      type: 'error',
      code: 'unknownRoom',
      re: 'webrtc_offer',
      roomId: 'nope',
      alias: 'unknownHost',
    });
  });

  it('пересылает ICE-кандидатов в обе стороны', async () => {
    const host = await connectHost();
    const client = await connect();

    client.ws.message({
      type: 'ice_candidate',
      targetId: host.roomId,
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
      fromId: host.roomId,
      epoch: 1,
      candidate: 'C2',
    });
  });
});

describe('ping_host / pong_host', () => {
  it('пересылает пинг хосту и понг обратно клиенту', async () => {
    const host = await connectHost();
    const client = await connect();

    client.ws.message({ type: 'ping_host', roomId: host.roomId, pingId: 7 });

    expect(host.ws.lastSent()).toEqual({
      type: 'ping_host',
      clientId: client.id,
      pingId: 7,
    });

    host.ws.message({ type: 'pong_host', clientId: client.id, pingId: 7 });

    expect(client.ws.lastSent()).toEqual({
      type: 'pong_host',
      roomId: host.roomId,
      hostId: host.roomId,
      pingId: 7,
    });
  });

  it('ограничивает частоту пингов с одного IP', async () => {
    const host = await connectHost();
    const client = await connect();

    // лимит в тестовом конфиге — 2 за окно
    client.ws.message({ type: 'ping_host', hostId: host.roomId, pingId: 1 });
    client.ws.message({ type: 'ping_host', roomId: host.roomId, pingId: 2 });
    client.ws.message({ type: 'ping_host', roomId: host.roomId, pingId: 3 });

    expect(client.ws.lastSent()).toEqual({
      type: 'error',
      code: 'rateLimited',
      re: 'ping_host',
    });

    // третий пинг до хоста не дошёл
    const pings = host.ws.sent.filter(msg => msg.type === 'ping_host');
    expect(pings).toHaveLength(2);
  });
});

// /like·/unlike удалены вместе с рейтингом серверов: старый клиент, ещё
// шлющий like_host/unlike_host, получает тишину, комната не трогается
describe('like_host / unlike_host (удалены)', () => {
  it('сообщения игнорируются как неизвестный type', async () => {
    const host = await connectHost({ hostUserId: 3 });
    const client = await connect({ ip: '5.5.5.5' });

    client.ws.message({ type: 'webrtc_offer', roomId: host.roomId, sdp: 'o' });

    const sentBefore = client.ws.sent.length;

    for (const type of ['like_host', 'unlike_host']) {
      client.ws.message({
        type,
        hostId: host.roomId,
        reason: 'r',
        token: signToken(9),
      });
    }
    await flushAsync();

    expect(client.ws.sent.length).toBe(sentBefore);
    expect(host.ws.closed).toBeFalsy();
    expect(registry.get(host.roomId)).toBeDefined();
  });
});

// гость входит в комнату (после AUTH_RESULT у хоста) и выходит из неё
const joinRoom = async (roomId, { userId = 50, ip = '5.5.5.5' } = {}) => {
  const conn = await connect({ ip });

  conn.memberId = memberIdOf(userId);
  conn.ws.message({
    type: 'join_room',
    roomId,
    memberId: conn.memberId,
    token: signToken(userId),
  });
  await flushAsync();

  return conn;
};

describe('join_room / leave_room', () => {
  it('участник добавлен, ответ room_joined с эпохой', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);

    expect(guest.ws.lastSent()).toEqual({
      type: 'room_joined',
      roomId: host.roomId,
      epoch: 1,
    });
    expect(registry.get(host.roomId).members.get(guest.memberId)).toMatchObject(
      { userId: 50, nick: 'user50', sessionId: guest.id },
    );
    expect(registry.getList().servers[0].currentPlayers).toBe(2);
  });

  it('неизвестная комната — unknownRoom, без токена — invalidToken', async () => {
    const guest = await joinRoom('abcd1234');

    expect(guest.ws.lastSent()).toEqual({
      type: 'error',
      code: 'unknownRoom',
      re: 'join_room',
      roomId: 'abcd1234',
    });

    const host = await connectHost();
    const anon = await connect({ ip: '6.6.6.6' });

    anon.ws.message({
      type: 'join_room',
      roomId: host.roomId,
      memberId: memberIdOf(60),
    });
    await flushAsync();

    expect(anon.ws.lastSent()).toEqual({
      type: 'error',
      code: 'invalidToken',
      re: 'join_room',
      roomId: host.roomId,
    });
  });

  it('реконнект сигналинга: тот же memberId перепривязывается', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);

    guest.ws.handlers.close();

    const member = registry.get(host.roomId).members.get(guest.memberId);

    expect(member.sessionId).toBeNull();

    const again = await joinRoom(host.roomId);

    expect(
      registry.get(host.roomId).members.get(guest.memberId).sessionId,
    ).toBe(again.id);
    expect(registry.get(host.roomId).members.size).toBe(2);
  });

  it('leave_room удаляет участника сразу', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);

    guest.ws.message({ type: 'leave_room', roomId: host.roomId });

    expect(registry.get(host.roomId).members.has(guest.memberId)).toBe(false);
  });

  it('leave_room хоста комнату не трогает', async () => {
    const host = await connectHost();

    host.ws.message({ type: 'leave_room', roomId: host.roomId });

    expect(registry.get(host.roomId).members.size).toBe(1);
  });

  it('join_room с чужим memberId другого пользователя — memberTaken, запись не тронута', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId, { userId: 50 });
    const thief = await connect({ ip: '6.6.6.6' });

    thief.ws.message({
      type: 'join_room',
      roomId: host.roomId,
      memberId: guest.memberId,
      token: signToken(77),
    });
    await flushAsync();

    expect(thief.ws.lastSent()).toEqual({
      type: 'error',
      code: 'memberTaken',
      re: 'join_room',
      roomId: host.roomId,
    });
    expect(registry.get(host.roomId).members.get(guest.memberId)).toMatchObject(
      { userId: 50, sessionId: guest.id },
    );
  });

  it('join_room той же сессией с другим memberId снимает прежнюю запись', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);

    guest.ws.message({
      type: 'join_room',
      roomId: host.roomId,
      memberId: memberIdOf(51),
      token: signToken(50),
    });
    await flushAsync();

    const members = registry.get(host.roomId).members;

    expect(members.has(guest.memberId)).toBe(false);
    expect(members.get(memberIdOf(51))).toMatchObject({ sessionId: guest.id });
    expect(members.size).toBe(2);
  });

  it('join_room от сессии хоста игнорируется', async () => {
    const hostX = await connectHost();
    const hostY = await connectHost({ hostUserId: 2, ip: '2.2.2.2' });

    hostX.ws.message({
      type: 'join_room',
      roomId: hostY.roomId,
      memberId: memberIdOf(1),
      token: signToken(1),
    });
    await flushAsync();

    const roomX = registry.get(hostX.roomId);

    expect(roomX.members.get(memberIdOf(1))).toMatchObject({
      sessionId: hostX.id,
    });
    expect(roomX.host.sessionId).toBe(hostX.id);
    expect(registry.get(hostY.roomId).members.has(memberIdOf(1))).toBe(false);
    expect(hostX.ws.sent.filter(m => m.type === 'room_joined')).toEqual([]);
  });

  // ревью-3 R4: сессия стала хостом, пока проверялся токен её join_room
  it('join_room, обогнанный register_host той же сессии, игнорируется', async () => {
    const hostY = await connectHost({ hostUserId: 2, ip: '2.2.2.2' });
    const conn = await connect({ ip: '1.1.1.1' });
    const verify = signaling._verifyToken.bind(signaling);
    let release;
    const held = new Promise(resolve => {
      release = resolve;
    });

    // проверка токена join_room задерживается, register_host — нет
    vi.spyOn(signaling, '_verifyToken').mockImplementationOnce(async token => {
      await held;

      return verify(token);
    });

    conn.ws.message({
      type: 'join_room',
      roomId: hostY.roomId,
      memberId: memberIdOf(1),
      token: signToken(1),
    });
    conn.ws.message({
      type: 'register_host',
      maxPlayers: 8,
      token: signToken(1),
      memberId: memberIdOf(1),
    });

    // flushAsync ждал бы и задержанный join_room
    const registered = await vi.waitFor(() => {
      const reply = conn.ws.sent.find(m => m.type === 'host_registered');

      expect(reply).toBeDefined();

      return reply;
    });

    release();
    await flushAsync();

    const roomX = registry.get(registered.roomId);

    expect(roomX.members.get(memberIdOf(1))).toMatchObject({
      sessionId: conn.id,
    });
    expect(registry.get(hostY.roomId).members.has(memberIdOf(1))).toBe(false);
    expect(conn.ws.sent.filter(m => m.type === 'room_joined')).toEqual([]);
  });

  it('register_host снимает прежнее членство сессии в чужой комнате', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);

    guest.ws.message({
      type: 'register_host',
      maxPlayers: 8,
      token: signToken(50),
      memberId: memberIdOf(51),
    });
    await signaling.idle();

    expect(guest.ws.lastSent().type).toBe('host_registered');
    expect(registry.get(host.roomId).members.has(guest.memberId)).toBe(false);
  });
});

describe('room_peers (подтверждение участников хостом)', () => {
  it('от хоста своей эпохи: счётчик лобби — только подтверждённые, мусор отброшен', async () => {
    const host = await connectHost();
    const a = await joinRoom(host.roomId, { userId: 50, ip: '5.5.5.1' });

    await joinRoom(host.roomId, { userId: 51, ip: '5.5.5.2' });

    expect(registry.getList().servers[0].currentPlayers).toBe(3);

    host.ws.message({
      type: 'room_peers',
      roomId: host.roomId,
      epoch: host.epoch,
      memberIds: [a.memberId, 'not-a-uuid', 42],
    });

    const room = registry.get(host.roomId);

    expect(room.members.get(a.memberId).peerConfirmed).toBe(true);
    expect(registry.getList().servers[0].currentPlayers).toBe(2);
  });

  it('берёт не больше maxPlayers × 2 элементов', async () => {
    const host = await connectHost();
    const a = await joinRoom(host.roomId);
    const filler = Array.from({ length: 16 }, (_v, i) => memberIdOf(900 + i));

    host.ws.message({
      type: 'room_peers',
      roomId: host.roomId,
      epoch: host.epoch,
      memberIds: [...filler, a.memberId],
    });

    expect(
      registry.get(host.roomId).members.get(a.memberId).peerConfirmed,
    ).toBe(false);
  });

  it('не от хоста, чужой эпохи или без массива — игнорируется', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);
    const room = registry.get(host.roomId);

    guest.ws.message({
      type: 'room_peers',
      roomId: host.roomId,
      epoch: host.epoch,
      memberIds: [guest.memberId],
    });
    host.ws.message({
      type: 'room_peers',
      roomId: host.roomId,
      epoch: host.epoch + 1,
      memberIds: [guest.memberId],
    });
    host.ws.message({
      type: 'room_peers',
      roomId: host.roomId,
      epoch: host.epoch,
      memberIds: 'nope',
    });

    expect(room.peersReportedAt).toBeNull();
  });
});

describe('reclaim_host', () => {
  const reclaim = async (conn, fields) => {
    conn.ws.message({
      type: 'reclaim_host',
      maxPlayers: 8,
      info: 'arena',
      ...fields,
    });
    await flushAsync();

    return conn.ws.lastSent();
  };

  it('реконнект хоста возвращает живую комнату с теми же roomId/epoch/секретом', async () => {
    const host = await connectHost();

    host.ws.handlers.close();

    const conn = await connect({ ip: '1.1.1.1' });
    const reply = await reclaim(conn, {
      roomId: host.roomId,
      epoch: 1,
      roomSecret: host.roomSecret,
      memberId: memberIdOf(1),
      token: signToken(1),
    });

    expect(reply).toMatchObject({
      type: 'host_registered',
      roomId: host.roomId,
      epoch: 1,
      roomSecret: host.roomSecret,
    });
    expect(registry.get(host.roomId).host.sessionId).toBe(conn.id);
    expect(registry.size).toBe(1);

    // офферы снова доходят до хоста
    const client = await connect();

    client.ws.message({ type: 'webrtc_offer', roomId: host.roomId, sdp: 'O' });

    expect(conn.ws.lastSent().type).toBe('webrtc_offer');
  });

  it('reclaim_host снимает членство сессии в чужой комнате', async () => {
    const hostX = await connectHost();
    // гость держит комнату X живой, пока её хост переподключается
    await joinRoom(hostX.roomId, { userId: 60, ip: '6.6.6.6' });
    const hostY = await connectHost({ hostUserId: 2, ip: '2.2.2.2' });

    hostX.ws.handlers.close();

    // вкладка бывшего хоста X успела войти гостем в Y
    const conn = await joinRoom(hostY.roomId, { userId: 1, ip: '1.1.1.1' });

    conn.memberId = memberIdOf(1);
    expect(registry.get(hostY.roomId).members.has(conn.memberId)).toBe(true);

    const reply = await reclaim(conn, {
      roomId: hostX.roomId,
      epoch: 1,
      roomSecret: hostX.roomSecret,
      memberId: memberIdOf(1),
      token: signToken(1),
    });

    expect(reply.type).toBe('host_registered');
    expect(registry.get(hostY.roomId).members.has(conn.memberId)).toBe(false);
  });

  // ревью N2: вернувшийся хост меняет версию комнаты только на текущую
  // каталожную
  const reclaimWithVersion = async (host, gameVersion) => {
    // гость держит комнату живой, пока хост переподключается: без людей
    // обрыв хоста её закрывает, и reclaim_host создал бы её заново
    const guest = await connect({ ip: '6.6.6.6' });

    guest.ws.message({
      type: 'join_room',
      roomId: host.roomId,
      memberId: memberIdOf(60),
      token: signToken(60),
    });
    await flushAsync();
    host.ws.handlers.close();

    return reclaim(await connect({ ip: '1.1.1.1' }), {
      roomId: host.roomId,
      epoch: host.epoch,
      roomSecret: host.roomSecret,
      memberId: memberIdOf(1),
      token: signToken(1),
      gameVersion,
    });
  };

  it('reclaim_host с версией каталога обновляет версию игры комнаты', async () => {
    const host = await connectHost();
    const room = registry.get(host.roomId);

    room.gameId = 'tanks';
    room.gameVersion = '1.0.0';
    signaling._gameCatalog = {
      getManifest: id =>
        id === 'tanks'
          ? { version: '2.0.0', maps: { version: 'm1' } }
          : undefined,
    };

    expect((await reclaimWithVersion(host, '2.0.0')).type).toBe(
      'host_registered',
    );
    expect(registry.get(host.roomId)).toBe(room);
    expect(room.gameVersion).toBe('2.0.0');
  });

  it('без каталога reclaim_host версию не меняет (ревью N2)', async () => {
    const host = await connectHost();
    const room = registry.get(host.roomId);

    room.gameId = 'tanks';
    room.gameVersion = '1.0.0';

    const reply = await reclaimWithVersion(host, '2.0.0');

    expect(reply.type).toBe('host_registered');
    expect(registry.get(host.roomId)).toBe(room);
    expect(room.gameVersion).toBe('1.0.0');
    // отклонённую версию хосту не подтверждают
    expect(reply.codeVersion.game.version).toBe('1.0.0');
  });

  it('после рестарта мастера комната создаётся заново с тем же roomId', async () => {
    const host = await connectHost();

    // рестарт: новый реестр (тот же ключ) и новый сигналинг
    registry = new RoomRegistry(REGISTRY_OPTIONS);
    signaling = new SignalingServer(registry, {
      iceServers: ICE_SERVERS,
      regionHeader: 'x-region',
      pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
      checkOrigin: allowAllOrigins,
      jwksProxy,
      issuer: ISSUER,
    });

    const conn = await connect({ ip: '1.1.1.1' });
    const reply = await reclaim(conn, {
      roomId: host.roomId,
      epoch: 1,
      roomSecret: host.roomSecret,
      memberId: memberIdOf(1),
      token: signToken(1),
      gameId: 'tanks',
    });

    expect(reply).toMatchObject({
      type: 'host_registered',
      roomId: host.roomId,
      epoch: 1,
    });
    expect(registry.get(host.roomId)).toMatchObject({
      gameId: 'tanks',
      host: { userId: 1 },
    });
  });

  // ревью-3 R2: после рестарта мастер не помнит прежнюю версию комнаты, а
  // гости возвращаются в неё сами
  const restartMaster = catalog => {
    registry = new RoomRegistry(REGISTRY_OPTIONS);
    signaling = new SignalingServer(registry, {
      iceServers: ICE_SERVERS,
      regionHeader: 'x-region',
      pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
      checkOrigin: allowAllOrigins,
      jwksProxy,
      issuer: ISSUER,
      successor: {
        minMemberAgeMs: 0,
        switchRatio: 0.65,
        switchSustainMs: 30000,
      },
    });
    signaling._gameCatalog = catalog;
  };

  // гость, способный стать бетой, возвращается в комнату (повторный
  // join_room той же сессии — назначение беты заново)
  const joinCandidate = async (roomId, guest = null) => {
    const conn = guest ?? (await connect({ ip: '5.5.5.50' }));

    conn.ws.message({
      type: 'join_room',
      roomId,
      memberId: memberIdOf(50),
      token: signToken(50),
      caps: { canHost: true, mobile: false, hidden: false },
    });
    await flushAsync();

    return conn;
  };

  // игра из последнего назначения беты
  const standbyGameOf = guest =>
    guest.ws.sent.filter(msg => msg.type === 'standby_assigned').at(-1)?.game;

  // каталог с переключаемой текущей версией игры tanks
  const catalogOf = current => ({
    current,
    getManifest(id) {
      return id === 'tanks' && this.current
        ? { version: this.current, maps: { version: 'm1' } }
        : undefined;
    },
    // как GameCatalog: всё, что не раздаётся, — «на тесте»; пустой каталог
    // не знает ни одной сборки
    isStaged(id, version) {
      return (
        id === 'tanks' && this.current !== null && version !== this.current
      );
    },
  });

  const reclaimRestored = async (host, gameVersion) =>
    reclaim(await connect({ ip: '1.1.1.1' }), {
      roomId: host.roomId,
      epoch: 1,
      roomSecret: host.roomSecret,
      memberId: memberIdOf(1),
      token: signToken(1),
      gameId: 'tanks',
      gameVersion,
    });

  it('рестарт мастера: застейдженная версия из reclaim_host бете не подтверждается', async () => {
    const host = await connectHost();

    restartMaster(catalogOf('1.0.0'));

    expect((await reclaimRestored(host, 'staged-9')).type).toBe(
      'host_registered',
    );
    // комната на заявленной версии и скрыта, как при register_host
    expect(registry.get(host.roomId)).toMatchObject({
      gameVersion: 'staged-9',
      hidden: true,
    });

    expect(standbyGameOf(await joinCandidate(host.roomId))).toEqual({
      id: 'tanks',
      versions: ['1.0.0'],
    });
  });

  it('рестарт мастера с версией каталога — бете она, как раньше', async () => {
    const host = await connectHost();

    restartMaster(catalogOf('1.0.0'));
    await reclaimRestored(host, '1.0.0');

    expect(registry.get(host.roomId).unverifiedGameVersion).toBeNull();
    expect(standbyGameOf(await joinCandidate(host.roomId))).toEqual({
      id: 'tanks',
      versions: ['1.0.0'],
    });
  });

  it('рестарт мастера без каталога: версия комнаты бете подтверждается', async () => {
    const host = await connectHost();

    restartMaster(undefined);
    await reclaimRestored(host, '1.0.0');

    // пустой список бета прочла бы как «любая версия»
    expect(standbyGameOf(await joinCandidate(host.roomId))).toEqual({
      id: 'tanks',
      versions: ['1.0.0'],
    });
  });

  // мастер начал слушать порт до первой синхронизации каталога
  it('рестарт мастера: каталог ещё не знает игру — беты нет, после загрузки — с версией каталога', async () => {
    const host = await connectHost();
    const catalog = catalogOf(null);

    restartMaster(catalog);
    await reclaimRestored(host, 'staged-9');

    const guest = await joinCandidate(host.roomId);

    expect(standbyGameOf(guest)).toBeUndefined();
    expect(registry.get(host.roomId).successorMemberId).toBeNull();

    catalog.current = '1.0.0';
    signaling.reviewSuccessors();

    expect(standbyGameOf(guest)).toEqual({
      id: 'tanks',
      versions: ['1.0.0'],
    });
  });

  it('рестарт мастера: помеченную версию одобрили — дальше она обычная', async () => {
    const host = await connectHost();
    const catalog = catalogOf('1.0.0');

    restartMaster(catalog);
    await reclaimRestored(host, 'staged-9');

    const guest = await joinCandidate(host.roomId);

    // админ одобрил версию комнаты, затем опубликовал следующую
    catalog.current = 'staged-9';
    signaling.reviewSuccessors();
    catalog.current = '2.0.0';
    await joinCandidate(host.roomId, guest);

    expect(standbyGameOf(guest)).toEqual({
      id: 'tanks',
      versions: ['staged-9', '2.0.0'],
    });
  });

  // ревью 5ba403eb F4
  it('рестарт мастера: каталог перестал знать игру помеченной комнаты — назначенная бета снимается', async () => {
    const host = await connectHost();
    const catalog = catalogOf('1.0.0');

    restartMaster(catalog);
    await reclaimRestored(host, 'staged-9');

    const guest = await joinCandidate(host.roomId);

    expect(registry.get(host.roomId).successorMemberId).toBe(memberIdOf(50));

    catalog.current = null;
    signaling.reviewSuccessors();

    expect(registry.get(host.roomId).successorMemberId).toBeNull();
    expect(guest.ws.sent.at(-1)).toEqual({
      type: 'standby_released',
      roomId: host.roomId,
    });
  });

  // ревью 5ba403eb F1: видимость тоже решалась по неполному каталогу
  it('рестарт мастера: каталог ещё не знает игру — застейдженная комната скрыта и после загрузки', async () => {
    const host = await connectHost();
    const catalog = catalogOf(null);

    restartMaster(catalog);
    await reclaimRestored(host, 'staged-9');

    expect(registry.get(host.roomId).hidden).toBe(true);

    catalog.current = '1.0.0';
    signaling.reviewSuccessors();

    expect(registry.get(host.roomId).hidden).toBe(true);
  });

  it('рестарт мастера: каталог ещё не знает игру — комната скрыта, пока он не загрузится', async () => {
    const host = await connectHost();
    const catalog = catalogOf(null);

    restartMaster(catalog);
    await reclaimRestored(host, '1.0.0');

    expect(registry.get(host.roomId).hidden).toBe(true);

    catalog.current = '1.0.0';
    signaling.reviewSuccessors();

    expect(registry.get(host.roomId)).toMatchObject({
      hidden: false,
      unverifiedGameVersion: null,
    });
  });

  // ревью 5ba403eb F3: следующая проверка токена ждёт release() — две
  // регистрации одной сессии завершаются в заданном порядке
  const holdNextVerify = () => {
    const verify = signaling._verifyToken.bind(signaling);
    let release;
    const held = new Promise(resolve => {
      release = resolve;
    });

    vi.spyOn(signaling, '_verifyToken').mockImplementationOnce(async token => {
      await held;

      return verify(token);
    });

    return release;
  };

  // хост комнаты без гостей оборвал сигналинг: комната ждёт reclaim_host
  const detachedHost = async () => {
    const host = await connectHost();

    host.ws.close();
    await flushAsync();

    return host;
  };

  const reclaimMessage = host => ({
    type: 'reclaim_host',
    roomId: host.roomId,
    epoch: 1,
    roomSecret: host.roomSecret,
    memberId: memberIdOf(1),
    token: signToken(1),
  });

  const registerMessage = {
    type: 'register_host',
    maxPlayers: 8,
    token: signToken(1),
    memberId: memberIdOf(1),
  };

  const waitFor = (conn, type) =>
    vi.waitFor(() => {
      const reply = conn.ws.sent.find(m => m.type === type);

      expect(reply).toBeDefined();

      return reply;
    });

  it('reclaim_host, обогнанный register_host той же сессии, — alreadyRegistered', async () => {
    const host = await detachedHost();
    const conn = await connect({ ip: '3.3.3.3' });
    const release = holdNextVerify();

    conn.ws.message(reclaimMessage(host));
    conn.ws.message(registerMessage);

    const own = await waitFor(conn, 'host_registered');

    release();
    await flushAsync();

    expect(conn.ws.lastSent()).toEqual({
      type: 'error',
      code: 'alreadyRegistered',
      re: 'reclaim_host',
      roomId: host.roomId,
    });
    expect(own.roomId).not.toBe(host.roomId);
    // прежнюю комнату сессия не заняла (новая комната того же хоста её
    // уже убрала)
    expect(registry.get(host.roomId)?.host.sessionId).not.toBe(conn.id);
    expect(signaling._sessions.get(conn.id).roomId).toBe(own.roomId);
  });

  it('register_host, обогнанный reclaim_host той же сессии, — alreadyRegistered', async () => {
    const host = await detachedHost();
    const conn = await connect({ ip: '3.3.3.3' });
    const release = holdNextVerify();

    conn.ws.message(registerMessage);
    conn.ws.message(reclaimMessage(host));

    const reclaimed = await waitFor(conn, 'host_registered');

    release();
    await flushAsync();

    expect(conn.ws.lastSent()).toEqual({
      type: 'error',
      code: 'alreadyRegistered',
      re: 'register_host',
    });
    expect(reclaimed.roomId).toBe(host.roomId);
    expect(registry.size).toBe(1);
  });

  it('угон: чужой пользователь с видимым roomId и чужим/подобранным секретом — invalidRoomSecret', async () => {
    const host = await connectHost();
    const thief = await connect({ ip: '6.6.6.6' });

    // секрет хоста, но токен вора — HMAC привязан к userId
    expect(
      await reclaim(thief, {
        roomId: host.roomId,
        epoch: 1,
        roomSecret: host.roomSecret,
        token: signToken(66),
      }),
    ).toEqual({
      type: 'error',
      code: 'invalidRoomSecret',
      re: 'reclaim_host',
      roomId: host.roomId,
    });

    expect(
      await reclaim(thief, {
        roomId: host.roomId,
        epoch: 1,
        roomSecret: 'A'.repeat(43),
        token: signToken(66),
      }),
    ).toEqual({
      type: 'error',
      code: 'invalidRoomSecret',
      re: 'reclaim_host',
      roomId: host.roomId,
    });

    expect(registry.get(host.roomId).host.sessionId).not.toBe(thief.id);
  });

  it('эпоха комнаты новее — staleEpoch', async () => {
    const host = await connectHost();

    registry.get(host.roomId).epoch = 2;

    const conn = await connect({ ip: '1.1.1.1' });

    expect(
      await reclaim(conn, {
        roomId: host.roomId,
        epoch: 1,
        roomSecret: host.roomSecret,
        token: signToken(1),
      }),
    ).toEqual({
      type: 'error',
      code: 'staleEpoch',
      re: 'reclaim_host',
      roomId: host.roomId,
    });
  });

  it('id занят комнатой другого пользователя — roomTaken', async () => {
    const host = await connectHost({ hostUserId: 1 });

    registry.get(host.roomId).host.userId = 2;

    const conn = await connect({ ip: '1.1.1.1' });

    expect(
      await reclaim(conn, {
        roomId: host.roomId,
        epoch: 1,
        roomSecret: host.roomSecret,
        token: signToken(1),
      }),
    ).toEqual({
      type: 'error',
      code: 'roomTaken',
      re: 'reclaim_host',
      roomId: host.roomId,
    });
  });

  it('без токена — invalidToken', async () => {
    const host = await connectHost();
    const conn = await connect({ ip: '1.1.1.1' });

    expect(
      await reclaim(conn, {
        roomId: host.roomId,
        epoch: 1,
        roomSecret: host.roomSecret,
      }),
    ).toEqual({
      type: 'error',
      code: 'invalidToken',
      re: 'reclaim_host',
      roomId: host.roomId,
    });
  });
});

describe('жизненный цикл комнаты', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('закрытие WS хоста без других людей — комната удалена сразу (reclaim восстановит её)', async () => {
    const host = await connectHost();

    host.ws.handlers.close();

    expect(registry.get(host.roomId)).toBeUndefined();

    const client = await connect();

    client.ws.message({ type: 'webrtc_offer', roomId: host.roomId, sdp: 'X' });

    expect(client.ws.lastSent()).toMatchObject({ code: 'unknownRoom' });
  });

  it('закрытие WS хоста, повысить некого — комната ждёт reclaim, после grace room_closed noHost', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);
    const sentBefore = guest.ws.sent.length;

    host.ws.handlers.close();

    // P2P-матч, возможно, цел: комната ждёт хоста, гостю ничего
    expect(registry.get(host.roomId)).toMatchObject({ status: 'online' });
    expect(guest.ws.sent).toHaveLength(sentBefore);

    signaling.sweep(Date.now() + 300);

    expect(registry.get(host.roomId)).toBeUndefined();
    expect(guest.ws.lastSent()).toEqual({
      type: 'room_closed',
      roomId: host.roomId,
      reason: 'noHost',
    });
  });

  it('sweep: хост молчит дольше heartbeatTimeout, кандидатов нет — room_closed, его сокету staleHost', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);

    registry.get(host.roomId).lastSeen = 0;

    const { lost } = signaling.sweep(5000);

    expect(lost).toEqual([host.roomId]);
    expect(registry.get(host.roomId)).toBeUndefined();
    expect(guest.ws.lastSent()).toMatchObject({
      type: 'room_closed',
      reason: 'noHost',
    });
    expect(guest.ws.sent.some(msg => msg.type === 'host_migrating')).toBe(
      false,
    );
    expect(host.ws.closed.code).toBe(4000);
  });

  // ревью F4: хост ждёт reclaim_host — оффер повторится, а не уведёт гостя
  it('оффер в online-комнату с отсоединённым хостом — error migrating', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);

    host.ws.handlers.close();
    guest.ws.message({ type: 'webrtc_offer', roomId: host.roomId, sdp: 'X' });

    expect(registry.get(host.roomId)).toMatchObject({ status: 'online' });
    expect(guest.ws.lastSent()).toEqual({
      type: 'error',
      code: 'migrating',
      re: 'webrtc_offer',
      roomId: host.roomId,
    });
  });

  it('отсоединённый гость после grace выпадает из комнаты', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);

    guest.ws.handlers.close();
    // grace участника 500 мс истёк, heartbeat хоста (1000 мс) — ещё нет
    signaling.sweep(Date.now() + 600);

    expect(registry.get(host.roomId).members.has(guest.memberId)).toBe(false);
  });
});

describe('преемник комнаты (host-migration этап 6)', () => {
  const clock = { now: 0 };

  beforeEach(() => {
    // часы сервера впереди реестра: joinedAt участника ставит реестр по
    // Date.now(), и возраст участника не должен выйти отрицательным
    clock.now = Date.now() + 60000;
    signaling = new SignalingServer(registry, {
      iceServers: ICE_SERVERS,
      regionHeader: 'x-region',
      hostReclaimGraceMs: 300,
      pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
      checkOrigin: allowAllOrigins,
      jwksProxy,
      issuer: ISSUER,
      now: () => clock.now,
      wsDeadAfterMs: 12000,
      successor: {
        minMemberAgeMs: 0,
        switchRatio: 0.65,
        switchSustainMs: 30000,
      },
    });
  });

  const CAN_HOST = { canHost: true, mobile: false, hidden: false };

  const join = async (roomId, userId, caps = CAN_HOST) => {
    const conn = await connect({ ip: `5.5.5.${userId}` });

    conn.memberId = memberIdOf(userId);
    conn.ws.message({
      type: 'join_room',
      roomId,
      memberId: conn.memberId,
      token: signToken(userId),
      caps,
    });
    await flushAsync();

    return conn;
  };

  const typed = (ws, type) => ws.sent.filter(msg => msg.type === type);

  describe('RTT участников', () => {
    const withPing = ws => {
      ws.pings = 0;
      ws.ping = () => {
        ws.pings += 1;
      };

      return ws;
    };

    it('ping/pong: EMA RTT и джиттера, score = rtt + 2 × jitter', async () => {
      const { ws, id } = await connect();

      withPing(ws);

      expect(signaling.scoreOf(id)).toBeNull();

      signaling.probeSessions(clock.now);
      expect(ws.pings).toBe(1);

      clock.now += 100;
      ws.handlers.pong();
      expect(signaling.scoreOf(id)).toBe(100);

      signaling.probeSessions(clock.now);
      clock.now += 300;
      ws.handlers.pong();

      // jitter = 0.2 × |300 − 100| = 40; rtt = 100 + 0.2 × 200 = 140
      expect(signaling.scoreOf(id)).toBeCloseTo(140 + 2 * 40);
    });

    it('pong без нашего ping RTT не трогает', async () => {
      const { ws, id } = await connect();

      ws.handlers.pong();

      expect(signaling.scoreOf(id)).toBeNull();
    });

    it('сессия без pong дольше wsDeadAfterMs — terminate', async () => {
      const { ws } = await connect();

      withPing(ws);
      signaling.probeSessions(clock.now + 11999);
      expect(ws.terminated).toBe(false);

      signaling.probeSessions(clock.now + 12000);
      expect(ws.terminated).toBe(true);
    });

    it('pong продлевает жизнь сессии', async () => {
      const { ws } = await connect();

      withPing(ws);
      clock.now += 10000;
      signaling.probeSessions(clock.now);
      ws.handlers.pong();
      signaling.probeSessions(clock.now + 11000);

      expect(ws.terminated).toBe(false);
    });
  });

  it('кандидат вошёл — ему standby_assigned, хосту successor_assigned', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 50);

    expect(typed(guest.ws, 'standby_assigned')).toEqual([
      { type: 'standby_assigned', roomId: host.roomId, epoch: 1, game: null },
    ]);
    expect(host.ws.lastSent()).toEqual({
      type: 'successor_assigned',
      roomId: host.roomId,
      epoch: 1,
      successorMemberId: guest.memberId,
      successorClientId: guest.id,
    });
    expect(registry.get(host.roomId).successorMemberId).toBe(guest.memberId);
  });

  it('гость без caps (страница до этапа 6) бетой не становится', async () => {
    const host = await connectHost();
    const guest = await joinRoom(host.roomId);

    expect(typed(guest.ws, 'standby_assigned')).toEqual([]);
    expect(typed(host.ws, 'successor_assigned')).toEqual([]);
  });

  it('caps санируются: лишние поля и чужой iceType отбрасываются', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 50, {
      canHost: 'yes',
      hidden: false,
      iceType: 'bogus',
      extra: 1,
      fps: 5000,
    });

    expect(registry.get(host.roomId).members.get(guest.memberId).caps).toEqual({
      canHost: false,
      mobile: false,
      hidden: false,
      iceType: null,
      fps: null,
    });
  });

  it('caps.fps (этап 9c): округляется; вне 0…1000 и не число — null', async () => {
    const host = await connectHost();
    const guest = await join(host.roomId, 50, { canHost: true, fps: 59.7 });
    const caps = () =>
      registry.get(host.roomId).members.get(guest.memberId).caps;

    expect(caps().fps).toBe(60);

    for (const fps of [-1, '60', Infinity]) {
      guest.ws.message({
        type: 'member_update',
        roomId: host.roomId,
        caps: { canHost: true, fps },
      });
      expect(caps().fps).toBeNull();
    }
  });

  it('бета спрятала вкладку (member_update) — бета переназначается', async () => {
    const host = await connectHost();
    const first = await join(host.roomId, 50);
    const second = await join(host.roomId, 51);

    first.ws.message({
      type: 'member_update',
      roomId: host.roomId,
      caps: { ...CAN_HOST, hidden: true },
    });

    expect(first.ws.lastSent()).toEqual({
      type: 'standby_released',
      roomId: host.roomId,
    });
    expect(typed(second.ws, 'standby_assigned')).toHaveLength(1);
    expect(host.ws.lastSent()).toMatchObject({
      type: 'successor_assigned',
      successorMemberId: second.memberId,
    });
  });

  it('member_update не из своей комнаты игнорируется', async () => {
    const host = await connectHost();
    const stranger = await connect({ ip: '7.7.7.7' });

    stranger.ws.message({
      type: 'member_update',
      roomId: host.roomId,
      caps: CAN_HOST,
    });

    expect(registry.get(host.roomId).members.size).toBe(1);
  });

  it('ушла бета — назначается другая; последний кандидат ушёл — null', async () => {
    const host = await connectHost();
    const first = await join(host.roomId, 50);
    const second = await join(host.roomId, 51);

    first.ws.handlers.close();

    expect(host.ws.lastSent()).toMatchObject({
      type: 'successor_assigned',
      successorMemberId: second.memberId,
    });

    second.ws.message({ type: 'leave_room', roomId: host.roomId });

    expect(host.ws.lastSent()).toMatchObject({
      type: 'successor_assigned',
      successorMemberId: null,
      successorClientId: null,
    });
  });

  it('гистерезис на плановом пересчёте: заметно лучший сменяет бету через switchSustainMs', async () => {
    const host = await connectHost();
    const first = await join(host.roomId, 50);
    const second = await join(host.roomId, 51);
    const room = registry.get(host.roomId);

    expect(room.successorMemberId).toBe(first.memberId);

    // RTT: бета 300 мс, второй 50 мс
    for (const [conn, rtt] of [
      [first, 300],
      [second, 50],
    ]) {
      conn.ws.ping = () => {};
      signaling.probeSessions(clock.now);
      clock.now += rtt;
      conn.ws.handlers.pong();
    }

    signaling.reviewSuccessors(clock.now);
    expect(room.successorMemberId).toBe(first.memberId);

    signaling.reviewSuccessors(clock.now + 30000);
    expect(room.successorMemberId).toBe(second.memberId);
    expect(first.ws.lastSent()).toMatchObject({ type: 'standby_released' });
  });

  it('standby_status: принимается только от беты текущей эпохи', async () => {
    const host = await connectHost();
    const beta = await join(host.roomId, 50);
    const other = await join(host.roomId, 51);
    const room = registry.get(host.roomId);
    const status = {
      type: 'standby_status',
      roomId: host.roomId,
      epoch: 1,
      checkpointId: 'abc-1',
      createdAt: 1234,
    };

    other.ws.message(status);
    beta.ws.message({ ...status, epoch: 2 });
    expect(room.standby).toBeNull();

    beta.ws.message(status);
    expect(room.standby).toEqual({
      memberId: beta.memberId,
      checkpointId: 'abc-1',
      createdAt: 1234,
      receivedAt: clock.now,
    });
  });

  it('standby_status: та же точка без ageMs не становится свежее (ревью F8)', async () => {
    const host = await connectHost();
    const beta = await join(host.roomId, 50);
    const room = registry.get(host.roomId);
    const status = {
      type: 'standby_status',
      roomId: host.roomId,
      epoch: 1,
      checkpointId: 'abc-1',
      createdAt: 1234,
    };
    const firstAt = clock.now;

    beta.ws.message(status);
    clock.now += 5000;
    beta.ws.message(status);
    expect(room.standby.receivedAt).toBe(firstAt);

    // новая точка — новый момент получения
    beta.ws.message({ ...status, checkpointId: 'abc-2' });
    expect(room.standby.receivedAt).toBe(clock.now);
  });

  it('standby_status.ageMs: момент получения точки = сейчас − возраст', async () => {
    const host = await connectHost();
    const beta = await join(host.roomId, 50);
    const room = registry.get(host.roomId);
    const status = {
      type: 'standby_status',
      roomId: host.roomId,
      epoch: 1,
      checkpointId: 'abc-1',
      createdAt: 1234,
    };

    beta.ws.message({ ...status, ageMs: 100 });
    expect(room.standby.receivedAt).toBe(clock.now - 100);

    beta.ws.message({ ...status, ageMs: 20000 });
    expect(room.standby.receivedAt).toBe(clock.now - 20000);

    // потолок возраста — 10 минут
    beta.ws.message({ ...status, ageMs: 1e12 });
    expect(room.standby.receivedAt).toBe(clock.now - 10 * 60 * 1000);
  });

  it('standby_status: мусорный ageMs — как будто поля нет', async () => {
    const host = await connectHost();
    const beta = await join(host.roomId, 50);
    const room = registry.get(host.roomId);
    const status = {
      type: 'standby_status',
      roomId: host.roomId,
      epoch: 1,
      createdAt: 1234,
    };

    beta.ws.message({ ...status, checkpointId: 'a', ageMs: '100' });
    expect(room.standby.receivedAt).toBe(clock.now);

    beta.ws.message({ ...status, checkpointId: 'b', ageMs: -5 });
    expect(room.standby.receivedAt).toBe(clock.now);

    beta.ws.message({ ...status, checkpointId: 'c', ageMs: Infinity });
    expect(room.standby.receivedAt).toBe(clock.now);
  });

  it('хост вернулся (reclaim_host) — ему снова successor_assigned', async () => {
    const host = await connectHost();
    const beta = await join(host.roomId, 50);

    host.ws.handlers.close();

    const again = await connect({ ip: '1.1.1.1' });

    again.ws.message({
      type: 'reclaim_host',
      roomId: host.roomId,
      epoch: host.epoch,
      roomSecret: host.roomSecret,
      memberId: memberIdOf(1),
      token: signToken(1),
    });
    await flushAsync();

    expect(typed(again.ws, 'successor_assigned')).toEqual([
      {
        type: 'successor_assigned',
        roomId: host.roomId,
        epoch: 1,
        successorMemberId: beta.memberId,
        successorClientId: beta.id,
      },
    ]);
  });

  // ревью F9: сигналинг гостя переподключился к свежему мастеру раньше хоста
  it('рестарт мастера: join_room до reclaim_host — unknownRoom, повтор после — участник и кандидат', async () => {
    const host = await connectHost();

    registry = new RoomRegistry(REGISTRY_OPTIONS);
    signaling = new SignalingServer(registry, {
      iceServers: ICE_SERVERS,
      regionHeader: 'x-region',
      hostReclaimGraceMs: 300,
      pingLimiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
      checkOrigin: allowAllOrigins,
      jwksProxy,
      issuer: ISSUER,
      now: () => clock.now,
      successor: {
        minMemberAgeMs: 0,
        switchRatio: 0.65,
        switchSustainMs: 30000,
      },
    });

    const guest = await connect({ ip: '5.5.5.50' });
    const joinMsg = {
      type: 'join_room',
      roomId: host.roomId,
      memberId: memberIdOf(50),
      token: signToken(50),
      caps: CAN_HOST,
    };

    guest.ws.message(joinMsg);
    await flushAsync();

    expect(guest.ws.lastSent()).toEqual({
      type: 'error',
      code: 'unknownRoom',
      re: 'join_room',
      roomId: host.roomId,
    });

    const again = await connect({ ip: '1.1.1.1' });

    again.ws.message({
      type: 'reclaim_host',
      roomId: host.roomId,
      epoch: host.epoch,
      roomSecret: host.roomSecret,
      memberId: memberIdOf(1),
      token: signToken(1),
    });
    await flushAsync();

    guest.ws.message(joinMsg);
    await flushAsync();

    expect(typed(guest.ws, 'room_joined')).toEqual([
      { type: 'room_joined', roomId: host.roomId, epoch: 1 },
    ]);
    expect(registry.get(host.roomId).members.has(memberIdOf(50))).toBe(true);
    expect(registry.getList().servers[0].currentPlayers).toBe(2);
    expect(typed(guest.ws, 'standby_assigned')).toHaveLength(1);
    expect(registry.get(host.roomId).successorMemberId).toBe(memberIdOf(50));
  });

  it('standby_assigned несёт игру: версия комнаты и каталога (ревью F1)', async () => {
    const host = await connectHost();
    const room = registry.get(host.roomId);

    room.gameId = 'tanks';
    room.gameVersion = '1.0.0';
    signaling._gameCatalog = {
      getManifest: id => (id === 'tanks' ? { version: '1.1.0' } : undefined),
    };

    const guest = await join(host.roomId, 50);

    expect(typed(guest.ws, 'standby_assigned')[0].game).toEqual({
      id: 'tanks',
      versions: ['1.0.0', '1.1.0'],
    });

    // реконнект сигналинга беты — назначение заново, с той же игрой
    guest.ws.handlers.close();

    const again = await connect({ ip: '5.5.5.5' });

    again.ws.message({
      type: 'join_room',
      roomId: host.roomId,
      memberId: guest.memberId,
      token: signToken(50),
      caps: CAN_HOST,
    });
    await flushAsync();

    expect(typed(again.ws, 'standby_assigned').at(-1).game).toEqual({
      id: 'tanks',
      versions: ['1.0.0', '1.1.0'],
    });
  });

  it('reclaim_host с застейдженной версией не меняет версию комнаты (ревью N2)', async () => {
    const host = await connectHost();
    const room = registry.get(host.roomId);

    room.gameId = 'tanks';
    room.gameVersion = '1.0.0';
    signaling._gameCatalog = {
      getManifest: id =>
        id === 'tanks'
          ? { version: '1.0.0', maps: { version: 'm1' } }
          : undefined,
    };

    // гость без canHost держит комнату живой, пока хост переподключается
    await join(host.roomId, 60, {
      canHost: false,
      mobile: false,
      hidden: false,
    });
    host.ws.handlers.close();

    const again = await connect({ ip: '1.1.1.1' });

    again.ws.message({
      type: 'reclaim_host',
      roomId: host.roomId,
      epoch: host.epoch,
      roomSecret: host.roomSecret,
      memberId: memberIdOf(1),
      token: signToken(1),
      gameVersion: 'staged-9',
    });
    await flushAsync();

    expect(again.ws.lastSent().type).toBe('host_registered');
    expect(registry.get(host.roomId)).toBe(room);
    expect(room.gameVersion).toBe('1.0.0');

    const guest = await join(host.roomId, 50);

    expect(typed(guest.ws, 'standby_assigned')[0].game).toEqual({
      id: 'tanks',
      versions: ['1.0.0'],
    });
  });
});
