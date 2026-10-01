import { describe, it, expect, vi } from 'vitest';
import lobbyConfig from '../../packages/engine/src/config/lobby.js';
import PlayerDataSync from '../../packages/engine/src/host/meta/modules/PlayerDataSync.js';

const okJson = json => ({ ok: true, status: 200, json: async () => json });
const fail = (status = 500) => ({
  ok: false,
  status,
  json: async () => ({ error: 'down' }),
});

const PLACEMENTS = {
  day: { rank: 40, placement: 3, total: 100 },
  month: { rank: 400, placement: 7, total: 100 },
  all: { rank: 4000, placement: 9, total: 100 },
};

// маршрутизация по URL, а не по порядку вызовов: с грязными флагами
// (snakes-v3 этап 3) число запросов flush'а перестало быть постоянным
const makeFetch = ({
  placements = () => okJson(PLACEMENTS),
  state = () => okJson({ state: {} }),
  placement = () => okJson({ placement: 1, total: 10, rank: 50 }),
  put = () => okJson({ ok: true }),
} = {}) =>
  vi.fn(async (url, opts = {}) => {
    if (opts.method === 'PUT') {
      return put(url, opts);
    }

    if (url.startsWith('/auth/placements')) {
      return placements(url, opts);
    }

    if (url.startsWith('/auth/placement')) {
      return placement(url, opts);
    }

    return state(url, opts);
  });

// время впрыскивается: интервал, очередь и бэкофф — это время, и проверять
// их реальными таймерами значит проверять их секундами ожидания
const makeSync = (fetchImpl, options = {}) => {
  const clock = { now: 1_000_000 };
  const sync = new PlayerDataSync('tanks', {
    fetchImpl,
    now: () => clock.now,
    sleep: ms => {
      clock.now += ms;

      return Promise.resolve();
    },
    random: () => 0.5, // середина диапазона джиттера — ровно minFlushInterval
    writeSeqStart: () => 2 ** 47, // старт номеров записей (host-migration 7.7)
    ...options,
  });

  return { sync, clock };
};

const putCalls = fetchImpl =>
  fetchImpl.mock.calls.filter(([, opts]) => opts.method === 'PUT');

describe('PlayerDataSync.load', () => {
  it('берёт три среза одним запросом и заполняет ratings', async () => {
    const fetchImpl = makeFetch();
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');

    // ровно два GET: агрегирующий placements + state
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith('/auth/placements?game=tanks', {
      method: 'GET',
      headers: { authorization: 'Bearer tok' },
      body: undefined,
    });
    expect(sync.getRating('p1', 'day')).toEqual({
      value: 40,
      placement: 3,
      total: 100,
    });
    expect(sync.getRating('p1', 'month')).toEqual({
      value: 400,
      placement: 7,
      total: 100,
    });
    expect(sync.getRating('p1', 'all')).toEqual({
      value: 4000,
      placement: 9,
      total: 100,
    });
    expect(sync.isRatingLoaded('p1')).toBe(true);
  });

  // регрессия: голый `fetch` в поле объекта вызывался как this._fetch(...), то
  // есть с получателем-экземпляром — в браузере/воркере это TypeError до сети,
  // и весь обмен профилями молча отключался. Тесты этого не ловили, потому
  // что всегда подставляли fetchImpl (обычную функцию без brand-check)
  it('дефолтный fetch вызывается без привязки к экземпляру', async () => {
    const receivers = [];
    const original = globalThis.fetch;

    globalThis.fetch = function (...args) {
      receivers.push(this);

      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ state: {} }),
      });
    };

    try {
      // без fetchImpl — ровно так модуль создаётся в HostGame
      await new PlayerDataSync('tanks').load('p1', 'tok');
    } finally {
      globalThis.fetch = original;
    }

    expect(receivers).toHaveLength(2);
    receivers.forEach(receiver =>
      expect(receiver).not.toBeInstanceOf(PlayerDataSync),
    );
  });

  it('оставляет дефолты при сбое auth-сервиса', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const { sync } = makeSync(fetchImpl, { defaultState: { skill: 0 } });

    await sync.load('p1', 'tok');

    expect(sync.getRating('p1', 'all')).toEqual({
      value: 0,
      placement: null,
      total: 0,
    });
    expect(sync.getState('p1')).toEqual({ skill: 0 });
    // сбой — это «рейтинга нет», а не «рейтинг 0»
    expect(sync.isRatingLoaded('p1')).toBe(false);
  });

  // getRating отдаёт нули и знакомому участнику до ответа мастера: игре,
  // которая пишет рейтинг в stat колонкой '=', такой ноль затирает
  // настоящее значение, поэтому загруженность видна отдельно
  it('isRatingLoaded отличает «0» от «данных ещё нет»', async () => {
    const fetchImpl = makeFetch({
      placements: () => okJson({ all: { rank: 0 } }),
    });
    const { sync } = makeSync(fetchImpl);

    expect(sync.isRatingLoaded('p1')).toBe(false);

    await sync.load('p1', 'tok');

    expect(sync.getRank('p1')).toBe(0);
    expect(sync.isRatingLoaded('p1')).toBe(true);
  });

  it('очки, добавленные во время загрузки, не теряются под серверным значением (F9)', async () => {
    let resolvePlacements;
    const fetchImpl = vi.fn(url => {
      if (url.startsWith('/auth/placements')) {
        return new Promise(resolve => {
          resolvePlacements = () => resolve(okJson({ month: { rank: 100 } }));
        });
      }

      return Promise.resolve(okJson({ state: {} }));
    });
    const { sync } = makeSync(fetchImpl);

    const loadPromise = sync.load('p1', 'tok');

    sync.addPoints('p1', 5);
    sync.finishGame('p1');
    resolvePlacements();
    await loadPromise;

    expect(sync.getRating('p1', 'month').value).toBe(105);
  });

  it('defaultState клонируется на каждую запись, не расшаривается между участниками (F10)', async () => {
    const fetchImpl = makeFetch({ state: () => fail(404) });
    const { sync } = makeSync(fetchImpl, { defaultState: { skill: 0 } });

    await sync.load('p1', 'tok1');
    await sync.load('p2', 'tok2');

    sync.getState('p1').skill = 99;

    expect(sync.getState('p2')).toEqual({ skill: 0 });
  });
});

// повторный load() — обычный путь, а не гонка: _sync повторяет его после
// неудачной первой загрузки, и к тому моменту игрок успел доиграть
describe('PlayerDataSync.load: срезы агрегируются каждый по-своему', () => {
  it('день берёт максимум, месяц складывает, all-time не двигается локально', async () => {
    let offline = true;
    const fetchImpl = makeFetch({
      placements: () =>
        offline
          ? fail(503)
          : okJson({
              day: { rank: 50, placement: 3, total: 100 },
              month: { rank: 500, placement: 7, total: 100 },
              all: { rank: 5000, placement: 9, total: 100 },
            }),
    });
    const { sync } = makeSync(fetchImpl);

    // auth недоступен на входе: участник стартует с нулей
    await sync.load('p1', 'tok');

    expect(sync.isRatingLoaded('p1')).toBe(false);

    // и успевает доиграть две жизни до того, как загрузка удалась
    sync.addPoints('p1', 100);
    sync.finishGame('p1');
    sync.addPoints('p1', 30);
    sync.finishGame('p1');

    offline = false;
    await sync.load('p1', 'tok');

    // день — МАКСИМУМ одной игры: 100 против серверных 50, а не 150
    expect(sync.getRating('p1', 'day').value).toBe(100);
    // месяц — сумма: 130 своих плюс 500 серверных
    expect(sync.getRating('p1', 'month').value).toBe(630);
    // all-time локально не двигается вовсе — это суточный снимок
    expect(sync.getRating('p1', 'all').value).toBe(5000);
  });
});

describe('PlayerDataSync.finishGame', () => {
  const loaded = async () => {
    const fetchImpl = makeFetch({ placements: () => okJson({}) });
    const made = makeSync(fetchImpl);

    await made.sync.load('p1', 'tok');

    return { ...made, fetchImpl };
  };

  it('кладёт очки текущей игры в сумму и в максимум и обнуляет текущую', async () => {
    const { sync, clock, fetchImpl } = await loaded();

    sync.addPoints('p1', 40);
    sync.finishGame('p1');

    expect(sync.getRating('p1', 'day').value).toBe(40);
    expect(sync.getRating('p1', 'month').value).toBe(40);
    // вторая игра начинается с нуля
    sync.addPoints('p1', 10);
    expect(sync.getRating('p1', 'day').value).toBe(40);

    sync.finishGame('p1');
    clock.now += lobbyConfig.playerData.minFlushInterval;
    await sync.flush('p1');

    const [, opts] = putCalls(fetchImpl).find(([url]) =>
      url.startsWith('/auth/rank'),
    );

    expect(JSON.parse(opts.body)).toMatchObject({ points: 50, best: 40 });
  });

  it('вторая игра хуже первой не роняет максимум', async () => {
    const { sync } = await loaded();

    sync.addPoints('p1', 40);
    sync.finishGame('p1');
    sync.addPoints('p1', 10);
    sync.finishGame('p1');

    expect(sync.getRating('p1', 'day').value).toBe(40);
    expect(sync.getRating('p1', 'month').value).toBe(50);
  });

  it('all-time не двигается локально: он суточный снимок', async () => {
    const fetchImpl = makeFetch();
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    sync.addPoints('p1', 40);
    sync.finishGame('p1');

    expect(sync.getRating('p1', 'day').value).toBe(40);
    expect(sync.getRating('p1', 'all').value).toBe(4000);
  });

  it('при нулевых очках не делает ничего: пустых записей в леджере нет', async () => {
    const { sync, clock, fetchImpl } = await loaded();

    sync.finishGame('p1');
    // отрицательный счёт (огонь по своим) — это не результат, а ноль
    sync.addPoints('p1', -2);
    sync.finishGame('p1');

    fetchImpl.mockClear();
    clock.now += lobbyConfig.playerData.minFlushInterval;
    await sync.flush('p1');

    expect(putCalls(fetchImpl)).toHaveLength(0);
  });

  it('addRank остаётся алиасом addPoints (старые игры и RoundManager.reportKill)', async () => {
    const { sync } = await loaded();

    sync.addRank('p1', 3);
    sync.finishGame('p1');

    expect(sync.getRating('p1', 'month').value).toBe(3);
  });

  it('finishAllGames закрывает игру каждого участника (границы раунда/карты)', async () => {
    const fetchImpl = makeFetch({ placements: () => okJson({}) });
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'tok1');
    await sync.load('p2', 'tok2');
    sync.addPoints('p1', 5);
    sync.addPoints('p2', 7);
    sync.finishAllGames();

    expect(sync.getRating('p1', 'day').value).toBe(5);
    expect(sync.getRating('p2', 'day').value).toBe(7);
  });
});

describe('PlayerDataSync.refreshPlacement', () => {
  it('перезапрашивает срез точечно и обновляет место', async () => {
    const fetchImpl = makeFetch();
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    clock.now += lobbyConfig.playerData.placementTtl;
    fetchImpl.mockClear();

    const rating = await sync.refreshPlacement('p1', 'day');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      '/auth/placement?game=tanks&period=day',
    );
    expect(rating).toEqual({ value: 50, placement: 1, total: 10 });
  });

  it('внутри placementTtl второй запрос не делает', async () => {
    const fetchImpl = makeFetch();
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    clock.now += lobbyConfig.playerData.placementTtl;
    await sync.refreshPlacement('p1', 'day');
    fetchImpl.mockClear();

    clock.now += lobbyConfig.playerData.placementTtl - 1;
    await sync.refreshPlacement('p1', 'day');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('не показывает меньше уже показанного, пока результат не отправлен', async () => {
    const fetchImpl = makeFetch();
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    sync.addPoints('p1', 90);
    sync.finishGame('p1');
    clock.now += lobbyConfig.playerData.placementTtl;

    // сервер о неотправленных 90 ещё не знает и отвечает 50
    expect((await sync.refreshPlacement('p1', 'day')).value).toBe(90);
  });

  it('незнакомый участник и незнакомый период — null', async () => {
    const { sync } = makeSync(makeFetch());

    expect(await sync.refreshPlacement('ghost', 'day')).toBeNull();
    expect(sync.getRating('ghost', 'day')).toBeNull();
  });
});

describe('PlayerDataSync.flush', () => {
  const loaded = async (overrides = {}) => {
    const fetchImpl = makeFetch(overrides);
    const made = makeSync(fetchImpl);

    await made.sync.load('p1', 'tok');
    made.sync.setRoom({ roomId: 'room-1', roomSecret: 'secret-1' });
    made.clock.now += lobbyConfig.playerData.minFlushInterval;
    fetchImpl.mockClear();

    return { ...made, fetchImpl };
  };

  it('шлёт результат игры { points, best } с roomId для атрибуции', async () => {
    const { sync, fetchImpl } = await loaded();

    sync.addPoints('p1', 2);
    sync.finishGame('p1');
    await sync.flush('p1');

    expect(fetchImpl).toHaveBeenCalledWith('/auth/rank?game=tanks', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer tok',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        points: 2,
        best: 2,
        // старт номеров 2^47 (makeSync), это первая запись
        writeSeq: 2 ** 47 + 1,
        roomId: 'room-1',
        roomSecret: 'secret-1',
      }),
    });
  });

  // без setRoom PUT несёт roomId/roomSecret: null — мастер пишет событие
  // без комнаты (rate-limit по IP), а не отклоняет
  it('без setRoom шлёт roomId/roomSecret: null (атрибуция не назначена)', async () => {
    const fetchImpl = makeFetch();
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    sync.addPoints('p1', 2);
    sync.finishGame('p1');
    clock.now += lobbyConfig.playerData.minFlushInterval;
    await sync.flush('p1');

    const [, opts] = putCalls(fetchImpl).find(([url]) =>
      url.startsWith('/auth/rank'),
    );

    expect(JSON.parse(opts.body)).toMatchObject({
      roomId: null,
      roomSecret: null,
    });
  });

  it('после успеха не переотправляет уже учтённый результат', async () => {
    const { sync, clock, fetchImpl } = await loaded();

    sync.addPoints('p1', 2);
    sync.finishGame('p1');
    await sync.flush('p1');

    fetchImpl.mockClear();
    clock.now += lobbyConfig.playerData.minFlushInterval;
    await sync.flush('p1');

    expect(putCalls(fetchImpl)).toHaveLength(0);
  });

  it('не теряет результат, если PUT rank завершился неуспехом', async () => {
    let ok = false;
    const { sync, clock, fetchImpl } = await loaded({
      put: () => (ok ? okJson({ ok: true }) : fail(500)),
    });

    sync.addPoints('p1', 3);
    sync.finishGame('p1');
    await sync.flush('p1');

    ok = true;
    fetchImpl.mockClear();
    clock.now += lobbyConfig.playerData.minFlushInterval;
    await sync.flush('p1', { urgent: true });

    const [, opts] = putCalls(fetchImpl).find(([url]) =>
      url.startsWith('/auth/rank'),
    );

    expect(JSON.parse(opts.body)).toMatchObject({ points: 3, best: 3 });
  });

  it('изменённый state уходит PUT state текущим значением', async () => {
    const { sync, fetchImpl } = await loaded();

    sync.setState('p1', { skill: 9 });
    await sync.flush('p1');

    expect(fetchImpl).toHaveBeenCalledWith('/auth/state?game=tanks', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer tok',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        state: { skill: 9 },
        roomId: 'room-1',
        roomSecret: 'secret-1',
      }),
    });
  });

  it('неизвестного участника не бросает исключение', async () => {
    const { sync } = makeSync(vi.fn());

    await expect(sync.flush('ghost')).resolves.toBeUndefined();
  });

  it('removeUser удаляет запись участника', async () => {
    const { sync } = await loaded();

    sync.removeUser('p1');

    expect(sync.getRating('p1', 'all')).toBeNull();
    expect(sync.getRank('p1')).toBe(0);
  });

  it('не шлёт PUT, если load ни разу не удался (F4 — не клобберить сохранённое)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    fetchImpl.mockClear();
    clock.now += lobbyConfig.playerData.minFlushInterval;
    await sync.flush('p1');

    // flush пытается повторить load (2 GET), но PUT не шлёт — ничего не loaded
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(putCalls(fetchImpl)).toHaveLength(0);
  });

  // Агрегирующий роут мастера отдаёт 200, если приехал ХОТЬ ОДИН срез, и
  // кладёт провалившийся как null. Общий флаг «рейтинги загружены» пометил бы
  // такой срез загруженным нулём навсегда, а ноль дневного среза игра читает
  // как «сегодня ещё не играл» — то есть как побитый рекорд на каждую смерть
  it('частично приехавшие срезы не помечаются загруженными', async () => {
    const fetchImpl = makeFetch({
      placements: () =>
        okJson({ day: null, month: PLACEMENTS.month, all: null }),
    });
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');

    expect(sync.isRatingLoaded('p1', 'month')).toBe(true);
    expect(sync.isRatingLoaded('p1', 'day')).toBe(false);
    expect(sync.isRatingLoaded('p1', 'all')).toBe(false);
  });

  it('повторная загрузка добирает недостающий срез и не удваивает приехавший', async () => {
    let complete = false;
    const fetchImpl = makeFetch({
      placements: () =>
        okJson(
          complete
            ? PLACEMENTS
            : { day: null, month: PLACEMENTS.month, all: null },
        ),
    });
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    complete = true;
    await sync.load('p1', 'tok');

    // месяц СКЛАДЫВАЕТСЯ — применить приехавший срез дважды значило бы
    // удвоить его
    expect(sync.getRating('p1', 'month').value).toBe(400);
    expect(sync.getRating('p1', 'day').value).toBe(40);
    expect(sync.isRatingLoaded('p1', 'all')).toBe(true);
  });

  // результат игры — строка в леджер, а не замещение: затирать ею нечего, и
  // гейт по загруженности держал бы очки в pending до конца жизни комнаты
  it('результат игры уходит, даже когда рейтинги не загрузились', async () => {
    const fetchImpl = makeFetch({ placements: () => fail(502) });
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    sync.addPoints('p1', 9);
    sync.finishGame('p1');
    fetchImpl.mockClear();
    clock.now += lobbyConfig.playerData.minFlushInterval;
    await sync.flush('p1', { urgent: true });

    const puts = putCalls(fetchImpl);

    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('/auth/rank?game=tanks');
  });

  it('шлёт PUT только для успешно загруженной части (рейтинги ок, state — нет)', async () => {
    const fetchImpl = makeFetch({ state: () => fail(500) });
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    sync.addPoints('p1', 4);
    sync.finishGame('p1');
    fetchImpl.mockClear();
    clock.now += lobbyConfig.playerData.minFlushInterval;
    await sync.flush('p1');

    const puts = putCalls(fetchImpl);

    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('/auth/rank?game=tanks');
  });
});

// Предел синхронизации с БД (snakes-v3 этап 3.2, решение пользователя 9):
// правило для ВСЕХ игр — игра может попросить синхронизацию, но не может
// участить её сверх минимального интервала и не может отправить то, что не
// изменилось. «Игр сотни, серверов сотни»
describe('PlayerDataSync: предел синхронизации', () => {
  const room = async (size, { placements = () => okJson(PLACEMENTS) } = {}) => {
    const fetchImpl = makeFetch({ placements });
    const made = makeSync(fetchImpl);

    for (let i = 0; i < size; i += 1) {
      await made.sync.load(`p${i}`, `tok${i}`);
    }

    made.clock.now += lobbyConfig.playerData.minFlushInterval;
    fetchImpl.mockClear();

    return { ...made, fetchImpl };
  };

  it('ничего не заработано и state не менялся — запросов нет', async () => {
    const { sync, fetchImpl } = await room(1);

    await sync.flushAll();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('незавершённая игра не отправляется: результата ещё нет', async () => {
    const { sync, fetchImpl } = await room(1);

    sync.addPoints('p0', 10);
    await sync.flushAll();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('комната из 32 участников, где заработал один, делает один PUT', async () => {
    const { sync, fetchImpl } = await room(32);

    sync.addPoints('p7', 12);
    sync.finishGame('p7');
    await sync.flushAll();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('/auth/rank?game=tanks');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      points: 12,
      best: 12,
    });
  });

  it('второй flushAll внутри minFlushInterval запросов не порождает, urgent — порождает', async () => {
    const { sync, fetchImpl } = await room(1);

    sync.addPoints('p0', 5);
    sync.finishGame('p0');
    await sync.flushAll();
    expect(putCalls(fetchImpl)).toHaveLength(1);

    fetchImpl.mockClear();
    sync.addPoints('p0', 5);
    sync.finishGame('p0');
    await sync.flushAll();
    expect(fetchImpl).not.toHaveBeenCalled();

    await sync.flushAll({ urgent: true });
    expect(putCalls(fetchImpl)).toHaveLength(1);
  });

  // уход участника и destroy() комнаты — срочные границы: второго шанса
  // записать эти очки не будет
  it('уход участника синхронизирует независимо от интервала', async () => {
    const { sync, fetchImpl } = await room(1);

    sync.addPoints('p0', 5);
    sync.finishGame('p0');
    await sync.flushAll();
    fetchImpl.mockClear();

    sync.addPoints('p0', 6);
    sync.finishGame('p0');
    await sync.flush('p0', { urgent: true });

    expect(putCalls(fetchImpl)).toHaveLength(1);
  });

  it('параллельные flush одного участника не наслаиваются, добавленное во время запроса уходит следующим', async () => {
    const pending = [];
    const fetchImpl = makeFetch({
      put: () =>
        new Promise(resolve =>
          pending.push(() => resolve(okJson({ ok: true }))),
        ),
    });
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    clock.now += lobbyConfig.playerData.minFlushInterval;
    sync.addPoints('p1', 5);
    sync.finishGame('p1');

    const first = sync.flush('p1', { urgent: true });

    // дать очереди дойти до самого запроса
    await Promise.resolve();
    await Promise.resolve();

    // второй вызов во время запроса: не стартует второй PUT, а ставит флаг
    sync.addPoints('p1', 7);
    sync.finishGame('p1');
    const second = sync.flush('p1', { urgent: true });

    expect(putCalls(fetchImpl)).toHaveLength(1);

    // повторный вызов ждёт ТЕКУЩУЮ серию, а не резолвится сразу: граница,
    // которая ждёт записи (destroy комнаты, уход участника), обязана дождаться
    // повтора, а не решить, что писать уже нечего
    let secondSettled = false;

    second.then(() => {
      secondSettled = true;
    });

    pending.shift()();
    // цикл flush'а выпускает повтор — им и уходит добавленное во время запроса
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    expect(secondSettled).toBe(false);

    pending.shift()();
    await first;
    await second;

    expect(secondSettled).toBe(true);

    const puts = putCalls(fetchImpl);

    expect(puts).toHaveLength(2);
    expect(JSON.parse(puts[0][1].body)).toMatchObject({ points: 5, best: 5 });
    expect(JSON.parse(puts[1][1].body)).toMatchObject({ points: 7, best: 7 });
  });

  // отказ по содержанию неустраним: тот же payload получит тот же ответ, и
  // держать его в pending значит слать заведомый мусор до конца жизни комнаты
  it('перестаёт повторять результат, отклонённый как невалидный (400)', async () => {
    const fetchImpl = makeFetch({ put: () => fail(400) });
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    sync.addPoints('p1', 5);
    sync.finishGame('p1');

    await sync.flush('p1', { urgent: true });

    expect(
      putCalls(fetchImpl).filter(([url]) => url.startsWith('/auth/rank')),
    ).toHaveLength(1);

    clock.now += lobbyConfig.playerData.minFlushInterval;
    await sync.flush('p1');

    // отклонённое не поехало второй раз
    expect(
      putCalls(fetchImpl).filter(([url]) => url.startsWith('/auth/rank')),
    ).toHaveLength(1);
  });

  it('повторяет результат, отклонённый потолком записи (429)', async () => {
    // 429 — «сейчас нельзя», а не «так и будет»: это единственный 4xx, после
    // которого повтор имеет смысл
    let limited = true;
    const fetchImpl = makeFetch({
      put: () => (limited ? fail(429) : okJson({ ok: true })),
    });
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    sync.addPoints('p1', 5);
    sync.finishGame('p1');

    await sync.flush('p1', { urgent: true });

    limited = false;
    clock.now += lobbyConfig.playerData.minFlushInterval;
    await sync.flush('p1', { urgent: true });

    const ranks = putCalls(fetchImpl).filter(([url]) =>
      url.startsWith('/auth/rank'),
    );

    expect(ranks).toHaveLength(2);
    expect(JSON.parse(ranks[1][1].body)).toMatchObject({ points: 5, best: 5 });
  });

  it('500 от auth включает бэкофф комнаты, успех его сбрасывает', async () => {
    let broken = true;
    const fetchImpl = makeFetch({
      put: () => (broken ? fail(500) : okJson({ ok: true })),
    });
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    clock.now += lobbyConfig.playerData.minFlushInterval;
    sync.addPoints('p1', 5);
    sync.finishGame('p1');

    // пауза экспоненциальная: 30, 60, 120 … секунды. Пока она короче
    // интервала синхронизации, её не видно — видно с пятого отказа
    // (480 с > 300 с). Границы бэкоффа соразмерны интервалу намеренно: потолок
    // ниже него не отложил бы ни одного запроса (см. lobbyConfig)
    for (let i = 0; i < 5; i += 1) {
      await sync.flush('p1');
      clock.now += lobbyConfig.playerData.minFlushInterval;
    }

    expect(putCalls(fetchImpl)).toHaveLength(5);

    // интервал прошёл, но комната в паузе — обычный flush молчит
    fetchImpl.mockClear();
    await sync.flush('p1');
    expect(fetchImpl).not.toHaveBeenCalled();

    // срочная граница паузу обходит и своим успехом её снимает
    broken = false;
    await sync.flush('p1', { urgent: true });
    expect(putCalls(fetchImpl)).toHaveLength(1);

    fetchImpl.mockClear();
    clock.now += lobbyConfig.playerData.minFlushInterval;
    sync.addPoints('p1', 3);
    sync.finishGame('p1');
    await sync.flush('p1');
    expect(putCalls(fetchImpl)).toHaveLength(1);
  });

  it('очередь комнаты не выпускает больше maxRequestsPerSecond', async () => {
    const { sync, clock, fetchImpl } = await room(4);
    const startedAt = clock.now;

    for (let i = 0; i < 4; i += 1) {
      sync.addPoints(`p${i}`, 1);
      sync.finishGame(`p${i}`);
    }

    await sync.flushAll();

    expect(putCalls(fetchImpl)).toHaveLength(4);
    // четыре запроса при потолке maxRequestsPerSecond — три интервала
    // ожидания. Слот округляется вверх (иначе потолок был бы чуть выше
    // объявленного), поэтому и здесь Math.ceil
    expect(clock.now - startedAt).toBe(
      3 * Math.ceil(1000 / lobbyConfig.playerData.maxRequestsPerSecond),
    );
  });
});

describe('PlayerDataSync.attachToken', () => {
  it('следующая запись идёт со свежим токеном', async () => {
    const fetchImpl = makeFetch();
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'old');
    expect(sync.attachToken('p1', 'fresh')).toBe(true);

    sync.addPoints('p1', 5);
    sync.finishGame('p1');
    await sync.flush('p1', { urgent: true });

    const put = fetchImpl.mock.calls.find(([, opts]) => opts?.method === 'PUT');

    expect(put[1].headers.authorization).toBe('Bearer fresh');
  });

  it('без записи участника или с пустым токеном — false', async () => {
    const { sync } = makeSync(makeFetch());

    expect(sync.attachToken('missing', 'fresh')).toBe(false);

    await sync.load('p1', 'old');
    expect(sync.attachToken('p1', '')).toBe(false);
  });
});

describe('PlayerDataSync: контрольная точка (host-migration этап 5)', () => {
  it('serialize не несёт токенов, restore переносит накопленное', async () => {
    const sync = new PlayerDataSync('tanks', {
      fetchImpl: makeFetch(),
      writeSeqStart: () => 2 ** 47,
    });

    await sync.load('1', 'secret-token');
    sync.addPoints('1', 5);
    sync.finishGame('1');
    sync.addPoints('1', 2);

    const state = sync.serialize();

    expect(JSON.stringify(state)).not.toContain('secret-token');
    expect(state['1']).toMatchObject({
      pendingPoints: 5,
      pendingBest: 5,
      currentGamePoints: 2,
      stateLoaded: true,
      writeSeq: 2 ** 47,
      writes: [],
    });

    const fetchImpl = makeFetch();
    const next = new PlayerDataSync('tanks', { fetchImpl });

    next.restore(state);

    expect(next.isLoaded('1')).toBe(true);
    expect(next.getRating('1', 'month').value).toBe(405);
  });

  it('без токена запись ждёт возврата участника и не пишет', async () => {
    const fetchImpl = makeFetch();
    // точка без writeSeq (Worker до 7.7): накопленное остаётся в pending и
    // уходит первой записью нового диапазона — здесь он с 0
    const sync = new PlayerDataSync('tanks', {
      fetchImpl,
      writeSeqStart: () => 0,
    });

    sync.restore({
      1: { pendingPoints: 3, pendingBest: 3, stateLoaded: true },
    });
    await sync.flush('1', { urgent: true });

    expect(fetchImpl).not.toHaveBeenCalled();

    sync.attachToken('1', 'fresh');
    await sync.flush('1', { urgent: true });

    const put = fetchImpl.mock.calls.find(
      ([url, opts]) => opts.method === 'PUT' && url.startsWith('/auth/rank'),
    );

    expect(put[1].headers.authorization).toBe('Bearer fresh');
    expect(JSON.parse(put[1].body)).toMatchObject({ points: 3, best: 3 });
    expect(sync.serialize()['1'].writeSeq).toBe(1);
  });

  it('restore с токеном вкладки пишет сразу', async () => {
    const fetchImpl = makeFetch();
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    sync.restore(
      { 1: { pendingPoints: 2, pendingBest: 2, stateLoaded: true } },
      { tokens: { 1: 'tab-token' } },
    );
    await sync.flush('1', { urgent: true });

    expect(
      fetchImpl.mock.calls.some(
        ([, opts]) => opts.headers?.authorization === 'Bearer tab-token',
      ),
    ).toBe(true);
  });
});

// host-migration 7.7: номер закрепляется за записью, повтор уходит с тем же
// номером и той же суммой — auth отсеивает дубль
describe('PlayerDataSync: идемпотентность записи (writeSeq)', () => {
  const rankBodies = fetchImpl =>
    putCalls(fetchImpl)
      .filter(([url]) => url.startsWith('/auth/rank'))
      .map(([, opts]) => JSON.parse(opts.body));

  const finish = (sync, id, points) => {
    sync.addPoints(id, points);
    sync.finishGame(id);
  };

  it('каждая новая запись получает следующий номер', async () => {
    const fetchImpl = makeFetch();
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    finish(sync, 'p1', 2);
    await sync.flush('p1', { urgent: true });
    finish(sync, 'p1', 3);
    await sync.flush('p1', { urgent: true });

    const [first, second] = rankBodies(fetchImpl);

    expect(second.writeSeq).toBe(first.writeSeq + 1);
  });

  it('повтор после 5xx несёт тот же номер и ту же сумму, накопленное уходит следом', async () => {
    let broken = true;
    const fetchImpl = makeFetch({
      put: () => (broken ? fail(500) : okJson({ ok: true })),
    });
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    finish(sync, 'p1', 5);
    await sync.flush('p1', { urgent: true });

    // между попытками закончилась ещё одна игра — в повтор она не входит
    finish(sync, 'p1', 7);
    broken = false;
    await sync.flush('p1', { urgent: true });

    const [failed, retried, next] = rankBodies(fetchImpl);

    expect(retried).toEqual(failed);
    expect(retried).toMatchObject({ points: 5, best: 5 });
    // накопленное за время сбоя ушло в той же серии, новым номером
    expect(next).toMatchObject({
      points: 7,
      best: 7,
      writeSeq: failed.writeSeq + 1,
    });
  });

  it('сетевой сбой (fetch бросил) тоже повторяется тем же номером', async () => {
    let down = true;
    const fetchImpl = makeFetch({
      put: () => {
        if (down) {
          throw new Error('network');
        }

        return okJson({ ok: true });
      },
    });
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    finish(sync, 'p1', 4);
    await sync.flush('p1', { urgent: true });
    down = false;
    await sync.flush('p1', { urgent: true });

    const [first, second] = rankBodies(fetchImpl);

    expect(second).toEqual(first);
  });

  it('отклонённая (400) запись закрывается, следующая — с новым номером', async () => {
    let invalid = true;
    const fetchImpl = makeFetch({
      put: () => (invalid ? fail(400) : okJson({ ok: true })),
    });
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    finish(sync, 'p1', 4);
    await sync.flush('p1', { urgent: true });
    invalid = false;
    finish(sync, 'p1', 6);
    await sync.flush('p1', { urgent: true });

    const [rejected, next] = rankBodies(fetchImpl);

    expect(next).toMatchObject({
      points: 6,
      writeSeq: rejected.writeSeq + 1,
    });
  });

  // ревью этапа 5: эстафета Worker'ов с зависшим PUT — новый Worker обязан
  // повторить запись с тем же номером, а не отправить ту же сумму новым
  it('летящая запись едет в точке отдельно, новый хост повторяет её тем же номером', async () => {
    const fetchImpl = makeFetch({ put: () => new Promise(() => {}) });
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    finish(sync, 'p1', 5);
    sync.flush('p1', { urgent: true });
    await vi.waitFor(() => expect(rankBodies(fetchImpl)).toHaveLength(1));

    const state = sync.serialize();
    const [sent] = rankBodies(fetchImpl);

    expect(state.p1.pendingPoints).toBe(0);
    expect(state.p1.writes).toEqual([
      { writeSeq: sent.writeSeq, points: 5, best: 5 },
    ]);

    const nextFetch = makeFetch();
    const next = makeSync(nextFetch, { writeSeqStart: () => 1000 }).sync;

    next.restore(state, { tokens: { p1: 'tok' } });
    await next.flush('p1', { urgent: true });

    expect(rankBodies(nextFetch)).toEqual([
      expect.objectContaining({ points: 5, best: 5, writeSeq: sent.writeSeq }),
    ]);
  });

  // ревью 7d: restore не продолжает номера точки — накопленное на момент
  // точки получает номер, который дал бы ему старый хост (N+1, его отправку
  // auth отсеет), а всё после — номера нового диапазона
  it('restore: летящая — свой номер, накопленное — N+1, дальше новый диапазон', async () => {
    const fetchImpl = makeFetch({ put: () => new Promise(() => {}) });
    const { sync } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    finish(sync, 'p1', 5);
    sync.flush('p1', { urgent: true });
    await vi.waitFor(() => expect(rankBodies(fetchImpl)).toHaveLength(1));
    // во время запроса закончилась ещё одна игра
    finish(sync, 'p1', 2);

    const state = sync.serialize();
    const n = state.p1.writeSeq;

    expect(state.p1.pendingPoints).toBe(2);

    const nextFetch = makeFetch();
    const next = makeSync(nextFetch, { writeSeqStart: () => 1000 }).sync;

    next.restore(state, { tokens: { p1: 'tok' } });
    await next.flush('p1', { urgent: true });
    finish(next, 'p1', 9);
    await next.flush('p1', { urgent: true });

    expect(rankBodies(nextFetch)).toEqual([
      expect.objectContaining({ points: 5, writeSeq: n }),
      expect.objectContaining({ points: 2, writeSeq: n + 1 }),
      // свежие очки — не n + 2: его старый хост мог уже занять после точки
      expect.objectContaining({ points: 9, writeSeq: 1001 }),
    ]);
  });

  it('вернувшийся в комнату участник не повторяет номера прошлого входа', async () => {
    const starts = [100, 900];
    const fetchImpl = makeFetch();
    const { sync } = makeSync(fetchImpl, {
      writeSeqStart: () => starts.shift(),
    });

    await sync.load('p1', 'tok');
    finish(sync, 'p1', 2);
    await sync.flush('p1', { urgent: true });
    sync.removeUser('p1');

    await sync.load('p1', 'tok');
    finish(sync, 'p1', 2);
    await sync.flush('p1', { urgent: true });

    expect(rankBodies(fetchImpl).map(body => body.writeSeq)).toEqual([
      101, 901,
    ]);
  });

  it('дефолтный старт номеров — случайное безопасное целое из 48 бит', () => {
    const sync = new PlayerDataSync('tanks', { fetchImpl: makeFetch() });

    sync.restore({ p1: {}, p2: {} });

    const { p1, p2 } = sync.serialize();

    for (const { writeSeq } of [p1, p2]) {
      expect(Number.isSafeInteger(writeSeq)).toBe(true);
      expect(writeSeq).toBeGreaterThanOrEqual(0);
      expect(writeSeq).toBeLessThan(2 ** 48);
    }

    expect(p1.writeSeq).not.toBe(p2.writeSeq);
  });

  it('неотправленная запись держит показанное значение при /rank', async () => {
    const fetchImpl = makeFetch({
      put: () => fail(500),
      placement: () => okJson({ placement: 1, total: 10, rank: 0 }),
    });
    const { sync, clock } = makeSync(fetchImpl);

    await sync.load('p1', 'tok');
    finish(sync, 'p1', 9);
    await sync.flush('p1', { urgent: true });
    clock.now += lobbyConfig.playerData.placementTtl;

    const rating = await sync.refreshPlacement('p1', 'month');

    expect(rating.value).toBe(409);
  });
});
