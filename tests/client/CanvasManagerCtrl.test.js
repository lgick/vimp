import { describe, it, expect, beforeEach, vi } from 'vitest';

// CanvasManagerCtrl — синглтон, перезагружаем модуль для изоляции
let CanvasManagerCtrl;

const makeModel = () => ({
  updateCoords: vi.fn(),
  resize: vi.fn(),
});

beforeEach(async () => {
  vi.resetModules();
  CanvasManagerCtrl = (
    await import('../../packages/engine/src/client/components/controller/CanvasManager.js')
  ).default;
});

describe('CanvasManagerCtrl', () => {
  it('updateCoords разбирает массив в аргументы модели', () => {
    const model = makeModel();
    const shake = { intensity: 2 };
    new CanvasManagerCtrl(model, {}).updateCoords([10, 20, true, shake]);

    expect(model.updateCoords).toHaveBeenCalledWith(10, 20, true, shake);
  });

  it('resize проксируется в модель', () => {
    const model = makeModel();
    new CanvasManagerCtrl(model, {}).resize({ width: 800, height: 600 });
    expect(model.resize).toHaveBeenCalledWith({ width: 800, height: 600 });
  });
});
