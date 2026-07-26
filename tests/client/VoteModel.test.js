import { describe, it, expect, beforeEach, vi } from 'vitest';

// VoteModel — синглтон, перезагружаем модуль для изоляции
let VoteModel;

const makeModel = () =>
  new VoteModel({
    formatMessage: (msg, arr) =>
      msg.replace(/\{(\d+)\}/g, (m, i) => arr[i] ?? m),
    time: 10000,
    menu: [
      ['changeMap', ['Сменить карту', 'map:list', 0]],
      ['kick', ['Кикнуть', ['p1', 'p2'], 0]],
    ],
    templates: {
      kick: ['Кикнуть {0}?', ['yes', 'no'], 0],
    },
  });

const collect = model => {
  const events = [];
  ['mode', 'socket', 'vote', 'clear'].forEach(type =>
    model.publisher.on(type, data => events.push({ type, data })),
  );
  return events;
};

// keyCode цифры: '0'->48 ... '9'->57
const digit = n => 48 + n;

beforeEach(async () => {
  vi.resetModules();
  VoteModel = (await import('../../packages/engine/src/client/components/model/Vote.js')).default;
});

describe('VoteModel.createVote', () => {
  it('с массивом значений сразу показывает голосование', () => {
    const model = makeModel();
    const events = collect(model);

    model.createVote('kick', 'Кикнуть?', ['yes', 'no'], false);

    const vote = events.find(e => e.type === 'vote');
    expect(vote.data.title).toBe('Кикнуть?');
    expect(vote.data.list).toEqual(['yes', 'no']);
    expect(vote.data.time).toBe(10000);
  });

  it('со строковыми значениями запрашивает их с сервера и ждёт', () => {
    const model = makeModel();
    const events = collect(model);

    model.createVote('map', 'Карта?', 'map:list', false);

    expect(events.find(e => e.type === 'socket').data).toBe('map:list');
    expect(events.find(e => e.type === 'vote')).toBeUndefined(); // ещё нет значений
  });

  it('timeOff=true отключает время жизни (time=null)', () => {
    const model = makeModel();
    const events = collect(model);

    model.createVote('x', 'T', ['a'], true);
    expect(events.find(e => e.type === 'vote').data.time).toBeNull();
  });
});

describe('VoteModel.updateValues', () => {
  it('подставляет значения после ожидания и показывает', () => {
    const model = makeModel();
    model.createVote('map', 'Карта?', 'map:list', false); // переход в ожидание
    const events = collect(model);

    model.updateValues(['m1', 'm2']);

    const vote = events.find(e => e.type === 'vote');
    expect(vote.data.list).toEqual(['m1', 'm2']);
  });

  it('игнорируется, если не было ожидания', () => {
    const model = makeModel();
    const events = collect(model);

    model.updateValues(['m1']);
    expect(events.find(e => e.type === 'vote')).toBeUndefined();
  });
});

describe('VoteModel.createWithTemplate', () => {
  it('форматирует заголовок шаблона параметрами', () => {
    const model = makeModel();
    const events = collect(model);

    model.createWithTemplate({ name: 'kick', params: ['Bob'] });

    expect(events.find(e => e.type === 'vote').data.title).toBe('Кикнуть Bob?');
  });

  it('неизвестный шаблон ничего не делает', () => {
    const model = makeModel();
    const events = collect(model);

    model.createWithTemplate({ name: 'unknown' });
    expect(events).toHaveLength(0);
  });
});

describe('VoteModel.show: пагинация', () => {
  it('показывает не более 7 значений и флаг more', () => {
    const model = makeModel();
    const values = Array.from({ length: 10 }, (_, i) => `v${i}`);
    const events = collect(model);

    model.createVote('x', 'T', values, false);

    const vote = events.find(e => e.type === 'vote');
    expect(vote.data.list).toHaveLength(7);
    expect(vote.data.more).toBe(true);
    expect(vote.data.back).toBe(false);
  });
});

describe('VoteModel.update: обработка клавиш', () => {
  it('цифра выбирает значение и отправляет на сервер', () => {
    const model = makeModel();
    model.createVote('kick', 'T', ['yes', 'no'], false);
    const events = collect(model);

    model.update(digit(1)); // первый пункт → 'yes'

    expect(events.find(e => e.type === 'socket').data).toEqual(['kick', 'yes']);
    // и завершает голосование
    expect(
      events.find(e => e.type === 'mode' && e.data.status === 'closed'),
    ).toBeDefined();
  });

  it('0 завершает голосование (exit)', () => {
    const model = makeModel();
    model.createVote('kick', 'T', ['yes'], false);
    const events = collect(model);

    model.update(digit(0));
    expect(
      events.find(e => e.type === 'mode' && e.data.status === 'closed'),
    ).toBeDefined();
  });

  it('9 (more) переходит на следующую страницу', () => {
    const model = makeModel();
    const values = Array.from({ length: 10 }, (_, i) => `v${i}`);
    model.createVote('x', 'T', values, false);
    const events = collect(model);

    model.update(digit(9)); // more

    const vote = events.find(e => e.type === 'vote');
    expect(vote.data.list).toEqual(['v7', 'v8', 'v9']);
    expect(vote.data.back).toBe(true);
    expect(vote.data.more).toBe(false);
  });

  it('нецифровые клавиши игнорируются', () => {
    const model = makeModel();
    model.createVote('x', 'T', ['a'], false);
    const events = collect(model);

    model.update(65); // 'A'
    expect(events).toHaveLength(0);
  });
});

describe('VoteModel.createMenu', () => {
  it('строит меню из заголовков пунктов', () => {
    const model = makeModel();
    const events = collect(model);

    model.createMenu();

    const vote = events.find(e => e.type === 'vote');
    expect(vote.data.title).toBe('Menu');
    expect(vote.data.list).toEqual(['Сменить карту', 'Кикнуть']);
  });
});
