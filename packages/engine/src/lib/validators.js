import { anchorPattern } from './formPattern.js';
import { normalizeOptions } from './formOptions.js';
import { formControls, resolveDescriptor } from './formControls.js';
import { toDisplay, isNumericField } from './formUnit.js';

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

// числовое поле (control 'text' + numeric/unit — в том числе разрешённые из
// выведенных 'number' и 'range'). Форма отдаёт его ЧИСЛОМ в единице
// хранения (formBuilder.buildText: getValue → toStored(Number(...))), а не
// строкой, поэтому оно идёт отдельной веткой до проверки типа
const isNumericControl = options =>
  isTextControl(options?.control) && isNumericField(options);

// min/max дескриптора объявлены в единице ОТОБРАЖЕНИЯ, а по сети едет
// единица хранения — сравниваем ровно так же, как validateField на клиенте
const numericError = (options, value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'must be a number';
  }

  const shown = toDisplay(options, value);

  if (options.min !== undefined && shown < options.min) {
    return `must be >= ${options.min}`;
  }

  if (options.max !== undefined && shown > options.max) {
    return `must be <= ${options.max}`;
  }

  // regExp числового поля хост НЕ проверяет, и это осознанно. Клиент
  // сверяет паттерн с сырой строкой, которую набрал игрок
  // (formBuilder.validateField: field.getRaw()); до хоста доезжает уже
  // число, и восстановить ту строку нечем — `String(значение)` даёт
  // каноническую запись, а не набранную. Паттерн, принимающий
  // неканоническую («^\d+\.\d{2}$» и ввод «1.50»), совпал бы с формой и
  // разошёлся бы с хостом: игрок видит поле валидным, а вход не пускает, и
  // набрать строку, годную обеим сторонам, нельзя вовсе. Блокировка входа
  // хуже той щели, которую паттерн закрывает: диапазон уже проверен, а
  // ведущий ноль до хоста и не доезжает (Number('08') === 8)
  return null;
};

// Сверяется только объявленный inline-список. String(): и <option>.value, и
// <input type=radio>.value — DOM-свойства, они всегда строки, так что
// options: [1, 2] форма отдаёт как '1'/'2'.
//
// Списка нет вовсе — ни массива, ни `source` (последний в auth-схеме не
// резолвится: форма строится с пустым ctx). Валидного значения у такого поля
// не существует, и форма это говорит прямо ('no options available'):
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

// игровой валидатор поля (authSchema.validators). Нерезолвнутое имя
// (опечатка) и не-функция ведут себя одинаково — поле проходит. Для клиента
// это норма (игровые валидаторы к нему не едут, авторитет проверки на
// хосте), для хоста — дефект схемы, о котором говорят C10 и console.error в
// PortMachine: звать что попало нельзя, TypeError отсюда уходит прямо в
// обработчик сообщения
const gameValidatorError = (options, value, validators) => {
  if (options?.validator === undefined) {
    return null;
  }

  const validatorFn = resolveValidator(options.validator, validators);

  return validatorFn && !validatorFn(value) ? 'not valid' : null;
};

// null → ничего не добавляем: errors.push(...withName(...)) читается одной
// строкой на обеих ветках поля
const withName = (name, error) => (error === null ? [] : [{ name, error }]);

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

  for (const { name, options: declared } of authParams) {
    if (!(name in data)) {
      return [{ name, error: `Property is missing` }];
    }

    // Тот же резолв алиаса, что делает билдер формы (client/lib/formBuilder.js:
    // buildField, collectFormErrors, resolveForcedValue). Без него контрол,
    // выведенный из эксплуатации в v3 ('segmented', 'number', 'range',
    // 'toggle'), не совпадает ни с одним именем ниже, и клиент, обошедший
    // форму, получает поле ВООБЩЕ без проверок — ровно то превосходство над
    // заполнившим форму, которого здесь быть не должно. Алиасы стали
    // достижимы вместе с реестром контролов (этап 3 plugin-forward-compat):
    // до него такое поле не строилось у клиента и сюда не доезжало
    const options = resolveDescriptor(declared);
    const value = data[name];

    // Контрол, которого нет в реестре, — дефект схемы (опечатка или игра из
    // будущего), и билдер выносит ему тот же приговор: поле не строится
    // (`unknown control`), в сабмит не попадает и до хоста не доезжает.
    // Значит доехать оно может только от клиента, обошедшего форму, — и
    // проверить его нечем: ниже не совпадёт ни одна ветка, останется лишь
    // потолок длины. Отвергаем явно; раньше это ловит правило C10
    if (options?.control !== undefined && !formControls.has(options.control)) {
      errors.push({ name, error: 'unknown control' });
      continue;
    }

    // Числовое поле идёт своей веткой: форма отдаёт его числом, и общий
    // путь ниже (длина, список вариантов, regExp) к нему не применим —
    // проверяется диапазон, ровно как validateField делает на клиенте.
    // Игровой валидатор зовётся для обоих видов поля одинаково
    if (isNumericControl(options)) {
      const error = numericError(options, value);

      errors.push(
        ...withName(
          name,
          error ?? gameValidatorError(options, value, validators),
        ),
      );
      continue;
    }

    if (typeof value !== 'string') {
      return [{ name, error: `Property must be a string` }];
    }

    // Те же декларативные правила, по которым отказывает форма
    // (client/lib/formBuilder.js → validateField): клиент, обошедший форму,
    // не должен получать больше прав, чем клиент, её заполнивший. Пустое
    // значение пропускается ровно как на клиенте (required здесь не
    // проверяется: solo-путь boot.autoAuth отвечает дефолтами схемы, среди
    // которых бывает '') — пустота остаётся делом игрового валидатора

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
    // `source` (спец-источник вариантов движка, например карты) в auth-схеме
    // не работает вовсе: auth-форма строится с ПУСТЫМ ctx
    // (client/components/view/Auth.js), поэтому у игрока такое поле
    // резолвится в пустой список и получает 'no options available' — войти
    // с ним нельзя. Пропустив его здесь, хост дал бы обошедшему форму
    // клиенту произвольную строку там, где игрок не может ввести ничего:
    // инвариант модуля наизнанку. Отвергаем как и любой не-вариант; раньше
    // это ловит правило C10
    if (
      OPTION_CONTROLS.includes(options?.control) &&
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

    errors.push(
      ...withName(name, gameValidatorError(options, value, validators)),
    );
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

// Сколько завершённых игр движок может склеить в один запрос: окно склейки
// на его стороне — минута (lobbyConfig.playerData.minFlushInterval), столько
// игр в неё не влезает.
//
// Множитель СВЯЗАН с rank.maxPoints auth-сервиса (packages/auth/src/config/
// auth.js): мастер не должен пропускать то, что auth отклонит. Отклонённое
// тело для хоста неустранимо — PlayerDataSync повторял бы его до конца жизни
// комнаты, — поэтому при правке per-game maxGameScore проверяется и потолок
// суммы на той стороне.
const MERGED_GAMES_PER_WINDOW = 20;

// клампит результат игры (snakes-v3 этап 3.3): `best` — очки ОДНОЙ игры,
// `points` — сумма склеенных игр с прошлой синхронизации. Потолок одной
// игры объявляет сама игра (master:games[].maxGameScore), потолок суммы —
// это же значение на минутное окно синхронизации; всё, что больше, значит
// либо взломанного клиента, либо неверно настроенную игру, и мастер режет
// его перед проксированием, а не отклоняет запрос целиком: честная часть
// результата не должна пропадать из-за одной аномальной строки.
// Инвариант `best <= points` держится и после клампа — auth его требует
export const clampGameResult = (points, best, maxGameScore) => {
  const maxPoints = maxGameScore * MERGED_GAMES_PER_WINDOW;
  const toInt = value => {
    const num = Math.trunc(Number(value));

    return Number.isFinite(num) ? Math.max(num, 0) : 0;
  };
  const cappedBest = Math.min(toInt(best), maxGameScore);
  const cappedPoints = Math.min(toInt(points), maxPoints);

  return {
    points: cappedPoints,
    // best > points — битый клиент: сумма не может быть меньше своего
    // максимума. Поднимать сумму до максимума значило бы дорисовать
    // месячному рейтингу очки, которых не было, поэтому режется best
    best: Math.min(cappedBest, cappedPoints),
    // превышение логируется вызывающим: это сигнал о сломанной игре
    clamped: cappedBest !== toInt(best) || cappedPoints !== toInt(points),
  };
};

// Ключ сопоставления ника с глобальным топом. Уникальность users.nick в auth
// регистронезависимая (миграция 002), поэтому и сравнивать надо так же —
// иначе «Alice» и «alice» разъедутся. Правило одно, а мест, где по нику
// ищут, три (host/meta/modules/Accolades.js, client/components/model/Stat.js
// и сам auth), поэтому оно живёт здесь, а не переписывается в каждом.
export const nickKey = nick => String(nick ?? '').toLowerCase();
