import { describe, it, expect, vi, afterEach } from 'vitest';
import VirtualClock from '../../packages/engine/src/devtools/VirtualClock.js';
import clock from '../../packages/engine/src/lib/clock.js';
import AbstractTimer from '../../packages/engine/src/lib/AbstractTimer.js';

class TestTimer extends AbstractTimer {
  start(key, cb, duration, isInterval) {
    this._startTimer(key, cb, duration, isInterval);
  }
  stop(key) {
    this._stopTimer(key);
  }
}

describe('VirtualClock', () => {
  afterEach(() => {
    clock.reset();
  });

  it('now() и monotonic() растут из одного счётчика', async () => {
    const virtual = new VirtualClock({ startTime: 1000 });

    expect(virtual.now()).toBe(1000);
    expect(virtual.monotonic()).toBe(0);

    await virtual.advance(250);

    expect(virtual.now()).toBe(1250);
    expect(virtual.monotonic()).toBe(250);
  });

  it('advance выполняет созревшие задачи в порядке времени', async () => {
    const virtual = new VirtualClock();
    const order = [];

    virtual.setTimeout(() => order.push('b'), 20);
    virtual.setTimeout(() => order.push('a'), 10);
    virtual.setTimeout(() => order.push('never'), 100);

    await virtual.advance(50);

    expect(order).toEqual(['a', 'b']);
  });

  it('при равном времени порядок — по очерёдности регистрации', async () => {
    const virtual = new VirtualClock();
    const order = [];

    virtual.setTimeout(() => order.push(1), 10);
    virtual.setTimeout(() => order.push(2), 10);
    virtual.setTimeout(() => order.push(3), 10);

    await virtual.advance(10);

    expect(order).toEqual([1, 2, 3]);
  });

  it('setInterval повторяется, clearInterval останавливает', async () => {
    const virtual = new VirtualClock();
    const cb = vi.fn();
    const id = virtual.setInterval(cb, 10);

    await virtual.advance(35);
    expect(cb).toHaveBeenCalledTimes(3);

    virtual.clearInterval(id);
    await virtual.advance(100);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('нулевой интервал не зацикливает advance', async () => {
    const virtual = new VirtualClock();
    const cb = vi.fn();

    virtual.setInterval(cb, 0);

    await virtual.advance(5);

    expect(cb).toHaveBeenCalledTimes(6);
  });

  it('random() воспроизводим по seed и различается между seed-ами', () => {
    const first = new VirtualClock({ seed: 7 });
    const same = new VirtualClock({ seed: 7 });
    const other = new VirtualClock({ seed: 8 });

    const draw = c => [c.random(), c.random(), c.random()];
    const values = draw(first);

    expect(draw(same)).toEqual(values);
    expect(draw(other)).not.toEqual(values);
    expect(values.every(v => v >= 0 && v < 1)).toBe(true);
  });

  it('install() перехватывает таймеры AbstractTimer', async () => {
    const virtual = new VirtualClock();
    const restore = virtual.install();
    const timer = new TestTimer();
    const cb = vi.fn();

    timer.start('t', cb, 100);

    expect(virtual.pendingCount).toBe(1);

    await virtual.advance(100);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(virtual.pendingCount).toBe(0);

    restore();
  });

  it('install() подменяет clock.now/random и откатывается', () => {
    const virtual = new VirtualClock({ startTime: 500, seed: 3 });
    const restore = virtual.install();

    expect(clock.now()).toBe(500);
    expect(clock.monotonic()).toBe(0);
    expect(clock.random()).toBe(new VirtualClock({ seed: 3 }).random());

    restore();

    expect(clock.now()).toBeGreaterThan(1e12);
  });

  it('задача, поставленная из задачи, выполняется в том же advance', async () => {
    const virtual = new VirtualClock();
    const order = [];

    virtual.setTimeout(() => {
      order.push('first');
      virtual.setTimeout(() => order.push('second'), 10);
    }, 10);

    await virtual.advance(30);

    expect(order).toEqual(['first', 'second']);
  });
});
