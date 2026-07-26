import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// AuthCtrl — синглтон, перезагружаем модуль для изоляции
let AuthCtrl;

const makeModel = () => ({
  add: vi.fn(),
  update: vi.fn(),
  send: vi.fn(),
  parseRes: vi.fn(),
});

const makeView = () => ({
  publisher: new Publisher(),
  showAuth: vi.fn(),
});

beforeEach(async () => {
  vi.resetModules();
  AuthCtrl = (await import('../../packages/engine/src/client/components/controller/Auth.js'))
    .default;
});

describe('AuthCtrl', () => {
  it('init добавляет все поля в модель и показывает форму', () => {
    const model = makeModel();
    const view = makeView();
    const ctrl = new AuthCtrl(model, view);

    ctrl.init(['a', 'b']);

    expect(model.add).toHaveBeenCalledTimes(2);
    expect(model.add).toHaveBeenNthCalledWith(1, 'a');
    expect(model.add).toHaveBeenNthCalledWith(2, 'b');
    expect(view.showAuth).toHaveBeenCalled();
  });

  it('проксирует update/send/parseRes в модель', () => {
    const model = makeModel();
    const ctrl = new AuthCtrl(model, makeView());

    ctrl.update({ name: 'login', value: 'x' });
    ctrl.send();
    ctrl.parseRes('err');

    expect(model.update).toHaveBeenCalledWith({ name: 'login', value: 'x' });
    expect(model.send).toHaveBeenCalled();
    expect(model.parseRes).toHaveBeenCalledWith('err');
  });

  it('событие input вызывает update модели', () => {
    const model = makeModel();
    const view = makeView();
    new AuthCtrl(model, view);

    view.publisher.emit('input', { name: 'login' });
    expect(model.update).toHaveBeenCalledWith({ name: 'login' });
  });

  it('событие enter вызывает send модели', () => {
    const model = makeModel();
    const view = makeView();
    new AuthCtrl(model, view);

    view.publisher.emit('enter');
    expect(model.send).toHaveBeenCalled();
  });
});
