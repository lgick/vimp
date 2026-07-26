/**
 * Заменяет плейсхолдеры в строке на значения из массива.
 * Плейсхолдеры имеют вид `{0}`, `{1}` и т.д.
 * @param {string} [message=''] - Исходное сообщение с плейсхолдерами.
 * @param {string[]} [arr=[]] - Массив значений для подстановки.
 * @returns {string} Сообщение с подставленными значениями.
 * @example
 * formatMessage('Hello, {0} {1}!', ['John', 'Doe']);
 * // возвращает "Hello, John Doe!"
 */
export const formatMessage = (message = '', arr = []) => {
  if (!message || !arr.length) {
    return message;
  }

  // замена плейсхолдеров
  return message.replace(/\{(\d+)\}/g, (match, index) => {
    // index — это номер, захваченный из скобок в RegExp
    const value = arr[index];
    // если значение для индекса существует, подставляем его.
    return typeof value !== 'undefined' ? value : match;
  });
};

/**
 * Округляет число до 2-х знаков после запятой.
 * @param {number} value - Число для округления.
 * @returns {number}
 * @example
 * round(10.567);      // 10.57
 * round(10.567, 1);  // 10.6
 */
export const roundTo2Decimals = value => Math.round(value * 100) / 100;
