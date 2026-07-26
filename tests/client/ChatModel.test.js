import { describe, it, expect, beforeEach, vi } from 'vitest';

// ChatModel — синглтон, перезагружаем модуль для изоляции
let ChatModel;

const makeModel = overrides =>
  new ChatModel({
    listLimit: 3,
    lineTime: 1000,
    cacheMin: 2,
    cacheMax: 4,
    messages: {
      sys: { 0: 'Игрок {0} зашёл', 1: 'Раунд начался' },
    },
    formatMessage: (msg, arr) =>
      msg.replace(/\{(\d+)\}/g, (m, i) => arr[i] ?? m),
    sanitizeMessage: msg => msg.replace(/[<>]/g, ''),
    ...overrides,
  });

// собирает события publisher в массив
const collect = model => {
  const events = [];
  ['open', 'close', 'mode', 'socket', 'newLine', 'newTimer', 'oldLine', 'oldTimer'].forEach(
    type => model.publisher.on(type, data => events.push({ type, data })),
  );
  return events;
};

beforeEach(async () => {
  vi.resetModules();
  ChatModel = (await import('../../packages/engine/src/client/components/model/Chat.js')).default;
});

describe('ChatModel.sendMessage', () => {
  it('санитизирует и отправляет непустое сообщение', () => {
    const model = makeModel();
    const events = collect(model);

    model.sendMessage('hi <script>');

    const socket = events.find(e => e.type === 'socket');
    expect(socket.data).toBe('hi script');
  });

  it('не отправляет, если после санитизации пусто', () => {
    const model = makeModel({ sanitizeMessage: () => '' });
    const events = collect(model);

    model.sendMessage('<<<');
    expect(events.find(e => e.type === 'socket')).toBeUndefined();
  });
});

describe('ChatModel.updateChat', () => {
  it('разворачивает строковый шаблон с параметрами', () => {
    const model = makeModel();
    const events = collect(model);

    model.updateChat('sys:0:Alice');

    const line = events.find(e => e.type === 'newLine');
    expect(line.data.message).toEqual(['Игрок Alice зашёл']);
  });

  it('игнорирует несуществующий шаблон', () => {
    const model = makeModel();
    const events = collect(model);

    model.updateChat('sys:99');
    expect(events.find(e => e.type === 'newLine')).toBeUndefined();
  });

  it('принимает массив сообщения как есть', () => {
    const model = makeModel();
    const events = collect(model);

    model.updateChat(['Привет', 'Bob', 'team']);

    const line = events.find(e => e.type === 'newLine');
    expect(line.data.message).toEqual(['Привет', 'Bob', 'team']);
  });

  it('инкрементирует id строки', () => {
    const model = makeModel();
    const events = collect(model);

    model.updateChat(['a']);
    model.updateChat(['b']);

    const ids = events.filter(e => e.type === 'newLine').map(e => e.data.id);
    expect(ids).toEqual([0, 1]);
  });

  it('при достижении listLimit принудительно вытесняет старую линию', () => {
    const model = makeModel(); // listLimit = 3
    // эмулируем заполненный список
    model.addToList({ messageId: 'm0', timerId: 't0' });
    model.addToList({ messageId: 'm1', timerId: 't1' });
    model.addToList({ messageId: 'm2', timerId: 't2' });

    const events = collect(model);
    model.updateChat(['new']);

    const old = events.find(e => e.type === 'oldLine');
    expect(old.data).toBe('m0'); // вытеснена самая старая
  });

  it('обрезает кэш при достижении cacheMax', () => {
    const model = makeModel(); // cacheMax = 4, cacheMin = 2
    for (let i = 0; i < 5; i += 1) {
      model.updateChat([`msg${i}`]);
    }
    // после 4-го push длина была 4 → обрезка до cacheMin перед 5-м
    expect(model._cache.length).toBeLessThanOrEqual(4);
  });
});

describe('ChatModel open/close', () => {
  it('open эмитит open и mode opened', () => {
    const model = makeModel();
    const events = collect(model);

    model.open();

    expect(events.find(e => e.type === 'open')).toBeDefined();
    expect(events.find(e => e.type === 'mode').data).toEqual({
      name: 'chat',
      status: 'opened',
    });
  });

  it('close передаёт булев success', () => {
    const model = makeModel();
    const events = collect(model);

    model.close(1);
    expect(events.find(e => e.type === 'close').data).toBe(true);
  });
});
