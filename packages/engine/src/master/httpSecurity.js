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

export default securityHeaders;
