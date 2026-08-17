// продублировано из packages/engine/src/lib/clientIp.js (тот же паттерн, что
// и rateLimiter.js — auth-сервис не тянет рантайм-зависимость на движок).
//
// `X-Forwarded-For` ключом rate-limit'а быть не может: Nginx деплоя ставит его
// через `$proxy_add_x_forwarded_for` (.github/deployment/install-system.sh),
// то есть ДОПИСЫВАЕТ реальный адрес к присланному клиентом — первый элемент
// списка задаёт сам клиент, а значит и обходит лимит (свой заголовок на каждый
// запрос), и занимает чужой бакет (заголовок с адресом жертвы). `X-Real-IP`
// тот же Nginx перезаписывает значением `$remote_addr` — за прокси доверяем
// только ему, без прокси — адресу сокета.

/**
 * @param {Object} req - Express Request.
 * @param {Object} [options]
 * @param {boolean} [options.trustProxy] - Стоит ли перед сервисом обратный
 *   прокси, перезаписывающий `X-Real-IP` (в проде — Nginx деплоя).
 * @returns {string} Адрес клиента или '' (сокет уже разорван).
 */
export function clientIp(req, { trustProxy = false } = {}) {
  const header = trustProxy ? req.headers['x-real-ip'] : undefined;

  return String(header || req.socket?.remoteAddress || '').trim();
}
