import express from 'express';
import { clientIp, rateLimitKey } from '../../lib/clientIp.js';
import { computeFingerprint } from './fingerprint.js';
import { STACK_SYMBOLICATED } from './limits.js';
import { sanitizeClientReport } from './sanitize.js';

const LOG_PREFIX = '[vimp:client-report]';

// промисифицированный колбэк lib/security.js → createOriginValidator
const originAllowed = (checkOrigin, origin) =>
  new Promise(resolve => checkOrigin(origin, err => resolve(!err)));

/**
 * Приём POST /client-reports на боксе (plan/client-reports, этап 2): браузер
 * шлёт на свой же бокс, бокс проверяет, режет, считает отпечаток и копит в
 * буфере до пересылки в auth.
 * @returns {Function[]} middleware для app.post('/client-reports', ...route)
 */
export function createClientReportRoute({
  buffer,
  limiter,
  checkOrigin,
  trustProxy,
  box, // { domain, mode: 'lobby'|'dedicated', engineVersion }
  bodyLimit = '16kb',
  maxItemsPerRequest = 10,
  symbolicate = null, // этап 4: async (stack) => stack
  log = console,
}) {
  // лимит стоит ДО парсера тела: спам не стоит боксу разбора JSON
  const limit = (req, res, next) => {
    const key = rateLimitKey(clientIp(req, { trustProxy }));

    if (!key || !limiter.consume(key)) {
      res.status(429).json({ error: 'rateLimited' });
      return;
    }

    next();
  };

  const handle = async (req, res) => {
    try {
      const origin = req.get('origin');

      // нет заголовка — пропустить: same-origin запросы его могут не нести,
      // а злоупотребление всё равно режет лимит
      if (origin && !(await originAllowed(checkOrigin, origin))) {
        res.status(403).json({ error: 'forbiddenOrigin' });
        return;
      }

      let report;

      try {
        report = sanitizeClientReport(req.body, { maxItemsPerRequest });
      } catch (err) {
        if (err.status) {
          res.status(400).json({ error: 'badRequest' });
          return;
        }

        throw err;
      }

      const { context, items } = report;

      for (const item of items) {
        const fingerprint = computeFingerprint({
          ...item,
          engineVersion: box.engineVersion,
          gameId: context.gameId,
          gameVersion: context.gameVersion,
        });
        let stack = item.stack;

        // бюджет и расшифровка — только для совсем новых: повтор уже
        // принимавшегося отпечатка не должен жечь ни то, ни другое
        if (!buffer.isKnown(fingerprint)) {
          const reason = buffer.canAcceptNew();

          // без расшифровки — спам не жжёт CPU
          if (reason) {
            buffer.countDropped(reason);
            continue;
          }

          if (symbolicate && stack) {
            try {
              stack = String(await symbolicate(stack)).slice(0, STACK_SYMBOLICATED);
            } catch {
              stack = item.stack;
            }
          }
        }

        const { isNew } = buffer.add({
          fingerprint,
          source: item.source,
          kind: item.kind,
          code: item.code,
          message: item.message,
          stack,
          details: item.details,
          count: item.count,
          firstSeen: item.firstAt,
          lastSeen: item.lastAt,
          engineVersion: box.engineVersion,
          gameId: context.gameId,
          gameVersion: context.gameVersion,
          box: box.domain,
          mode: context.mode ?? box.mode,
          userAgent: context.userAgent,
        });

        if (isNew) {
          log.warn(
            `${LOG_PREFIX} new ${fingerprint.slice(0, 8)} ${item.kind}/${item.source} ` +
              `${item.code ?? item.message.slice(0, 120)} ` +
              `(${context.gameId}@${context.gameVersion}, engine ${box.engineVersion})`,
          );
        }
      }

      // 204 и когда часть записей отброшена бюджетом: спамеру это подсказка,
      // честному клиенту — бесполезно
      res.status(204).end();
    } catch (err) {
      log.error(`${LOG_PREFIX} route failed:`, err.message);
      res.status(500).json({ error: 'internal' });
    }
  };

  return [limit, express.json({ limit: bodyLimit }), handle];
}
