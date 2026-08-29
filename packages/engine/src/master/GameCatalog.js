import fs from 'node:fs';
import path from 'node:path';
import { checkPluginCompatibility } from '../lib/gamePlugin.js';
import { resolveProjectUrl } from '../lib/packageLink.js';
import MapCatalog from './MapCatalog.js';

// Каталог игр-плагинов мастера (Этап A2 плана разделения): по конфигу
// `master:games` ({id, package}[]) резолвит директорию пакета в node_modules
// и читает <package>/dist/manifest.json (продукт сборки пакета игры, см.
// `docs/en/extending.md`) + per-game MapCatalog из <package>/dist/maps/*.json.
// Мастер не исполняет код игры (только уже собранный манифест + статичные
// JSON карт). Пакет игры — обычная npm-зависимость (`@vimp-games/tanks` и т.п.),
// не workspace-член этого репозитория (Этап A3).
//
// Гейта по `engineApi` здесь больше нет (этап 5 плана
// plugin-forward-compat): игра любого возраста попадает в manifestList.
// Игра, которая просит возможность, отсутствующую в этой сборке движка,
// тоже остаётся в каталоге — но с полем `compat` ({ok: false, missing,
// text}), по которому лобби показывает её недоступной с причиной.
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

    for (const game of games) {
      // Разбор ОДНОЙ игры целиком под try: инвариант «битая игра не уносит
      // каталог» обязан держаться механически, а не по доброй воле
      // вызываемого кода. Раньше try накрывал только JSON.parse, и
      // TypeError из checkPluginCompatibility на кривом manifest.requires
      // уходил из конструктора — мастер не стартовал вовсе
      try {
        this._addGame(game, nodeModulesDir, dev);
      } catch (err) {
        console.warn(`GameCatalog: skip "${game.id}" — ${err.message}`);
      }
    }

    this._manifestList = JSON.stringify(
      [...this._games.values()].map(g => g.manifest),
    );
  }

  // одна игра каталога: манифест, метаданные пакета, вердикт совместимости,
  // карты. Бросает — вызывающий пропускает игру и продолжает с остальными
  _addGame({ id, package: pkg }, nodeModulesDir, dev) {
    const gameDir = path.join(nodeModulesDir, pkg);
    const distDir = path.join(gameDir, 'dist');
    const manifestPath = path.join(distDir, 'manifest.json');

    let manifest;

    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return; // игра не собрана/не установлена (npm run build в репозитории игры) — пропускаем молча
    }

    // статик-маунт мастера раздаёт dist/ по id из конфига — при
    // расхождении с manifest.id он бьёт мимо
    if (manifest.id !== id) {
      console.warn(
        `GameCatalog: skip "${id}" — manifest.id "${manifest.id}" ` +
          'does not match configured id',
      );
      return;
    }

    // метаданные npm-пакета игры (версия и адрес проекта) — их движок
    // показывает в футере формы входа. Источник здесь, а не в манифесте:
    // манифест пишет сборка в репозитории игры, и любое новое поле в нём
    // доезжает до игроков только через правку скрипта сборки каждой игры и
    // её перепубликацию, тогда как package.json лежит рядом с уже
    // установленным пакетом и верен по определению
    const withPackage = { ...manifest, ...this._readPackageMeta(gameDir) };

    // игра просит возможность, которой в этой сборке движка нет (этап 5
    // плана plugin-forward-compat): она ОСТАЁТСЯ в каталоге с пометкой
    // недоступности. Молчаливое выкидывание выглядело у игрока как пустое
    // лобби без единой строки о причине; теперь причина едет клиенту
    const compat = checkPluginCompatibility(manifest);

    if (!compat.ok) {
      console.warn(`GameCatalog: "${id}" is unavailable — ${compat.text}`);
      withPackage.compat = compat;
    }

    this._games.set(manifest.id, {
      manifest: dev ? this._toDevManifest(withPackage, gameDir) : withPackage,
      mapCatalog: new MapCatalog(this._readMaps(path.join(distDir, 'maps'))),
    });
    this._distDirs.set(manifest.id, distDir);
  }

  // package.json пакета игры: версия и адрес проекта (уже нормализованный —
  // клиенту остаётся только подпись). Пакета без манифеста здесь уже быть не
  // может, но битый/отсутствующий package.json — не повод выкидывать игру из
  // каталога: без этих полей пустеет только футер
  _readPackageMeta(gameDir) {
    let meta;

    try {
      meta = JSON.parse(
        fs.readFileSync(path.join(gameDir, 'package.json'), 'utf8'),
      );
    } catch {
      return { packageVersion: null, packageUrl: null };
    }

    return {
      packageVersion: meta.version ?? null,
      packageUrl: resolveProjectUrl(meta),
    };
  }

  _readMaps(mapsDir) {
    const maps = {};
    let files;

    try {
      files = fs.readdirSync(mapsDir).filter(name => name.endsWith('.json'));
    } catch {
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
    } catch {
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
