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

      if (validatorFn && !validatorFn(value)) {
        errors.push({ name, error: 'not valid' });
      } else if (!validatorFn) {
        console.warn(`Validator function '${options.validator}' not found.`);
      }
    }
  }

  return errors.length ? errors : undefined;
};
