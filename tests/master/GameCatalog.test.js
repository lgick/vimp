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
  engineApi: 1,
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
    expect(catalog.getManifest('tanks')).toEqual(fixtureManifest);
    expect(JSON.parse(catalog.manifestList)).toEqual([fixtureManifest]);
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

  it('игра с несовпадающим engineApi пропускается с warn (Этап A4)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeManifest('tanks', { ...fixtureManifest, engineApi: ENGINE_API_VERSION + 1 });

    const catalog = new GameCatalog(tanksGames, nodeModulesDir);

    expect(catalog.ids).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('requires engine API'),
    );

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
