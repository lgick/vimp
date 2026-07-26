import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_API_VERSION } from '../config/opcodes.js';
import MapCatalog from './MapCatalog.js';

// Каталог игр-плагинов мастера (Этап A2 плана разделения): по конфигу
// `master:games` ({id, package}[]) резолвит директорию пакета в node_modules
// и читает <package>/dist/manifest.json (продукт сборки пакета игры, см.
// `docs/en/extending.md`) + per-game MapCatalog из <package>/dist/maps/*.json.
// Мастер не исполняет код игры (только уже собранный манифест + статичные
// JSON карт). Пакет игры — обычная npm-зависимость (`@vimp/tanks` и т.п.),
// не workspace-член этого репозитория (Этап A3).
//
// Манифест с несовпадающим `engineApi` (Этап A4) пропускается тем же
// гейтом, что `assertEngineApiCompatible` на клиенте/хосте — несовместимая
// игра не должна попасть в manifestList, который отдаётся клиентам.
//
// В dev entries манифеста (client/host/wasm) подменяются на исходники через
// Vite `/@fs/` (HMR штатный, как у остального движка); maps/assetsBase
// остаются из уже собранного dist — каталог требует, чтобы пакет игры был
// уже собран/установлен один раз перед первым запуском (см. CLAUDE.md).
export default class GameCatalog {
  /**
   * @param {{id: string, package: string}[]} games - список игр из конфига (`master:games`)
   * @param {string} nodeModulesDir - директория node_modules, где резолвятся пакеты игр
   * @param {{dev?: boolean}} [options]
   */
  constructor(games, nodeModulesDir, { dev = false } = {}) {
    this._games = new Map(); // id -> { manifest, mapCatalog }
    this._distDirs = new Map(); // id -> абсолютный путь к dist/ пакета

    for (const { id, package: pkg } of games) {
      const gameDir = path.join(nodeModulesDir, pkg);
      const distDir = path.join(gameDir, 'dist');
      const manifestPath = path.join(distDir, 'manifest.json');

      let manifest;

      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        continue; // игра не собрана/не установлена (npm run build в репозитории игры) — пропускаем
      }

      // статик-маунт мастера раздаёт dist/ по id из конфига — при
      // расхождении с manifest.id он бьёт мимо
      if (manifest.id !== id) {
        console.warn(
          `GameCatalog: skip "${id}" — manifest.id "${manifest.id}" ` +
            'does not match configured id',
        );
        continue;
      }

      // игра собрана под другую версию плагинного контракта (Этап A4) —
      // тот же гейт, что assertEngineApiCompatible на клиенте/хосте, но
      // здесь ещё до раздачи манифеста: несовместимая игра не должна даже
      // попасть в manifestList
      if (manifest.engineApi !== ENGINE_API_VERSION) {
        console.warn(
          `GameCatalog: skip "${id}" — requires engine API ` +
            `v${manifest.engineApi}, this engine build is v${ENGINE_API_VERSION}`,
        );
        continue;
      }

      this._games.set(manifest.id, {
        manifest: dev ? this._toDevManifest(manifest, gameDir) : manifest,
        mapCatalog: new MapCatalog(this._readMaps(path.join(distDir, 'maps'))),
      });
      this._distDirs.set(manifest.id, distDir);
    }

    this._manifestList = JSON.stringify(
      [...this._games.values()].map(game => game.manifest),
    );
  }

  _readMaps(mapsDir) {
    const maps = {};
    let files;

    try {
      files = fs.readdirSync(mapsDir).filter(name => name.endsWith('.json'));
    } catch (err) {
      return maps;
    }

    for (const file of files) {
      const name = file.slice(0, -'.json'.length);

      try {
        maps[name] = JSON.parse(
          fs.readFileSync(path.join(mapsDir, file), 'utf8'),
        );
      } catch (err) {
        console.warn(`GameCatalog: skip broken map "${file}": ${err.message}`);
      }
    }

    return maps;
  }

  // dev: entries -> Vite '/@fs/' исходники (HMR); maps/assetsBase/
  // roomDefaults/version — как в prod-манифесте, из уже собранного dist
  _toDevManifest(manifest, gameDir) {
    const src = rel => `/@fs/${path.join(gameDir, 'src', rel)}`;
    const wasm = this._findWasmBinary(path.join(gameDir, 'core', 'pkg-web'));

    return {
      ...manifest,
      entries: {
        client: src('client/index.js'),
        host: src('host/index.js'),
        wasm: wasm ? `/@fs/${wasm}` : manifest.entries.wasm,
      },
    };
  }

  _findWasmBinary(pkgWebDir) {
    try {
      const file = fs
        .readdirSync(pkgWebDir)
        .find(name => name.endsWith('_bg.wasm'));

      return file ? path.join(pkgWebDir, file) : null;
    } catch (err) {
      return null;
    }
  }

  get ids() {
    return [...this._games.keys()];
  }

  // манифесты всех известных игр — готовая JSON-строка (массив)
  get manifestList() {
    return this._manifestList;
  }

  getManifest(id) {
    return this._games.get(id)?.manifest;
  }

  getMapCatalog(id) {
    return this._games.get(id)?.mapCatalog;
  }

  // абсолютный путь к dist/ игры — под него мастер монтирует статику
  getDistDir(id) {
    return this._distDirs.get(id);
  }
}
