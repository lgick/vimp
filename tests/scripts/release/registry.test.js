import { describe, it, expect } from 'vitest';

import { crateIndexPath, parseNpmView } from '../../../scripts/release/registry.js';

describe('crateIndexPath', () => {
  it('раскладывает имя по правилам sparse-индекса', () => {
    expect(crateIndexPath('a')).toBe('1/a');
    expect(crateIndexPath('ab')).toBe('2/ab');
    expect(crateIndexPath('abc')).toBe('3/a/abc');
    expect(crateIndexPath('vimp-engine-core')).toBe('vi/mp/vimp-engine-core');
  });
});

describe('parseNpmView', () => {
  it('возвращает версию из stdout', () => {
    expect(
      parseNpmView('vimp-engine', { code: 0, stdout: '"0.6.0"\n', stderr: '' }),
    ).toBe('0.6.0');
  });

  it('не спотыкается о предупреждение в stderr', () => {
    expect(
      parseNpmView('vimp-engine', {
        code: 0,
        stdout: '"0.6.0"\n',
        stderr: 'npm warn Unknown env config "some-typo".\n',
      }),
    ).toBe('0.6.0');
  });

  it('берёт последнюю версию, если npm отдал массив', () => {
    expect(
      parseNpmView('vimp-engine', {
        code: 0,
        stdout: '["0.5.0","0.6.0"]',
        stderr: '',
      }),
    ).toBe('0.6.0');
  });

  it('E404 — это «пакета нет», валидный ответ', () => {
    expect(
      parseNpmView('@vimp-games/nope', {
        code: 1,
        stdout: '{"error":{"code":"E404","summary":"Not Found"}}',
        stderr: '',
      }),
    ).toBeNull();
  });

  // молчаливый null здесь означал бы «ещё не публиковался» → публикацию
  // поверх уже опубликованного
  it('любой другой отказ — это исключение, а не null', () => {
    expect(() =>
      parseNpmView('vimp-engine', {
        code: 1,
        stdout: '',
        stderr: 'network timeout',
      }),
    ).toThrow(/не ответил/);
  });
});
