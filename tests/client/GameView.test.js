import { describe, it, expect, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';
import GameView from '../../packages/engine/src/client/components/view/Game.js';

// GameView — НЕ синглтон, создаём напрямую
const makeApp = () => ({
  stage: {
    addChild: vi.fn(),
    sortChildren: vi.fn(),
  },
});

const makeModel = () => ({ publisher: new Publisher() });

describe('GameView.add', () => {
  it('добавляет экземпляр на сцену и сортирует по слою', () => {
    const app = makeApp();
    const view = new GameView(makeModel(), app);
    const instance = { layer: 2 };

    view.add(instance);

    expect(app.stage.addChild).toHaveBeenCalledWith(instance);
    expect(app.stage.sortChildren).toHaveBeenCalled();
  });
});

describe('GameView.addEffect', () => {
  it('добавляет эффект и запускает его', () => {
    const app = makeApp();
    const view = new GameView(makeModel(), app);
    const effect = { layer: 1, run: vi.fn() };

    view.addEffect(effect);

    expect(app.stage.addChild).toHaveBeenCalledWith(effect);
    expect(effect.run).toHaveBeenCalled();
  });
});

describe('GameView.remove', () => {
  it('уничтожает экземпляр', () => {
    const view = new GameView(makeModel(), makeApp());
    const instance = { destroy: vi.fn() };

    view.remove(instance);

    expect(instance.destroy).toHaveBeenCalled();
  });
});

describe('GameView: события модели', () => {
  it('create → add, createEffect → addEffect, remove → remove', () => {
    const app = makeApp();
    const model = makeModel();
    new GameView(model, app);

    const inst = { layer: 0 };
    const effect = { layer: 0, run: vi.fn() };
    const dead = { destroy: vi.fn() };

    model.publisher.emit('create', inst);
    model.publisher.emit('createEffect', effect);
    model.publisher.emit('remove', dead);

    expect(app.stage.addChild).toHaveBeenCalledWith(inst);
    expect(effect.run).toHaveBeenCalled();
    expect(dead.destroy).toHaveBeenCalled();
  });
});
