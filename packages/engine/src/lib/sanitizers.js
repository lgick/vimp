// Управляющие символы (переводы строк, табы и т.п.) ломают однострочный чат.
// eslint-disable-next-line no-control-regex
const controlCharsRegExp = /[\x00-\x1f\x7f]/g;

/**
 * Убирает из сообщения управляющие символы. Не XSS-защита — экранирование
 * на выводе (`textContent`/`setAttribute`).
 * @param {string} message
 * @returns {string} - Очищенная строка (пустая, если на входе не строка).
 */
export const sanitizeMessage = message => {
  if (typeof message !== 'string') {
    return '';
  }

  return message.replace(controlCharsRegExp, '');
};
