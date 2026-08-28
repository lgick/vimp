import { describe, it, expect, beforeEach, vi } from 'vitest';

// StatModel — синглтон, перезагружаем модуль для изоляции
let StatModel;

const makeModel = () =>
  new StatModel({
    // teamId -> id таблицы <thead>
    heads: { 1: 'head-team1', 2: 'head-team2' },
    // teamId -> id таблицы <tbody>
    bodies: { 1: 'body-team1', 2: 'body-team2' },
    // tableId -> правило сортировки
    sortList: { 'body-team1': ['score', 'desc'] },
  });

const collect = model => {
  const events = [];
  ['open', 'close', 'mode', 'clearBodies', 'tBody', 'tHead'].forEach(type =>
    model.publisher.on(type, data => events.push({ type, data })),
  );
  return events;
};

beforeEach(async () => {
  vi.resetModules();
  StatModel = (await import('../../packages/engine/src/client/components/model/Stat.js')).default;
});

describe('StatModel.update', () => {
  it('полное обновление очищает tbody', () => {
    const model = makeModel();
    const events = collect(model);

    model.update([null, null, true]);

    const clear = events.find(e => e.type === 'clearBodies');
    expect(clear.data).toEqual(['body-team1', 'body-team2']);
  });

  it('эмитит tBody с маппингом таблицы и сортировкой', () => {
    const model = makeModel();
    const events = collect(model);

    // [gameId, teamId, cellsData, bodyNumber]
    const bodies = [['g1', 1, ['Alice', 10], 0]];
    model.update([bodies, null, false]);

    const tBody = events.find(e => e.type === 'tBody');
    expect(tBody.data).toEqual({
      id: 'g1',
      tableId: 'body-team1',
      cellsData: ['Alice', 10],
      sortData: ['score', 'desc'],
      bodyNumber: 0,
    });
  });

  it('пропускает строки с неизвестной командой', () => {
    const model = makeModel();
    const events = collect(model);

    const bodies = [['g1', 99, ['X'], 0]]; // нет команды 99
    model.update([bodies, null, false]);

    expect(events.find(e => e.type === 'tBody')).toBeUndefined();
  });

  it('эмитит tHead с маппингом', () => {
    const model = makeModel();
    const events = collect(model);

    // [teamId, cellsData, rowNumber]
    const heads = [[1, ['Team1', 5], 0]];
    model.update([null, heads, false]);

    const tHead = events.find(e => e.type === 'tHead');
    expect(tHead.data).toEqual({
      tableId: 'head-team1',
      cellsData: ['Team1', 5],
      rowNumber: 0,
    });
  });

  it('частичное обновление (flag !== true) не очищает tbody', () => {
    const model = makeModel();
    const events = collect(model);

    model.update([[['g1', 1, ['A'], 0]], null, false]);
    expect(events.find(e => e.type === 'clearBodies')).toBeUndefined();
  });
});

describe('StatModel.open/close', () => {
  it('open эмитит open и mode opened', () => {
    const model = makeModel();
    const events = collect(model);

    model.open();
    expect(events.find(e => e.type === 'open')).toBeDefined();
    expect(events.find(e => e.type === 'mode').data).toEqual({
      name: 'stat',
      status: 'opened',
    });
  });

  it('close эмитит close и mode closed', () => {
    const model = makeModel();
    const events = collect(model);

    model.close();
    expect(events.find(e => e.type === 'mode').data).toEqual({
      name: 'stat',
      status: 'closed',
    });
  });
});

// snakes-v3 этап 4: режим 'leaderboard' — по Tab показывается глобальный топ
// игры. Топ привозит ХОСТ портом ACCOLADES_DATA: из матча клиент к мастеру не
// ходит вовсе, поэтому в модели нет ни одного запроса и нечего троттлить
const BOARD = [
  { place: 1, nick: 'a', score: 100 },
  { place: 2, nick: 'b', score: 90 },
  { place: 3, nick: 'c', score: 80 },
];

// заглушка сервиса accolades (client/lib/accolades.js) — ровно те три
// вопроса, которые модель ему задаёт
const stubAccolades = ({ board = BOARD, self = { place: 42, score: 7 } } = {}) => ({
  placeOf: () => ({ daily: null, monthly: null }),
  boardOf: period => (period === 'day' ? board : []),
  selfOf: (id, period) => (period === 'day' ? self : null),
});

const makeBoardModel = (deps = {}) => {
  const model = new StatModel(
    {
      mode: 'leaderboard',
      period: 'day',
      limit: 3,
      columns: ['#', 'snake', 'score'],
    },
    {
      accolades: stubAccolades(),
      localPlayer: { id: '1' },
      getNick: () => 'me',
      ...deps,
    },
  );

  return { model };
};

describe("StatModel: режим 'leaderboard'", () => {
  it('update от хоста ничего не рисует', () => {
    const { model } = makeBoardModel();
    const events = collect(model);

    model.update([[['g1', 1, ['Alice', 10], 0]], null, true]);

    expect(events.filter(e => e.type !== 'leaderboard')).toEqual([]);
  });

  it('open рисует последнюю рассылку хоста и ничего не запрашивает', () => {
    const { model } = makeBoardModel();
    const rows = [];

    model.publisher.on('leaderboard', data => rows.push(data));

    model.open();

    expect(rows[0].map(r => r.nick)).toEqual(['a', 'b', 'me']);
  });

  it('пустая рассылка (до первой) даёт пустой список, а не сбой', () => {
    const { model } = makeBoardModel({ accolades: stubAccolades({ board: [], self: null }) });
    const emitted = [];

    model.publisher.on('leaderboard', data => emitted.push(data));

    model.applyAccolades();

    expect(emitted[0]).toEqual([]);
  });

  it('игрок вне топа заменяет последнюю строку', () => {
    const { model } = makeBoardModel();
    const emitted = [];

    model.publisher.on('leaderboard', data => emitted.push(data));

    model.refreshLeaderboard();

    const rows = emitted[0];

    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({ place: 42, nick: 'me', score: 7, isSelf: true });
  });

  // регрессия: список пересобирался поверх самого себя, и подставленная своя
  // строка выдавала себя за строку из топа — место игрока вне топа
  // не обновлялось больше никогда
  it('своя строка обновляется каждой рассылкой, а не застревает', () => {
    let self = { place: 42, score: 7 };
    const { model } = makeBoardModel({
      accolades: {
        placeOf: () => ({ daily: null, monthly: null }),
        boardOf: period => (period === 'day' ? BOARD : []),
        selfOf: () => self,
      },
    });
    const emitted = [];

    model.publisher.on('leaderboard', data => emitted.push(data));

    model.applyAccolades();
    self = { place: 17, score: 55 };
    model.applyAccolades();

    expect(emitted[1][2]).toEqual({ place: 17, nick: 'me', score: 55, isSelf: true });
  });

  it('игрок из топа подсвечивается на своём месте', () => {
    const { model } = makeBoardModel({ getNick: () => 'B' });
    const emitted = [];

    model.publisher.on('leaderboard', data => emitted.push(data));

    model.refreshLeaderboard();

    expect(emitted[0].map(r => r.isSelf)).toEqual([false, true, false]);
    expect(emitted[0]).toHaveLength(3);
  });

  it('неранжированный за период получает прочерк вместо места', () => {
    const { model } = makeBoardModel({
      accolades: stubAccolades({ self: { place: null, score: 0 } }),
    });
    const emitted = [];

    model.publisher.on('leaderboard', data => emitted.push(data));

    model.refreshLeaderboard();

    expect(emitted[0][2]).toEqual({
      place: null,
      nick: 'me',
      score: 0,
      isSelf: true,
    });
  });

  it('без токена (нет ника) список остаётся как есть', () => {
    const { model } = makeBoardModel({ getNick: () => null });
    const emitted = [];

    model.publisher.on('leaderboard', data => emitted.push(data));

    model.refreshLeaderboard();

    expect(emitted[0].map(r => r.nick)).toEqual(['a', 'b', 'c']);
  });

  // синглтон переиспользуется на каждый вход в матч (runModules): вернуть
  // старый экземпляр как есть значило бы играть в одну игру с параметрами
  // другой
  it('повторная конструкция перенастраивает синглтон под новую схему', () => {
    const { model } = makeBoardModel();
    const again = new StatModel(
      { heads: {}, bodies: {}, sortList: {} },
      {},
    );

    expect(again).toBe(model);
    expect(again.isLeaderboard).toBe(false);
  });
});
