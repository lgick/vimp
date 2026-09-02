import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import GameSync from '../../packages/engine/src/master/GameSync.js';

// Синхронизация каталога с реестром игр auth-сервиса (master-game-registry,
// этап 3). Инвариант: отказ реестра или битый пакет одной игры не снимают с
// раздачи то, что уже работает.

const manifestOf = id => ({ id, version: `${id}-hash`, entries: {}, assetsBase: `/games/${id}/` });

const makeStore = (overrides = {}) => ({
  ensure: vi.fn(async (id, pkg, version) => ({
    ok: true,
    version,
    distDir: `/games-dir/${id}/${version}`,
    manifest: manifestOf(id),
    compat: null,
    errors: [],
  })),
  prune: vi.fn(async () => []),
  ...overrides,
});

const makeCatalog = () => ({
  upsert: vi.fn(),
  remove: vi.fn(),
  stagedManifests: vi.fn(() => []),
});

const makeRegistry = games => ({
  list: vi.fn(async () => ({ status: 200, json: { games } })),
});

const tanks = {
  id: 'tanks',
  packageName: '@vimp-games/tanks',
  version: '0.16.1',
  repoUrl: 'https://github.com/lgick/vimp-tanks',
  maxGameScore: 5000,
};

const snakes = {
  id: 'snakes',
  packageName: '@vimp-games/snakes',
  version: '0.9.1',
  repoUrl: null,
  maxGameScore: null,
};

let warn;
let info;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GameSync', () => {
  it('ставит новую игру реестра в каталог активной версией', async () => {
    const catalog = makeCatalog();
    const store = makeStore();
    const sync = new GameSync({ registry: makeRegistry([tanks]), store, catalog });

    await sync.run();

    expect(store.ensure).toHaveBeenCalledWith('tanks', '@vimp-games/tanks', '0.16.1');
    expect(catalog.upsert).toHaveBeenCalledWith({
      id: 'tanks',
      version: '0.16.1',
      distDir: '/games-dir/tanks/0.16.1',
      manifest: manifestOf('tanks'),
      packageVersion: '0.16.1',
      packageUrl: 'https://github.com/lgick/vimp-tanks',
      maxGameScore: 5000,
      active: true,
    });
  });

  it('смена версии в реестре переносит активную запись', async () => {
    const catalog = makeCatalog();
    const store = makeStore();
    const registry = makeRegistry([tanks]);
    const sync = new GameSync({ registry, store, catalog });

    await sync.run();

    registry.list.mockResolvedValueOnce({
      status: 200,
      json: { games: [{ ...tanks, version: '0.17.0' }] },
    });

    await sync.run();

    expect(catalog.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'tanks', version: '0.17.0', active: true }),
    );
    expect(catalog.remove).not.toHaveBeenCalled();
  });

  it('отказ реестра оставляет каталог прежним', async () => {
    const catalog = makeCatalog();
    const store = makeStore();
    const sync = new GameSync({
      registry: { list: vi.fn(async () => ({ status: 502, json: null })) },
      store,
      catalog,
    });

    await sync.run();

    expect(catalog.upsert).not.toHaveBeenCalled();
    expect(catalog.remove).not.toHaveBeenCalled();
    expect(store.prune).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('недоступный auth-сервис (бросок fetch) не роняет проход', async () => {
    const catalog = makeCatalog();
    const sync = new GameSync({
      registry: {
        list: vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
      },
      store: makeStore(),
      catalog,
    });

    await expect(sync.run()).resolves.toBeUndefined();
    expect(catalog.upsert).not.toHaveBeenCalled();
  });

  it('битый пакет не ломает остальные игры', async () => {
    const catalog = makeCatalog();
    const store = makeStore({
      ensure: vi.fn(async (id, pkg, version) =>
        id === 'tanks'
          ? { ok: false, version, distDir: null, manifest: null, compat: null, errors: ['нет dist/manifest.json'] }
          : {
              ok: true,
              version,
              distDir: `/games-dir/${id}/${version}`,
              manifest: manifestOf(id),
              compat: null,
              errors: [],
            },
      ),
    });
    const sync = new GameSync({ registry: makeRegistry([tanks, snakes]), store, catalog });

    await sync.run();

    expect(catalog.upsert).toHaveBeenCalledTimes(1);
    expect(catalog.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'snakes' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('нет dist/manifest.json'));
  });

  it('игра, исчезнувшая из реестра, снимается с раздачи', async () => {
    const catalog = makeCatalog();
    const registry = makeRegistry([tanks, snakes]);
    const sync = new GameSync({ registry, store: makeStore(), catalog });

    await sync.run();

    registry.list.mockResolvedValueOnce({ status: 200, json: { games: [snakes] } });
    await sync.run();

    expect(catalog.remove).toHaveBeenCalledWith('tanks');
    expect(catalog.remove).toHaveBeenCalledTimes(1);
  });

  it('локально прилинкованная игра не перезаписывается реестром', async () => {
    const catalog = makeCatalog();
    const store = makeStore();
    const sync = new GameSync({
      registry: makeRegistry([tanks, snakes]),
      store,
      catalog,
      localGameIds: new Set(['tanks']),
    });

    await sync.run();
    await sync.run();

    expect(store.ensure).not.toHaveBeenCalledWith('tanks', expect.anything(), expect.anything());
    expect(catalog.upsert).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'tanks' }));
    expect(catalog.remove).not.toHaveBeenCalled();
    // сообщение об игноре реестра — один раз на игру, а не каждый проход
    expect(info.mock.calls.filter(([text]) => text.includes('linked locally'))).toHaveLength(1);
  });

  it('prune получает активные версии и застейдженные в пределах keepVersions', async () => {
    const catalog = makeCatalog();

    catalog.stagedManifests.mockReturnValue([
      { id: 'tanks', version: '0.17.0', manifest: manifestOf('tanks') },
      { id: 'tanks', version: '0.18.0', manifest: manifestOf('tanks') },
    ]);

    const store = makeStore();
    const sync = new GameSync({
      registry: makeRegistry([tanks, snakes]),
      store,
      catalog,
      keepVersions: 2,
    });

    await sync.run();

    expect(store.prune).toHaveBeenCalledWith(
      new Map([
        ['tanks', new Set(['0.16.1', '0.17.0'])],
        ['snakes', new Set(['0.9.1'])],
      ]),
    );
  });

  it('локальная игра не попадает в keep — её пакета в хранилище нет', async () => {
    const store = makeStore();
    const sync = new GameSync({
      registry: makeRegistry([tanks, snakes]),
      store,
      catalog: makeCatalog(),
      localGameIds: new Set(['tanks']),
    });

    await sync.run();

    expect(store.prune).toHaveBeenCalledWith(new Map([['snakes', new Set(['0.9.1'])]]));
  });

  it('start/stop заводят и снимают периодический опрос', async () => {
    vi.useFakeTimers();

    const registry = makeRegistry([tanks]);
    const sync = new GameSync({
      registry,
      store: makeStore(),
      catalog: makeCatalog(),
      intervalMs: 1000,
    });

    sync.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(registry.list).toHaveBeenCalledTimes(2);

    sync.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(registry.list).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
