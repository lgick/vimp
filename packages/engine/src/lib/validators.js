const NAME_REGEXP = new RegExp('^[a-zA-Z]([\\w\\s#]{0,13})[\\w]{1}$');

/**
 * Проверяет, является ли строка валидным именем пользователя.
 * @param {string} name - Имя для проверки.
 * @returns {boolean} - true, если имя валидно, иначе false.
 */
export const isValidName = name =>
  typeof name === 'string' && NAME_REGEXP.test(name);

// движковые правила валидации; игровые (например isValidModel)
// инжектируются третьим аргументом validateAuth (authSchema игры)
const validationRules = {
  isValidName,
};

/**
 * Валидирует объект с данными для авторизации.
 * @param {object} data - Объект с данными для проверки.
 * @param {Array} authParams - Массив правил для валидации
 * @param {Object} [validators] - Игровые валидаторы (имя → функция),
 *   дополняют движковые validationRules.
 * @returns {Array|undefined} - Массив ошибок или undefined.
 */
export const validateAuth = (data, authParams, validators = {}) => {
  const rules = { ...validationRules, ...validators };
  const errors = [];

  for (const { name, options } of authParams) {
    if (!(name in data)) {
      return [{ name, error: `Property is missing` }];
    }

    const value = data[name];

    if (typeof value !== 'string') {
      return [{ name, error: `Property must be a string` }];
    }

    if (options?.validator) {
      const validatorFn = rules[options.validator];

      // validateAuth используется и клиентом (без игровых validators —
      // это норма, авторитет проверки на хосте), и хостом (с authSchema.validators
      // игры — здесь отсутствие validatorFn обычно опечатка в имени валидатора
      // конфига игры). В обоих случаях просто пропускаем поле без ошибки,
      // сохраняя прежнее поведение (эта ветка никогда не добавляла в errors).
      if (validatorFn && !validatorFn(value)) {
        errors.push({ name, error: 'not valid' });
      }
    }
  }

  return errors.length ? errors : undefined;
};

// клампит query-параметр в целое [1, max]; невалидное значение — fallback
// (lobby-page-plan: GET /auth/leaderboard?limit=, мастер клампит ещё раз
// перед проксированием). Вынесено из master/main.js (code review L3), чтобы
// клампинг был покрыт юнит-тестом отдельно от роута
export const clampLimit = (value, fallback, max) => {
  const num = Number(value);

  return Number.isInteger(num) ? Math.min(Math.max(num, 1), max) : fallback;
};
