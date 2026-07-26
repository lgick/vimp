import { describe, it, expect } from 'vitest';
import { formatMessage, roundTo2Decimals } from '../../packages/engine/src/lib/formatters.js';

describe('formatMessage', () => {
  it('подставляет значения по плейсхолдерам', () => {
    expect(formatMessage('Hello, {0} {1}!', ['John', 'Doe'])).toBe(
      'Hello, John Doe!',
    );
  });

  it('оставляет плейсхолдер, если значения нет', () => {
    expect(formatMessage('a {0} b {1}', ['x'])).toBe('a x b {1}');
  });

  it('возвращает сообщение без изменений при пустом массиве', () => {
    expect(formatMessage('no placeholders', [])).toBe('no placeholders');
  });

  it('работает со значениями по умолчанию', () => {
    expect(formatMessage()).toBe('');
    expect(formatMessage('text')).toBe('text');
  });

  it('повторяющиеся плейсхолдеры', () => {
    expect(formatMessage('{0}-{0}', ['x'])).toBe('x-x');
  });
});

describe('roundTo2Decimals', () => {
  it('округляет до двух знаков', () => {
    expect(roundTo2Decimals(10.567)).toBe(10.57);
    expect(roundTo2Decimals(10.564)).toBe(10.56);
  });

  it('целые числа не меняются', () => {
    expect(roundTo2Decimals(10)).toBe(10);
  });

  it('работает с отрицательными', () => {
    expect(roundTo2Decimals(-1.236)).toBe(-1.24);
  });
});
