import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { checkGamePackage } from './gamePackageCheck.js';
import {
  downloadTarball,
  extractDist,
  fetchPackument,
  listVersions,
  resolveVersion,
} from './npmRegistry.js';

// Хранилище игровых пакетов мастера (направление master-game-registry):
// скачивает одобренную версию игры из npm registry, проверяет её структурно
// (gamePackageCheck — без исполнения игрового кода) и кладёт dist/ на диск,
// откуда её раздаёт мастер. Раскладка:
//
//   <dir>/<gameId>/<npmVersion>/     ← содержимое package/dist
//   <dir>/<gameId>/.staging/<rand>/  ← временная распаковка
//
// Инвариант каталога («одна битая игра не роняет мастер») здесь усилен:
// ensure/inspect НИКОГДА не бросают — сетевой отказ, 404, битый архив и
// проваленная проверка одинаково возвращают вердикт {ok: false, errors}.
// Бросает только конструктор, и только про право записи в корень: невнятный
// EACCES из середины скачивания через час работы — худший способ узнать о
// неправильно смонтированном томе.

const STAGING = '.staging';
// чужой .staging моложе часа — это, скорее всего, идущая прямо сейчас
// распаковка соседнего процесса: делить том два мастера могут только по
// ошибке конфигурации, но удалять чужой каталог посреди работы всё равно
// не следует
const STAGING_TTL = 3600000;

export default class GameStore {
  /**
   * @param {Object} options - Корень хранилища, реестр, потолки и сеть.
   * @param {string} options.dir - Корень хранилища на диске.
   * @param {string} options.registryUrl - Базовый адрес npm registry.
   * @param {Object} [options.limits] - maxTarballBytes, maxFiles, timeout.
   * @param {Function} [options.fetchImpl] - Реализация fetch.
   */
  constructor({ dir, registryUrl, limits = {}, fetchImpl = fetch }) {
    this._dir = dir;
    this._registryUrl = registryUrl;
    this._limits = limits;
    this._fetch = fetchImpl;
    // distDir -> {mtimeMs, check}: см. _checkCached
    this._checks = new Map();

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
      throw new Error(
        `GameStore: no write access to "${dir}" (${err.code ?? err.message}) — ` +
          'check VIMP_GAMES_DIR and the permissions of the mounted volume',
      );
    }
  }

  get dir() {
    return this._dir;
  }

  /**
   * Гарантирует наличие версии на диске. Идемпотентно: уже лежащая версия
   * не качается заново, а только перепроверяется (чтение JSON — дёшево, и
   * это бесплатная защита от порчи тома).
   * @param {string} gameId - Идентификатор игры в каталоге.
   * @param {string} packageName - Имя npm-пакета игры.
   * @param {string} [version] - Точная версия либо 'latest'.
   * @returns {Promise<{ok: boolean, version: string|null, distDir: string|null,
   *   manifest: Object|null, compat: Object|null, errors: string[]}>} Вердикт.
   */
  async ensure(gameId, packageName, version) {
    const badRef = refError(gameId, version);

    if (badRef) {
      return { ok: false, version: null, distDir: null, manifest: null, compat: null, errors: [badRef] };
    }

    if (version && version !== 'latest' && this.has(gameId, version)) {
      const distDir = this.distDir(gameId, version);
      const check = this._checkCached(distDir, gameId);

      return { ...check, version, distDir: check.ok ? distDir : null };
    }

    const staged = await this._stage(gameId, packageName, version);

    if (!staged.ok) {
      await remove(staged.stagingDir);

      return { ...verdictOf(staged), distDir: null };
    }

    const distDir = this.distDir(gameId, staged.version);

    try {
      // переезд одним rename: недокачанная или непрошедшая проверку версия
      // физически не может оказаться в раздаче
      await fsp.mkdir(path.dirname(distDir), { recursive: true });
      await fsp.rename(staged.stagingDir, distDir);
    } catch (err) {
      // гонка двух ensure одной версии: каталог уже на месте — это успех
      if (!this.has(gameId, staged.version)) {
        await remove(staged.stagingDir);

        return {
          ok: false,
          version: staged.version,
          distDir: null,
          manifest: null,
          compat: null,
          errors: [`the version was not moved into service: ${err.message}`],
        };
      }

      await remove(staged.stagingDir);
    }

    return { ...verdictOf(staged), distDir };
  }

  // Перепроверка уже лежащей версии — защита от порчи тома, но бесплатной
  // она не является: GameSync зовёт ensure на каждую игру каждый проход, а
  // checkGamePackage читает манифест и щупает каждый entry и каждую карту.
  //
  // Ключ кэша — mtime каталога версии, поэтому кэш ловит появление и
  // исчезновение файлов, но НЕ правку файла на месте: mtime каталога она не
  // двигает. Это осознанный размен — раздача идёт из каталога, который
  // мастер собрал сам одним rename, и правит его только сбой тома или
  // человек с shell на хосте
  _checkCached(distDir, gameId) {
    let mtimeMs;

    try {
      mtimeMs = fs.statSync(distDir).mtimeMs;
    } catch {
      mtimeMs = null;
    }

    const cached = this._checks.get(distDir);

    if (cached && mtimeMs !== null && cached.mtimeMs === mtimeMs) {
      return cached.check;
    }

    const check = checkGamePackage(distDir, { id: gameId });

    this._checks.set(distDir, { mtimeMs, check });

    return check;
  }

  /**
   * Скачать и проверить версию, НЕ делая её доступной. Для заявки и «Test».
   * @param {string} gameId - Идентификатор игры в каталоге.
   * @param {string} packageName - Имя npm-пакета игры.
   * @param {string} [version] - Точная версия либо 'latest'.
   * @returns {Promise<{ok: boolean, version: string|null, manifest: Object|null,
   *   compat: Object|null, errors: string[]}>} Вердикт.
   */
  async inspect(gameId, packageName, version) {
    const badRef = refError(gameId, version);

    if (badRef) {
      return { ok: false, version: null, manifest: null, compat: null, errors: [badRef] };
    }

    const staged = await this._stage(gameId, packageName, version);

    await remove(staged.stagingDir);

    return verdictOf(staged);
  }

  /**
   * Версии пакета, опубликованные в npm (индикатор «есть обновление» в
   * панели модерации, master-game-registry этап 4). Как ensure/inspect,
   * не бросает: недоступный реестр — пустой список, а не отказ роута.
   * @param {string} packageName - Имя npm-пакета игры.
   * @returns {Promise<string[]>} Версии в порядке возрастания.
   */
  async publishedVersions(packageName) {
    try {
      const packument = await fetchPackument(packageName, {
        registryUrl: this._registryUrl,
        fetchImpl: this._fetch,
        timeout: this._limits.timeout,
      });

      return packument ? listVersions(packument) : [];
    } catch {
      return [];
    }
  }

  /**
   * @param {string} gameId - Идентификатор игры.
   * @param {string} version - Версия пакета.
   * @returns {boolean} Лежит ли версия на диске.
   */
  has(gameId, version) {
    return fs.existsSync(path.join(this.distDir(gameId, version)));
  }

  /**
   * @param {string} gameId - Идентификатор игры.
   * @param {string} version - Версия пакета.
   * @returns {string} Путь к dist/ этой версии (существующей или нет).
   */
  distDir(gameId, version) {
    assertSegment(gameId, 'game id');
    assertSegment(version, 'version');

    return path.join(this._dir, gameId, version);
  }

  /**
   * @param {string} gameId - Идентификатор игры.
   * @returns {string[]} Версии игры, лежащие на диске.
   */
  listLocalVersions(gameId) {
    assertSegment(gameId, 'game id');

    return readDirNames(path.join(this._dir, gameId)).filter(
      name => name !== STAGING,
    );
  }

  /**
   * Удаляет всё, чего нет в keep.
   * @param {Map<string, Set<string>>} keep - gameId → версии, которые нужны.
   * @returns {Promise<string[]>} Удалённые пути.
   */
  async prune(keep) {
    const removed = [];

    for (const gameId of readDirNames(this._dir)) {
      const wanted = keep.get(gameId) ?? new Set();
      const gameDir = path.join(this._dir, gameId);

      for (const name of readDirNames(gameDir)) {
        if (name === STAGING) {
          removed.push(...(await this._pruneStaging(gameDir)));
          continue;
        }

        if (!wanted.has(name)) {
          await remove(path.join(gameDir, name));
          this._checks.delete(path.join(gameDir, name));
          removed.push(path.join(gameDir, name));
        }
      }

      // игры не осталось вовсе — убираем и её каталог
      if (wanted.size === 0 && readDirNames(gameDir).length === 0) {
        await remove(gameDir);
        removed.push(gameDir);
      }
    }

    return removed;
  }

  async _pruneStaging(gameDir) {
    const stagingDir = path.join(gameDir, STAGING);
    const removed = [];

    for (const name of readDirNames(stagingDir)) {
      const dir = path.join(stagingDir, name);
      let stat;

      try {
        stat = await fsp.stat(dir);
      } catch {
        continue;
      }

      if (Date.now() - stat.mtimeMs < STAGING_TTL) {
        continue;
      }

      await remove(dir);
      removed.push(dir);
    }

    return removed;
  }

  // скачивание, распаковка и проверка в <gameId>/.staging/<rand>. Каталог
  // остаётся на диске: вызывающий либо переносит его в раздачу, либо удаляет
  async _stage(gameId, packageName, version) {
    assertSegment(gameId, 'game id');

    const stagingDir = path.join(
      this._dir,
      gameId,
      STAGING,
      randomBytes(4).toString('hex'),
    );
    const { maxTarballBytes, maxFiles, timeout } = this._limits;

    try {
      const packument = await fetchPackument(packageName, {
        registryUrl: this._registryUrl,
        fetchImpl: this._fetch,
        timeout,
      });

      if (!packument) {
        return fail(stagingDir, null, `package "${packageName}" is not in the registry`);
      }

      const resolved = resolveVersion(packument, version);

      if (!resolved) {
        return fail(
          stagingDir,
          null,
          `package "${packageName}" has no version "${version ?? 'latest'}"`,
        );
      }

      // версия из пакумента станет ИМЕНЕМ КАТАЛОГА в distDir: ключ приходит
      // из недоверенного реестра, и проверить его надо здесь — под общим
      // try/catch и ДО скачивания, — иначе бросок уедет из ensure вопреки
      // её контракту «никогда не бросать»
      assertSegment(resolved.version, 'version');

      const tarball = await downloadTarball(resolved.tarball, {
        integrity: resolved.integrity,
        shasum: resolved.shasum,
        fetchImpl: this._fetch,
        maxBytes: maxTarballBytes,
        timeout,
      });

      await fsp.mkdir(stagingDir, { recursive: true });
      await extractDist(tarball, stagingDir, {
        maxBytes: maxTarballBytes,
        maxFiles,
      });

      const check = checkGamePackage(stagingDir, { id: gameId });

      return { ...check, version: resolved.version, stagingDir };
    } catch (err) {
      return fail(stagingDir, null, err.message);
    }
  }
}

// id и версия становятся ИМЕНАМИ КАТАЛОГОВ под this._dir: значение с
// разделителем или '..' увело бы path.join за пределы хранилища. Проверка
// стоит в самом хранилище, а не только в роуте, потому что держаться она
// обязана независимо от того, кто и откуда позвал
function assertSegment(value, what) {
  if (!isSegment(value)) {
    throw new Error(`GameStore: invalid ${what} "${value}"`);
  }
}

function isSegment(value) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    // path.basename('..') === '..': сами по себе '.' и '..' разделителя не
    // содержат, но каталогом версии быть не могут
    value !== '.' &&
    value !== '..' &&
    value === path.basename(value)
  );
}

// ensure/inspect не бросают по контракту, поэтому кривую ссылку они обязаны
// вернуть вердиктом, а не исключением: assertSegment ниже по стеку — это
// страховка на случай прямого вызова distDir/_stage, а не путь ответа
function refError(gameId, version) {
  if (!isSegment(gameId)) {
    return `invalid game id "${gameId}"`;
  }

  if (version !== undefined && version !== null && version !== 'latest' && !isSegment(version)) {
    return `invalid version "${version}"`;
  }

  return null;
}

function fail(stagingDir, version, message) {
  return {
    ok: false,
    version,
    manifest: null,
    compat: null,
    errors: [message],
    stagingDir,
  };
}

function verdictOf({ ok, version, manifest, compat, errors }) {
  return { ok, version, manifest, compat, errors };
}

function readDirNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

async function remove(dir) {
  if (!dir) {
    return;
  }

  await fsp.rm(dir, { recursive: true, force: true });
}
