import { describe, it, expect } from 'vitest';
import {
  computeFingerprint,
  isFrameLine,
  normalizeMessage,
  parseFrame,
  rawTopFrame,
} from '../../packages/engine/src/master/clientReports/fingerprint.js';

// Отпечаток журнала клиентских ошибок (решение 4 плана client-reports)

describe('parseFrame', () => {
  it('имя функции и место в форматах V8 и Firefox/Safari', () => {
    const expected = { fn: 'Tr', url: 'https://h/a.js', line: 84, col: 46108 };

    expect(parseFrame('    at Tr (https://h/a.js:84:46108)')).toEqual(expected);
    expect(parseFrame('Tr@https://h/a.js:84:46108')).toEqual(expected);
    expect(parseFrame('    at https://h/a.js:84:46108')).toEqual({
      ...expected,
      fn: null,
    });
    expect(parseFrame('TypeError: boom')).toBeNull();
  });
});

describe('rawTopFrame', () => {
  it('V8 и Firefox/Safari дают одинаковый pathname:line:col', () => {
    const v8 = [
      "TypeError: Cannot read properties of null (reading 'x')",
      '    at Tr (https://vimp.example/assets/client-BvkP3FTH.js:84:46108)',
      '    at oa._applyModel (https://vimp.example/assets/client-BvkP3FTH.js:210:14757)',
    ].join('\n');
    const v8Anon =
      '    at https://vimp.example/assets/client-BvkP3FTH.js:84:46108';
    const firefox =
      'Tr@https://localhost:3002/assets/client-BvkP3FTH.js:84:46108\n';

    expect(rawTopFrame(v8)).toBe('/assets/client-BvkP3FTH.js:84:46108');
    expect(rawTopFrame(v8Anon)).toBe('/assets/client-BvkP3FTH.js:84:46108');
    expect(rawTopFrame(firefox)).toBe('/assets/client-BvkP3FTH.js:84:46108');
  });

  it('строка сообщения V8 с url:line:col — не кадр', () => {
    const stack =
      'Error: failed https://h/a.js:1:2\n    at f (https://h/b.js:3:4)';

    expect(rawTopFrame(stack)).toBe('/b.js:3:4');
  });

  it('нет кадра с URL — null', () => {
    expect(rawTopFrame('Error: x\n    at <anonymous>')).toBeNull();
    expect(rawTopFrame(null)).toBeNull();
  });
});

describe('isFrameLine', () => {
  it('кадр — строка `at …` или `fn@url`, сообщение — нет', () => {
    expect(isFrameLine('    at f (https://h/a.js:1:2)')).toBe(true);
    expect(isFrameLine('Tr@https://h/a.js:1:2')).toBe(true);
    expect(isFrameLine('global code@https://h/a.js:1:2')).toBe(true);
    expect(isFrameLine('TypeError: x')).toBe(false);
    expect(isFrameLine('Error: failed https://h/a.js:1:2')).toBe(false);
  });
});

describe('normalizeMessage', () => {
  it('числа → N, длинный hex → H', () => {
    expect(
      normalizeMessage('  room 12 of deadbeef00112233 failed at 3  '),
    ).toBe('room N of H failed at N');
  });

  it('длина ключа ограничена', () => {
    expect(normalizeMessage('x'.repeat(500))).toHaveLength(200);
  });
});

describe('computeFingerprint', () => {
  const base = {
    source: 'client',
    kind: 'error',
    code: null,
    message: 'player 17 missing',
    stack: '    at f (https://a.example/x.js:1:2)',
    engineVersion: '0.34.8',
    gameId: 'tanks',
    gameVersion: '0.22.7',
  };

  it('sha256-hex; числа в сообщении и хост в стеке ключ не меняют', () => {
    const fp = computeFingerprint(base);

    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(
      computeFingerprint({
        ...base,
        message: 'player 99 missing',
        stack: 'f@https://b.example/x.js:1:2',
      }),
    ).toBe(fp);
  });

  it('не зависит от count и времени', () => {
    expect(
      computeFingerprint({ ...base, count: 5, firstAt: 1, lastAt: 2 }),
    ).toBe(computeFingerprint(base));
  });

  it('зависит от версий движка и игры и от extra', () => {
    const fp = computeFingerprint(base);

    expect(computeFingerprint({ ...base, engineVersion: '0.34.9' })).not.toBe(
      fp,
    );
    expect(computeFingerprint({ ...base, gameVersion: '0.22.8' })).not.toBe(fp);
    expect(computeFingerprint({ ...base, extra: 'a.example' })).not.toBe(fp);
    expect(computeFingerprint({ ...base, extra: 'a.example' })).not.toBe(
      computeFingerprint({ ...base, extra: 'b.example' }),
    );
  });

  it('code заменяет сообщение в ключе', () => {
    expect(computeFingerprint({ ...base, code: 'tanks.x', message: 'a' })).toBe(
      computeFingerprint({ ...base, code: 'tanks.x', message: 'b' }),
    );
  });
});
