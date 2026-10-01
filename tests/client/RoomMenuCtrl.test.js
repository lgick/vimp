import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// RoomMenuCtrl — синглтон, перезагружаем модуль для изоляции
let RoomMenuCtrl;

beforeEach(async () => {
  vi.resetModules();
  RoomMenuCtrl = (
    await import('../../packages/engine/src/client/components/controller/RoomMenu.js')
  ).default;
});

describe('RoomMenuCtrl', () => {
  it('события view — в модель и действия, сеттеры — в модель', () => {
    const model = {
      toggle: vi.fn(),
      setLink: vi.fn(),
      setRole: vi.fn(),
      setHandoff: vi.fn(),
    };
    const view = { publisher: new Publisher(), placeInPanel: vi.fn() };
    const actions = { onLeave: vi.fn(), onHandover: vi.fn() };
    const ctrl = new RoomMenuCtrl(model, view, actions);

    view.publisher.emit('toggle');
    view.publisher.emit('leave');
    view.publisher.emit('handover');
    ctrl.setLink('L');
    ctrl.setRole({ role: 'host' });
    ctrl.setHandoff('pending');
    ctrl.setInPanel(true);

    expect(model.toggle).toHaveBeenCalledOnce();
    expect(actions.onLeave).toHaveBeenCalledOnce();
    expect(actions.onHandover).toHaveBeenCalledOnce();
    expect(model.setLink).toHaveBeenCalledWith('L');
    expect(model.setRole).toHaveBeenCalledWith({ role: 'host' });
    expect(model.setHandoff).toHaveBeenCalledWith('pending');
    expect(view.placeInPanel).toHaveBeenCalledWith(true);
  });
});
