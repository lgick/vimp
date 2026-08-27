import { describe, it, expect, vi } from 'vitest';
import Accolades from '../../packages/engine/src/host/meta/modules/Accolades.js';

// ответ мастера: топ-N среза + ETag, по которому следующий запрос получит 304
const top = (rows, etag = 'W/"top"') => ({
  ok: true,
  status: 200,
  headers: { get: name => (name === 'etag' ? etag : null) },
  json: async () => ({ leaderboard: rows, total: rows.length }),
});

const notModified = () => ({
  ok: false,
  status: 304,
  headers: { get: () => null },
  json: async () => null,
});

const participants = list => ({ getAll: () => list });

// day и month приходят одним и тем же роутом, различаются ?period=
const makeFetch = ({ day = () => top([]), month = () => top([]) } = {}) =>
  vi.fn(async (url, opts = {}) =>
    url.includes('period=day') ? day(url, opts) : month(url, opts),
  );

const makeAccolades = (fetchImpl, list, now = () => 0) =>
  new Accolades({
    participants: participants(list),
    gameId: 'snakes',
    fetchImpl,
    now,
  });

describe('Accolades: места участников в глобальном топе', () => {
  it('сопоставляет ник без учёта регистра', async () => {
    const fetchImpl = makeFetch({
      day: () => top([{ nick: 'Alice', rank: 90, place: 1 }]),
      month: () => top([{ nick: 'ALICE', rank: 900, place: 4 }]),
    });
    const accolades = makeAccolades(fetchImpl, [{ gameId: 0, name: 'alice' }]);

    await accolades.refresh();

    expect(accolades.shift()).toEqual({ 0: { daily: 1, monthly: 4 } });
  });

  it('бот и гость получают null: записи в auth у них нет', async () => {
    const fetchImpl = makeFetch({
      day: () => top([{ nick: 'Alice', rank: 90, place: 1 }]),
    });
    const accolades = makeAccolades(fetchImpl, [
      { gameId: 0, name: 'Alice' },
      { gameId: 1, name: 'bot-1' },
    ]);

    await accolades.refresh();

    expect(accolades.shift()).toEqual({
      0: { daily: 1, monthly: null },
      1: { daily: null, monthly: null },
    });
  });

  it('shift отдаёт null, пока места не изменились', async () => {
    const fetchImpl = makeFetch({
      day: () => top([{ nick: 'Alice', rank: 90, place: 1 }]),
    });
    const accolades = makeAccolades(fetchImpl, [{ gameId: 0, name: 'Alice' }]);

    await accolades.refresh();

    expect(accolades.shift()).not.toBeNull();
    expect(accolades.shift()).toBeNull();
  });

  it('запрос идёт с If-None-Match, а 304 не считается изменением', async () => {
    let calls = 0;
    const fetchImpl = makeFetch({
      day: () => {
        calls += 1;

        return calls === 1
          ? top([{ nick: 'Alice', rank: 90, place: 1 }])
          : notModified();
      },
    });
    const accolades = makeAccolades(fetchImpl, [{ gameId: 0, name: 'Alice' }]);

    await accolades.refresh();
    accolades.shift();

    await accolades.refresh({ force: true });

    const [, opts] = fetchImpl.mock.calls.find(([url]) =>
      url.includes('period=day&') || url.endsWith('period=day'),
    );

    expect(opts.headers['if-none-match']).toBeUndefined();

    const second = fetchImpl.mock.calls.filter(([url]) =>
      url.includes('period=day'),
    )[1];

    expect(second[1].headers['if-none-match']).toBe('W/"top"');
    // топ тот же и состав комнаты тот же — рассылать нечего
    expect(accolades.shift()).toBeNull();
  });

  it('периодический tick не ходит чаще refreshInterval', async () => {
    let clock = 0;
    const fetchImpl = makeFetch();
    const accolades = makeAccolades(fetchImpl, [{ gameId: 0, name: 'Alice' }], () => clock);

    await accolades.refresh();
    const afterFirst = fetchImpl.mock.calls.length;

    clock = 1000;
    await accolades.refresh();

    expect(fetchImpl.mock.calls.length).toBe(afterFirst);

    clock = 60000;
    await accolades.refresh();

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('недоступность мастера оставляет прошлые места', async () => {
    let fail = false;
    const fetchImpl = makeFetch({
      day: () => {
        if (fail) {
          throw new Error('offline');
        }

        return top([{ nick: 'Alice', rank: 90, place: 1 }]);
      },
    });
    const accolades = makeAccolades(fetchImpl, [{ gameId: 0, name: 'Alice' }]);

    await accolades.refresh();
    accolades.shift();

    fail = true;
    await accolades.refresh({ force: true });

    expect(accolades.shift()).toBeNull();
  });
});
