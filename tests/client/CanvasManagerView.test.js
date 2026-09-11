import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// CanvasManagerView — синглтон, перезагружаем модуль для изоляции
let CanvasManagerView;

// `screen` — размер сцены в её собственных единицах, `canvas` — буфер
// полотна: они расходятся, как только у рендерера resolution не единица
const makeApp = (screen = { width: 800, height: 600 }) => ({
  renderer: { resize: vi.fn(), screen },
  canvas: {
    width: screen.width,
    height: screen.height,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: screen.width,
      height: screen.height,
    }),
  },
  stage: {
    position: { set: vi.fn(), x: 0, y: 0 },
    scale: { set: vi.fn(), x: 1, y: 1 },
  },
  render: vi.fn(),
});

const makeModel = () => ({ publisher: new Publisher() });

beforeEach(async () => {
  vi.resetModules();
  CanvasManagerView = (
    await import('../../packages/engine/src/client/components/view/CanvasManager.js')
  ).default;
});

describe('CanvasManagerView.resize', () => {
  it('меняет размер рендерера нужного приложения', () => {
    const app = makeApp();
    const view = new CanvasManagerView(makeModel(), { vimp: app });

    view.resize({ id: 'vimp', sizes: { width: 1024, height: 768 } });

    expect(app.renderer.resize).toHaveBeenCalledWith(1024, 768);
  });

  it('срабатывает по событию resize модели', () => {
    const app = makeApp();
    const model = makeModel();
    new CanvasManagerView(model, { vimp: app });

    model.publisher.emit('resize', {
      id: 'vimp',
      sizes: { width: 640, height: 480 },
    });

    expect(app.renderer.resize).toHaveBeenCalledWith(640, 480);
  });
});

describe('CanvasManagerView.updateCoords', () => {
  it('центрирует сцену относительно координат с учётом масштаба', () => {
    const app = makeApp(); // сцена 800x600
    const view = new CanvasManagerView(makeModel(), { vimp: app });

    view.updateCoords({ id: 'vimp', coords: { x: 100, y: 50 }, scale: 2 });

    // x = 800/2 - 100*2 = 200; y = 600/2 - 50*2 = 200
    expect(app.stage.position.set).toHaveBeenCalledWith(200, 200);
    expect(app.stage.scale.set).toHaveBeenCalledWith(2);
  });

  // сцену двигают в единицах `renderer.screen`; буфер полотна умножен на
  // resolution, и по нему центр уехал бы на полэкрана — молча: картинка
  // осталась бы на месте, а части игры, восстанавливающие центр камеры по
  // трансформу сцены (проекция 2.5D), считали бы его от чужой точки
  it('центр считается по сцене, а не по буферу полотна', () => {
    const app = makeApp();

    // retina: буфер вдвое больше сцены
    app.canvas.width = 1600;
    app.canvas.height = 1200;

    const view = new CanvasManagerView(makeModel(), { vimp: app });

    view.updateCoords({ id: 'vimp', coords: { x: 0, y: 0 }, scale: 1 });

    expect(app.stage.position.set).toHaveBeenCalledWith(400, 300);
  });

  // полотно рисует тикер (TickerPlugin, приоритет LOW — после renderTick),
  // и рисует РАЗ за тик. Своя отрисовка здесь означала бы два-три полных
  // обхода сцены на каждый видимый кадр: кадров камеры за тик несколько
  it('сам не рисует: отрисовка принадлежит тикеру', () => {
    const app = makeApp();
    const view = new CanvasManagerView(makeModel(), { vimp: app });

    view.updateCoords({ id: 'vimp', coords: { x: 0, y: 0 }, scale: 1 });

    expect(app.render).not.toHaveBeenCalled();
  });
});

describe('CanvasManagerView.toWorld', () => {
  // указатель переводится в мировые координаты тем же трансформом сцены,
  // поэтому и его единицы — `renderer.screen`, а не пиксели буфера
  it('переводит точку указателя в мировую по сцене, а не по буферу', () => {
    const app = makeApp();

    app.canvas.width = 1600;
    app.canvas.height = 1200;
    app.stage.position.x = 400;
    app.stage.position.y = 300;
    app.stage.scale.x = 2;
    app.stage.scale.y = 2;

    const view = new CanvasManagerView(makeModel(), { vimp: app });

    // центр полотна — это центр камеры, то есть мировой (0, 0)
    expect(view.toWorld('vimp', 400, 300)).toEqual({ x: 0, y: 0 });
  });
});
