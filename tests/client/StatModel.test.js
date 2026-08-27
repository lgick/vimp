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

// snakes-v3 этап 4: режим 'leaderboard' — по Tab показывается глобальный
// топ игры, который клиент тянет сам; данные хоста не рисуются
const TOP = {
  leaderboard: [
    { nick: 'a', rank: 100, place: 1 },
    { nick: 'b', rank: 90, place: 2 },
    { nick: 'c', rank: 80, place: 3 },
  ],
  total: 3,
};

const makeBoardModel = (deps = {}) => {
  const fetchLeaderboard = vi.fn(async () => TOP);
  const fetchPlacement = vi.fn(async () => ({
    placement: 42,
    total: 100,
    rank: 7,
  }));

  const model = new StatModel(
    {
      mode: 'leaderboard',
      period: 'day',
      limit: 3,
      refreshMs: 15000,
      columns: ['#', 'snake', 'score'],
    },
    {
      gameId: 'snakes',
      fetchLeaderboard,
      fetchPlacement,
      getNick: () => 'me',
      now: () => 0,
      ...deps,
    },
  );

  return { model, fetchLeaderboard, fetchPlacement };
};

describe("StatModel: режим 'leaderboard'", () => {
  it('update от хоста ничего не рисует', async () => {
    const { model } = makeBoardModel();
    const events = collect(model);

    model.update([[['g1', 1, ['Alice', 10], 0]], null, true]);

    expect(events.filter(e => e.type !== 'leaderboard')).toEqual([]);
  });

  it('open тянет топ и свою позицию', async () => {
    const { model, fetchLeaderboard, fetchPlacement } = makeBoardModel();
    const rows = [];

    model.publisher.on('leaderboard', data => rows.push(data));

    model.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchLeaderboard).toHaveBeenCalledWith('snakes', 'day');
    expect(fetchPlacement).toHaveBeenCalledWith('snakes', 'day');
    expect(rows[0].map(r => r.nick)).toEqual(['a', 'b', 'me']);
  });

  it('повторный open внутри refreshMs не делает запросов', async () => {
    const { model, fetchLeaderboard } = makeBoardModel();

    await model.refreshLeaderboard();
    await model.refreshLeaderboard();

    expect(fetchLeaderboard).toHaveBeenCalledTimes(1);
  });

  it('304 (null от fetch) оставляет прошлый список', async () => {
    let first = true;
    const fetchLeaderboard = vi.fn(async () => {
      if (first) {
        first = false;

        return TOP;
      }

      return null;
    });
    let clock = 0;
    const { model } = makeBoardModel({
      fetchLeaderboard,
      fetchPlacement: async () => null,
      now: () => clock,
    });
    const emitted = [];

    model.publisher.on('leaderboard', data => emitted.push(data));

    await model.refreshLeaderboard();
    clock = 100000;
    await model.refreshLeaderboard();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].map(r => r.nick)).toEqual(['a', 'b', 'c']);
  });

  it('игрок вне топа заменяет последнюю строку', async () => {
    const { model } = makeBoardModel();
    const emitted = [];

    model.publisher.on('leaderboard', data => emitted.push(data));

    await model.refreshLeaderboard();

    const rows = emitted[0];

    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({ place: 42, nick: 'me', score: 7, isSelf: true });
  });

  it('игрок из топа подсвечивается на своём месте', async () => {
    const { model } = makeBoardModel({ getNick: () => 'B' });
    const emitted = [];

    model.publisher.on('leaderboard', data => emitted.push(data));

    await model.refreshLeaderboard();

    expect(emitted[0].map(r => r.isSelf)).toEqual([false, true, false]);
    expect(emitted[0]).toHaveLength(3);
  });

  it('неранжированный за период получает прочерк вместо места', async () => {
    const { model } = makeBoardModel({
      fetchPlacement: async () => ({ placement: null, total: 100, rank: 0 }),
    });
    const emitted = [];

    model.publisher.on('leaderboard', data => emitted.push(data));

    await model.refreshLeaderboard();

    expect(emitted[0][2]).toEqual({
      place: null,
      nick: 'me',
      score: 0,
      isSelf: true,
    });
  });

  it('без токена (нет ника) список остаётся как есть', async () => {
    const { model } = makeBoardModel({ getNick: () => null });
    const emitted = [];

    model.publisher.on('leaderboard', data => emitted.push(data));

    await model.refreshLeaderboard();

    expect(emitted[0].map(r => r.nick)).toEqual(['a', 'b', 'c']);
  });
});
