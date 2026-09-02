import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// GamesCtrl — синглтон, перезагружаем модуль для изоляции
let GamesCtrl;

let model;
let view;
let ctrl;

beforeEach(async () => {
  vi.resetModules();
  GamesCtrl = (
    await import('../../packages/engine/src/client/components/controller/Games.js')
  ).default;

  model = {
    publisher: new Publisher(),
    loadMine: vi.fn(),
    loadAdmin: vi.fn(),
    loadVersions: vi.fn(),
    submit: vi.fn(),
    requestVersion: vi.fn(),
    setFilter: vi.fn(),
    loadStaged: vi.fn(),
    stage: vi.fn(),
    moderate: vi.fn(),
  };

  view = { publisher: new Publisher(), show: vi.fn(), setAdmin: vi.fn() };
  ctrl = new GamesCtrl(model, view);
});

describe('GamesCtrl', () => {
  it('«Мои игры» открывает панель без модерации и грузит заявки', () => {
    view.publisher.emit('open-mine');

    expect(view.show).toHaveBeenCalledWith(false);
    expect(model.loadMine).toHaveBeenCalled();
    expect(model.loadAdmin).not.toHaveBeenCalled();
  });

  it('«Модерация» открывает очередь', () => {
    view.publisher.emit('open-moderation');

    expect(view.show).toHaveBeenCalledWith(true);
    expect(model.loadAdmin).toHaveBeenCalled();
  });

  it('решения модератора уходят патчем статуса', () => {
    view.publisher.emit('approve', { id: 'tanks' });
    view.publisher.emit('reject', { id: 'tanks', note: 'нет карт' });
    view.publisher.emit('disable', { id: 'tanks' });

    expect(model.moderate.mock.calls).toEqual([
      ['tanks', { status: 'approved' }],
      ['tanks', { status: 'rejected', note: 'нет карт' }],
      ['tanks', { status: 'disabled' }],
    ]);
  });

  it('пробрасывает остальные намерения в модель', () => {
    view.publisher.emit('submit', { id: 'tanks' });
    view.publisher.emit('update-version', { id: 'tanks', version: '1.1.0' });
    view.publisher.emit('filter', 'approved');
    view.publisher.emit('stage', { id: 'tanks', version: '1.1.0' });
    view.publisher.emit('load-versions', { id: 'tanks' });

    expect(model.submit).toHaveBeenCalledWith({ id: 'tanks' });
    expect(model.requestVersion).toHaveBeenCalledWith('tanks', '1.1.0');
    expect(model.setFilter).toHaveBeenCalledWith('approved');
    expect(model.stage).toHaveBeenCalledWith('tanks', '1.1.0');
    expect(model.loadVersions).toHaveBeenCalledWith('tanks');
  });

  it('манифест застейдженной версии пробрасывается наружу (main.js)', () => {
    const seen = [];

    ctrl.publisher.on('staged', e => seen.push(e));
    model.publisher.emit('staged', { id: 'tanks', version: '1.1.0', manifest: { id: 'tanks' } });

    expect(seen).toEqual([{ id: 'tanks', version: '1.1.0', manifest: { id: 'tanks' } }]);
  });

  it('роль решает видимость кнопки модерации и возврат черновиков', () => {
    ctrl.setAdmin(true);

    expect(view.setAdmin).toHaveBeenCalledWith(true);
    expect(model.loadStaged).toHaveBeenCalled();
  });

  it('обычному игроку черновики не запрашиваются', () => {
    ctrl.setAdmin(false);

    expect(model.loadStaged).not.toHaveBeenCalled();
  });
});
