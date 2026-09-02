import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createAdminAuth } from '../../packages/engine/src/master/adminAuth.js';
import { createGameRoutes } from '../../packages/engine/src/master/gameRoutes.js';
import HostRegistry from '../../packages/engine/src/master/HostRegistry.js';

// Роуты реестра игр мастера (master-game-registry, этап 4). lobby.js
// поднимает сервер и из теста не импортируется, поэтому проверяются
// обработчики и их композиция с middleware — ровно та, что расставлена там.

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const ISSUER = 'vimp-auth-test';

const jwks = {
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }],
};

const signToken = role =>
  jwt.sign({ nick: 'admin', ...(role ? { role } : {}) }, privateKey, {
    subject: '1',
    algorithm: 'RS256',
    keyid: KID,
    issuer: ISSUER,
    expiresIn: '15m',
  });

const fakeRes = () => {
  const res = {
    code: 200,
    body: null,
    status(code) {
      res.code = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };

  return res;
};

const GAME = {
  id: 'tanks',
  packageName: '@vimp-games/tanks',
  version: '1.0.0',
  pendingVersion: '1.1.0',
  repoUrl: null,
  maxGameScore: null,
  status: 'pending',
};

let registry;
let store;
let catalog;
let sync;
let routes;

beforeEach(() => {
  registry = {
    mine: vi.fn(async () => ({ status: 200, json: { games: [GAME] } })),
    listAll: vi.fn(async () => ({ status: 200, json: { games: [GAME] } })),
    submit: vi.fn(async () => ({ status: 201, json: { game: GAME } })),
    requestVersion: vi.fn(async () => ({ status: 200, json: { game: GAME } })),
    moderate: vi.fn(async () => ({ status: 200, json: { game: GAME } })),
  };

  store = {
    inspect: vi.fn(async () => ({ ok: true, version: '1.1.0', manifest: {}, errors: [] })),
    ensure: vi.fn(async () => ({
      ok: true,
      version: '1.1.0',
      distDir: '/games/tanks/1.1.0',
      manifest: { id: 'tanks' },
      errors: [],
    })),
    has: vi.fn(() => true),
    publishedVersions: vi.fn(async () => ['1.0.0', '1.1.0']),
  };

  catalog = {
    stagedManifests: vi.fn(() => [{ id: 'tanks', version: '1.1.0', manifest: { id: 'tanks' } }]),
    upsert: vi.fn(),
    getManifest: vi.fn(() => ({ id: 'tanks', version: 'hash' })),
  };

  sync = { run: vi.fn(async () => {}), lastError: vi.fn(() => null) };

  routes = createGameRoutes({ registry, store, catalog, sync });
});

describe('POST /games/submit', () => {
  it('непрошедший проверку пакет — 400 со списком проблем, и в auth не ходим', async () => {
    store.inspect.mockResolvedValue({
      ok: false,
      version: null,
      errors: ['пакета "@vimp-games/none" нет в реестре'],
    });

    const res = fakeRes();

    await routes.submit(
      { authToken: 't', body: { id: 'none', packageName: '@vimp-games/none' } },
      res,
    );

    expect(res.code).toBe(400);
    expect(res.body.errors).toHaveLength(1);
    expect(registry.submit).not.toHaveBeenCalled();
  });

  it('проверенный пакет уходит в реестр с резолвнутой версией', async () => {
    const res = fakeRes();

    await routes.submit(
      {
        authToken: 't',
        body: { id: 'tanks', packageName: '@vimp-games/tanks', version: 'latest' },
      },
      res,
    );

    expect(res.code).toBe(201);
    expect(registry.submit).toHaveBeenCalledWith(
      't',
      expect.objectContaining({ id: 'tanks', version: '1.1.0' }),
    );
  });
});

describe('POST /games/mine/:id/version', () => {
  it('чужая/несуществующая игра — 404 без похода в реестр', async () => {
    registry.mine.mockResolvedValue({ status: 200, json: { games: [] } });

    const res = fakeRes();

    await routes.requestVersion({ authToken: 't', params: { id: 'tanks' }, body: {} }, res);

    expect(res.code).toBe(404);
    expect(registry.requestVersion).not.toHaveBeenCalled();
  });

  it('валидная версия уходит в реестр', async () => {
    const res = fakeRes();

    await routes.requestVersion(
      { authToken: 't', params: { id: 'tanks' }, body: { version: '1.1.0' } },
      res,
    );

    expect(store.inspect).toHaveBeenCalledWith('tanks', '@vimp-games/tanks', '1.1.0');
    expect(registry.requestVersion).toHaveBeenCalledWith('t', 'tanks', '1.1.0');
  });
});

describe('GET /admin/games', () => {
  it('к строкам реестра добавляет локальное состояние мастера', async () => {
    sync.lastError.mockReturnValue('битый архив');

    const res = fakeRes();

    await routes.adminList({ authToken: 't' }, res);

    expect(res.body.games[0].local).toEqual({
      downloaded: true,
      stagedVersion: '1.1.0',
      lastError: 'битый архив',
    });
  });
});

describe('POST /admin/games/:id/stage', () => {
  it('кладёт скачанную версию в каталог НЕ раздаваемой и отдаёт манифест', async () => {
    const res = fakeRes();

    await routes.stage({ authToken: 't', params: { id: 'tanks' }, body: {} }, res);

    expect(store.ensure).toHaveBeenCalledWith('tanks', '@vimp-games/tanks', '1.1.0');
    expect(catalog.upsert).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    expect(res.body.manifest).toEqual({ id: 'tanks', version: 'hash' });
  });

  it('битый пакет — 400, каталог не трогается', async () => {
    store.ensure.mockResolvedValue({ ok: false, version: null, errors: ['нет manifest.json'] });

    const res = fakeRes();

    await routes.stage({ authToken: 't', params: { id: 'tanks' }, body: {} }, res);

    expect(res.code).toBe(400);
    expect(catalog.upsert).not.toHaveBeenCalled();
  });
});

describe('PATCH /admin/games/:id', () => {
  it('успешное решение модератора завершается немедленной синхронизацией', async () => {
    const res = fakeRes();

    await routes.moderate(
      { authToken: 't', params: { id: 'tanks' }, body: { status: 'approved' } },
      res,
    );

    expect(registry.moderate).toHaveBeenCalledWith('t', 'tanks', { status: 'approved' });
    expect(sync.run).toHaveBeenCalled();
  });

  it('отказ реестра синхронизацию не запускает', async () => {
    registry.moderate.mockResolvedValue({ status: 403, json: { error: 'forbidden' } });

    const res = fakeRes();

    await routes.moderate(
      { authToken: 't', params: { id: 'tanks' }, body: { status: 'approved' } },
      res,
    );

    expect(res.code).toBe(403);
    expect(sync.run).not.toHaveBeenCalled();
  });
});

describe('GET /admin/games/:id/versions', () => {
  it('отдаёт версии, опубликованные в npm', async () => {
    const res = fakeRes();

    await routes.versions({ authToken: 't', params: { id: 'tanks' } }, res);

    expect(res.body).toEqual({ versions: ['1.0.0', '1.1.0'] });
  });
});

// GET /servers: та же композиция, что в lobby.js — optional-middleware
// заполняет req.user, а видимость скрытых комнат решает его роль
describe('GET /servers', () => {
  const adminAuth = createAdminAuth({ get: async () => jwks }, ISSUER);

  const list = async token => {
    const hosts = new HostRegistry({ maxPlayersLimit: 8 });

    hosts.add({ name: 'public', ip: '1.1.1.1', maxPlayers: 8, gameId: 'tanks' });
    hosts.add({
      name: 'staged',
      ip: '2.2.2.2',
      maxPlayers: 8,
      gameId: 'tanks',
      hidden: true,
    });

    const req = {
      query: {},
      get: name => (name === 'authorization' && token ? `Bearer ${token}` : undefined),
    };

    await new Promise(resolve => adminAuth.optional(req, fakeRes(), resolve));

    return hosts.getList({ ...req.query, includeHidden: adminAuth.isAdmin(req.user) });
  };

  it('без токена скрытые комнаты не видны', async () => {
    const { servers } = await list(null);

    expect(servers.map(({ name }) => name)).toEqual(['public']);
  });

  it('админский токен показывает и тестовые комнаты', async () => {
    const { servers } = await list(signToken('admin'));

    expect(servers.map(({ name }) => name).sort()).toEqual(['public', 'staged']);
  });
});
