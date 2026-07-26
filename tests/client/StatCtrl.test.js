import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// StatCtrl — синглтон, перезагружаем модуль для изоляции
let StatCtrl;

const makeModel = () => ({
  open: vi.fn(),
  close: vi.fn(),
  update: vi.fn(),
});

beforeEach(async () => {
  vi.resetModules();
  StatCtrl = (await import('../../packages/engine/src/client/components/controller/Stat.js'))
    .default;
});

describe('StatCtrl', () => {
  it('open/close/update проксируются в модель', () => {
    const model = makeModel();
    const ctrl = new StatCtrl(model, { publisher: new Publisher() });

    ctrl.open();
    ctrl.close();
    ctrl.update({ rows: [] });

    expect(model.open).toHaveBeenCalled();
    expect(model.close).toHaveBeenCalled();
    expect(model.update).toHaveBeenCalledWith({ rows: [] });
  });
});
