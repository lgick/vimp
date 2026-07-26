import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// ChatCtrl — синглтон, перезагружаем модуль для изоляции
let ChatCtrl;

const makeModel = () => ({
  open: vi.fn(),
  close: vi.fn(),
  sendMessage: vi.fn(),
  updateChat: vi.fn(),
  addToList: vi.fn(),
  removeFromList: vi.fn(),
});

const makeView = () => ({ publisher: new Publisher() });

beforeEach(async () => {
  vi.resetModules();
  ChatCtrl = (await import('../../packages/engine/src/client/components/controller/Chat.js'))
    .default;
});

describe('ChatCtrl.updateCmd', () => {
  it('enter закрывает cmd с отправкой', () => {
    const model = makeModel();
    new ChatCtrl(model, makeView()).updateCmd('enter');
    expect(model.close).toHaveBeenCalledWith(true);
  });

  it('escape закрывает cmd без отправки', () => {
    const model = makeModel();
    new ChatCtrl(model, makeView()).updateCmd('escape');
    expect(model.close).toHaveBeenCalledWith(false);
  });

  it('неизвестная команда ничего не делает', () => {
    const model = makeModel();
    new ChatCtrl(model, makeView()).updateCmd('tab');
    expect(model.close).not.toHaveBeenCalled();
  });
});

describe('ChatCtrl: проводка методов', () => {
  it('open/add проксируются в модель', () => {
    const model = makeModel();
    const ctrl = new ChatCtrl(model, makeView());

    ctrl.open();
    ctrl.add('привет');

    expect(model.open).toHaveBeenCalled();
    expect(model.updateChat).toHaveBeenCalledWith('привет');
  });
});

describe('ChatCtrl: события view', () => {
  it('message → sendMessage модели', () => {
    const model = makeModel();
    const view = makeView();
    new ChatCtrl(model, view);

    view.publisher.emit('message', 'hi');
    expect(model.sendMessage).toHaveBeenCalledWith('hi');
  });

  it('newTimer → addToList, oldTimer → removeFromList', () => {
    const model = makeModel();
    const view = makeView();
    new ChatCtrl(model, view);

    view.publisher.emit('newTimer', { id: 1 });
    view.publisher.emit('oldTimer');

    expect(model.addToList).toHaveBeenCalledWith({ id: 1 });
    expect(model.removeFromList).toHaveBeenCalled();
  });
});
