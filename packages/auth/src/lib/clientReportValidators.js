import { isValidGameId } from './validators.js';

// Нормализация записи журнала клиентских ошибок (plan/client-reports), как
// её прислал бокс. Чистые функции: пределы приходят аргументом
// (config.clientReports.limits), конфиг не импортируется.

// 'box' — служебные записи самого бокса (reports.dropped, этап 2)
export const REPORT_SOURCES = ['client', 'host-worker', 'plugin', 'box'];
// 'csp' — нарушение Content-Security-Policy на странице (этап 3)
export const REPORT_KINDS = ['error', 'rejection', 'worker', 'warn', 'csp'];
export const REPORT_STATUSES = ['open', 'fixed', 'ignored'];
export const REPORT_MODES = ['lobby', 'dedicated', 'solo'];

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const CODE_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const VERSION_RE = /^[0-9A-Za-z.+-]+$/;
const BOX_RE = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i;

const MAX_COUNT = 1_000_000;
// окно правдоподобных дат: бокс копит отчёты минуты, а не сутки, и часы
// бокса могут немного убегать вперёд
const PAST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_WINDOW_MS = 5 * 60 * 1000;

const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const cut = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

function normalizeDetails(details, maxBytes) {
  if (!isPlainObject(details)) {
    return null;
  }

  let json;

  try {
    json = JSON.stringify(details);
  } catch {
    return { truncated: true };
  }

  return Buffer.byteLength(json) <= maxBytes ? details : { truncated: true };
}

function normalizeCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }

  return Math.min(Math.max(Math.trunc(value), 1), MAX_COUNT);
}

// epoch ms или ISO-строка; вне окна или мусор — now
function normalizeTime(value, now) {
  let ms = NaN;

  if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string') {
    ms = Date.parse(value);
  }

  return Number.isFinite(ms) && ms >= now - PAST_WINDOW_MS && ms <= now + FUTURE_WINDOW_MS ? ms : now;
}

const normalizeVersion = (value, max) =>
  typeof value === 'string' && value.length <= max && VERSION_RE.test(value) ? value : null;

/**
 * Одна запись пачки бокса → чистый объект для репозитория или null.
 * Всё, чего нет в правилах, отбрасывается.
 * @param {Object} raw - Запись из тела POST /client-reports.
 * @param {Object} options
 * @param {Object} options.limits - config.clientReports.limits.
 * @param {Object} options.gameIdRules - config.games (idPattern, reservedIds).
 * @param {number} [options.now] - Текущее время (для тестов).
 * @returns {Object|null}
 */
export function normalizeReportItem(raw, { limits, gameIdRules, now = Date.now() }) {
  if (!isPlainObject(raw)) {
    return null;
  }

  const { fingerprint, source, kind, message } = raw;

  if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) {
    return null;
  }

  if (!REPORT_SOURCES.includes(source) || !REPORT_KINDS.includes(kind)) {
    return null;
  }

  if (typeof message !== 'string' || message.length === 0) {
    return null;
  }

  let firstSeen = normalizeTime(raw.firstSeen, now);
  let lastSeen = normalizeTime(raw.lastSeen, now);

  if (firstSeen > lastSeen) {
    [firstSeen, lastSeen] = [lastSeen, firstSeen];
  }

  const code = raw.code;
  const gameId = raw.gameId;
  const box = raw.box;

  return {
    fingerprint,
    source,
    kind,
    message: message.slice(0, limits.message),
    code: typeof code === 'string' && code.length <= limits.code && CODE_RE.test(code) ? code : null,
    stack: cut(raw.stack, limits.stack),
    details: normalizeDetails(raw.details, limits.details),
    count: normalizeCount(raw.count),
    firstSeen: new Date(firstSeen),
    lastSeen: new Date(lastSeen),
    engineVersion: normalizeVersion(raw.engineVersion, limits.version),
    gameVersion: normalizeVersion(raw.gameVersion, limits.version),
    gameId: isValidGameId(gameId, gameIdRules) ? gameId : null,
    box: typeof box === 'string' && BOX_RE.test(box) ? box : null,
    mode: REPORT_MODES.includes(raw.mode) ? raw.mode : null,
    userAgent: cut(raw.userAgent, limits.userAgent),
  };
}
