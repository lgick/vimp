import { describe, it, expect } from 'vitest';
import { etagFor, isNotModified } from '../../packages/engine/src/master/etag.js';

// «Не изменилось — не отправляем» на стороне чтения (snakes-v3 3.3, решение
// пользователя 9): топ рейтинга меняется медленно, а лобби перезапрашивает
// его на каждое открытие вкладки
describe('etag', () => {
  it('одинаковое тело — одинаковый валидатор, разное — разный', () => {
    const json = { leaderboard: [{ nick: 'a', rank: 10 }], total: 1 };

    expect(etagFor(json)).toBe(etagFor({ ...json }));
    expect(etagFor(json)).not.toBe(etagFor({ ...json, total: 2 }));
  });

  it('валидатор слабый (W/) — сжатие и заголовки мастер не контролирует', () => {
    expect(etagFor({})).toMatch(/^W\/"[0-9a-f]{40}"$/);
  });

  it('совпадение If-None-Match — 304, промах — нет', () => {
    const etag = etagFor({ total: 1 });

    expect(isNotModified(etag, etag)).toBe(true);
    expect(isNotModified(etagFor({ total: 2 }), etag)).toBe(false);
  });

  it('список валидаторов и сильная форма сравниваются по слабому правилу', () => {
    const etag = etagFor({ total: 1 });
    const strong = etag.replace('W/', '');

    expect(isNotModified(`"deadbeef", ${strong}`, etag)).toBe(true);
  });

  it('без заголовка — не 304', () => {
    expect(isNotModified(undefined, etagFor({}))).toBe(false);
    expect(isNotModified('', etagFor({}))).toBe(false);
  });
});
