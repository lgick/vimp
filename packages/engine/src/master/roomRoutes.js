// Роут прямой ссылки на комнату (host-migration, этап 3): GET /rooms/:roomId.
// Как и gameRoutes.js, модуль отдаёт голый обработчик, а URL расставляет
// lobby.js — тот поднимает сервер и из теста не импортируется.

import { clientIp } from '../lib/clientIp.js';
import { isValidRoomId } from '../lib/roomId.js';

/**
 * @param {Object} deps
 * @param {Object} deps.registry - RoomRegistry.
 * @param {Object} deps.limiter - RateLimiter поиска по id (на IP).
 * @param {boolean} [deps.trustProxy] - Мастер за Nginx (clientIp).
 * @returns {{lookup: Function}} Express-обработчики.
 */
export function createRoomRoutes({ registry, limiter, trustProxy = false }) {
  return {
    lookup(req, res) {
      const { roomId } = req.params;

      if (!isValidRoomId(roomId)) {
        res.status(400).json({ error: 'badRequest' });
        return;
      }

      // лимит после проверки формата: мусор не тратит чужой бакет, а
      // перебор валидных id упирается в него
      if (!limiter.consume(clientIp(req, { trustProxy }))) {
        res.status(429).json({ error: 'tooManyRequests' });
        return;
      }

      const room = registry.getPublic(roomId);

      if (!room) {
        res.status(404).json({ error: 'unknownRoom' });
        return;
      }

      res.json(room);
    },
  };
}
