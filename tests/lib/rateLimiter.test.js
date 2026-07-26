import { describe, it, expect } from 'vitest';
import RateLimiter from '../../packages/engine/src/lib/rateLimiter.js';

describe('RateLimiter', () => {
  it('пропускает события в пределах лимита', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });

    expect(limiter.consume('ip1', 0)).toBe(true);
    expect(limiter.consume('ip1', 10)).toBe(true);
    expect(limiter.consume('ip1', 20)).toBe(true);
  });

  it('блокирует события сверх лимита в одном окне', () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });

    limiter.consume('ip1', 0);
    limiter.consume('ip1', 10);

    expect(limiter.consume('ip1', 20)).toBe(false);
    expect(limiter.consume('ip1', 999)).toBe(false);
  });

  it('сбрасывает счётчик в новом окне', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });

    expect(limiter.consume('ip1', 0)).toBe(true);
    expect(limiter.consume('ip1', 500)).toBe(false);
    expect(limiter.consume('ip1', 1000)).toBe(true);
  });

  it('считает лимиты независимо по ключам', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });

    expect(limiter.consume('ip1', 0)).toBe(true);
    expect(limiter.consume('ip2', 0)).toBe(true);
    expect(limiter.consume('ip1', 10)).toBe(false);
  });

  it('sweep удаляет истёкшие окна, свежие остаются', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });

    limiter.consume('old', 0);
    limiter.consume('fresh', 900);

    limiter.sweep(1000);

    // истёкшее окно удалено — ключ снова доступен
    expect(limiter.consume('old', 1000)).toBe(true);
    // свежее окно осталось — лимит всё ещё действует
    expect(limiter.consume('fresh', 1000)).toBe(false);
  });

  it('clear сбрасывает все счётчики', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });

    limiter.consume('ip1', 0);
    limiter.clear();

    expect(limiter.consume('ip1', 10)).toBe(true);
  });
});
