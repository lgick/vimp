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
});
