import { anchorPattern } from './formPattern.js';

const NAME_REGEXP = new RegExp('^[a-zA-Z]([\\w\\s#]{0,13})[\\w]{1}$');

/**
 * Проверяет, является ли строка валидным именем пользователя.
 * @param {string} name - Имя для проверки.
 * @returns {boolean} - true, если имя валидно, иначе false.
 */
export const isValidName = name =>
  typeof name === 'string' && NAME_REGEXP.test(name);

// regExp дескриптора якорится тем же anchorPattern, что и на клиенте
// (formBuilder.fieldPattern). Некомпилируемый паттерн — дефект схемы игры,
// а не ограничение: поле проходит, иначе игра с битым regExp не пускала бы
// в комнату вообще никого
const matchesPattern = (regExp, value) => {
  try {
    return anchorPattern(regExp).test(value);
  } catch {
    return true;
  }
};

// движковые правила валидации; игровые (например isValidModel)
// инжектируются третьим аргументом validateAuth (authSchema игры)
const validationRules = {
  isValidName,
};

// имена валидаторов, которые validateAuth резолвит сам: правило C10
// проверяет, что имя из дескриптора резолвится хоть где-то — движковое
// имя схема игры дублировать в validators не обязана
export const engineValidatorNames = Object.keys(validationRules);

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

    // те же декларативные правила, по которым отказывает форма
    // (client/lib/formBuilder.js → validateField): клиент, обошедший форму,
    // не должен получать больше прав, чем клиент, её заполнивший. Пустое
    // значение пропускается ровно как на клиенте (required здесь не
    // проверяется: solo-путь boot.autoAuth отвечает дефолтами схемы, среди
    // которых бывает '') — пустота остаётся делом игрового валидатора
    if (value !== '') {
      if (
        options?.maxlength !== undefined &&
        value.length > options.maxlength
      ) {
        errors.push({ name, error: 'too long' });
        continue;
      }

      if (options?.regExp && !matchesPattern(options.regExp, value)) {
        errors.push({ name, error: 'invalid format' });
        continue;
      }
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
