import RateLimiter from '../../lib/rateLimiter.js';
import ClientReportBuffer from './ClientReportBuffer.js';
import ClientReportForwarder from './ClientReportForwarder.js';
import { createClientReportRoute } from './createClientReportRoute.js';
import { computeFingerprint } from './fingerprint.js';

// Сборка журнала клиентских ошибок (plan/client-reports, этап 2) для входов
// бокса — лобби (master/lobby.js) и dedicated (dedicated/main.js), чтобы
// не дублировать код в обоих

const LOG_PREFIX = '[vimp:client-report]';
const DROPPED_CODE = 'reports.dropped';

/**
 * Служебная запись об отброшенных бюджетом/переполнением новых отпечатках.
 * Одна строка в журнале на бокс и версию движка: её count копит общее число
 * отброшенного.
 * @param {{ budget: number, bufferFull: number }} dropped
 * @param {Object} options
 * @param {Object} options.box - { domain, mode, engineVersion }.
 * @param {number} options.windowMs - Период тика пересылки.
 * @returns {Object|null} Запись для auth или null, если отброшенного нет.
 */
export function makeDroppedEntry(
  { budget, bufferFull },
  { box, windowMs, log = console, now = Date.now() },
) {
  const total = budget + bufferFull;

  if (total === 0) {
    return null;
  }

  const message = `dropped ${total} new client reports`;

  // строка в журнал независимо от того, включена ли пересылка
  log.warn(
    `${LOG_PREFIX} dropped ${total} new reports (budget: ${budget}, bufferFull: ${bufferFull})`,
  );

  return {
    fingerprint: computeFingerprint({
      source: 'box',
      kind: 'warn',
      code: DROPPED_CODE,
      message,
      stack: null,
      engineVersion: box.engineVersion,
      gameId: null,
      gameVersion: null,
      extra: box.domain,
    }),
    source: 'box',
    kind: 'warn',
    code: DROPPED_CODE,
    message,
    stack: null,
    details: { budget, bufferFull, windowMs },
    count: total,
    firstSeen: now,
    lastSeen: now,
    engineVersion: box.engineVersion,
    gameId: null,
    gameVersion: null,
    box: box.domain,
    mode: box.mode,
    role: null,
    page: null,
    userAgent: null,
  };
}

/**
 * @param {Object} options
 * @param {Object} options.config - Синглтон lib/config.js.
 * @param {Object} options.box - { domain, mode: 'lobby'|'dedicated', engineVersion }.
 * @param {boolean} options.trustProxy - За Nginx ли процесс (X-Real-IP).
 * @param {Function} options.checkOrigin - security.createOriginValidator(...).
 * @param {Function} [options.symbolicate] - Этап 4: async (stack) => stack.
 * @param {Function} [options.fetchImpl] - fetch (инъекция тестов).
 * @param {Object} [options.log] - Журнал процесса (по умолчанию console).
 * @returns {{ route: Function[], forwarder: ClientReportForwarder }} route —
 *   массив middleware, forwarder.start() зовёт вход.
 */
export function createClientReports({
  config,
  box,
  trustProxy,
  checkOrigin,
  symbolicate = null,
  fetchImpl = fetch,
  log = console,
}) {
  const cfg = config.get('master:clientReports');

  const buffer = new ClientReportBuffer({
    maxPending: cfg.maxPending,
    logSeenMax: cfg.logSeenMax,
    newPerMinute: cfg.newFingerprintsPerMinute,
  });

  const limiter = new RateLimiter(cfg.rateLimit);

  const forwarder = new ClientReportForwarder({
    buffer,
    authServiceUrl: config.get('master:security:authServiceUrl'),
    token: cfg.token,
    fetchImpl,
    intervalMs: cfg.flushIntervalMs,
    batchSize: cfg.forwardBatch,
    timeoutMs: cfg.forwardTimeoutMs,
    log,
    extraEntries: () =>
      [
        makeDroppedEntry(buffer.drainDropped(), {
          box,
          windowMs: cfg.flushIntervalMs,
          log,
        }),
      ].filter(Boolean),
  });

  // уборка бакетов лимитера тем же темпом, что и его окно
  const sweep = setInterval(() => limiter.sweep(), cfg.rateLimit.windowMs);

  sweep.unref?.();

  if (!forwarder.enabled) {
    log.warn(
      `${LOG_PREFIX} forwarding disabled (no VIMP_CLIENT_REPORTS_TOKEN) — logging only`,
    );
  }

  const route = createClientReportRoute({
    buffer,
    limiter,
    checkOrigin,
    trustProxy,
    box,
    bodyLimit: cfg.bodyLimit,
    maxItemsPerRequest: cfg.maxItemsPerRequest,
    symbolicate,
    log,
  });

  return { route, forwarder, buffer };
}

/**
 * Последний flush журнала при остановке бокса — с потолком: недоступный
 * auth не должен подвешивать остановку.
 * @param {Object} forwarder - ClientReportForwarder.
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=3000]
 * @param {Object} [options.log=console]
 * @returns {Promise<void>} Никогда не отклоняется.
 */
export async function stopClientReports(forwarder, { timeoutMs = 3000, log = console } = {}) {
  let timer;

  try {
    await Promise.race([
      forwarder.stop(),
      new Promise(resolve => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch (err) {
    log.error(`${LOG_PREFIX} final flush failed:`, err.message);
  } finally {
    clearTimeout(timer);
  }
}
