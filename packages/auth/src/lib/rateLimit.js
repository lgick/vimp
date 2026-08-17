import { clientIp } from './clientIp.js';

// Express-middleware лимита по адресу клиента (F12: перебор/сквоттинг ников,
// старт OAuth). Живёт отдельным модулем, а не внутри main.js: тот при импорте
// поднимает сервер и тянет пул БД, то есть проверить контракт лимита в нём
// нечем.
//
// Ключ даёт clientIp, а не req.ip/`trust proxy` Express: без app.set('trust
// proxy') req.ip за Nginx равен адресу самого Nginx, и лимит стал бы одним
// общим на всех клиентов сразу. Заголовок берётся только за прокси и только
// X-Real-IP — X-Forwarded-For тот же Nginx дописывает к клиентскому, то есть
// его первый адрес пишет сам клиент (см. lib/clientIp.js).

/**
 * @param {Object} limiter - RateLimiter (lib/rateLimiter.js).
 * @param {Object} [options]
 * @param {boolean} [options.trustProxy] - Стоит ли перед сервисом обратный
 *   прокси, перезаписывающий `X-Real-IP` (в проде — Nginx деплоя).
 * @returns {Function} Middleware `(req, res, next)`.
 */
export default function rateLimit(limiter, { trustProxy = false } = {}) {
  return (req, res, next) => {
    const ip = clientIp(req, { trustProxy });

    // адреса нет только у уже разорванного сокета: общий бакет '' раздал бы
    // всем таким запросам один лимит на всех (мастер и dedicated такое
    // соединение обрывают, здесь отвечать уже некому — просто не пускаем)
    if (!ip || !limiter.consume(ip)) {
      res.status(429).json({ error: 'rateLimited' });
      return;
    }

    next();
  };
}
