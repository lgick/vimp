import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import GameCatalog from '../../packages/engine/src/master/GameCatalog.js';
import { ENGINE_API_VERSION } from '../../packages/engine/src/config/opcodes.js';

// Каталог игр-плагинов мастера (Этап A2): резолвит пакеты из конфига
// {id, package}[] в node_modules/<package>/dist/manifest.json (продукт
// `npm run game:build`) + per-game карты dist/maps/*.json; в dev подменяет
// entries на Vite '/@fs/' исходники для HMR.

let nodeModulesDir;

const writeManifest = (pkg, manifest) => {
  const distDir = path.join(nodeModulesDir, pkg, 'dist');

  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'manifest.json'),
    JSON.stringify(manifest),
  );
};

const writeMap = (pkg, name, data) => {
  const mapsDir = path.join(nodeModulesDir, pkg, 'dist', 'maps');

  fs.mkdirSync(mapsDir, { recursive: true });
  fs.writeFileSync(path.join(mapsDir, `${name}.json`), JSON.stringify(data));
};

const fixtureManifest = {
  id: 'tanks',
  engineApi: ENGINE_API_VERSION,
  version: 'abc123',
  title: 'VIMP Tanks',
  entries: {
    client: '/games/tanks/client-Xyz.js',
    host: '/games/tanks/host-Xyz.js',
    wasm: '/games/tanks/assets/core_bg-Xyz.wasm',
  },
  assetsBase: '/games/tanks/',
  maps: { version: 'maps123', list: ['arena'] },
  roomDefaults: { maxPlayers: 8, roundTime: 120000, mapTime: 600000, friendlyFire: false, map: 'arena' },
};

const writePackageJson = (pkg, data) => {
  fs.mkdirSync(path.join(nodeModulesDir, pkg), { recursive: true });
  fs.writeFileSync(
    path.join(nodeModulesDir, pkg, 'package.json'),
    JSON.stringify(data),
  );
};

// метаданные пакета, которые каталог подмешивает в манифест: их движок
// показывает в футере формы входа. Пакета без package.json в fixture нет,
// поэтому по умолчанию поля пустые
const noPackageMeta = { packageVersion: null, packageUrl: null };

const tanksGames = [{ id: 'tanks', package: 'tanks' }];

beforeEach(() => {
  nodeModulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-catalog-'));
});

afterEach(() => {
  fs.rmSync(nodeModulesDir, { recursive: true, force: true });
});

describe('GameCatalog', () => {
  it('резолвит пакеты из конфига в node_modules и собирает список манифестов', () => {
    writeManifest('tanks', fixtureManifest);
    writeMap('tanks', 'arena', { setId: 'c1', step: 32, layers: {} });

    const catalog = new GameCatalog(tanksGames, nodeModulesDir);

    expect(catalog.ids).toEqual(['tanks']);
    expect(catalog.getManifest('tanks')).toEqual({
      ...fixtureManifest,
      ...noPackageMeta,
    });
    expect(JSON.parse(catalog.manifestList)).toEqual([
      { ...fixtureManifest, ...noPackageMeta },
    ]);
  });

  it('подмешивает в манифест версию и нормализованный адрес пакета игры', () => {
    writeManifest('tanks', fixtureManifest);
    writePackageJson('tanks', {
      name: '@vimp-games/tanks',
      version: '0.14.0',
      repository: { type: 'git', url: 'git+ssh://git@github.com/lgick/vimp-tanks.git' },
    });

    const manifest = new GameCatalog(tanksGames, nodeModulesDir).getManifest(
      'tanks',
    );

    expect(manifest.packageVersion).toBe('0.14.0');
    // клиенту достаётся готовый https-адрес: ему остаётся только подпись
    expect(manifest.packageUrl).toBe('https://github.com/lgick/vimp-tanks');
  });

  it('пакет без repository/homepage остаётся без адреса, но с версией', () => {
    writeManifest('tanks', fixtureManifest);
    writePackageJson('tanks', { name: '@vimp-games/tanks', version: '0.14.0' });

    const manifest = new GameCatalog(tanksGames, nodeModulesDir).getManifest(
      'tanks',
    );

    expect(manifest.packageVersion).toBe('0.14.0');
    expect(manifest.packageUrl).toBe(null);
  });

  it('пакет без package.json остаётся в каталоге с пустыми метаданными', () => {
    writeManifest('tanks', fixtureManifest);

    const manifest = new GameCatalog(tanksGames, nodeModulesDir).getManifest(
      'tanks',
    );

    expect(manifest.id).toBe('tanks');
    expect(manifest).toMatchObject(noPackageMeta);
  });

  it('per-game MapCatalog отдаёт карты игры', () => {
    writeManifest('tanks', fixtureManifest);
    writeMap('tanks', 'arena', { setId: 'c1', step: 32, layers: {} });

    const catalog = new GameCatalog(tanksGames, nodeModulesDir);
    const mapCatalog = catalog.getMapCatalog('tanks');

    expect(JSON.parse(mapCatalog.manifest).maps).toEqual(['arena']);
    expect(JSON.parse(mapCatalog.get('arena'))).toEqual({
      setId: 'c1',
      step: 32,
      layers: {},
    });
  });

  it('getDistDir отдаёт путь к dist/ пакета — под него монтируется статика', () => {
    writeManifest('tanks', fixtureManifest);

    const catalog = new GameCatalog(tanksGames, nodeModulesDir);

    expect(catalog.getDistDir('tanks')).toBe(
      path.join(nodeModulesDir, 'tanks', 'dist'),
    );
  });

  it('пустой список игр в конфиге — пустой каталог', () => {
    const empty = new GameCatalog([], nodeModulesDir);

    expect(empty.ids).toEqual([]);
    expect(empty.getManifest('tanks')).toBeUndefined();
    expect(empty.getMapCatalog('tanks')).toBeUndefined();
    expect(JSON.parse(empty.manifestList)).toEqual([]);
  });

  it('игра без dist/manifest.json (не собрана/не установлена) пропускается', () => {
    const catalog = new GameCatalog(
      [{ id: 'unbuilt', package: 'unbuilt' }, ...tanksGames],
      nodeModulesDir,
    );

    writeManifest('tanks', fixtureManifest);

    expect(new GameCatalog(tanksGames, nodeModulesDir).ids).toEqual(['tanks']);
    expect(catalog.ids).toEqual([]);
  });

  it('игра с manifest.id ≠ id из конфига пропускается с warn (Д4.3)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeManifest('wrong-pkg', fixtureManifest); // manifest.id === 'tanks'
    writeManifest('tanks', fixtureManifest);

    const catalog = new GameCatalog(
      [{ id: 'wrong-pkg', package: 'wrong-pkg' }, ...tanksGames],
      nodeModulesDir,
    );

    expect(catalog.ids).toEqual(['tanks']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wrong-pkg'));

    warn.mockRestore();
  });

  it('битый JSON карты пропускается с warn, мастер не падает (Д4.3)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeManifest('tanks', fixtureManifest);
    writeMap('tanks', 'arena', { setId: 'c1', step: 32, layers: {} });

    const mapsDir = path.join(nodeModulesDir, 'tanks', 'dist', 'maps');

    fs.writeFileSync(path.join(mapsDir, 'broken.json'), '{oops');

    const catalog = new GameCatalog(tanksGames, nodeModulesDir);
    const mapCatalog = catalog.getMapCatalog('tanks');

    expect(JSON.parse(mapCatalog.manifest).maps).toEqual(['arena']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken.json'));

    warn.mockRestore();
  });

  it('игра прошлого поколения engineApi остаётся в каталоге (этап 5)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeManifest('tanks', { ...fixtureManifest, engineApi: ENGINE_API_VERSION - 1 });

    const catalog = new GameCatalog(tanksGames, nodeModulesDir);

    expect(catalog.ids).toEqual(['tanks']);
    expect(catalog.getManifest('tanks').compat).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('dev: entries указывают на Vite /@fs/ исходники, остальное — из манифеста', () => {
    writeManifest('tanks', fixtureManifest);

    const catalog = new GameCatalog(tanksGames, nodeModulesDir, { dev: true });
    const manifest = catalog.getManifest('tanks');

    const gameDir = path.join(nodeModulesDir, 'tanks');

    expect(manifest.entries.client).toBe(
      `/@fs/${path.join(gameDir, 'src', 'client/index.js')}`,
    );
    expect(manifest.entries.host).toBe(
      `/@fs/${path.join(gameDir, 'src', 'host/index.js')}`,
    );
    // core/pkg-web не собран в фикстуре — wasm остаётся из манифеста
    expect(manifest.entries.wasm).toBe(fixtureManifest.entries.wasm);
    expect(manifest.maps).toEqual(fixtureManifest.maps);
    expect(manifest.assetsBase).toBe(fixtureManifest.assetsBase);
  });

  it('dev: entries.wasm — Vite /@fs/ путь до собранного core/pkg-web/*_bg.wasm', () => {
    writeManifest('tanks', fixtureManifest);

    const pkgWebDir = path.join(nodeModulesDir, 'tanks', 'core', 'pkg-web');

    fs.mkdirSync(pkgWebDir, { recursive: true });
    fs.writeFileSync(path.join(pkgWebDir, 'vimp_tanks_core_bg.wasm'), 'wasm');

    const catalog = new GameCatalog(tanksGames, nodeModulesDir, { dev: true });

    expect(catalog.getManifest('tanks').entries.wasm).toBe(
      `/@fs/${path.join(pkgWebDir, 'vimp_tanks_core_bg.wasm')}`,
    );
  });
});


// ***** ИЗМЕНЯЕМЫЙ ВЕРСИОННЫЙ КАТАЛОГ (master-game-registry, этап 3) *****
//
// Каталог перестал быть снимком стартового конфига: GameSync добавляет и
// снимает игры на лету, а две версии одной игры живут в нём одновременно —
// админ тестирует новую, пока игроки играют в одобренную.

// dist/ скачанной версии на диске: манифест + карта
const writeVersion = (id, version, manifest = { ...fixtureManifest, id }) => {
  const distDir = path.join(nodeModulesDir, '.games', id, version);
  const mapsDir = path.join(distDir, 'maps');

  fs.mkdirSync(mapsDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(mapsDir, 'arena.json'), JSON.stringify({ setId: 'c1' }));

  return { distDir, manifest };
};

const upsertVersion = (catalog, id, version, overrides = {}) => {
  const { distDir, manifest } = writeVersion(id, version, overrides.manifest);

  catalog.upsert({
    id,
    version,
    distDir,
    manifest,
    packageVersion: version,
    packageUrl: null,
    ...overrides,
  });

  return distDir;
};

describe('GameCatalog: изменяемый версионный каталог', () => {
  it('upsert добавляет игру и делает версию активной', () => {
    const catalog = new GameCatalog([], nodeModulesDir);

    upsertVersion(catalog, 'tanks', '0.16.1', { active: true });

    expect(catalog.ids).toEqual(['tanks']);
    expect(catalog.getManifest('tanks').assetsBase).toBe('/games/tanks/0.16.1/');
    expect(catalog.getMapCatalog('tanks').get('arena')).toBeTruthy();
  });

  it('ребейз применён к скачанной игре и не применён к node_modules-пути', () => {
    writeManifest('tanks', fixtureManifest);

    const catalog = new GameCatalog(tanksGames, nodeModulesDir);

    // node_modules-путь раздаётся по неверсионному /games/<id>/
    expect(catalog.getManifest('tanks').assetsBase).toBe('/games/tanks/');
    expect(catalog.getManifest('tanks').mapsBase).toBeUndefined();

    upsertVersion(catalog, 'snakes', '0.9.1', {
      active: true,
      manifest: { ...fixtureManifest, id: 'snakes', assetsBase: '/games/snakes/' },
    });

    const snakes = catalog.getManifest('snakes');

    expect(snakes.assetsBase).toBe('/games/snakes/0.9.1/');
    expect(snakes.mapsBase).toBe('/games/snakes/0.9.1/maps');
  });

  it('две версии одной игры сосуществуют, активна одна', () => {
    const catalog = new GameCatalog([], nodeModulesDir);

    upsertVersion(catalog, 'tanks', '0.16.1', { active: true });
    upsertVersion(catalog, 'tanks', '0.17.0', {
      manifest: { ...fixtureManifest, version: 'next-hash' },
    });

    expect(catalog.getManifest('tanks').assetsBase).toBe('/games/tanks/0.16.1/');
    expect(catalog.getManifest('tanks', '0.17.0').assetsBase).toBe('/games/tanks/0.17.0/');
    expect(JSON.parse(catalog.manifestList)).toHaveLength(1);
    expect(catalog.stagedManifests().map(({ version }) => version)).toEqual(['0.17.0']);
  });

  it('setActive переключает раздаваемую версию', () => {
    const catalog = new GameCatalog([], nodeModulesDir);

    upsertVersion(catalog, 'tanks', '0.16.1', { active: true });
    upsertVersion(catalog, 'tanks', '0.17.0');

    expect(catalog.setActive('tanks', '0.17.0')).toBe(true);
    expect(catalog.getManifest('tanks').assetsBase).toBe('/games/tanks/0.17.0/');
    expect(catalog.setActive('tanks', '9.9.9')).toBe(false);
  });

  it('remove снимает версию, а без версии — игру целиком', () => {
    const catalog = new GameCatalog([], nodeModulesDir);

    upsertVersion(catalog, 'tanks', '0.16.1', { active: true });
    upsertVersion(catalog, 'tanks', '0.17.0');

    expect(catalog.remove('tanks', '0.17.0')).toBe(true);
    expect(catalog.getManifest('tanks', '0.17.0')).toBeUndefined();
    expect(catalog.ids).toEqual(['tanks']);

    expect(catalog.remove('tanks')).toBe(true);
    expect(catalog.ids).toEqual([]);
    expect(catalog.manifestList).toBe('[]');
  });

  it('manifestList содержит только активные манифесты в порядке по id', () => {
    const catalog = new GameCatalog([], nodeModulesDir);

    upsertVersion(catalog, 'tanks', '0.16.1', { active: true });
    upsertVersion(catalog, 'tanks', '0.17.0');
    upsertVersion(catalog, 'snakes', '0.9.1', {
      active: true,
      manifest: { ...fixtureManifest, id: 'snakes', assetsBase: '/games/snakes/' },
    });

    expect(JSON.parse(catalog.manifestList).map(({ id }) => id)).toEqual([
      'snakes',
      'tanks',
    ]);
  });

  it('isStaged отличает комнату застейдженной версии по manifest.version', () => {
    const catalog = new GameCatalog([], nodeModulesDir);

    upsertVersion(catalog, 'tanks', '0.16.1', { active: true });
    upsertVersion(catalog, 'tanks', '0.17.0', {
      manifest: { ...fixtureManifest, version: 'next-hash' },
    });

    expect(catalog.isStaged('tanks', 'next-hash')).toBe(true);
    expect(catalog.isStaged('tanks', fixtureManifest.version)).toBe(false);
    expect(catalog.isStaged('tanks', undefined)).toBe(false);
    expect(catalog.isStaged('snakes', 'next-hash')).toBe(false);
  });

  it('getMaxGameScore отдаёт потолок активной версии, иначе null', () => {
    const catalog = new GameCatalog([], nodeModulesDir);

    upsertVersion(catalog, 'tanks', '0.16.1', { active: true, maxGameScore: 5000 });
    upsertVersion(catalog, 'snakes', '0.9.1', {
      active: true,
      manifest: { ...fixtureManifest, id: 'snakes' },
    });

    expect(catalog.getMaxGameScore('tanks')).toBe(5000);
    expect(catalog.getMaxGameScore('snakes')).toBe(null);
    expect(catalog.getMaxGameScore('chess')).toBe(null);
  });

  it('конфиг node_modules-пути отдаёт maxGameScore в каталог', () => {
    writeManifest('tanks', fixtureManifest);

    const catalog = new GameCatalog(
      [{ id: 'tanks', package: 'tanks', maxGameScore: 777 }],
      nodeModulesDir,
    );

    expect(catalog.getMaxGameScore('tanks')).toBe(777);
  });

  it('getDistDir отдаёт директорию названной версии', () => {
    const catalog = new GameCatalog([], nodeModulesDir);
    const active = upsertVersion(catalog, 'tanks', '0.16.1', { active: true });
    const staged = upsertVersion(catalog, 'tanks', '0.17.0');

    expect(catalog.getDistDir('tanks')).toBe(active);
    expect(catalog.getDistDir('tanks', '0.17.0')).toBe(staged);
    expect(catalog.getDistDir('tanks', '9.9.9')).toBeUndefined();
  });
});
