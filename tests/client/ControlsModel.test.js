import { describe, it, expect, beforeEach, vi } from 'vitest';

// ControlsModel — синглтон, перезагружаем модуль для изоляции
let ControlsModel;

const makeModel = () =>
  new ControlsModel({
    keySetList: [{ 87: 'forward', 83: 'back' }],
    modes: { 84: 'stat', 67: 'chat' },
    cmds: { 13: 'send' },
  });

const collect = model => {
  const events = [];
  ['socket', 'mode', 'chat', 'vote', 'stat'].forEach(type =>
    model.publisher.on(type, data => events.push({ type, data })),
  );
  return events;
};

const ev = keyCode => ({ keyCode, preventDefault: vi.fn() });

beforeEach(async () => {
  vi.resetModules();
  ControlsModel = (await import('../../packages/engine/src/client/components/model/Controls.js'))
    .default;
});

describe('ControlsModel: блокировка ввода', () => {
  it('игровые клавиши игнорируются, пока ввод выключен', () => {
    const model = makeModel();
    const events = collect(model);

    model.addKey(ev(87)); // forward
    expect(events).toHaveLength(0);
  });

  it('stat доступен даже при выключенном вводе', () => {
    const model = makeModel();
    const events = collect(model);

    model.addKey(ev(84)); // stat
    expect(events.find(e => e.type === 'mode').data).toBe('stat');
  });
});

describe('ControlsModel: игровые клавиши', () => {
  it('down эмитится один раз на зажатие', () => {
    const model = makeModel();
    model.setKeysEnabled(true);
    const events = collect(model);

    model.addKey(ev(87));
    model.addKey(ev(87)); // повторный keydown — уже зажата

    const downs = events.filter(e => e.type === 'socket');
    expect(downs).toHaveLength(1);
    expect(downs[0].data).toBe('down:forward');
  });

  it('removeKey эмитит up для зажатой клавиши', () => {
    const model = makeModel();
    model.setKeysEnabled(true);
    const events = collect(model);

    model.addKey(ev(87));
    model.removeKey(ev(87));

    expect(events.find(e => e.data === 'up:forward')).toBeDefined();
  });

  it('неизвестная клавиша не эмитит socket', () => {
    const model = makeModel();
    model.setKeysEnabled(true);
    const events = collect(model);

    model.addKey(ev(65)); // нет в keySet и modes
    expect(events).toHaveLength(0);
  });
});

describe('ControlsModel: режимы vote и chat', () => {
  it('в режиме vote клавиша дублируется в событие vote', () => {
    const model = makeModel();
    model.setKeysEnabled(true);
    model.setMode('vote', 'opened');
    const events = collect(model);

    model.addKey(ev(87));
    expect(events.find(e => e.type === 'vote').data).toBe(87);
  });

  it('в режиме chat командные клавиши уходят в chat', () => {
    const model = makeModel();
    model.setMode('chat', 'opened');
    const events = collect(model);

    model.addKey(ev(13)); // cmd 'send'
    expect(events.find(e => e.type === 'chat').data).toBe('send');
  });

  it('setMode closed выключает режим', () => {
    const model = makeModel();
    model.setMode('vote', 'opened');
    model.setMode('vote', 'closed');
    model.setKeysEnabled(true);
    const events = collect(model);

    model.addKey(ev(87));
    expect(events.find(e => e.type === 'vote')).toBeUndefined();
  });
});

describe('ControlsModel.changeKeySet', () => {
  it('сбрасывает состояние зажатых клавиш', () => {
    const model = makeModel();
    model.setKeysEnabled(true);
    const events = collect(model);

    model.addKey(ev(87)); // зажата
    model.changeKeySet(0); // сброс pressedKeys
    model.addKey(ev(87)); // снова down

    const downs = events.filter(e => e.data === 'down:forward');
    expect(downs).toHaveLength(2);
  });
});
