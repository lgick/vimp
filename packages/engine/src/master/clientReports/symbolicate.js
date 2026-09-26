import fs from 'node:fs/promises';
import path from 'node:path';
import { SourceMapConsumer } from 'source-map-js';
import { parseFrame } from './fingerprint.js';
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
 * @returns {(stack: string) => Promise<string>}
 */
export function createSymbolicator({
  resolveFile,
  roots,
  maxFrames = 12,
  cacheSize = 20,
  maxMapBytes = 20 * 1024 * 1024,
}) {
  const rootPrefixes = roots.filter(Boolean).map(root => path.resolve(root) + path.sep);
  // mapPath → SourceMapConsumer; порядок вставки Map и есть порядок LRU
  const cache = new Map();

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

    const stat = await fs.stat(mapPath);

    if (!stat.isFile() || stat.size > maxMapBytes) {
      return null;
    }

    const consumer = new SourceMapConsumer(JSON.parse(await fs.readFile(mapPath, 'utf8')));

    cache.set(mapPath, consumer);

    if (cache.size > cacheSize) {
      cache.delete(cache.keys().next().value);
    }

    return consumer;
  };

  const symbolicateFrame = async text => {
    const frame = parseFrame(text);

    if (!frame) {
      return text;
    }

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

    const pos = consumer.originalPositionFor({ line: frame.line, column: frame.col - 1 });

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
    const [head, ...frames] = String(stack).split('\n');
    const out = [head];

    for (let i = 0; i < frames.length; i += 1) {
      if (i >= maxFrames) {
        out.push(frames[i]);
        continue;
      }

      try {
        out.push(await symbolicateFrame(frames[i]));
      } catch {
        // одна битая карта не ломает весь стек
        out.push(frames[i]);
      }
    }

    return out.join('\n').slice(0, STACK_SYMBOLICATED);
  };
}

export default createSymbolicator;
