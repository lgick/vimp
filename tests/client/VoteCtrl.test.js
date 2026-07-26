import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// VoteCtrl — синглтон, перезагружаем модуль для изоляции
let VoteCtrl;

const makeModel = () => ({
  updateValues: vi.fn(),
  createWithTemplate: vi.fn(),
  createMenu: vi.fn(),
  open: vi.fn(),
  update: vi.fn(),
  assignTimer: vi.fn(),
  complete: vi.fn(),
});

const makeView = () => ({ publisher: new Publisher() });

beforeEach(async () => {
  vi.resetModules();
  VoteCtrl = (await import('../../packages/engine/src/client/components/controller/Vote.js'))
    .default;
});

describe('VoteCtrl.open', () => {
  it('массив → обновляет values без открытия', () => {
    const model = makeModel();
    new VoteCtrl(model, makeView()).open(['v1', 'v2']);

    expect(model.updateValues).toHaveBeenCalledWith(['v1', 'v2']);
    expect(model.open).not.toHaveBeenCalled();
  });

  it('объект → создаёт голосование по шаблону и открывает', () => {
    const model = makeModel();
    const data = { name: 'map', params: [], values: [] };
    new VoteCtrl(model, makeView()).open(data);

    expect(model.createWithTemplate).toHaveBeenCalledWith(data);
    expect(model.open).toHaveBeenCalled();
  });

  it('иначе → открывает меню', () => {
    const model = makeModel();
    new VoteCtrl(model, makeView()).open();

    expect(model.createMenu).toHaveBeenCalled();
    expect(model.open).toHaveBeenCalled();
  });
});

describe('VoteCtrl: проводка', () => {
  it('assignKey → update модели', () => {
    const model = makeModel();
    new VoteCtrl(model, makeView()).assignKey(13);
    expect(model.update).toHaveBeenCalledWith(13);
  });

  it('событие timer → assignTimer, clear → complete', () => {
    const model = makeModel();
    const view = makeView();
    new VoteCtrl(model, view);

    view.publisher.emit('timer', 7);
    view.publisher.emit('clear');

    expect(model.assignTimer).toHaveBeenCalledWith(7);
    expect(model.complete).toHaveBeenCalled();
  });
});
