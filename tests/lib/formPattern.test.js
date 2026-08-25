import { describe, it, expect } from 'vitest';
import { anchorPattern } from '../../packages/engine/src/lib/formPattern.js';

describe('formPattern.anchorPattern', () => {
  // общий якорь клиента (formBuilder.validateField) и правила B5: без него
  // "99" прошло бы против паттерна одной цифры по частичному совпадению
  it('привязывает паттерн ко всей строке', () => {
    const pattern = anchorPattern('[1-8]');

    expect(pattern.test('8')).toBe(true);
    expect(pattern.test('99')).toBe(false);
    expect(pattern.test('a8')).toBe(false);
  });

  it('альтернатива не растаскивает якоря по веткам', () => {
    // без оборачивающей группы `^a|b$` значило бы «начинается на a ИЛИ
    // кончается на b» — ровно та ошибка, которую делает ручное якорение
    const pattern = anchorPattern('a|b');

    expect(pattern.test('b')).toBe(true);
    expect(pattern.test('ab')).toBe(false);
  });

  it('собственные якоря паттерна безвредны', () => {
    expect(anchorPattern('^[a-z]+$').test('abc')).toBe(true);
  });

  it('некомпилируемый паттерн бросает — перехватывает вызывающий', () => {
    // formBuilder гасит это в console.error и снимает ограничение с поля,
    // правило B5 — в строку нарушения
    expect(() => anchorPattern('[1-8')).toThrow(SyntaxError);
  });
});
