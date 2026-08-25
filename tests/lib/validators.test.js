import { describe, it, expect } from 'vitest';
import { isValidName, validateAuth, clampLimit } from '../../packages/engine/src/lib/validators.js';

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

  it('поле без maxlength/regExp проходит любой строкой', () => {
    const params = [{ name: 'tag', options: { control: 'text' } }];

    expect(validateAuth({ tag: 'x'.repeat(10000) }, params)).toBeUndefined();
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

  it('незарегистрированное имя валидатора молча пропускает поле (без ошибки и без throw)', () => {
    const params = [{ name: 'model', options: { validator: 'isValidModel' } }];
    // validators не передан — isValidModel не найден в rules
    expect(() => validateAuth({ model: 'm1' }, params)).not.toThrow();
    expect(validateAuth({ model: 'm1' }, params)).toBeUndefined();
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
