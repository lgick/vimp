import { describe, it, expect, beforeEach, vi } from 'vitest';

// PanelModel — синглтон, перезагружаем модуль для изоляции
let PanelModel;

// форматирование задаёт type в схеме полей (Д2), а не имя поля
const makeModel = () =>
  new PanelModel(
    {
      h: 'health',
      t: 'time',
      w1: 'bullet',
      wa: 'activeWeapon',
    },
    [
      { name: 'health', elem: 'panel-health', type: 'bar' },
      { name: 'bullet', elem: 'panel-bullet', type: 'weapon' },
      { name: 'time', elem: 'panel-time', type: 'time' },
    ],
  );

const collect = model => {
  const events = [];
  ['data', 'hide', 'activeWeapon'].forEach(type =>
    model.publisher.on(type, data => events.push({ type, data })),
  );
  return events;
};

beforeEach(async () => {
  vi.resetModules();
  PanelModel = (await import('../../packages/engine/src/client/components/model/Panel.js'))
    .default;
});

describe('PanelModel.update', () => {
  it('числовое поле эмитит data с числом', () => {
    const model = makeModel();
    const events = collect(model);

    model.update(['h:100']);
    expect(events.find(e => e.type === 'data').data).toEqual({
      name: 'health',
      value: 100,
    });
  });

  it('поле без значения скрывается', () => {
    const model = makeModel();
    const events = collect(model);

    model.update(['h']);
    expect(events.find(e => e.type === 'hide').data).toBe('health');
  });

  it('смена активного оружия мапит ключ в имя панели', () => {
    const model = makeModel();
    const events = collect(model);

    model.update(['wa:w1']);
    expect(events.find(e => e.type === 'activeWeapon').data).toBe('bullet');
  });

  it('время форматируется', () => {
    const model = makeModel();
    const events = collect(model);

    model.update(['t:125']);
    expect(events.find(e => e.type === 'data').data).toEqual({
      name: 'time',
      value: '2:05',
    });
  });

  it('обрабатывает несколько полей за один вызов', () => {
    const model = makeModel();
    const events = collect(model);

    model.update(['h:80', 'w1:39']);
    const data = events.filter(e => e.type === 'data').map(e => e.data);
    expect(data).toEqual([
      { name: 'health', value: 80 },
      { name: 'bullet', value: 39 },
    ]);
  });
});

describe('PanelModel.formatTime', () => {
  it('добавляет ведущий ноль к секундам < 10', () => {
    const model = makeModel();
    expect(model.formatTime(125)).toBe('2:05');
  });

  it('ровные минуты дают :00', () => {
    const model = makeModel();
    expect(model.formatTime(120)).toBe('2:00');
  });

  it('секунды >= 10 без ведущего нуля', () => {
    const model = makeModel();
    expect(model.formatTime(615)).toBe('10:15');
  });

  it('меньше минуты', () => {
    const model = makeModel();
    expect(model.formatTime(5)).toBe('0:05');
  });
});
