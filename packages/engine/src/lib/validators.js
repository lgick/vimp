import { anchorPattern } from './formPattern.js';
import { normalizeOptions } from './formOptions.js';

const NAME_REGEXP = new RegExp('^[a-zA-Z]([\\w\\s#]{0,13})[\\w]{1}$');

/**
 * Проверяет, является ли строка валидным именем пользователя.
 * @param {string} name - Имя для проверки.
 * @returns {boolean} - true, если имя валидно, иначе false.
 */
export const isValidName = name =>
  typeof name === 'string' && NAME_REGEXP.test(name);

// потолок длины поля формы, когда maxlength в дескрипторе не объявлен.
// regExp игры исполняется на хосте против строки, которую прислал клиент, и
// катастрофический паттерн вроде "(a+)+b" превращает три десятка символов в
// минуты заблокированного event loop — а хост это либо Worker с авторитетным
// матчем (замирает комната целиком), либо процесс dedicated. 256 — с запасом
// на любое поле auth-формы (ник, имя модели): длиннее не бывает у формы и не
// нужно тому, кто её обошёл
const MAX_FIELD_LENGTH = 256;

// контролы со списком вариантов: браузер другого значения и не отдаст —
// <option>.value и <input type=radio>.value это ровно объявленный список
const OPTION_CONTROLS = ['select', 'radio'];

// maxlength/regExp форма применяет только к text-полю (formBuilder.
// validateField), и хост обязан к тому же: отбить значение варианта, который
// сам же предложил список, значит завести игрока в тупик. Контрол по
// умолчанию — text (тот же дефолт, что у билдера формы)
const isTextControl = control => control === 'text' || control === undefined;

// source-варианты хост не резолвит (их и форма в auth не резолвит: она
// строится с пустым ctx) — сверяем только объявленный inline-список.
// String(): и <option>.value, и <input type=radio>.value — DOM-свойства,
// они всегда строки, так что options: [1, 2] форма отдаёт как '1'/'2'.
// Списка нет вовсе (или он не массив — дефект схемы) — валидного значения у
// поля не существует, и форма это говорит прямо ('no options available'):
// пропустить здесь что угодно значило бы дать обошедшему форму клиенту
// больше прав, чем игроку, который войти не может вовсе
const isDeclaredOption = (list, value) =>
  Array.isArray(list) &&
  normalizeOptions(list).some(opt => String(opt.value) === value);

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

/**
 * Резолвит имя валидатора из дескриптора: движковые правила, перекрытые
 * игровыми. Одно определение на движок — им пользуется и validateAuth
 * (чтобы звать), и правило C10 с PortMachine (чтобы проверять): две копии
 * этого правила уже разъезжались на типе значения, и не-функция в
 * validators игры уходила TypeError'ом прямо в обработчик сообщения.
 * @param {string} name - Имя из options.validator.
 * @param {Object} [validators] - authSchema.validators игры.
 * @returns {Function|undefined} Функция либо undefined, если имя не резолвится.
 */
export const resolveValidator = (name, validators = {}) => {
  const fn = { ...validationRules, ...validators }[name];

  return typeof fn === 'function' ? fn : undefined;
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
  const errors = [];

  for (const { name, options } of authParams) {
    if (!(name in data)) {
      return [{ name, error: `Property is missing` }];
    }

    const value = data[name];

    if (typeof value !== 'string') {
      return [{ name, error: `Property must be a string` }];
    }

    // Те же декларативные правила, по которым отказывает форма
    // (client/lib/formBuilder.js → validateField): клиент, обошедший форму,
    // не должен получать больше прав, чем клиент, её заполнивший. Пустое
    // значение пропускается ровно как на клиенте (required здесь не
    // проверяется: solo-путь boot.autoAuth отвечает дефолтами схемы, среди
    // которых бывает '') — пустота остаётся делом игрового валидатора.
    // min/max формы здесь не применяются и не нужны: числовое поле отдаёт из
    // формы число, а нестроковое значение отбито выше, то есть числовых
    // полей в authSchema не бывает вовсе

    // длина — первой и безусловно: потолок ограничивает не столько ввод,
    // сколько работу паттерна ниже (см. MAX_FIELD_LENGTH)
    const limit =
      isTextControl(options?.control) && options?.maxlength !== undefined
        ? options.maxlength
        : MAX_FIELD_LENGTH;

    if (value.length > limit) {
      errors.push({ name, error: 'too long' });
      continue;
    }

    // членство в списке вариантов — самое жёсткое ограничение формы: без
    // этой проверки поле-select без игрового валидатора принимает от
    // обошедшего форму клиента любую строку
    if (
      OPTION_CONTROLS.includes(options?.control) &&
      !options.source &&
      !isDeclaredOption(options.options, value)
    ) {
      errors.push({ name, error: 'not an option' });
      continue;
    }

    if (
      value !== '' &&
      isTextControl(options?.control) &&
      options?.regExp &&
      !matchesPattern(options.regExp, value)
    ) {
      errors.push({ name, error: 'invalid format' });
      continue;
    }

    if (options?.validator) {
      const validatorFn = resolveValidator(options.validator, validators);

      // нерезолвнутое имя (опечатка) и не-функция ведут себя одинаково —
      // поле проходит. Для клиента это норма (игровые валидаторы к нему не
      // едут, авторитет проверки на хосте), для хоста — дефект схемы, о
      // котором говорят C10 и console.error в PortMachine: звать что попало
      // нельзя, TypeError отсюда уходит прямо в обработчик сообщения
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
