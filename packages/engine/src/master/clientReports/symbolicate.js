import fs from 'node:fs/promises';
import path from 'node:path';
import { SourceMapConsumer } from 'source-map-js';
import { isFrameLine, parseFrame } from './fingerprint.js';
import { STACK_SYMBOLICATED } from './limits.js';

// Расшифровка стеков журнала клиентских ошибок (plan/client-reports, этап 4):
// бокс читает скрытые source maps ровно тех сборок, что сам раздаёт, и
// переводит минифицированные кадры в исходные. Зовётся только для нового
// отпечатка — не для каждого отчёта

const SOURCE_TAIL_RE = /(?:^|\/)((?:src|node_modules)\/.*)$/;

// путь исходника из карты без префиксов сборщика: `webpack://`, `vite://`,
// ведущие `../` и `./`; от путей внутри src/ или node_modules/ — хвост с них
export function normalizeSource(source) {
  const cleaned = String(source)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/\/?/i, '')
    .replace(/^(?:\.\.?\/)+/, '');
  const tail = SOURCE_TAIL_RE.exec(cleaned);

  return tail ? tail[1] : cleaned;
}

/**
 * @param {Object} opts
 * @param {(pathname: string) => string|null} opts.resolveFile - URL-путь бандла → абсолютный файл
 * @param {string[]} opts.roots - корни, за которые файл выходить не вправе
 * @param {number} [opts.maxFrames=12]
 * @param {number} [opts.cacheSize=20] - сколько разобранных карт держать (LRU)
 * @param {number} [opts.maxMapBytes=20 * 1024 * 1024]
 * @param {number} [opts.maxColdLoadsPerMinute=20] - сколько карт в минуту
 *   читать с диска; сверх — кадр остаётся сырым
 * @param {number} [opts.maxMissing=1000] - сколько отсутствующих/негодных карт
 *   помнить; при переполнении множество чистится целиком
 * @param {() => number} [opts.now=Date.now]
 * @returns {(stack: string) => Promise<string>}
 */
export function createSymbolicator({
  resolveFile,
  roots,
  maxFrames = 12,
  cacheSize = 20,
  maxMapBytes = 20 * 1024 * 1024,
  maxColdLoadsPerMinute = 20,
  maxMissing = 1000,
  now = Date.now,
}) {
  const rootPrefixes = roots
    .filter(Boolean)
    .map(root => path.resolve(root) + path.sep);
  // mapPath → SourceMapConsumer: только настоящие карты. Порядок вставки
  // Map и есть порядок LRU
  const cache = new Map();
  // mapPath → Promise<SourceMapConsumer|null>: одновременные загрузки одной
  // карты читают её с диска один раз
  const inflight = new Map();
  // карты, которых нет или которые не годятся (не файл, больше maxMapBytes),
  // — отдельно от LRU: поток выдуманных путей бандлов иначе вытеснял бы из
  // него настоящие карты. При переполнении чистится целиком — как
  // `_logged` в ClientReportBuffer
  const missing = new Set();
  let coldMinute = null;
  let coldLoads = 0;

  // Разбор карты — синхронные десятки мс в event loop бокса (у dedicated
  // там же идёт матч), а корни лобби держат все версии всех игр: без
  // бюджета стеки с разными картами гоняли бы LRU по кругу. Списывается
  // только перед чтением существующей карты
  const takeColdLoad = () => {
    const minute = Math.floor(now() / 60000);

    if (minute !== coldMinute) {
      coldMinute = minute;
      coldLoads = 0;
    }

    if (coldLoads >= maxColdLoadsPerMinute) {
      return false;
    }

    coldLoads += 1;

    return true;
  };

  const rememberMissing = mapPath => {
    if (missing.size >= maxMissing) {
      missing.clear();
    }

    missing.add(mapPath);
  };

  // null — карты нет, она не годится или кончился бюджет минуты; прочие
  // сбои — исключение. Бюджет тратит только настоящее чтение с разбором:
  // stat дёшев, а выдуманные пути бандлов не должны выжигать бюджет
  const readMap = async mapPath => {
    let stat;

    try {
      stat = await fs.stat(mapPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        rememberMissing(mapPath);
        return null;
      }

      throw err;
    }

    if (!stat.isFile() || stat.size > maxMapBytes) {
      rememberMissing(mapPath);
      return null;
    }

    if (!takeColdLoad()) {
      return null;
    }

    return new SourceMapConsumer(
      JSON.parse(await fs.readFile(mapPath, 'utf8')),
    );
  };

  // карта бандла или null, если файл не вправе читаться / карты нет
  const loadMap = async pathname => {
    const file = resolveFile(pathname);

    if (!file) {
      return null;
    }

    const resolved = path.resolve(file);

    // обход через `..` или чужое расширение — не читать с диска вовсе
    if (!rootPrefixes.some(prefix => resolved.startsWith(prefix))) {
      return null;
    }

    if (!/\.m?js$/.test(resolved)) {
      return null;
    }

    const mapPath = `${resolved}.map`;
    const cached = cache.get(mapPath);

    if (cached) {
      cache.delete(mapPath);
      cache.set(mapPath, cached);

      return cached;
    }

    if (missing.has(mapPath)) {
      return null;
    }

    let pending = inflight.get(mapPath);

    if (!pending) {
      pending = readMap(mapPath).finally(() => inflight.delete(mapPath));
      inflight.set(mapPath, pending);
    }

    const consumer = await pending;

    // в LRU попадают только настоящие карты: пустой ответ ничего не
    // вытесняет. Карты нет — её помнит `missing`; кончился бюджет —
    // прочитается в следующую минуту. Сбой чтения (EIO, битый JSON)
    // исключением уходит к вызывающему и тоже не кешируется
    if (consumer && !cache.has(mapPath)) {
      cache.set(mapPath, consumer);

      if (cache.size > cacheSize) {
        cache.delete(cache.keys().next().value);
      }
    }

    return consumer;
  };

  const symbolicateFrame = async (text, frame) => {
    let url;

    try {
      url = new URL(frame.url);
    } catch {
      return text;
    }

    // blob: Worker-а и прочее не своё — на диске бокса этого нет
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return text;
    }

    const consumer = await loadMap(url.pathname);

    if (!consumer) {
      return text;
    }

    const pos = consumer.originalPositionFor({
      line: frame.line,
      column: frame.col - 1,
    });

    if (!pos.source) {
      return text;
    }

    // сырое место в скобках — на случай, если карта не от этой сборки
    return (
      `    at ${pos.name ?? frame.fn ?? '<anonymous>'} ` +
      `(${normalizeSource(pos.source)}:${pos.line}:${pos.column + 1}) ` +
      `[${url.pathname}:${frame.line}:${frame.col}]`
    );
  };

  return async stack => {
    const out = [];
    let decoded = 0;

    for (const line of String(stack).split('\n')) {
      const frame =
        decoded < maxFrames && isFrameLine(line) ? parseFrame(line) : null;

      if (!frame) {
        out.push(line);
        continue;
      }

      decoded += 1;

      try {
        out.push(await symbolicateFrame(line, frame));
      } catch {
        // одна битая карта не ломает весь стек
        out.push(line);
      }
    }

    return out.join('\n').slice(0, STACK_SYMBOLICATED);
  };
}

export default createSymbolicator;
