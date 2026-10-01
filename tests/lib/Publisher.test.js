import { describe, it, expect, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

describe('Publisher', () => {
  it('вызывает подписчика при emit', () => {
    const pub = new Publisher();
    const fn = vi.fn();

    pub.on('event', fn);
    pub.emit('event', 42);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(42);
  });

  it('рассылает событие всем подписчикам', () => {
    const pub = new Publisher();
    const a = vi.fn();
    const b = vi.fn();

    pub.on('e', a);
    pub.on('e', b);
    pub.emit('e');

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('emit без подписчиков не падает', () => {
    const pub = new Publisher();
    expect(() => pub.emit('missing', 1)).not.toThrow();
  });

  it('вызывает обработчик в указанном контексте', () => {
    const pub = new Publisher();
    const context = {
      value: 7,
      handler(data) {
        this.received = this.value + data;
      },
    };

    pub.on('e', 'handler', context);
    pub.emit('e', 3);

    expect(context.received).toBe(10);
  });

  it('подписка по имени метода без контекста бросает (текущее поведение)', () => {
    const pub = new Publisher();
    expect(() => pub.on('e', 'handler')).toThrow();
  });

  it('off снимает подписчика-функцию', () => {
    const pub = new Publisher();
    const a = vi.fn();
    const b = vi.fn();

    pub.on('e', a);
    pub.on('e', b);
    pub.off('e', a);
    pub.emit('e');

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('off по имени метода снимает только подписку этого контекста', () => {
    const pub = new Publisher();
    const first = { handler: vi.fn() };
    const second = { handler: vi.fn() };

    // один и тот же обработчик у двух контекстов
    second.handler = first.handler;

    pub.on('e', 'handler', first);
    pub.on('e', 'handler', second);
    pub.off('e', 'handler', first);
    pub.emit('e');

    expect(first.handler).toHaveBeenCalledTimes(1);
    expect(first.handler.mock.contexts[0]).toBe(second);
  });

  it('отписка из обработчика посреди emit не пропускает соседа', () => {
    const pub = new Publisher();
    const b = vi.fn();
    const a = () => pub.off('e', a);

    pub.on('e', a);
    pub.on('e', b);
    pub.emit('e');

    expect(b).toHaveBeenCalledTimes(1);
  });

  it('off неизвестного события не падает', () => {
    const pub = new Publisher();

    expect(() => pub.off('missing', () => {})).not.toThrow();
  });
});
