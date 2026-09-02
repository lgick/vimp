import { verifyIdentityToken } from '../lib/jwt.js';

// Авторизующая middleware мастера (master-game-registry, этап 4). До неё
// мастер проверял подпись identity-токена только на сигнальном пути
// (SignalingServer._verifyToken); REST-роуты просто перекладывали Bearer в
// auth. Админской панели этого мало: часть её работы мастер делает сам
// (списки, скачивание пакета из npm), не ходя в auth ни за чем.
//
// ***** ПОЧЕМУ ЗДЕСЬ ДОСТАТОЧНО КЛЕЙМА `role` ИЗ ТОКЕНА *****
//
// Всё, что мастер делает под этой проверкой сам, — читает списки и качает
// опубликованный пакет из npm registry: это не запись и не приносит вреда
// даже при роли, протухшей вместе с 4-часовым токеном. ЛЮБАЯ запись уходит
// в auth-сервис, где `requireAdmin` перечитывает роль из БД (этап 1, §1.5).
// Разделение намеренное: снятая роль перестаёт что-либо менять немедленно,
// а не по истечении токена.
export function createAdminAuth(jwksProxy, issuer) {
  const ADMIN_ROLES = ['admin', 'superadmin'];

  async function identify(req) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return null;
    }

    let payload;

    try {
      const jwks = await jwksProxy.get();

      payload = await verifyIdentityToken(token, { jwks, issuer });
    } catch {
      return null;
    }

    // сырой токен едет дальше вместе с личностью: роуты реестра проксируют
    // им же запрос в auth, где решение принимает роль из БД
    req.authToken = token;
    req.user = {
      id: Number(payload.sub),
      nick: payload.nick,
      role: payload.role ?? 'user',
    };

    return req.user;
  }

  // промис возвращается наружу (express его игнорирует) — так проверку
  // можно дождаться в тесте, не поднимая сервера
  return {
    // без валидного токена — 401, без админской роли — 403
    required: (req, res, next) =>
      identify(req)
        .then(user => {
          if (!user) {
            res.status(401).json({ error: 'unauthorized' });
            return;
          }

          if (!ADMIN_ROLES.includes(user.role)) {
            res.status(403).json({ error: 'forbidden' });
            return;
          }

          next();
        })
        .catch(next),

    // заполняет req.user, если токен валиден, и всегда пропускает дальше:
    // GET /servers отвечает всем, но админу — вместе со скрытыми комнатами
    optional: (req, res, next) =>
      identify(req)
        .then(() => next())
        .catch(next),

    // «просто авторизован»: заявку подаёт любой игрок, роль тут ни при чём
    authenticated: (req, res, next) =>
      identify(req)
        .then(user => {
          if (!user) {
            res.status(401).json({ error: 'unauthorized' });
            return;
          }

          next();
        })
        .catch(next),

    /**
     * @param {Object} user - req.user, заполненный identify.
     * @returns {boolean} Админская ли это роль.
     */
    isAdmin: user => ADMIN_ROLES.includes(user?.role),
  };
}
