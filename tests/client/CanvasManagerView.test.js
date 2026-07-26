import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// CanvasManagerView — синглтон, перезагружаем модуль для изоляции
let CanvasManagerView;

const makeApp = () => ({
  renderer: { resize: vi.fn() },
  canvas: { width: 800, height: 600 },
  stage: {
    position: { set: vi.fn() },
    scale: { set: vi.fn() },
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
    const app = makeApp(); // canvas 800x600
    const view = new CanvasManagerView(makeModel(), { vimp: app });

    view.updateCoords({ id: 'vimp', coords: { x: 100, y: 50 }, scale: 2 });

    // x = 800/2 - 100*2 = 200; y = 600/2 - 50*2 = 200
    expect(app.stage.position.set).toHaveBeenCalledWith(200, 200);
    expect(app.stage.scale.set).toHaveBeenCalledWith(2);
    expect(app.render).toHaveBeenCalled();
  });
});
