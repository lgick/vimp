import { describe, it, expect, vi } from 'vitest';
import {
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
    const result = validateAuth({ name: 123, model: 'm1' }, authParams, validators);
    expect(result).toEqual([
      { name: 'name', error: 'Property must be a string' },
    ]);
  });

  it('накапливает ошибки валидации', () => {
    const result = validateAuth({ name: '1', model: 'm9' }, authParams, validators);
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
    const params = [{ name: 'tag', options: { regExp: '[a-z]+', required: true } }];

    expect(validateAuth({ tag: '' }, params)).toBeUndefined();
  });

  // список вариантов — самое жёсткое ограничение формы: <select> значения
  // вне своих options не отдаст, и хост обязан требовать того же
  it('отбивает значение вне списка вариантов select/radio', () => {
    const params = [
      { name: 'side', options: { control: 'select', options: ['red', 'blue'] } },
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

  it('поле с source хост не проверяет по списку (каталога он не знает)', () => {
    const params = [
      { name: 'map', options: { control: 'select', source: 'maps' } },
    ];

    expect(validateAuth({ map: 'anything' }, params)).toBeUndefined();
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
    expect(resolveValidator('isValidModel', { isValidModel: 'm1' })).toBeUndefined();
    expect(resolveValidator('isValidName', { isValidName: null })).toBeUndefined();
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
