import fs from 'node:fs';
import path from 'node:path';
import { checkPluginCompatibility } from '../lib/gamePlugin.js';
import { resolveProjectUrl } from '../lib/packageLink.js';
import MapCatalog from './MapCatalog.js';
import { rebaseManifest } from './rebaseManifest.js';

// Каталог игр-плагинов мастера (Этап A2 плана разделения): по конфигу
// `master:games` ({id, package}[]) резолвит директорию пакета в node_modules
// и читает <package>/dist/manifest.json (продукт сборки пакета игры, см.
// `docs/en/extending.md`) + per-game MapCatalog из <package>/dist/maps/*.json.
// Мастер не исполняет код игры (только уже собранный манифест + статичные
// JSON карт). Пакет игры — обычная npm-зависимость (`@vimp-games/tanks` и т.п.),
// не workspace-член этого репозитория (Этап A3).
//
// Каталог ИЗМЕНЯЕМ (master-game-registry, этап 3): конструктор — только один
// из источников (node_modules локальной разработки и dedicated-сервера),
// а GameSync добавляет и снимает игры на лету по реестру auth-сервиса.
// Запись адресуется парой id + npm-версия пакета, поэтому две версии одной
// игры живут в каталоге одновременно: админ играет в застейдженную, игроки —
// в одобренную. Индекс `_active` говорит, какая версия каждой игры считается
// раздаваемой; всё, что не активно, — «на тесте» (см. isStaged).
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
   * @param {{id: string, package: string, maxGameScore?: number}[]} games - список игр из конфига (`master:games`)
   * @param {string} nodeModulesDir - директория node_modules, где резолвятся пакеты игр
   * @param {{dev?: boolean}} [options]
   */
  constructor(games, nodeModulesDir, { dev = false } = {}) {
    // `${id}@${version ?? ''}` -> { id, version, manifest, mapCatalog, distDir, maxGameScore }
    this._entries = new Map();
    this._active = new Map(); // id -> version активной записи (null у node_modules-пути)
    this._manifestList = '[]';

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
  }

  // одна игра каталога из node_modules: манифест, метаданные пакета, карты.
  // Бросает — вызывающий пропускает игру и продолжает с остальными
  _addGame({ id, package: pkg, maxGameScore }, nodeModulesDir, dev) {
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
    const meta = this._readPackageMeta(gameDir);

    this.upsert({
      id: manifest.id,
      // без версии в ключе: node_modules-путь держит ровно одну сборку игры,
      // и раздаётся она по неверсионному /games/<id>/ (ребейза нет)
      version: null,
      distDir,
      manifest: dev ? this._toDevManifest(manifest, gameDir) : manifest,
      packageVersion: meta.packageVersion,
      packageUrl: meta.packageUrl,
      maxGameScore,
      active: true,
    });
  }

  /**
   * Добавляет или заменяет запись каталога. Единственный вход для обоих
   * источников — node_modules (конструктор) и реестра auth (GameSync).
   * @param {Object} entry - Описание версии игры.
   * @param {string} entry.id - Идентификатор игры (сегмент URL).
   * @param {string|null} [entry.version] - npm-версия пакета; null — node_modules-путь.
   * @param {string} entry.distDir - Абсолютный путь к dist/ этой версии.
   * @param {Object} entry.manifest - Манифест из dist/manifest.json.
   * @param {string|null} [entry.packageVersion] - Версия пакета для футера.
   * @param {string|null} [entry.packageUrl] - Адрес проекта игры для футера.
   * @param {number|null} [entry.maxGameScore] - Потолок результата одной игры.
   * @param {boolean} [entry.active] - Делать ли версию раздаваемой.
   * @returns {void}
   */
  upsert({
    id,
    version = null,
    distDir,
    manifest,
    packageVersion,
    packageUrl,
    maxGameScore = null,
    active = false,
  }) {
    const withPackage = { ...manifest };

    if (packageVersion !== undefined) {
      withPackage.packageVersion = packageVersion ?? null;
    }

    if (packageUrl !== undefined) {
      withPackage.packageUrl = packageUrl ?? null;
    }

    // игра просит возможность, которой в этой сборке движка нет (этап 5
    // плана plugin-forward-compat): она ОСТАЁТСЯ в каталоге с пометкой
    // недоступности. Молчаливое выкидывание выглядело у игрока как пустое
    // лобби без единой строки о причине; теперь причина едет клиенту
    const compat = checkPluginCompatibility(manifest);

    if (!compat.ok) {
      console.warn(`GameCatalog: "${id}" is unavailable — ${compat.text}`);
      withPackage.compat = compat;
    }

    this._entries.set(this._key(id, version), {
      // id хранится в самой записи: разбор ключа по последнему '@' молча
      // ломался бы на идентификаторе, содержащем '@'
      id,
      version,
      // версионный URL раздачи: на диске рядом лежат несколько версий игры,
      // и один assetsBase на всех адресовал бы их вперемешку. У
      // node_modules-пути версии в ключе нет — там раздача неверсионная
      manifest: version ? rebaseManifest(withPackage, `/games/${id}/${version}/`) : withPackage,
      mapCatalog: new MapCatalog(this._readMaps(path.join(distDir, 'maps'))),
      distDir,
      maxGameScore: Number.isInteger(maxGameScore) && maxGameScore > 0 ? maxGameScore : null,
    });

    if (active) {
      this._active.set(id, version);
    }

    this._rebuild();
  }

  /**
   * Делает уже известную версию раздаваемой.
   * @param {string} id - Идентификатор игры.
   * @param {string|null} version - Версия из upsert.
   * @returns {boolean} Была ли такая версия в каталоге.
   */
  setActive(id, version) {
    if (!this._entries.has(this._key(id, version))) {
      return false;
    }

    this._active.set(id, version);
    this._rebuild();

    return true;
  }

  /**
   * Убирает версию игры (или игру целиком).
   * @param {string} id - Идентификатор игры.
   * @param {string|null} [version] - Версия; не задана — все версии игры.
   * @returns {boolean} Удалено ли хоть что-нибудь.
   */
  remove(id, version) {
    if (version === undefined) {
      let removed = false;

      for (const [key, entry] of [...this._entries]) {
        if (entry.id === id) {
          this._entries.delete(key);
          removed = true;
        }
      }

      this._active.delete(id);
      this._rebuild();

      return removed;
    }

    const removed = this._entries.delete(this._key(id, version));

    if (this._active.get(id) === version) {
      this._active.delete(id);
    }

    this._rebuild();

    return removed;
  }

  /**
   * Комната поднята на версии, которая в каталоге есть, но не раздаётся, —
   * то есть это тестовая комната админа (master-game-registry, этап 3.5).
   * Сверка идёт по manifest.version (хеш бандла): именно его хост шлёт в
   * register_host, npm-версии он не знает.
   * @param {string} id - Идентификатор игры.
   * @param {string} manifestVersion - `manifest.version` из register_host.
   * @returns {boolean} Застейдженная ли это версия.
   */
  isStaged(id, manifestVersion) {
    if (!manifestVersion) {
      return false;
    }

    // хеш активной сборки важнее: одна и та же сборка может быть
    // опубликована под двумя npm-версиями (правка только package.json), и
    // тогда комната игрока обязана остаться видимой
    if (this._resolve(id)?.manifest.version === manifestVersion) {
      return false;
    }

    const activeVersion = this._active.get(id);

    for (const entry of this._entries.values()) {
      if (entry.id !== id) {
        continue;
      }

      if (entry.version !== activeVersion && entry.manifest.version === manifestVersion) {
        return true;
      }
    }

    return false;
  }

  /**
   * Все неактивные версии каталога — очередь «на тесте» админского роута.
   * @returns {{id: string, version: string|null, manifest: Object}[]} Записи.
   */
  stagedManifests() {
    const staged = [];

    for (const entry of this._entries.values()) {
      if (entry.version !== this._active.get(entry.id)) {
        staged.push({ id: entry.id, version: entry.version, manifest: entry.manifest });
      }
    }

    return staged;
  }

  /**
   * Все записи каталога — чем он их раздаёт (GameSync сверяет с диском).
   * @returns {{id: string, version: string|null, distDir: string}[]} Записи.
   */
  entries() {
    return [...this._entries.values()].map(({ id, version, distDir }) => ({
      id,
      version,
      distDir,
    }));
  }

  /**
   * @param {string} id - Идентификатор игры.
   * @param {string|null} version - npm-версия.
   * @returns {boolean} Стоит ли эта версия в каталоге раздаваемой.
   */
  hasActive(id, version) {
    return this._active.get(id) === version && this._entries.has(this._key(id, version));
  }

  // package.json пакета игры: версия и адрес проекта (уже нормализованный —
  // клиенту остаётся только подпись). Пакета без манифеста здесь уже быть не
  // может, но битый/отсутствующий package.json — не повод выкидывать игру из
  // каталога: без этих полей пустеет только футер.
  //
  // Для скачанных из реестра игр этот путь не работает и не нужен: в тарболле
  // лежит только dist/, а версию и адрес проекта присылает сам реестр
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

  _key(id, version) {
    return `${id}@${version ?? ''}`;
  }

  // активная запись игры, либо конкретная версия, если она названа
  _resolve(id, version) {
    if (version === undefined || version === null) {
      return this._active.has(id)
        ? this._entries.get(this._key(id, this._active.get(id)))
        : undefined;
    }

    return this._entries.get(this._key(id, version));
  }

  // manifestList пересчитывается при каждом изменении каталога и содержит
  // только активные манифесты в порядке по id: первая игра списка становится
  // активной в лобби (client/main.js), и этот выбор не должен зависеть от
  // порядка, в котором реестр или диск отдали игры
  _rebuild() {
    this._manifestList = JSON.stringify(
      [...this._active.keys()]
        .sort((a, b) => a.localeCompare(b))
        .map(id => this._resolve(id)?.manifest)
        .filter(Boolean),
    );
  }

  // id игр, которые каталог раздаёт (активные записи)
  get ids() {
    return [...this._active.keys()].sort((a, b) => a.localeCompare(b));
  }

  // манифесты всех раздаваемых игр — готовая JSON-строка (массив)
  get manifestList() {
    return this._manifestList;
  }

  getManifest(id, version) {
    return this._resolve(id, version)?.manifest;
  }

  getMapCatalog(id, version) {
    return this._resolve(id, version)?.mapCatalog;
  }

  // абсолютный путь к dist/ игры — из него мастер раздаёт статику
  getDistDir(id, version) {
    return this._resolve(id, version)?.distDir;
  }

  // Потолок результата ОДНОЙ игры, объявленный АДМИНОМ в реестре (или
  // конфигом мастера для node_modules-пути). Из манифеста его брать нельзя:
  // игра завысила бы себе потолок сама
  getMaxGameScore(id) {
    return this._resolve(id)?.maxGameScore ?? null;
  }
}
