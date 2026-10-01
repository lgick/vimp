import crypto from 'crypto';

// Секрет комнаты (host-migration, этап 2): доказательство «я хост этой эпохи
// этой комнаты». Не хранится, а вычисляется HMAC'ом от ключа мастера: после
// рестарта мастера реестр в памяти пуст, и reclaim_host должен отличить
// настоящего хоста от любого, кто видел roomId в адресной строке. Привязка к
// userId хоста (из проверенного токена) и к эпохе — секрет меняется сам со
// сменой хоста.

const message = ({ roomId, epoch, userId }) => `${roomId}:${epoch}:${userId}`;

/**
 * @param {string|Buffer} key - VIMP_ROOM_SECRET_KEY.
 * @param {{roomId: string, epoch: number, userId: number}} fields
 * @returns {string} base64url
 */
export function deriveRoomSecret(key, fields) {
  return crypto
    .createHmac('sha256', key)
    .update(message(fields))
    .digest('base64url');
}

/**
 * Сверяет предъявленный секрет за постоянное время.
 * @param {string|Buffer} key
 * @param {*} secret - Предъявленное значение (из сети, любой тип).
 * @param {{roomId: string, epoch: number, userId: number}} fields
 * @returns {boolean}
 */
export function verifyRoomSecret(key, secret, fields) {
  if (typeof secret !== 'string' || secret === '') {
    return false;
  }

  const expected = Buffer.from(deriveRoomSecret(key, fields));
  const actual = Buffer.from(secret);

  // timingSafeEqual требует равной длины; длина секрета публична (HMAC-SHA256
  // в base64url всегда 43 символа), её сравнение ничего не выдаёт
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}
