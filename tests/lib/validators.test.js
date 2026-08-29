import { describe, it, expect, vi } from 'vitest';
import {
  clampGameResult,
  isValidName,
  validateAuth,
  resolveValidator,
  clampLimit,
} from '../../packages/engine/src/lib/validators.js';

describe('isValidName', () => {
  it('принимает корректные имена', () => {
    expect(isValidName('John')).toBe(true);
    expect(isValidName('ab')).toBe(true); // минимум 2 символа
    expect(isValidName('Player_1')).toBe(true);
    expect(isValidName('a b c')).toBe(true); // допустимы пробелы внутри
  });

  it('отклоняет имена, начинающиеся не с буквы', () => {
    expect(isValidName('1abc')).toBe(false);
    expect(isValidName('_abc')).toBe(false);
    expect(isValidName(' abc')).toBe(false);
  });

  it('отклоняет слишком короткие и слишком длинные имена', () => {
    expect(isValidName('a')).toBe(false); // 1 символ
    expect(isValidName('a'.repeat(16))).toBe(false); // > 15
  });

  it('отклоняет имена с запрещёнными символами', () => {
    expect(isValidName('na<me>')).toBe(false);
    expect(isValidName('na;me')).toBe(false);
  });

  it('отклоняет не-строки', () => {
    expect(isValidName(123)).toBe(false);
    expect(isValidName(null)).toBe(false);
    expect(isValidName(undefined)).toBe(false);
  });
});

describe('validateAuth', () => {
  const authParams = [
    { name: 'name', options: { validator: 'isValidName' } },
    { name: 'model', options: { validator: 'isValidModel' } },
  ];

  // игровой валидатор инжектируется (движок isValidModel не знает)
  const validators = { isValidModel: model => model === 'm1' };

  it('возвращает undefined при валидных данных', () => {
    const result = validateAuth(
      { name: 'John', model: 'm1' },
      authParams,
      validators,
    );
    expect(result).toBeUndefined();
  });

  it('сообщает об отсутствующем свойстве', () => {
    const result = validateAuth({ name: 'John' }, authParams, validators);
    expect(result).toEqual([{ name: 'model', error: 'Property is missing' }]);
  });

  it('сообщает о нестроковом значении', () => {
    const result = validateAuth(
      { name: 123, model: 'm1' },
      authParams,
      validators,
    );
    expect(result).toEqual([
      { name: 'name', error: 'Property must be a string' },
    ]);
  });

  it('накапливает ошибки валидации', () => {
    const result = validateAuth(
      { name: '1', model: 'm9' },
      authParams,
      validators,
    );
    expect(result).toEqual([
      { name: 'name', error: 'not valid' },
      { name: 'model', error: 'not valid' },
    ]);
  });

  it('игровой валидатор может переопределить движковый', () => {
    const params = [{ name: 'name', options: { validator: 'isValidName' } }];
    const strict = { isValidName: () => false };

    expect(validateAuth({ name: 'John' }, params, strict)).toEqual([
      { name: 'name', error: 'not valid' },
    ]);
  });

  it('параметр без валидатора считается валидным, если это строка', () => {
    const params = [{ name: 'free', options: {} }];
    expect(validateAuth({ free: 'anything' }, params)).toBeUndefined();
  });

  // декларативная часть дескриптора: те же правила, что отбивают форму,
  // применяет и хост — иначе клиент, обошедший форму, получал бы больше прав
  it('отбивает строку длиннее maxlength', () => {
    const params = [{ name: 'tag', options: { maxlength: 15 } }];

    expect(validateAuth({ tag: 'x'.repeat(16) }, params)).toEqual([
      { name: 'tag', error: 'too long' },
    ]);
    expect(validateAuth({ tag: 'x'.repeat(15) }, params)).toBeUndefined();
  });

  it('отбивает значение, не матчащееся под regExp', () => {
    const params = [{ name: 'tag', options: { regExp: '[a-z]+' } }];

    expect(validateAuth({ tag: 'ABC' }, params)).toEqual([
      { name: 'tag', error: 'invalid format' },
    ]);
    // паттерн якорится целиком, как и на клиенте (anchorPattern)
    expect(validateAuth({ tag: 'abc9' }, params)).toEqual([
      { name: 'tag', error: 'invalid format' },
    ]);
    expect(validateAuth({ tag: 'abc' }, params)).toBeUndefined();
  });

  it('maxlength коротит игровой валидатор (слишком длинное значение до него не доходит)', () => {
    const params = [
      { name: 'tag', options: { maxlength: 5, validator: 'isValidTag' } },
    ];
    const isValidTag = vi.fn(() => true);

    expect(validateAuth({ tag: 'xxxxxx' }, params, { isValidTag })).toEqual([
      { name: 'tag', error: 'too long' },
    ]);
    expect(isValidTag).not.toHaveBeenCalled();
  });

  // поле без maxlength всё равно ограничено потолком: regExp игры крутится
  // на хосте (Worker авторитетного матча / процесс dedicated), и без
  // потолка катастрофический паттерн замораживает комнату
  it('поле без maxlength ограничено потолком в 256 символов', () => {
    const params = [{ name: 'tag', options: { control: 'text' } }];

    expect(validateAuth({ tag: 'x'.repeat(256) }, params)).toBeUndefined();
    expect(validateAuth({ tag: 'x'.repeat(257) }, params)).toEqual([
      { name: 'tag', error: 'too long' },
    ]);
  });

  it('катастрофический regExp не блокирует хост: потолок отбивает раньше матча', () => {
    const params = [{ name: 'tag', options: { regExp: '(a+)+b' } }];
    const started = Date.now();

    expect(validateAuth({ tag: 'a'.repeat(300) }, params)).toEqual([
      { name: 'tag', error: 'too long' },
    ]);
    expect(Date.now() - started).toBeLessThan(100);
  });

  // паритет с формой: maxlength/regExp она применяет только к text-полю,
  // хост обязан к тому же — иначе отбивает вариант, который сам предложил
  it('maxlength/regExp не применяются к нетекстовому контролу (как и в форме)', () => {
    const params = [
      {
        name: 'side',
        options: {
          control: 'select',
          options: ['RED'],
          regExp: '[a-z]+',
          maxlength: 1,
        },
      },
    ];

    expect(validateAuth({ side: 'RED' }, params)).toBeUndefined();
  });

  it('некомпилируемый regExp — не ограничение, а не отказ (как на клиенте)', () => {
    const params = [{ name: 'tag', options: { regExp: '[' } }];

    expect(() => validateAuth({ tag: 'anything' }, params)).not.toThrow();
    expect(validateAuth({ tag: 'anything' }, params)).toBeUndefined();
  });

  it('пустое значение декларативные правила пропускают (required не проверяется)', () => {
    const params = [
      { name: 'tag', options: { regExp: '[a-z]+', required: true } },
    ];

    expect(validateAuth({ tag: '' }, params)).toBeUndefined();
  });

  // список вариантов — самое жёсткое ограничение формы: <select> значения
  // вне своих options не отдаст, и хост обязан требовать того же
  it('отбивает значение вне списка вариантов select/radio', () => {
    const params = [
      {
        name: 'side',
        options: { control: 'select', options: ['red', 'blue'] },
      },
    ];

    expect(validateAuth({ side: 'green' }, params)).toEqual([
      { name: 'side', error: 'not an option' },
    ]);
    expect(validateAuth({ side: 'red' }, params)).toBeUndefined();
  });

  it('вариант-объект сверяется по value, числовой — по строковому виду', () => {
    const objectParams = [
      {
        name: 'side',
        options: {
          control: 'radio',
          options: [{ value: 'red', label: 'Red' }],
        },
      },
    ];
    const numericParams = [
      { name: 'lvl', options: { control: 'select', options: [1, 2] } },
    ];

    expect(validateAuth({ side: 'red' }, objectParams)).toBeUndefined();
    expect(validateAuth({ side: 'Red' }, objectParams)).toEqual([
      { name: 'side', error: 'not an option' },
    ]);
    // форма отдаёт значение <option> строкой, хост сравнивает с ним
    expect(validateAuth({ lvl: '1' }, numericParams)).toBeUndefined();
  });

  // у поля без вариантов валидного значения нет по определению: форма
  // отказывает безусловно ('no options available'), и хост не вправе
  // пропускать то, чего игрок отправить не может
  it('select без вариантов не принимает ничего', () => {
    const empty = [
      { name: 'side', options: { control: 'select', options: [] } },
    ];
    const missing = [{ name: 'side', options: { control: 'select' } }];
    const broken = [
      { name: 'side', options: { control: 'select', options: 'red' } },
    ];

    expect(validateAuth({ side: 'red' }, empty)).toEqual([
      { name: 'side', error: 'not an option' },
    ]);
    expect(validateAuth({ side: 'red' }, missing)).toEqual([
      { name: 'side', error: 'not an option' },
    ]);
    // список не массив — тот же дефект схемы, и он не должен бросать
    expect(() => validateAuth({ side: 'red' }, broken)).not.toThrow();
    expect(validateAuth({ side: 'red' }, broken)).toEqual([
      { name: 'side', error: 'not an option' },
    ]);
  });

  // раньше такое поле хост пропускал целиком («каталога он не знает»), но
  // auth-форма строится с ПУСТЫМ ctx: у игрока список пуст и войти он не
  // может, а обошедший форму слал что угодно — инвариант модуля наизнанку.
  // Правило C10 запрещает source в authSchema, валидация — последний рубеж
  it('поле с source отвергается: валидного значения у него нет вовсе', () => {
    const params = [
      { name: 'map', options: { control: 'select', source: 'maps' } },
    ];

    expect(validateAuth({ map: 'anything' }, params)).toEqual([
      { name: 'map', error: 'not an option' },
    ]);
  });

  // гостевой контур (createGuestIdentity) — единственное место в
  // поставляемом коде, где новая проверка длины срабатывает сегодня
  it('гостевой ник длиннее maxlength отбивается как too long, а не not valid', () => {
    const params = [
      {
        name: 'name',
        options: { control: 'text', maxlength: 15, validator: 'isValidName' },
      },
    ];

    expect(validateAuth({ name: 'a'.repeat(16) }, params)).toEqual([
      { name: 'name', error: 'too long' },
    ]);
  });

  it('валидатор-не-функция не бросает: поле проходит, как и незнакомое имя', () => {
    const params = [{ name: 'model', options: { validator: 'isValidModel' } }];
    const broken = { isValidModel: 'm1' };

    expect(() => validateAuth({ model: 'm1' }, params, broken)).not.toThrow();
    expect(validateAuth({ model: 'm1' }, params, broken)).toBeUndefined();
  });

  it('незарегистрированное имя валидатора молча пропускает поле (без ошибки и без throw)', () => {
    const params = [{ name: 'model', options: { validator: 'isValidModel' } }];
    // validators не передан — isValidModel не найден в rules
    expect(() => validateAuth({ model: 'm1' }, params)).not.toThrow();
    expect(validateAuth({ model: 'm1' }, params)).toBeUndefined();
  });
});

// одно определение «валидатор резолвится» на движок: им пользуется и
// validateAuth, и правило C10, и конструктор PortMachine
describe('resolveValidator', () => {
  it('резолвит движковое имя и игровое, игровое перекрывает движковое', () => {
    const gameRule = () => true;

    expect(resolveValidator('isValidName')).toBe(isValidName);
    expect(resolveValidator('isValidModel', { isValidModel: gameRule })).toBe(
      gameRule,
    );
    expect(resolveValidator('isValidName', { isValidName: gameRule })).toBe(
      gameRule,
    );
  });

  it('незнакомое имя и не-функция резолвятся в undefined', () => {
    expect(resolveValidator('isValidMdoel')).toBeUndefined();
    expect(
      resolveValidator('isValidModel', { isValidModel: 'm1' }),
    ).toBeUndefined();
    expect(
      resolveValidator('isValidName', { isValidName: null }),
    ).toBeUndefined();
  });
});

// code review L3: клампинг GET /auth/leaderboard?limit= вынесен из
// master/main.js сюда, чтобы быть покрытым юнит-тестом независимо от роута
describe('clampLimit', () => {
  it('клампит в диапазон [1, max]', () => {
    expect(clampLimit(50, 10, 100)).toBe(50);
    expect(clampLimit(0, 10, 100)).toBe(1);
    expect(clampLimit(9999, 10, 100)).toBe(100);
  });

  it('невалидное значение (не целое/отсутствует) — fallback', () => {
    expect(clampLimit(undefined, 10, 100)).toBe(10);
    expect(clampLimit('junk', 10, 100)).toBe(10);
    expect(clampLimit(1.5, 10, 100)).toBe(10);
  });
});

// snakes-v3 этап 3.3: игра, приславшая результат больше своего потолка,
// либо взломана, либо неверно настроена — мастер режет её перед
// проксированием, а не отклоняет запрос целиком
describe('clampGameResult', () => {
  it('нормальный результат проходит как есть', () => {
    expect(clampGameResult(640, 400, 10000)).toEqual({
      points: 640,
      best: 400,
      clamped: false,
    });
  });

  it('режет одну игру по потолку игры, а сумму — по двадцатикратному', () => {
    expect(clampGameResult(999999999, 999999, 10000)).toEqual({
      points: 200000,
      best: 10000,
      clamped: true,
    });
  });

  it('best > points — битый клиент: режется максимум, а не растёт сумма', () => {
    expect(clampGameResult(5, 100, 10000)).toMatchObject({
      points: 5,
      best: 5,
    });
  });

  it('отрицательное, дробное и мусор — ноль', () => {
    expect(clampGameResult(-10, -1, 10000)).toMatchObject({
      points: 0,
      best: 0,
    });
    expect(clampGameResult('junk', undefined, 10000)).toMatchObject({
      points: 0,
      best: 0,
    });
    expect(clampGameResult(7.9, 3.2, 10000)).toMatchObject({
      points: 7,
      best: 3,
    });
  });

  it('потолок объявляет игра: 100 у одной, 10000 у другой', () => {
    expect(clampGameResult(500, 500, 100)).toMatchObject({
      points: 500,
      best: 100,
    });
    expect(clampGameResult(500, 500, 10000)).toMatchObject({
      points: 500,
      best: 500,
    });
  });
});

// Алиасы выведенных контролов в авторитетной валидации хоста. Этап 3 плана
// plugin-forward-compat научил разрешать их ТОЛЬКО билдер формы, и
// authSchema с именем прошлого поколения строилась у клиента, а на хосте не
// совпадала ни с одним именем — поле уезжало вообще без проверок. Инвариант
// модуля: клиент, обошедший форму, не получает больше прав, чем заполнивший
describe('validateAuth: выведенные контролы проверяются как их замены', () => {
  const optionField = control => [
    { name: 'team', options: { control, options: ['red', 'blue'] } },
  ];

  it("'segmented' проверяет членство в options ровно как 'radio'", () => {
    expect(validateAuth({ team: 'hacked' }, optionField('segmented'))).toEqual([
      { name: 'team', error: 'not an option' },
    ]);
    expect(
      validateAuth({ team: 'red' }, optionField('segmented')),
    ).toBeUndefined();
  });

  it("'toggle' ведёт себя как 'checkbox' — свободное значение", () => {
    expect(
      validateAuth({ t: 'on' }, [
        { name: 't', options: { control: 'toggle' } },
      ]),
    ).toBeUndefined();
  });

  it("'number' и 'range' проверяются диапазоном, а не длиной строки", () => {
    const field = control => [
      { name: 'players', options: { control, min: 1, max: 8 } },
    ];

    expect(validateAuth({ players: 4 }, field('number'))).toBeUndefined();
    expect(validateAuth({ players: 99 }, field('range'))).toEqual([
      { name: 'players', error: 'must be <= 8' },
    ]);
    expect(validateAuth({ players: 0 }, field('number'))).toEqual([
      { name: 'players', error: 'must be >= 1' },
    ]);
  });

  it('числовое поле не принимает строку вместо числа', () => {
    expect(
      validateAuth({ players: '4' }, [
        { name: 'players', options: { control: 'number', min: 1, max: 8 } },
      ]),
    ).toEqual([{ name: 'players', error: 'must be a number' }]);
  });

  it('min/max сверяются в единице отображения, а не хранения', () => {
    const field = [
      {
        name: 'roundTime',
        options: { control: 'range', unit: 's', min: 10, max: 60 },
      },
    ];

    // 30000 мс = 30 с — внутри диапазона; 300000 мс = 300 с — вне его
    expect(validateAuth({ roundTime: 30000 }, field)).toBeUndefined();
    expect(validateAuth({ roundTime: 300000 }, field)).toEqual([
      { name: 'roundTime', error: 'must be <= 60' },
    ]);
  });

  it('игровой валидатор зовётся и для числового поля', () => {
    const isEven = vi.fn(value => value % 2 === 0);

    expect(
      validateAuth(
        { n: 3 },
        [{ name: 'n', options: { control: 'number', validator: 'isEven' } }],
        { isEven },
      ),
    ).toEqual([{ name: 'n', error: 'not valid' }]);
    expect(isEven).toHaveBeenCalledWith(3);
  });

  it('активные контролы не изменились в поведении', () => {
    expect(validateAuth({ team: 'hacked' }, optionField('radio'))).toEqual([
      { name: 'team', error: 'not an option' },
    ]);
    expect(
      validateAuth({ nick: 'abcdefgh' }, [
        { name: 'nick', options: { control: 'text', maxlength: 3 } },
      ]),
    ).toEqual([{ name: 'nick', error: 'too long' }]);
  });
});

// Паритет с формой на путях, где хост раньше проверял меньше клиента.
// Мерило одно: клиент, обошедший форму, не должен получать больше прав, чем
// клиент, её заполнивший
describe('validateAuth: паритет с формой', () => {
  // regExp числового поля хост НЕ проверяет: клиент сверяет паттерн с сырой
  // строкой игрока, а сюда приезжает число, и набранную строку из него не
  // восстановить. Паттерн, принимающий неканоническую запись, разошёлся бы с
  // формой так, что валидной строки не существует вовсе — вход заперт
  it('числовое поле не запирается паттерном, принимающим «1.50»', () => {
    const field = [
      {
        name: 'price',
        options: {
          control: 'number',
          numeric: true,
          min: 1,
          max: 8,
          regExp: '\\d+\\.\\d{2}',
        },
      },
    ];

    // форма приняла бы «1.50», а String(1.5) паттерну не соответствует:
    // отбить это значило бы не пустить игрока вовсе
    expect(validateAuth({ price: 1.5 }, field)).toBeUndefined();
  });

  it('диапазон числового поля проверяется по-прежнему', () => {
    const field = [
      {
        name: 'players',
        options: { control: 'number', min: 1, max: 8, regExp: '([1-8])' },
      },
    ];

    expect(validateAuth({ players: 4 }, field)).toBeUndefined();
    expect(validateAuth({ players: 99 }, field)).toEqual([
      { name: 'players', error: 'must be <= 8' },
    ]);
  });

  // `source` резолвится вызывающей стороной через ctx.sources, а auth-форма
  // строится с пустым ctx: у игрока список пуст ('no options available') и
  // войти он не может. Пропустить это на хосте значило бы дать обошедшему
  // форму клиенту то, чего у заполнившего нет вовсе
  it('поле с options.source не принимает произвольную строку', () => {
    expect(
      validateAuth({ map: 'что угодно' }, [
        { name: 'map', options: { control: 'select', source: 'maps' } },
      ]),
    ).toEqual([{ name: 'map', error: 'not an option' }]);
  });

  // билдер такому полю выносит тот же приговор ('unknown control'): оно не
  // строится, в сабмит не попадает и до хоста доезжает только от клиента,
  // обошедшего форму, — а проверить его нечем
  it('поле с неизвестным контролом отвергается, а не проходит по длине', () => {
    expect(
      validateAuth({ x: 'что угодно' }, [
        { name: 'x', options: { control: 'megaslider' } },
      ]),
    ).toEqual([{ name: 'x', error: 'unknown control' }]);
  });

  it('контрол по умолчанию (его нет вовсе) остаётся текстовым', () => {
    expect(validateAuth({ x: 'abc' }, [{ name: 'x' }])).toBeUndefined();
  });
});
