import { createHash, timingSafeEqual } from 'node:crypto';

// Общий секрет «бокс → auth» (plan/client-reports, решение 3): боксы
// пересылают журнал клиентских ошибок с `Authorization: Bearer <token>`.

const sha256 = value => createHash('sha256').update(value).digest();

// сравнение через хэши одинаковой длины: timingSafeEqual требует равных
// длин, а сравнение длин само по себе утекло бы по времени
export function isValidServiceToken(authorizationHeader, expected) {
  if (!expected || typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith('Bearer ')) {
    return false;
  }

  return timingSafeEqual(sha256(authorizationHeader.slice(7)), sha256(expected));
}

// middleware: пустой expected → 503 { error: 'reportsDisabled' };
// неверный/отсутствующий Bearer → 401 { error: 'unauthorized' }; иначе next()
export function requireServiceToken(expected) {
  return (req, res, next) => {
    if (!expected) {
      res.status(503).json({ error: 'reportsDisabled' });
      return;
    }

    if (!isValidServiceToken(req.headers?.authorization, expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    next();
  };
}
