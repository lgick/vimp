import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// Канал указателя (этап 4): распознавание двойного тапа, гашение канала
// вместе с клавишами и перевод экранной точки в мировую.

let ControlsModel;
let CanvasManagerView;
let CanvasManagerModel;
let CanvasManagerCtrl;

const makeModel = (pointer = {}) =>
  new ControlsModel({
    keySetList: [{ 78: 'nextPlayer' }, { 65: 'left', 68: 'right' }],
    modes: { 84: 'stat', 67: 'chat' },
    cmds: { 13: 'send' },
    pointer: {
      doubleTapMs: 300,
      doubleTapPx: 40,
      sendIntervalMs: 0,
      ...pointer,
    },
  });

const collectAim = model => {
  const events = [];

  model.publisher.on('aim', data => events.push(data));

  return events;
};

const down = (x, y) => ({ type: 'down', x, y });
const move = (x, y) => ({ type: 'move', x, y });
const up = (x, y) => ({ type: 'up', x, y });

beforeEach(async () => {
  vi.resetModules();
  ControlsModel = (
    await import('../../packages/engine/src/client/components/model/Controls.js')
  ).default;
  CanvasManagerView = (
    await import('../../packages/engine/src/client/components/view/CanvasManager.js')
  ).default;
  CanvasManagerModel = (
    await import('../../packages/engine/src/client/components/model/CanvasManager.js')
  ).default;
  CanvasManagerCtrl = (
    await import('../../packages/engine/src/client/components/controller/CanvasManager.js')
  ).default;
});

describe('ControlsModel: канал указателя', () => {
  it('игра, не объявившая pointer, канала не получает', async () => {
    vi.resetModules();

    const Model = (
      await import('../../packages/engine/src/client/components/model/Controls.js')
    ).default;
    const model = new Model({
      keySetList: [{ 65: 'left' }],
      modes: {},
      cmds: {},
    });
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.addPointer(down(10, 10));

    expect(events).toHaveLength(0);
  });

  it('нажатие и перемещение шлют точку с битом «прижат»', () => {
    const model = makeModel();
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.addPointer(down(100, 200));
    model.addPointer(move(120, 210));

    expect(events).toEqual([
      { x: 100, y: 200, flags: 1 },
      { x: 120, y: 210, flags: 1 },
    ]);
  });

  it('move без прижатого указателя не шлётся', () => {
    const model = makeModel();
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.addPointer(move(10, 10));

    expect(events).toHaveLength(0);
  });

  it('второе нажатие в пределах порогов — двойной тап (бит 1)', () => {
    const model = makeModel();
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.addPointer(down(100, 100));
    model.addPointer(up(100, 100));
    model.addPointer(down(110, 105));

    expect(events.at(-1).flags).toBe(3);
  });

  it('двойной тап держится, пока указатель прижат, и гаснет с отпусканием', () => {
    const model = makeModel();
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.addPointer(down(100, 100));
    model.addPointer(up(100, 100));
    model.addPointer(down(100, 100));
    model.addPointer(move(150, 100));

    expect(events.at(-1).flags).toBe(3);

    model.addPointer(up(150, 100));

    expect(events.at(-1).flags).toBe(0);
  });

  it('нажатие дальше doubleTapPx двойным тапом не считается', () => {
    const model = makeModel();
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.addPointer(down(100, 100));
    model.addPointer(up(100, 100));
    model.addPointer(down(200, 100));

    expect(events.at(-1).flags).toBe(1);
  });

  it('нажатие позже doubleTapMs двойным тапом не считается', () => {
    vi.useFakeTimers();

    const model = makeModel();
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.addPointer(down(100, 100));
    model.addPointer(up(100, 100));

    vi.advanceTimersByTime(500);
    model.addPointer(down(100, 100));

    expect(events.at(-1).flags).toBe(1);

    vi.useRealTimers();
  });

  it('пока ввод выключен, указатель молчит', () => {
    const model = makeModel();
    const events = collectAim(model);

    model.addPointer(down(10, 10));

    expect(events).toHaveLength(0);
  });

  it('открытый чат гасит канал и отпускает прижатый указатель', () => {
    const model = makeModel();
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.addPointer(down(100, 100));
    model.setMode('chat', 'opened');

    expect(events.at(-1)).toEqual({ x: 100, y: 100, flags: 0 });

    model.addPointer(move(150, 150));

    expect(events).toHaveLength(2);
  });

  it('открытое голосование тоже гасит канал', () => {
    const model = makeModel();
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.setMode('vote', 'opened');
    model.addPointer(down(100, 100));

    expect(events).toHaveLength(0);
  });

  it('keySets ограничивает канал игровым набором клавиш', () => {
    const model = makeModel({ keySets: [1] });
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.addPointer(down(10, 10));

    expect(events).toHaveLength(0);

    model.changeKeySet(1);
    model.addPointer(down(10, 10));

    expect(events).toHaveLength(1);
  });

  it('смена набора клавиш отпускает прижатый указатель', () => {
    const model = makeModel();
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.addPointer(down(100, 100));
    model.changeKeySet(0);

    expect(events.at(-1).flags).toBe(0);
  });

  it('sendIntervalMs режет частоту move, не трогая down и up', () => {
    vi.useFakeTimers();

    const model = makeModel({ sendIntervalMs: 50 });
    const events = collectAim(model);

    model.setKeysEnabled(true);
    model.addPointer(down(100, 100));
    model.addPointer(move(101, 100));
    model.addPointer(move(102, 100));

    // окно отсчитывается и от нажатия: самая свежая точка уже ушла с down
    expect(events).toHaveLength(1);

    vi.advanceTimersByTime(60);
    model.addPointer(move(103, 100));

    expect(events).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe('CanvasManagerView.toWorld', () => {
  const makeApp = (overrides = {}) => ({
    renderer: { resize: vi.fn() },
    canvas: {
      width: 800,
      height: 600,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
      }),
      ...overrides,
    },
    stage: {
      position: { x: 400, y: 300, set: vi.fn() },
      scale: { x: 2, y: 2, set: vi.fn() },
    },
    render: vi.fn(),
  });

  it('снимает смещение камеры и масштаб сцены', () => {
    const view = new CanvasManagerView(
      { publisher: new Publisher() },
      { vimp: makeApp() },
    );

    // центр полотна — центр камеры (stage сдвинут ровно на половину)
    expect(view.toWorld('vimp', 400, 300)).toEqual({ x: 0, y: 0 });
    expect(view.toWorld('vimp', 600, 300)).toEqual({ x: 100, y: 0 });
  });

  it('учитывает растянутое CSS полотно и его положение на странице', () => {
    const app = makeApp({
      getBoundingClientRect: () => ({
        left: 100,
        top: 50,
        width: 400,
        height: 300,
      }),
    });
    const view = new CanvasManagerView(
      { publisher: new Publisher() },
      { vimp: app },
    );

    // 100 CSS-пикселей от левого края = 200 пикселей буфера
    expect(view.toWorld('vimp', 200, 50)).toEqual({ x: -100, y: -150 });
  });

  it('неизвестное полотно и схлопнутый прямоугольник дают null', () => {
    const app = makeApp({
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    });
    const view = new CanvasManagerView(
      { publisher: new Publisher() },
      { vimp: app },
    );

    expect(view.toWorld('нет такого', 10, 10)).toBeNull();
    expect(view.toWorld('vimp', 10, 10)).toBeNull();
  });

  it('контроллер берёт полотно указателя из конфига модели', () => {
    const model = new CanvasManagerModel({
      canvases: { vimp: { width: 800, height: 600 } },
    });
    const view = new CanvasManagerView(model, { vimp: makeApp() });
    const ctrl = new CanvasManagerCtrl(model, view);

    expect(model.pointerCanvasId).toBe('vimp');
    expect(ctrl.toWorld(400, 300)).toEqual({ x: 0, y: 0 });
  });
});

describe('InputListener: события указателя', () => {
  it('pointerdown/move/up транслируются в pointerAction с координатами', async () => {
    vi.resetModules();

    const InputListener = (
      await import('../../packages/engine/src/client/InputListener.js')
    ).default;
    const listener = new InputListener();
    const handler = vi.fn();

    listener.publisher.on('pointerAction', handler);

    window.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 10, clientY: 20 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 11, clientY: 21 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 12, clientY: 22 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointercancel', { clientX: 13, clientY: 23 }),
    );

    expect(handler.mock.calls.map(([data]) => data)).toEqual([
      { type: 'down', x: 10, y: 20 },
      { type: 'move', x: 11, y: 21 },
      { type: 'up', x: 12, y: 22 },
      { type: 'up', x: 13, y: 23 },
    ]);
  });
});
