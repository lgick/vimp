import crypto from 'node:crypto';

// Отпечаток отчёта (решение 4 плана client-reports): ключ строки в журнале.
// Версии входят в ключ сознательно — регрессия в новой версии становится
// новой строкой, а исправленная старая остаётся `fixed`

const MESSAGE_KEY_MAX = 200;

// URL с `:line:col` в конце кадра: V8 — `at fn (URL:l:c)` / `at URL:l:c`,
// Firefox/Safari — `fn@URL:l:c`
const FRAME_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/i;

// строка стека — кадр: V8 `    at …`, Firefox/Safari `fn@scheme://…`.
// Первая строка V8 — сообщение, у Firefox/Safari её нет вовсе. Сообщение,
// оканчивающееся на `url:line:col`, кадром не считается — у него нет ни
// `at `, ни `@`. Одно правило для отпечатка и расшифровки стеков
const FRAME_LINE_RE = /^\s*at\s|@[a-z][a-z0-9+.-]*:\/\//i;

export function isFrameLine(line) {
  return FRAME_LINE_RE.test(String(line));
}

// сообщение без «шума» экземпляра: числа и длинные hex-идентификаторы.
// Сначала hex — иначе цифры внутри идентификатора уже стали бы N
export function normalizeMessage(message) {
  return String(message ?? '')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'H')
    .replace(/\d+/g, 'N')
    .trim()
    .slice(0, MESSAGE_KEY_MAX);
}

// один кадр стека → { fn, url, line, col } или null. fn — имя функции кадра
// (`at fn (…)` / `fn@…`) или null. Общий разбор отпечатка и расшифровки
// стеков (этап 4)
export function parseFrame(text) {
  const trimmed = String(text).trim();
  const found = FRAME_RE.exec(trimmed);

  if (!found) {
    return null;
  }

  const [, url, row, col] = found;
  const fn = trimmed
    .slice(0, found.index)
    .replace(/^at\s+/, '')
    .replace(/\s*\($/, '')
    .replace(/@$/, '')
    .trim();

  return { fn: fn || null, url, line: Number(row), col: Number(col) };
}

// первый кадр стека как `<pathname>:<line>:<col>` или null. От URL остаётся
// pathname: хост у бокса свой, а хешированное имя бандла стабильно в
// пределах сборки
export function rawTopFrame(stack) {
  if (typeof stack !== 'string') {
    return null;
  }

  for (const line of stack.split('\n')) {
    if (!isFrameLine(line)) {
      continue;
    }

    const frame = parseFrame(line);

    if (!frame) {
      continue;
    }

    let pathname;

    try {
      pathname = new URL(frame.url).pathname;
    } catch {
      pathname = frame.url;
    }

    return `${pathname}:${frame.line}:${frame.col}`;
  }

  return null;
}

/**
 * @param {Object} report
 * @param {*} [report.extra] - Дополнительный элемент ключа (служебной записи
 *   бокса — его домен, чтобы у каждого бокса была своя строка).
 * @returns {string} sha256-hex, 64 символа.
 */
export function computeFingerprint({
  source,
  kind,
  code,
  message,
  stack,
  engineVersion,
  gameId,
  gameVersion,
  extra = null,
}) {
  const key = [
    source,
    kind,
    code ?? normalizeMessage(message),
    rawTopFrame(stack),
    engineVersion ?? null,
    gameId ?? null,
    gameVersion ?? null,
  ];

  if (extra !== null) {
    key.push(extra);
  }

  return crypto.createHash('sha256').update(JSON.stringify(key)).digest('hex');
}
