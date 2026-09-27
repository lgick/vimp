import config from '../lib/config.js';

// Базовые security-заголовки серверных ответов (гигиена среды, Этап 5.4),
// вынесены из master/main.js: их ставят обе точки входа — и лобби-мастер, и
// dedicated-сервер (Этап 4 плана standalone-sdk). Копия политики в двух
// файлах разъехалась бы ровно так же, как разъезжались бы копии порт-машины.

/**
 * @param {Object} [options]
 * @param {boolean} [options.isProduction] - Ставить ли CSP: в dev она сломала
 *   бы Vite HMR, прод-статику/.wasm с CSP отдаёт Nginx, здесь — для
 *   API-ответов и как исполняемая документация политики.
 * @returns {Function} express-middleware.
 */
export function securityHeaders({ isProduction = false } = {}) {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', config.get('master:security:referrerPolicy'));
    res.setHeader('X-Frame-Options', 'DENY');

    if (isProduction) {
      const csp = config.get('master:security:csp')(
        config.get('master:security:authServiceUrl'),
      );

      res.setHeader('Content-Security-Policy', csp);
    }

    next();
  };
}

// Скрытые source maps лежат рядом с бандлами (plan/client-reports): их
// читает сам бокс, а снаружи они — исходники сборки по запросу любого.
// Только прод: в dev карты раздаёт Vite, и они нужны DevTools.
//
// Проверяется РАСКОДИРОВАННЫЙ путь и без учёта регистра: express.static
// (send) раскодирует pathname сам, и `/a.js.%6dap` или `/a.js%2Emap` иначе
// прошли бы мимо проверки и отдали карту
const SOURCE_MAP_RE = /\.map$/i;

export function denySourceMaps({ isProduction = false } = {}) {
  return (req, res, next) => {
    if (!isProduction) {
      next();
      return;
    }

    let pathname;

    try {
      pathname = decodeURIComponent(req.path);
    } catch {
      // битую процентную последовательность дальше отвергнет сам send (400)
      next();
      return;
    }

    if (SOURCE_MAP_RE.test(pathname)) {
      res.status(404).json({ error: 'notFound' });
      return;
    }

    next();
  };
}

export default securityHeaders;
