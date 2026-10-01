// Секрет возобновления сессии участника (host-migration этап 4): хост выдаёт
// его после входа в матч (SESSION_DATA), клиент предъявляет в RESUME_REQUEST
// после обрыва транспорта. Изоморфен — крутится и в Worker'е, и в Node.

// 128 бит — угадать ключ чужого места в разумное время нельзя
const KEY_BYTES = 16;

/**
 * @returns {string} Случайный ключ (32 hex-символа).
 */
export function createResumeKey() {
  const bytes = new Uint8Array(KEY_BYTES);

  globalThis.crypto.getRandomValues(bytes);

  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Сравнение за время, не зависящее от позиции первого расхождения: по
 * таймингу ответов ключ не подобрать посимвольно.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function resumeKeysEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}
