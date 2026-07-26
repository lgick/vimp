import { describe, it, expect, vi } from 'vitest';
import GameCtrl from '../../packages/engine/src/client/components/controller/Game.js';

// GameCtrl — НЕ синглтон, можно создавать напрямую
const makeModel = (existing = {}) => ({
  createEffect: vi.fn(),
  read: vi.fn((constructor, id) => existing[id]),
  update: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
});

describe('GameCtrl.parse', () => {
  it('массив инстансов трактуется как эффекты (createEffect)', () => {
    const model = makeModel();
    new GameCtrl(model, {}).parse('explosion', [[1, 2], [3, 4]]);

    expect(model.createEffect).toHaveBeenCalledTimes(2);
    expect(model.createEffect).toHaveBeenNthCalledWith(1, 'explosion', [1, 2]);
    expect(model.createEffect).toHaveBeenNthCalledWith(2, 'explosion', [3, 4]);
  });

  it('обновляет существующий экземпляр', () => {
    const model = makeModel({ p1: true }); // read('p1') → true
    new GameCtrl(model, {}).parse('tank', { p1: [10, 20] });

    expect(model.update).toHaveBeenCalledWith('tank', 'p1', [10, 20]);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('создаёт новый экземпляр при наличии данных', () => {
    const model = makeModel(); // read → undefined
    new GameCtrl(model, {}).parse('tank', { p2: [5, 5] });

    expect(model.create).toHaveBeenCalledWith('tank', 'p2', [5, 5]);
    expect(model.update).not.toHaveBeenCalled();
  });

  it('не создаёт экземпляр при отсутствии данных (null)', () => {
    const model = makeModel(); // read → undefined
    new GameCtrl(model, {}).parse('tank', { p3: null });

    expect(model.create).not.toHaveBeenCalled();
    expect(model.update).not.toHaveBeenCalled();
  });

  it('remove проксируется в модель', () => {
    const model = makeModel();
    new GameCtrl(model, {}).remove('tank', 'p1');
    expect(model.remove).toHaveBeenCalledWith('tank', 'p1');
  });
});
