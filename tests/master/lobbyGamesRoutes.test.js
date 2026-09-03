import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createAdminAuth } from '../../packages/engine/src/master/adminAuth.js';
import { createGameRoutes } from '../../packages/engine/src/master/gameRoutes.js';
import { createGameStatic } from '../../packages/engine/src/master/gameStatic.js';
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
    // разбор пакета без заранее известного id: он читается из манифеста
    // внутри тарболла (форма заявки спрашивает только пакет и версию)
    inspectPackage: vi.fn(async () => ({
      ok: true,
      id: 'tanks',
      version: '1.1.0',
      manifest: { id: 'tanks', title: 'Tanks', engineApi: 4 },
      compat: null,
      errors: [],
    })),
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
    remove: vi.fn(),
    getManifest: vi.fn(() => ({ id: 'tanks', version: 'hash' })),
  };

  sync = { run: vi.fn(async () => {}), lastError: vi.fn(() => null) };

  routes = createGameRoutes({ registry, store, catalog, sync });
});

describe('POST /games/submit', () => {
  it('непрошедший проверку пакет — 400 со списком проблем, и в auth не ходим', async () => {
    store.inspectPackage.mockResolvedValue({
      ok: false,
      id: null,
      version: null,
      manifest: null,
      compat: null,
      errors: ['пакета "@vimp-games/none" нет в реестре'],
    });

    const res = fakeRes();

    await routes.submit({ authToken: 't', body: { packageName: '@vimp-games/none' } }, res);

    expect(res.code).toBe(400);
    expect(res.body.errors).toHaveLength(1);
    expect(registry.submit).not.toHaveBeenCalled();
  });

  it.each([
    ['кривое имя пакета', { packageName: '../../etc/passwd' }],
    ['имя пакета не строка', { packageName: 42 }],
    ['кривая версия', { packageName: '@vimp-games/tanks', version: '../../x' }],
  ])('%s — 400 ДО скачивания: пакет не качается', async (_name, body) => {
    const res = fakeRes();

    await routes.submit({ authToken: 't', body }, res);

    expect(res.code).toBe(400);
    expect(res.body).toEqual({ error: 'badRequest' });
    expect(store.inspectPackage).not.toHaveBeenCalled();
    expect(registry.submit).not.toHaveBeenCalled();
  });

  it.each([
    ['обход каталога', '../../../../tmp/pwn'],
    ['разделитель', 'a/b'],
    ['зарезервированный', 'submit'],
  ])('%s id из манифеста в реестр не уходит', async (_name, id) => {
    store.inspectPackage.mockResolvedValue({
      ok: true,
      id,
      version: '1.1.0',
      manifest: { id },
      compat: null,
      errors: [],
    });

    const res = fakeRes();

    await routes.submit({ authToken: 't', body: { packageName: '@vimp-games/tanks' } }, res);

    expect(res.code).toBe(400);
    expect(res.body).toEqual({ error: 'badRequest' });
    expect(registry.submit).not.toHaveBeenCalled();
  });

  it('заявка без id/title/repoUrl заводит игру полями из пакета', async () => {
    const res = fakeRes();

    await routes.submit(
      { authToken: 't', body: { packageName: '@vimp-games/tanks', version: 'latest' } },
      res,
    );

    expect(res.code).toBe(201);
    expect(registry.submit).toHaveBeenCalledWith('t', {
      id: 'tanks',
      packageName: '@vimp-games/tanks',
      version: '1.1.0',
      title: 'Tanks',
      repoUrl: null,
    });
  });

  it('тело со всеми полями по-прежнему принимается', async () => {
    // старый клиент и прямые вызовы: присланные поля — запасной путь, но
    // прочитанное из пакета важнее
    const res = fakeRes();

    await routes.submit(
      {
        authToken: 't',
        body: {
          id: 'other',
          packageName: '@vimp-games/tanks',
          version: '1.1.0',
          title: 'Old title',
          repoUrl: 'https://example.com/repo',
        },
      },
      res,
    );

    expect(res.code).toBe(201);
    expect(registry.submit).toHaveBeenCalledWith(
      't',
      expect.objectContaining({ id: 'tanks', title: 'Tanks', repoUrl: 'https://example.com/repo' }),
    );
  });
});

describe('GET /games/lookup', () => {
  const query = (over = {}) => ({ query: { package: '@vimp-games/tanks', ...over } });

  it('отдаёт поля манифеста, версии npm и репозиторий пакета', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        'dist-tags': { latest: '1.1.0' },
        versions: {
          '1.1.0': { repository: { type: 'git', url: 'git+https://github.com/lgick/vimp-tanks.git' } },
        },
      }),
    }));
    const withRegistry = createGameRoutes({
      registry,
      store,
      catalog,
      sync,
      registryUrl: 'https://registry.example',
      fetchImpl,
    });
    const res = fakeRes();

    await withRegistry.lookup(query({ version: 'latest' }), res);

    expect(res.body).toEqual({
      id: 'tanks',
      title: 'Tanks',
      version: '1.1.0',
      versions: ['1.0.0', '1.1.0'],
      repoUrl: 'https://github.com/lgick/vimp-tanks',
      engineApi: 4,
      compat: null,
      errors: [],
    });
  });

  it('отказ npm обнуляет репозиторий, но не роняет разбор', async () => {
    const withRegistry = createGameRoutes({
      registry,
      store,
      catalog,
      sync,
      registryUrl: 'https://registry.example',
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const res = fakeRes();

    await withRegistry.lookup(query(), res);

    expect(res.body.repoUrl).toBeNull();
    expect(res.body.id).toBe('tanks');
  });

  it('кривое имя пакета — 400 без похода в сеть', async () => {
    const res = fakeRes();

    await routes.lookup(query({ package: '../../etc/passwd' }), res);

    expect(res.code).toBe(400);
    expect(store.inspectPackage).not.toHaveBeenCalled();
  });

  it('проблемы пакета едут карточкой, а не отказом роута', async () => {
    store.inspectPackage.mockResolvedValue({
      ok: false,
      id: null,
      version: null,
      manifest: null,
      compat: null,
      errors: ['dist/manifest.json отсутствует'],
    });

    const res = fakeRes();

    await routes.lookup(query(), res);

    expect(res.code).toBe(200);
    expect(res.body.errors).toEqual(['dist/manifest.json отсутствует']);
    expect(res.body.id).toBeNull();
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

  it('админ поднимает версию ЧУЖОЙ игры — списком служит очередь модерации', async () => {
    const adminRoutes = createGameRoutes({
      registry,
      store,
      catalog,
      sync,
      isAdmin: user => user?.role === 'admin',
    });
    const res = fakeRes();

    await adminRoutes.requestVersion(
      {
        authToken: 't',
        user: { id: 1, role: 'admin' },
        params: { id: 'tanks' },
        body: { version: '1.1.0' },
      },
      res,
    );

    expect(registry.listAll).toHaveBeenCalledWith('t');
    expect(registry.mine).not.toHaveBeenCalled();
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

  it('новый «Тест» снимает прошлый черновик той же игры', async () => {
    // застейдженную запись не убирает больше никто: у локально прилинкованной
    // игры цикл синхронизации до неё не доходит, а оставленная она навсегда
    // держит свою версию на диске и висит лишним пунктом «(test)»
    catalog.stagedManifests.mockReturnValue([
      { id: 'tanks', version: '1.0.5', manifest: { id: 'tanks' } },
      { id: 'snakes', version: '0.9.1', manifest: { id: 'snakes' } },
    ]);

    const res = fakeRes();

    await routes.stage({ authToken: 't', params: { id: 'tanks' }, body: {} }, res);

    expect(catalog.remove).toHaveBeenCalledWith('tanks', '1.0.5');
    expect(catalog.remove).toHaveBeenCalledTimes(1);
    expect(catalog.upsert).toHaveBeenCalledWith(expect.objectContaining({ version: '1.1.0' }));
  });

  it('повторный «Тест» той же версии сам себя не снимает', async () => {
    catalog.stagedManifests.mockReturnValue([
      { id: 'tanks', version: '1.1.0', manifest: { id: 'tanks' } },
    ]);

    const res = fakeRes();

    await routes.stage({ authToken: 't', params: { id: 'tanks' }, body: {} }, res);

    expect(catalog.remove).not.toHaveBeenCalled();
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

// Раздача /games/<id>[/<version>]/… — тот же обработчик, что app.use('/games')
// в lobby.js. Версионный путь адресует хранилище пакетов: промах по нему
// обязан быть 404, иначе html-фолбэк ViteExpress отвечает 200 на
// отсутствующий бандл и import() падает невнятной ошибкой
describe('/games/… (статика игр)', () => {
  const make = ({ dirs = {}, files = [] } = {}) => {
    const served = [];
    const mounted = [];
    const gameStatic = createGameStatic({
      catalog: { getDistDir: (id, version) => dirs[version ? `${id}@${version}` : id] ?? null },
      staticImpl: dir => {
        mounted.push(dir);

        return (req, res, next) => {
          served.push({ dir, url: req.url });

          if (files.includes(`${dir}${req.url.split('?')[0]}`)) {
            res.code = 200;
            res.body = 'file';
            return;
          }

          next();
        };
      },
    });

    return { gameStatic, served, mounted };
  };

  it('версионный путь неизвестной игры — 404 JSON, а не html-фолбэк', () => {
    const { gameStatic } = make();
    const res = fakeRes();
    const next = vi.fn();

    gameStatic.handler({ method: 'GET', url: '/tanks/9.9.9/client.js' }, res, next);

    expect(res.code).toBe(404);
    expect(res.body).toEqual({ error: 'unknownGame' });
    expect(next).not.toHaveBeenCalled();
  });

  it('отсутствующий файл живой версии — 404, req.url восстановлен', () => {
    const { gameStatic } = make({ dirs: { 'tanks@0.16.1': '/games-dir/tanks/0.16.1' } });
    const res = fakeRes();
    const next = vi.fn();
    const req = { method: 'GET', url: '/tanks/0.16.1/nope.js' };

    gameStatic.handler(req, res, next);

    expect(res.code).toBe(404);
    expect(res.body).toEqual({ error: 'notFound' });
    expect(next).not.toHaveBeenCalled();
    expect(req.url).toBe('/tanks/0.16.1/nope.js');
  });

  it('существующий файл версии отдаётся статикой с путём внутри dist/', () => {
    const { gameStatic, served } = make({
      dirs: { 'tanks@0.16.1': '/games-dir/tanks/0.16.1' },
      files: ['/games-dir/tanks/0.16.1/client.js'],
    });
    const res = fakeRes();
    const next = vi.fn();

    gameStatic.handler({ method: 'GET', url: '/tanks/0.16.1/client.js?import' }, res, next);

    expect(served).toEqual([{ dir: '/games-dir/tanks/0.16.1', url: '/client.js?import' }]);
    expect(res.code).toBe(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('не-GET по версионному пути уходит next(): «файла нет» тут неизвестно', () => {
    // serve-static пропускает всё, кроме GET/HEAD, не заглядывая в диск —
    // отвечать на такой запрос 404 значило бы выдумать результат
    const { gameStatic } = make({ dirs: { 'tanks@0.16.1': '/games-dir/tanks/0.16.1' } });
    const res = fakeRes();
    const next = vi.fn();

    gameStatic.handler({ method: 'POST', url: '/tanks/0.16.1/client.js' }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.body).toBeNull();
  });

  it('неверсионный путь уходит next() — в dev это исходники Vite', () => {
    const { gameStatic } = make();
    const res = fakeRes();
    const next = vi.fn();
    const req = { method: 'GET', url: '/tanks/anything.js' };

    gameStatic.handler(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.code).toBe(200);
    expect(res.body).toBeNull();
  });

  it('промах по неверсионному пути локальной игры тоже уходит next()', () => {
    const { gameStatic } = make({ dirs: { tanks: '/local/tanks/dist' } });
    const res = fakeRes();
    const next = vi.fn();
    const req = { method: 'GET', url: '/tanks/nope.js' };

    gameStatic.handler(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.url).toBe('/tanks/nope.js');
    expect(res.body).toBeNull();
  });

  it('снятая с диска версия уносит свой статик-маунт', () => {
    const { gameStatic, mounted } = make({
      dirs: { 'tanks@0.16.1': '/games-dir/tanks/0.16.1' },
      files: ['/games-dir/tanks/0.16.1/client.js'],
    });

    gameStatic.handler({ method: 'GET', url: '/tanks/0.16.1/client.js' }, fakeRes(), vi.fn());
    gameStatic.handler({ method: 'GET', url: '/tanks/0.16.1/client.js' }, fakeRes(), vi.fn());
    // второй запрос берёт маунт из кэша
    expect(mounted).toHaveLength(1);

    expect(gameStatic.drop('/games-dir/tanks/0.16.1')).toBe(true);
    gameStatic.handler({ method: 'GET', url: '/tanks/0.16.1/client.js' }, fakeRes(), vi.fn());

    // маунт создан заново — иначе Map росла бы на каждую скачанную версию
    expect(mounted).toHaveLength(2);
  });
});
