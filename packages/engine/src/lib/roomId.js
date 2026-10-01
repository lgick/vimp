// Публичный id комнаты (host-migration, этап 2): короткий, стабильный за всю
// жизнь комнаты (переживает реконнект сигналинга хоста и смену хоста),
// виден в карточке лобби и в прямой ссылке. Модуль изоморфный: id выдаёт
// мастер, а клиентский роутер проверяет им ссылку до похода в сеть.

// crockford-base32 в нижнем регистре: без i, l, o, u — их путают с 1, 0 и v
// при наборе ссылки руками
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

// длина — константа модуля, не конфиг: её же проверяет роутер ссылок
export const ROOM_ID_LENGTH = 8;

const ROOM_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{8}$/;

/**
 * Генерирует roomId.
 * @param {Function} randomBytes - Источник случайных байт (мастер передаёт
 *   crypto.randomBytes): (n) => Uint8Array|Buffer длиной n.
 * @returns {string}
 */
export function generateRoomId(randomBytes) {
  const bytes = randomBytes(ROOM_ID_LENGTH);
  let id = '';

  // 256 делится на 32 нацело — остаток не смещает распределение
  for (let i = 0; i < ROOM_ID_LENGTH; i += 1) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }

  return id;
}

/**
 * @param {*} value
 * @returns {boolean} Является ли значение корректным roomId.
 */
export function isValidRoomId(value) {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}
