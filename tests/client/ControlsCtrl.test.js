import { describe, it, expect, beforeEach, vi } from 'vitest';

// ControlsCtrl — синглтон, перезагружаем модуль для изоляции
let ControlsCtrl;

const makeModel = () => ({
  addKey: vi.fn(),
  removeKey: vi.fn(),
  setMode: vi.fn(),
  changeKeySet: vi.fn(),
  setKeysEnabled: vi.fn(),
});

const makeView = () => ({ resetCursorHideTimer: vi.fn() });

beforeEach(async () => {
  vi.resetModules();
  ControlsCtrl = (
    await import('../../packages/engine/src/client/components/controller/Controls.js')
  ).default;
});

describe('ControlsCtrl', () => {
  it('add/remove проксируют клавиши в модель', () => {
    const model = makeModel();
    const ctrl = new ControlsCtrl(model, makeView());

    ctrl.add({ code: 'KeyW' });
    ctrl.remove({ code: 'KeyW' });

    expect(model.addKey).toHaveBeenCalledWith({ code: 'KeyW' });
    expect(model.removeKey).toHaveBeenCalledWith({ code: 'KeyW' });
  });

  it('switchMode передаёт name и status', () => {
    const model = makeModel();
    new ControlsCtrl(model, makeView()).switchMode({
      name: 'chat',
      status: true,
    });
    expect(model.setMode).toHaveBeenCalledWith('chat', true);
  });

  it('changeKeySet проксируется в модель', () => {
    const model = makeModel();
    new ControlsCtrl(model, makeView()).changeKeySet('game');
    expect(model.changeKeySet).toHaveBeenCalledWith('game');
  });

  it('enableKeys/disableKeys переключают флаг модели', () => {
    const model = makeModel();
    const ctrl = new ControlsCtrl(model, makeView());

    ctrl.enableKeys();
    expect(model.setKeysEnabled).toHaveBeenCalledWith(true);

    ctrl.disableKeys();
    expect(model.setKeysEnabled).toHaveBeenCalledWith(false);
  });

  it('resetCursorHideTimer обращается к view', () => {
    const view = makeView();
    new ControlsCtrl(makeModel(), view).resetCursorHideTimer();
    expect(view.resetCursorHideTimer).toHaveBeenCalled();
  });
});
