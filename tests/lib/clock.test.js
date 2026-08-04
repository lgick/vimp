import { describe, it, expect, vi, afterEach } from 'vitest';
import clock from '../../packages/engine/src/lib/clock.js';

describe('clock', () => {
  afterEach(() => {
    clock.reset();
    vi.useRealTimers();
  });

  describe('реализация по умолчанию', () => {
    it('now() отдаёт эпоху, monotonic() — счётчик высокого разрешения', () => {
      const before = Date.now();
      const now = clock.now();

      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(Date.now());

      const first = clock.monotonic();
      expect(typeof first).toBe('number');
      expect(clock.monotonic()).toBeGreaterThanOrEqual(first);
    });

    it('random() возвращает число из [0, 1)', () => {
      for (let i = 0; i < 20; i += 1) {
        const value = clock.random();

        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });

    it('таймеры идут через глобалы (позднее связывание с fake timers)', () => {
      vi.useFakeTimers();

      const onTimeout = vi.fn();
      const onInterval = vi.fn();

      const timeoutId = clock.setTimeout(onTimeout, 100);
      const intervalId = clock.setInterval(onInterval, 50);

      vi.advanceTimersByTime(100);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onInterval).toHaveBeenCalledTimes(2);

      clock.clearInterval(intervalId);
      clock.clearTimeout(timeoutId);

      vi.advanceTimersByTime(200);

      expect(onInterval).toHaveBeenCalledTimes(2);
    });
  });

  describe('install / reset', () => {
    it('подменяет все методы и возвращает функцию отката', () => {
      const restore = clock.install({
        now: () => 1000,
        monotonic: () => 7,
        random: () => 0.5,
      });

      expect(clock.now()).toBe(1000);
      expect(clock.monotonic()).toBe(7);
      expect(clock.random()).toBe(0.5);

      restore();

      expect(clock.now()).not.toBe(1000);
      expect(clock.random()).not.toBe(0.5);
    });

    it('частичная подмена дополняется дефолтами', () => {
      clock.install({ random: () => 0.25 });

      expect(clock.random()).toBe(0.25);
      expect(clock.now()).toBeGreaterThan(0);
      expect(typeof clock.monotonic()).toBe('number');
    });

    it('install поверх install откатывается послойно', () => {
      const restoreFirst = clock.install({ now: () => 1 });
      const restoreSecond = clock.install({ now: () => 2 });

      expect(clock.now()).toBe(2);

      restoreSecond();
      expect(clock.now()).toBe(1);

      restoreFirst();
      expect(clock.now()).not.toBe(1);
    });

    it('reset() возвращает дефолты независимо от глубины install', () => {
      clock.install({ now: () => 1 });
      clock.install({ now: () => 2 });

      clock.reset();

      expect(clock.now()).toBeGreaterThan(1e12);
    });

    it('таймеры уходят в подменённую реализацию', () => {
      const pending = [];
      const setFake = vi.fn(callback => {
        pending.push(callback);
        return pending.length;
      });
      const clearFake = vi.fn();

      clock.install({
        setTimeout: setFake,
        clearTimeout: clearFake,
        setInterval: setFake,
        clearInterval: clearFake,
      });

      const callback = vi.fn();

      expect(clock.setTimeout(callback, 10)).toBe(1);
      expect(clock.setInterval(callback, 10)).toBe(2);
      expect(setFake).toHaveBeenCalledTimes(2);

      clock.clearTimeout(1);
      clock.clearInterval(2);

      expect(clearFake).toHaveBeenCalledTimes(2);
    });
  });
});
