import { describe, it, expect, vi } from 'vitest';
import Accolades from '../../packages/engine/src/host/meta/modules/Accolades.js';
import lobbyConfig from '../../packages/engine/src/config/lobby.js';

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

// участник с проверенной личностью. В лобби `name` — это claim
// identity-токена (host/identity.js), и знак выдаётся только такому: гость
// без токена мог бы просто назваться чужим ником
const player = (gameId, name) => ({ gameId, name, token: `tok-${gameId}` });

// day и month приходят одним и тем же роутом, различаются ?period=
const makeFetch = ({ day = () => top([]), month = () => top([]) } = {}) =>
  vi.fn(async (url, opts = {}) =>
    url.includes('period=day') ? day(url, opts) : month(url, opts),
  );

const makeAccolades = (fetchImpl, list, now = () => 0, getRating = () => null) =>
  new Accolades({
    participants: participants(list),
    gameId: 'snakes',
    fetchImpl,
    getRating,
    now,
  });

// рассылка целиком — три части; большинство проверок про места, поэтому
// смотрят они именно на них
const placesOf = payload => payload?.places ?? null;

describe('Accolades: места участников в глобальном топе', () => {
  it('сопоставляет ник без учёта регистра', async () => {
    const fetchImpl = makeFetch({
      day: () => top([{ nick: 'Alice', rank: 90, place: 1 }]),
      month: () => top([{ nick: 'ALICE', rank: 900, place: 4 }]),
    });
    const accolades = makeAccolades(fetchImpl, [player(0, 'alice')]);

    await accolades.refresh();

    expect(placesOf(accolades.shift())).toEqual({ 0: { daily: 1, monthly: 4 } });
  });

  it('бот и гость получают null: записи в auth у них нет', async () => {
    const fetchImpl = makeFetch({
      day: () => top([{ nick: 'Alice', rank: 90, place: 1 }]),
    });
    const accolades = makeAccolades(fetchImpl, [
      player(0, 'Alice'),
      { gameId: 1, name: 'bot-1' }, // scripted: токена нет
    ]);

    await accolades.refresh();

    expect(placesOf(accolades.shift())).toEqual({
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
    const clock = { now: 0 };
    const accolades = makeAccolades(fetchImpl, [player(0, 'Alice')], () => clock.now);

    await accolades.refresh();
    accolades.shift();

    clock.now += lobbyConfig.accolades.refreshInterval;
    await accolades.refresh();

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
    const clock = { now: 0 };
    const accolades = makeAccolades(fetchImpl, [player(0, 'Alice')], () => clock.now);

    await accolades.refresh();
    accolades.shift();

    fail = true;
    clock.now += lobbyConfig.accolades.refreshInterval;
    await accolades.refresh();

    expect(accolades.shift()).toBeNull();
  });

  // вход участника — это пересчёт по уже известным срезам, а не поход за
  // ними: иначе наплыв в комнату стоил бы по два запроса на вход, а при уже
  // летящем опросе новичок терялся бы до следующего refreshInterval
  it('noteRoster пересчитывает места новичка, не трогая сеть', async () => {
    const fetchImpl = makeFetch({
      day: () => top([{ nick: 'Alice', rank: 90, place: 1 }]),
    });
    const list = [player(0, 'Bob')];
    const accolades = makeAccolades(fetchImpl, list);

    await accolades.refresh();
    accolades.shift();

    const afterRefresh = fetchImpl.mock.calls.length;

    list.push(player(1, 'Alice'));
    accolades.noteRoster();

    expect(fetchImpl.mock.calls.length).toBe(afterRefresh);
    expect(placesOf(accolades.shift())).toEqual({
      0: { daily: null, monthly: null },
      1: { daily: 1, monthly: null },
    });
  });

  // ***** ЗА ТОПОМ ХОДИТ КОМНАТА, А НЕ ИГРОК *****
  //
  // Тот же топ рисуется клиенту по Tab: он приезжает ЭТОЙ рассылкой, и в
  // матче клиент к мастеру не обращается вовсе. На целевом масштабе (100 игр
  // × 100 серверов × 8 игроков) это разница между 5300 запросами в секунду,
  // которые ничем не схлопываются, и 440, которые схлопываются TTL-кэшем
  it('везёт клиенту сам топ строками, а не только места', async () => {
    const fetchImpl = makeFetch({
      day: () =>
        top([
          { nick: 'Alice', rank: 90, place: 1 },
          { nick: 'Bob', rank: 80, place: 2 },
        ]),
    });
    const accolades = makeAccolades(fetchImpl, [player(0, 'Alice')]);

    await accolades.refresh();

    expect(accolades.shift().boards.day).toEqual([
      { place: 1, nick: 'Alice', score: 90 },
      { place: 2, nick: 'Bob', score: 80 },
    ]);
  });

  // игрок вне топа-10 должен видеть по Tab СВОЮ строку, а взять её больше
  // неоткуда: топ его по определению не содержит. Место привозит
  // PlayerDataSync на входе игрока
  it('везёт участнику его собственное место и очки', async () => {
    const fetchImpl = makeFetch({
      day: () => top([{ nick: 'Alice', rank: 90, place: 1 }]),
    });
    const accolades = makeAccolades(
      fetchImpl,
      [player(0, 'Zoe')],
      () => 0,
      (id, period) =>
        period === 'day' ? { value: 12, placement: 431, total: 900 } : null,
    );

    await accolades.refresh();

    expect(accolades.shift().self).toEqual({ 0: { day: { place: 431, score: 12 } } });
  });

  // гость и бот в рассылку своей строки не попадают по той же причине, по
  // которой не получают знака: их личность не проверена
  it('своей строки без проверенной личности не бывает', async () => {
    const fetchImpl = makeFetch();
    const accolades = makeAccolades(
      fetchImpl,
      [{ gameId: 0, name: 'Zoe' }],
      () => 0,
      () => ({ value: 12, placement: 431, total: 900 }),
    );

    await accolades.refresh();

    expect(accolades.shift().self).toEqual({});
  });

  // в лобби `name` — claim проверенного identity-токена (host/identity.js), а
  // в гостевом контуре это поле формы, которое createGuestIdentity прямо
  // объявляет незащищённым от подмены. Сопоставление идёт по нику, поэтому
  // знак получает только тот, чья личность проверена
  it('не выдаёт знак участнику без проверенной личности', async () => {
    const fetchImpl = makeFetch({
      day: () => top([{ nick: 'Alice', rank: 90, place: 1 }]),
    });
    const accolades = makeAccolades(fetchImpl, [
      { gameId: 0, name: 'Alice' }, // гость, назвавшийся ником из топа
      player(1, 'Alice'),
    ]);

    await accolades.refresh();

    expect(placesOf(accolades.shift())).toEqual({
      0: { daily: null, monthly: null },
      1: { daily: 1, monthly: null },
    });
  });
});
