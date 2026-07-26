import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// PanelCtrl — синглтон, перезагружаем модуль для изоляции
let PanelCtrl;

beforeEach(async () => {
  vi.resetModules();
  PanelCtrl = (await import('../../packages/engine/src/client/components/controller/Panel.js'))
    .default;
});

describe('PanelCtrl', () => {
  it('update проксируется в модель', () => {
    const model = { update: vi.fn() };
    new PanelCtrl(model, { publisher: new Publisher() }).update([1, 2, 3]);
    expect(model.update).toHaveBeenCalledWith([1, 2, 3]);
  });
});
