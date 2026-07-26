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
