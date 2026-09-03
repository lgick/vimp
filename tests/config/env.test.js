import { describe, test, expect } from 'vitest';

import { readDedicatedRoom } from '../../packages/engine/src/config/env.js';

// VIMP_DEDICATED_ROOM приезжает из SERVERS_MATRIX через toJSON(matrix.settings)
// (см. .github/workflows/deploy.yml): отсутствующее поле даёт строку 'null',
// поэтому мусор обязан давать именованный отказ, а не TypeError.
describe('readDedicatedRoom', () => {
  test('пустое значение — переменная считается незаданной', () => {
    expect(readDedicatedRoom({})).toEqual({});
    expect(readDedicatedRoom({ VIMP_DEDICATED_ROOM: '' })).toEqual({});
  });

  test('JSON-объект разбирается как есть', () => {
    const env = { VIMP_DEDICATED_ROOM: '{"map":"arena","maxPlayers":8}' };

    expect(readDedicatedRoom(env)).toEqual({ map: 'arena', maxPlayers: 8 });
  });

  test("строка 'null' — именованный отказ, а не TypeError", () => {
    const env = { VIMP_DEDICATED_ROOM: 'null' };

    expect(() => readDedicatedRoom(env)).toThrow(
      /VIMP_DEDICATED_ROOM: expected a JSON object/,
    );
  });

  test('массив не объект — именованный отказ', () => {
    const env = { VIMP_DEDICATED_ROOM: '[]' };

    expect(() => readDedicatedRoom(env)).toThrow(
      /VIMP_DEDICATED_ROOM: expected a JSON object/,
    );
  });

  test('невалидный JSON — именованный отказ', () => {
    const env = { VIMP_DEDICATED_ROOM: '{map:' };

    expect(() => readDedicatedRoom(env)).toThrow(
      /VIMP_DEDICATED_ROOM: invalid JSON/,
    );
  });
});
