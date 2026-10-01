import { describe, test, expect } from 'vitest';

import {
  readDedicatedRoom,
  readRoomSecretKey,
} from '../../packages/engine/src/config/env.js';

// VIMP_DEDICATED_ROOM приезжает из SERVERS_MATRIX через toJSON(matrix.settings),
// схлопнутый в одну строку через jq -c (см. .github/workflows/deploy.yml):
// отсутствующее поле даёт строку 'null', поэтому мусор обязан давать
// именованный отказ, а не TypeError.
describe('readDedicatedRoom', () => {
  test('пустое значение — переменная считается незаданной', () => {
    expect(readDedicatedRoom({})).toEqual({});
    expect(readDedicatedRoom({ VIMP_DEDICATED_ROOM: '' })).toEqual({});
  });

  test('JSON-объект разбирается как есть', () => {
    const env = { VIMP_DEDICATED_ROOM: '{"map":"arena","maxPlayers":8}' };

    expect(readDedicatedRoom(env)).toEqual({ map: 'arena', maxPlayers: 8 });
  });

  // Многострочный JSON движок читает штатно: проблема toJSON в deploy.yml
  // была не здесь, а в формате .env — env_file docker compose разбирает
  // файл построчно и спотыкается на продолжении объекта. Поэтому тест
  // движка её и не ловил, а чинится она на раннере (jq -c)
  test('переводы строк внутри JSON разбору не мешают', () => {
    const env = { VIMP_DEDICATED_ROOM: '{\n  "maxPlayers": 8\n}' };

    expect(readDedicatedRoom(env)).toEqual({ maxPlayers: 8 });
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

// ключ секрета комнаты (host-migration, этап 2): без него в проде reclaim_host
// после рестарта мастера не отличил бы хоста от угонщика
describe('readRoomSecretKey', () => {
  const randomBytes = n => Buffer.alloc(n, 7);

  test('в production обязателен', () => {
    expect(() =>
      readRoomSecretKey({}, { isProduction: true, randomBytes }),
    ).toThrow(/VIMP_ROOM_SECRET_KEY must be set/);
  });

  test('заданный ключ берётся как есть', () => {
    const key = 'k'.repeat(32);

    expect(
      readRoomSecretKey(
        { VIMP_ROOM_SECRET_KEY: key },
        { isProduction: true, randomBytes },
      ),
    ).toEqual({ key, ephemeral: false });
  });

  test('ключ короче 32 байт — именованный отказ и в dev', () => {
    expect(() =>
      readRoomSecretKey(
        { VIMP_ROOM_SECRET_KEY: 'short' },
        { isProduction: false, randomBytes },
      ),
    ).toThrow(/at least 32 bytes/);
  });

  test('в dev без ключа генерируется случайный на время процесса', () => {
    const { key, ephemeral } = readRoomSecretKey(
      {},
      { isProduction: false, randomBytes },
    );

    expect(ephemeral).toBe(true);
    expect(key).toEqual(Buffer.alloc(32, 7));
  });
});
