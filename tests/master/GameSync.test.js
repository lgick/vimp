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
  // каталог ещё не описывает состояние, полученное из реестра, — проход
  // обязан дойти до upsert
  hasActive: vi.fn(() => false),
  entries: vi.fn(() => []),
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

  it('prune получает раздаваемые версии в пределах keepVersions и все черновики', async () => {
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

    // потолок тратят раздаваемые версии; черновики идут сверх него — они
    // существуют только на диске, перекачать их из npm нельзя
    expect(store.prune).toHaveBeenCalledWith(
      new Map([
        ['tanks', new Set(['0.16.1', '0.17.0', '0.18.0'])],
        ['snakes', new Set(['0.9.1'])],
      ]),
    );
  });

  it('застейдженная версия локально прилинкованной игры остаётся в keep', async () => {
    // dev-контур: игра прилинкована в node_modules, но «Тест» админа кладёт
    // скачанную версию на диск — она не из node_modules, и запрет на
    // локальные id её не касается
    const catalog = makeCatalog();

    catalog.stagedManifests.mockReturnValue([
      { id: 'tanks', version: '0.16.1', manifest: manifestOf('tanks') },
    ]);

    const store = makeStore();
    const sync = new GameSync({
      registry: makeRegistry([tanks]),
      store,
      catalog,
      localGameIds: new Set(['tanks']),
    });

    await sync.run();

    expect(store.ensure).not.toHaveBeenCalled();
    expect(store.prune).toHaveBeenCalledWith(new Map([['tanks', new Set(['0.16.1'])]]));
  });

  it('черновик локальной игры снимается, когда реестр раздаёт ту же версию', async () => {
    // «Тест» одобрен: тестировать больше нечего, а снять запись больше
    // некому — локальная игра выходит из цикла до _owned
    const catalog = makeCatalog();

    catalog.stagedManifests.mockReturnValue([
      { id: 'tanks', version: '0.16.1', manifest: manifestOf('tanks') },
    ]);

    const sync = new GameSync({
      registry: makeRegistry([tanks]),
      store: makeStore(),
      catalog,
      localGameIds: new Set(['tanks']),
    });

    await sync.run();

    expect(catalog.remove).toHaveBeenCalledWith('tanks', '0.16.1');
  });

  it('черновик локальной игры с другой версией остаётся: он ещё на тесте', async () => {
    const catalog = makeCatalog();

    catalog.stagedManifests.mockReturnValue([
      { id: 'tanks', version: '0.17.0', manifest: manifestOf('tanks') },
    ]);

    const sync = new GameSync({
      registry: makeRegistry([tanks]),
      store: makeStore(),
      catalog,
      localGameIds: new Set(['tanks']),
    });

    await sync.run();

    expect(catalog.remove).not.toHaveBeenCalled();
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

  it('застейдженная версия игры вне одобренного каталога остаётся в keep', async () => {
    // основной сценарий модерации: заявка на НОВУЮ игру, админ жмёт «Тест».
    // В GET /games её ещё нет, и раньше первый же тик таймера сносил
    // скачанную версию с диска прямо посреди тестового матча
    const catalog = makeCatalog();

    catalog.stagedManifests.mockReturnValue([
      { id: 'new-game', version: '1.0.0', manifest: manifestOf('new-game') },
    ]);

    const store = makeStore();
    const sync = new GameSync({ registry: makeRegistry([tanks]), store, catalog });

    await sync.run();

    expect(store.prune).toHaveBeenCalledWith(
      new Map([
        ['tanks', new Set(['0.16.1'])],
        ['new-game', new Set(['1.0.0'])],
      ]),
    );
  });

  it('повторный проход без изменений в реестре не трогает каталог', async () => {
    const catalog = makeCatalog();
    const store = makeStore();
    const sync = new GameSync({ registry: makeRegistry([tanks]), store, catalog });

    await sync.run();

    catalog.hasActive.mockReturnValue(true);

    await sync.run();

    expect(catalog.upsert).toHaveBeenCalledTimes(1);
  });

  it('смена maxGameScore без смены версии доезжает до каталога', async () => {
    // потолок счёта и адрес проекта живут в СТРОКЕ РЕЕСТРА, а не в пакете:
    // админ правит их PATCH'ем, не трогая версию, и пропуск upsert по одной
    // только версии заморозил бы старое значение навсегда
    const catalog = makeCatalog();
    const store = makeStore();
    const registry = makeRegistry([tanks]);
    const sync = new GameSync({ registry, store, catalog });

    await sync.run();

    catalog.hasActive.mockReturnValue(true);
    registry.list.mockResolvedValue({
      status: 200,
      json: { games: [{ ...tanks, maxGameScore: 9000 }] },
    });

    await sync.run();

    expect(catalog.upsert).toHaveBeenCalledTimes(2);
    expect(catalog.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: '0.16.1', maxGameScore: 9000 }),
    );

    // строка реестра не изменилась — третий проход каталог не трогает
    await sync.run();

    expect(catalog.upsert).toHaveBeenCalledTimes(2);
  });

  it('запись каталога, чьей директории на диске нет, снимается', async () => {
    const catalog = makeCatalog();

    catalog.entries.mockReturnValue([
      { id: 'tanks', version: '0.15.0', distDir: '/games-dir/tanks/0.15.0' },
      // неверсионная запись (node_modules) диском не проверяется
      { id: 'local', version: null, distDir: '/nowhere' },
    ]);

    const sync = new GameSync({
      registry: makeRegistry([tanks]),
      store: makeStore(),
      catalog,
    });

    await sync.run();

    expect(catalog.remove).toHaveBeenCalledWith('tanks', '0.15.0');
    expect(catalog.remove).not.toHaveBeenCalledWith('local', null);
  });

  it('два одновременных run() дают один поход в реестр', async () => {
    const registry = makeRegistry([tanks]);
    const sync = new GameSync({ registry, store: makeStore(), catalog: makeCatalog() });

    await Promise.all([sync.run(), sync.run()]);

    expect(registry.list).toHaveBeenCalledTimes(1);
  });

  it('удалённые prune пути отдаются в onPruned', async () => {
    const onPruned = vi.fn();
    const store = makeStore({ prune: vi.fn(async () => ['/games-dir/tanks/0.15.0']) });
    const sync = new GameSync({
      registry: makeRegistry([tanks]),
      store,
      catalog: makeCatalog(),
      onPruned,
    });

    await sync.run();

    expect(onPruned).toHaveBeenCalledWith(['/games-dir/tanks/0.15.0']);
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
