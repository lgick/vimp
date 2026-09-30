import {
  CODE,
  DETAILS_BYTES,
  MESSAGE,
  PAGE,
  SESSION_ID,
  STACK,
  USER_AGENT,
} from './limits.js';

// Разбор тела POST /client-reports от браузера (контракт — plan/client-reports/
// stage_2.md). Всё, чего нет в схеме, не проходит — в том числе клиентское
// engineVersion: версию штампует бокс (решение 5 плана)

const MODES = ['lobby', 'dedicated', 'solo'];
const ROLES = ['client', 'host'];
const KINDS = ['error', 'rejection', 'worker', 'warn', 'csp'];
// без 'box': служебные записи порождает только сам бокс
const SOURCES = ['client', 'host-worker', 'plugin'];

const SESSION_ID_RE = /^[0-9a-f-]{8,64}$/i;
// как idPattern auth-сервиса
const GAME_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const GAME_VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;
const CODE_RE = /^[a-z0-9][a-z0-9._-]*$/i;

const MAX_COUNT = 10000;
// отчёт копится во вкладке минуты, а не сутки; часы клиента могут спешить
const PAST_WINDOW_MS = 24 * 60 * 60 * 1000;
const FUTURE_WINDOW_MS = 5 * 60 * 1000;

const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const cut = (value, max) =>
  typeof value === 'string' ? value.slice(0, max) : null;

const pick = (value, allowed) => (allowed.includes(value) ? value : null);

const match = (value, re) =>
  typeof value === 'string' && re.test(value) ? value : null;

function badRequest(message) {
  const err = new Error(message);

  err.status = 400;

  return err;
}

function sanitizeDetails(details) {
  if (!isPlainObject(details)) {
    return null;
  }

  let json;

  try {
    json = JSON.stringify(details);
  } catch {
    return { truncated: true };
  }

  return Buffer.byteLength(json) <= DETAILS_BYTES
    ? details
    : { truncated: true };
}

function sanitizeCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }

  return Math.min(Math.max(Math.trunc(value), 1), MAX_COUNT);
}

const sanitizeTime = (value, now) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= now - PAST_WINDOW_MS &&
  value <= now + FUTURE_WINDOW_MS
    ? value
    : now;

function sanitizeContext(context) {
  const ctx = isPlainObject(context) ? context : {};

  return {
    mode: pick(ctx.mode, MODES),
    role: pick(ctx.role, ROLES),
    gameId: match(ctx.gameId, GAME_ID_RE),
    gameVersion: match(ctx.gameVersion, GAME_VERSION_RE),
    page: cut(ctx.page, PAGE),
    userAgent: cut(ctx.userAgent, USER_AGENT),
  };
}

// item с неизвестным kind/source или пустым сообщением отбрасывается
function sanitizeItem(raw, now) {
  if (!isPlainObject(raw)) {
    return null;
  }

  const kind = pick(raw.kind, KINDS);
  const source = pick(raw.source, SOURCES);
  const message = cut(raw.message, MESSAGE);

  if (!kind || !source || !message) {
    return null;
  }

  const code =
    typeof raw.code === 'string' &&
    raw.code.length <= CODE &&
    CODE_RE.test(raw.code)
      ? raw.code
      : null;

  return {
    kind,
    source,
    code,
    message,
    stack: cut(raw.stack, STACK),
    details: sanitizeDetails(raw.details),
    count: sanitizeCount(raw.count),
    firstAt: sanitizeTime(raw.firstAt, now),
    lastAt: sanitizeTime(raw.lastAt, now),
  };
}

/**
 * @param {*} body - Разобранное тело запроса.
 * @param {Object} options
 * @param {number} options.maxItemsPerRequest - Потолок items в одном запросе.
 * @param {number} [options.now] - Текущее время (для тестов).
 * @returns {{ sessionId: ?string, context: Object, items: Object[] }}
 * @throws {Error} status = 400 на неверной форме тела.
 */
export function sanitizeClientReport(
  body,
  { maxItemsPerRequest, now = Date.now() },
) {
  if (!isPlainObject(body) || body.v !== 1) {
    throw badRequest('unsupported report');
  }

  const rawItems = body.items;

  if (
    !Array.isArray(rawItems) ||
    rawItems.length < 1 ||
    rawItems.length > maxItemsPerRequest
  ) {
    throw badRequest('invalid items');
  }

  const items = rawItems.map(item => sanitizeItem(item, now)).filter(Boolean);

  if (items.length === 0) {
    throw badRequest('no valid items');
  }

  const sessionId =
    typeof body.sessionId === 'string' &&
    body.sessionId.length <= SESSION_ID &&
    SESSION_ID_RE.test(body.sessionId)
      ? body.sessionId
      : null;

  return { sessionId, context: sanitizeContext(body.context), items };
}
