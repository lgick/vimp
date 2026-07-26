import { describe, it, expect, beforeEach, vi } from 'vitest';

// InputListener — синглтон, перезагружаем для изоляции
let InputListener;

beforeEach(async () => {
  vi.resetModules();
  InputListener = (await import('../../packages/engine/src/client/InputListener.js')).default;
});

describe('InputListener', () => {
  it('keydown окна транслируется в событие keyDown', () => {
    const listener = new InputListener();
    const handler = vi.fn();
    listener.publisher.on('keyDown', handler);

    window.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 87 }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].keyCode).toBe(87);
  });

  it('keyup транслируется в keyUp', () => {
    const listener = new InputListener();
    const handler = vi.fn();
    listener.publisher.on('keyUp', handler);

    window.dispatchEvent(new KeyboardEvent('keyup', { keyCode: 65 }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('действия мыши эмитят mouseAction', () => {
    const listener = new InputListener();
    const handler = vi.fn();
    listener.publisher.on('mouseAction', handler);

    window.dispatchEvent(new MouseEvent('mousedown'));
    window.dispatchEvent(new MouseEvent('mousemove'));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('resize эмитит размеры окна', () => {
    const listener = new InputListener();
    const handler = vi.fn();
    listener.publisher.on('resize', handler);

    window.dispatchEvent(new Event('resize'));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toHaveProperty('width');
    expect(handler.mock.calls[0][0]).toHaveProperty('height');
  });
});
