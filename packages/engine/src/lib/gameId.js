// Формат id игры — изоморфно: его проверяет мастер (реестр, раздача, каталог)
// и клиентский роутер ссылок (client/lib/roomLink.js) до похода в сеть.
// Значение обязано совпадать с packages/auth/src/config/auth.js:games
// (см. master/gameRefs.js — он реэкспортирует отсюда)
export const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * @param {*} value
 * @returns {boolean} Является ли значение корректным id игры.
 */
export function isValidGameId(value) {
  return typeof value === 'string' && GAME_ID_PATTERN.test(value);
}
