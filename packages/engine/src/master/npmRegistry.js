import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as tarExtract } from 'tar';

// Клиент npm registry для мастера (направление master-game-registry): по
// имени пакета и версии скачивает опубликованный тарболл игры, проверяет
// его целостность и распаковывает ТОЛЬКО package/dist/ на диск. Код игры
// здесь не импортируется и не исполняется — см. README направления.
//
// Модуль без состояния: конфиг не читается, всё приходит аргументами, а
// сеть инъектируется через `fetchImpl` — тем же приёмом, которым тестируют
// JwksProxy/PlayerDataProxy/HostRatingProxy без сети.
//
// Инвариант, унаследованный от scripts/release/registry.js: «пакета нет»
// (404 → null) обязано отличаться от «реестр не ответил» (throw). Иначе
// сетевой сбой читается вызывающим как «такой версии не существует».

// «тощий» пакумент: в разы меньше полного, а нужные поля
// (versions[v].dist.{tarball,integrity,shasum}, dist-tags.latest) в нём есть
const ABBREVIATED = 'application/vnd.npm.install-v1+json';

/**
 * Метаданные пакета из npm registry (packument).
 * @param {string} packageName - Имя пакета, в том числе scoped.
 * @param {Object} options - Реестр, сеть и таймаут.
 * @param {string} options.registryUrl - Базовый адрес реестра.
 * @param {Function} [options.fetchImpl] - Реализация fetch.
 * @param {number} [options.timeout] - Потолок ожидания ответа (мс).
 * @returns {Promise<Object|null>} Пакумент либо null, если пакета нет (404).
 * @throws {Error} Реестр недоступен или ответил не 200/404.
 */
export async function fetchPackument(
  packageName,
  { registryUrl, fetchImpl = fetch, timeout } = {},
) {
  // имя scoped-пакета кодируется целиком: без этого '@vimp-games/tanks'
  // уезжает в путь /@vimp-games/tanks и даёт 404. Кодируется КАЖДЫЙ сегмент,
  // а не только первый '/': нормализацию пути иначе делает уже fetch
  // ведущая '@' скоупа остаётся как есть — так адресует пакеты сам npm
  const url = `${registryUrl}/${String(packageName)
    .split('/')
    .map(encodeURIComponent)
    .join('%2F')
    .replace(/^%40/, '@')}`;
  let res;

  try {
    res = await fetchImpl(url, {
      headers: { accept: ABBREVIATED },
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    });
  } catch (err) {
    throw new Error(
      `npm registry не ответил (${packageName}): ${err.message}`,
    );
  }

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    throw new Error(
      `npm registry не ответил (${packageName}): HTTP ${res.status}`,
    );
  }

  try {
    return await res.json();
  } catch (err) {
    throw new Error(
      `npm registry не ответил (${packageName}): битый JSON — ${err.message}`,
    );
  }
}

/**
 * Резолв версии в запись дистрибутива.
 * @param {Object} packument - Пакумент из fetchPackument.
 * @param {string} [spec] - Точная версия, 'latest' либо ничего (= latest).
 * @returns {{version: string, tarball: string, integrity: string|null,
 *   shasum: string|null}|null} Запись версии либо null, если её нет.
 */
export function resolveVersion(packument, spec) {
  const versions = packument?.versions ?? {};
  const version =
    !spec || spec === 'latest' ? packument?.['dist-tags']?.latest : spec;

  if (!version || !versions[version]) {
    return null;
  }

  const dist = versions[version].dist ?? {};

  if (!dist.tarball) {
    return null;
  }

  return {
    version,
    tarball: dist.tarball,
    integrity: dist.integrity ?? null,
    shasum: dist.shasum ?? null,
  };
}

/**
 * Список опубликованных версий, новые в конце (индикатор «есть обновление»).
 * @param {Object} packument - Пакумент из fetchPackument.
 * @returns {string[]} Версии в порядке возрастания.
 */
export function listVersions(packument) {
  return Object.keys(packument?.versions ?? {}).sort(compareVersions);
}

/**
 * Скачивание тарболла с проверкой целостности.
 * @param {string} url - Адрес тарболла из записи версии.
 * @param {Object} options - Ожидаемые дайджесты, сеть и потолки.
 * @param {string|null} [options.integrity] - SRI вида 'sha512-<base64>'.
 * @param {string|null} [options.shasum] - sha1 hex (старые записи реестра).
 * @param {Function} [options.fetchImpl] - Реализация fetch.
 * @param {number} [options.maxBytes] - Потолок размера архива.
 * @param {number} [options.timeout] - Потолок ожидания ответа (мс).
 * @returns {Promise<Buffer>} Тело тарболла.
 * @throws {Error} Сетевой отказ, не-200, превышение maxBytes, несовпадение
 *   дайджеста.
 */
export async function downloadTarball(
  url,
  { integrity, shasum, fetchImpl = fetch, maxBytes, timeout } = {},
) {
  let res;

  try {
    res = await fetchImpl(url, {
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    });
  } catch (err) {
    throw new Error(`тарболл не скачался (${url}): ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`тарболл не скачался (${url}): HTTP ${res.status}`);
  }

  const buffer = await readBody(res, maxBytes, url);

  verifyDigest(buffer, { integrity, shasum });

  return buffer;
}

/**
 * Распаковка ТОЛЬКО package/dist/** в destDir. destDir должен существовать.
 * @param {Buffer} buffer - Тело тарболла.
 * @param {string} destDir - Каталог назначения (создаётся вызывающим).
 * @param {Object} [options] - Потолки распаковки.
 * @param {number} [options.maxBytes] - Суммарный размер распакованного.
 * @param {number} [options.maxFiles] - Число файлов.
 * @returns {Promise<{files: number, bytes: number, warnings: string[]}>}
 *   Итог распаковки.
 * @throws {Error} Превышение maxFiles/maxBytes, отказ tar.
 */
export async function extractDist(buffer, destDir, { maxBytes, maxFiles } = {}) {
  const warnings = [];
  let files = 0;
  let bytes = 0;
  // отказ фиксируется флагом, а не throw из filter: бросок изнутри разбора
  // потока уходит мимо pipeline. Дальше всё отбрасывается, ошибка вылетает
  // после завершения разбора — распаковка идёт в .staging и целиком удаляется
  let limitError = null;
  // поток рвётся сразу, а не дочитывается до конца: 64 МБ архива с высоким
  // коэффициентом сжатия — это десятки гигабайт разжатия впустую
  const source = Readable.from(buffer);

  const filter = (entryPath, entry) => {
    if (limitError) {
      return false;
    }

    // за пределами package/dist/ в раздаче делать нечего: src/, README,
    // package.json пакета и прочее содержимое тарболла отбрасывается
    if (!entryPath.startsWith('package/dist/')) {
      return false;
    }

    // симлинки, хардлинки, устройства: их разбор — это доверие к путям
    // внутри недоверенного архива
    if (entry.type !== 'File' && entry.type !== 'Directory') {
      warnings.push(`отброшена запись ${entry.type}: ${entryPath}`);

      return false;
    }

    if (entry.type === 'Directory') {
      return true;
    }

    files += 1;
    bytes += entry.size ?? 0;

    if (maxFiles && files > maxFiles) {
      limitError = `в архиве больше ${maxFiles} файлов`;
      source.destroy();

      return false;
    }

    if (maxBytes && bytes > maxBytes) {
      limitError = `распакованное содержимое больше ${maxBytes} байт`;
      source.destroy();

      return false;
    }

    return true;
  };

  try {
    await pipeline(
      source,
      tarExtract({
        cwd: destDir,
        strip: 2, // срезает 'package/dist'
        filter,
        preservePaths: false, // не доверять абсолютным путям внутри архива
        onwarn: (code, message) => warnings.push(`${code}: ${message}`),
      }),
    );
  } catch (err) {
    // разорванный по лимиту поток отклоняет pipeline (ERR_STREAM_PREMATURE_
    // CLOSE) — снаружи это обязано читаться как превышение лимита, а не как
    // сбой потока
    if (!limitError) {
      throw err;
    }
  }

  if (limitError) {
    throw new Error(`архив не распакован: ${limitError}`);
  }

  return { files, bytes, warnings };
}

// тело ответа читается ПО ХОДУ: недоверенный сервер не должен уметь
// заставить мастер выделить гигабайт до первой проверки размера
async function readBody(res, maxBytes, url) {
  if (!res.body || typeof res.body[Symbol.asyncIterator] !== 'function') {
    const whole = Buffer.from(await res.arrayBuffer());

    if (maxBytes && whole.length > maxBytes) {
      throw new Error(`тарболл больше ${maxBytes} байт (${url})`);
    }

    return whole;
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk);

    size += buf.length;

    if (maxBytes && size > maxBytes) {
      throw new Error(`тарболл больше ${maxBytes} байт (${url})`);
    }

    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

// integrity (sha512, base64) — основной путь; shasum (sha1 hex) остаётся
// запасным для старых записей реестра, где integrity ещё не публиковали
function verifyDigest(buffer, { integrity, shasum }) {
  if (integrity) {
    const [algorithm, expected] = splitIntegrity(integrity);
    const actual = createHash(algorithm).update(buffer).digest('base64');

    if (actual !== expected) {
      throw new Error(
        `целостность тарболла не сошлась: ожидался ${algorithm}-${expected}, ` +
          `получен ${algorithm}-${actual}`,
      );
    }

    return;
  }

  if (shasum) {
    const actual = createHash('sha1').update(buffer).digest('hex');

    if (actual !== shasum) {
      throw new Error(
        `целостность тарболла не сошлась: ожидался shasum ${shasum}, ` +
          `получен ${actual}`,
      );
    }

    return;
  }

  throw new Error('реестр не отдал ни integrity, ни shasum — проверить нечем');
}

function splitIntegrity(integrity) {
  // SRI бывает списком через пробел — берём первую запись
  const first = String(integrity).trim().split(/\s+/)[0];
  const dash = first.indexOf('-');

  if (dash === -1) {
    throw new Error(`битое поле integrity: "${integrity}"`);
  }

  const algorithm = first.slice(0, dash);

  if (!['sha512', 'sha384', 'sha256', 'sha1'].includes(algorithm)) {
    throw new Error(`неизвестный алгоритм integrity: "${algorithm}"`);
  }

  return [algorithm, first.slice(dash + 1)];
}

// semver-порядок без зависимости: числовые части по значению, пререлиз
// (любой суффикс после '-') младше релиза той же тройки
function compareVersions(a, b) {
  const parse = value => {
    // build-метаданные (+…) в сравнении не участвуют вовсе (semver §10),
    // пререлиз отделяется по ПЕРВОМУ дефису и дальше сравнивается целиком:
    // split('-', 2) терял хвост, и '1.0.0-alpha-1' равнялся '1.0.0-alpha-2'
    const withoutBuild = String(value).split('+', 1)[0];
    const dash = withoutBuild.indexOf('-');
    const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
    const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1);

    return { nums: core.split('.').map(n => Number(n) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] || 0) - (right.nums[i] || 0);

    if (diff !== 0) {
      return diff;
    }
  }

  if (left.pre === right.pre) {
    return 0;
  }

  if (!left.pre) {
    return 1;
  }

  if (!right.pre) {
    return -1;
  }

  return left.pre < right.pre ? -1 : 1;
}
