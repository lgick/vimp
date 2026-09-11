import { describe, it, expect, vi } from 'vitest';
import applyCamera from '../../packages/engine/src/client/lib/applyCamera.js';

const makeDeps = () => {
  const canvasManager = {
    updateCoords: vi.fn(),
    getCameraZoom: vi.fn(() => 0.8),
  };
  const soundManager = { setListenerPosition: vi.fn() };

  return { canvasManager, soundManager };
};

describe('applyCamera', () => {
  it('передаёт слушателю позицию и зум камеры', () => {
    const { canvasManager, soundManager } = makeDeps();
    const camera = [120, -40, 0, null];

    applyCamera(canvasManager, soundManager, camera);

    expect(canvasManager.updateCoords).toHaveBeenCalledWith(camera);
    expect(soundManager.setListenerPosition).toHaveBeenCalledWith(
      120,
      -40,
      0.8,
    );
  });

  it('считает зум ПОСЛЕ обновления полотна', () => {
    const { canvasManager, soundManager } = makeDeps();

    applyCamera(canvasManager, soundManager, [0, 0]);

    // зум пересчитывается внутри updateCoords: спросив его раньше, слушатель
    // получил бы зум прошлого кадра, и на разгоне стереобаза отставала бы
    // от картинки
    const [update] = canvasManager.updateCoords.mock.invocationCallOrder;
    const [zoom] = canvasManager.getCameraZoom.mock.invocationCallOrder;

    expect(zoom).toBeGreaterThan(update);
  });

  it('пустой кадр камеры не трогает ничего', () => {
    const { canvasManager, soundManager } = makeDeps();

    for (const camera of [0, null, undefined]) {
      applyCamera(canvasManager, soundManager, camera);
    }

    expect(canvasManager.updateCoords).not.toHaveBeenCalled();
    expect(soundManager.setListenerPosition).not.toHaveBeenCalled();
  });
});
