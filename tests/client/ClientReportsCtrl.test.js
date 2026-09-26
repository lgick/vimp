import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// ClientReportsCtrl — синглтон, перезагружаем модуль для изоляции
let ClientReportsCtrl;

let model;
let view;
let ctrl;

beforeEach(async () => {
  vi.resetModules();
  ClientReportsCtrl = (
    await import('../../packages/engine/src/client/components/controller/ClientReports.js')
  ).default;

  model = { load: vi.fn(), setFilter: vi.fn(), setStatus: vi.fn() };
  view = { publisher: new Publisher(), show: vi.fn(), setAdmin: vi.fn() };
  ctrl = new ClientReportsCtrl(model, view);
});

describe('ClientReportsCtrl', () => {
  it('setAdmin пробрасывает роль во view', () => {
    ctrl.setAdmin(false);
    ctrl.setAdmin(true);

    expect(view.setAdmin.mock.calls).toEqual([[false], [true]]);
  });

  it('открытие показывает панель и грузит журнал с начала', () => {
    view.publisher.emit('open');

    expect(view.show).toHaveBeenCalled();
    expect(model.load).toHaveBeenCalledWith({ reset: true });
  });

  it('графа, игра, «ещё» и решение доезжают до модели', () => {
    view.publisher.emit('filter', 'fixed');
    view.publisher.emit('game', 'tanks');
    view.publisher.emit('more');
    view.publisher.emit('set-status', { id: 3, status: 'ignored', note: null });

    expect(model.setFilter.mock.calls).toEqual([[{ status: 'fixed' }], [{ gameId: 'tanks' }]]);
    expect(model.load).toHaveBeenCalledWith();
    expect(model.setStatus).toHaveBeenCalledWith(3, 'ignored', null);
  });
});
