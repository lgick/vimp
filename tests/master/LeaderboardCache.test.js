import { describe, it, expect, vi } from 'vitest';
import LeaderboardCache from '../../packages/engine/src/master/LeaderboardCache.js';

const okResult = { status: 200, json: { leaderboard: [], total: 0 } };

const makeProxy = impl => ({ getLeaderboard: vi.fn(impl) });

describe('LeaderboardCache', () => {
  it('промах — вызывает proxy и отдаёт результат', async () => {
    const proxy = makeProxy(async () => okResult);
    const cache = new LeaderboardCache(proxy);

    const result = await cache.get('tanks', 10);

    expect(result).toBe(okResult);
    expect(proxy.getLeaderboard).toHaveBeenCalledWith('tanks', 10);
  });

  it('в пределах TTL повторно proxy не зовёт', async () => {
    const proxy = makeProxy(async () => okResult);
    let now = 0;
    const cache = new LeaderboardCache(proxy, { ttlMs: 15000, now: () => now });

    await cache.get('tanks', 10);
    now += 1000;
    await cache.get('tanks', 10);

    expect(proxy.getLeaderboard).toHaveBeenCalledTimes(1);
  });

  it('после истечения TTL — рефетч', async () => {
    const proxy = makeProxy(async () => okResult);
    let now = 0;
    const cache = new LeaderboardCache(proxy, { ttlMs: 15000, now: () => now });

    await cache.get('tanks', 10);
    now += 15000;
    await cache.get('tanks', 10);

    expect(proxy.getLeaderboard).toHaveBeenCalledTimes(2);
  });

  it('ответ не-200 не кэшируется', async () => {
    const proxy = makeProxy(async () => ({ status: 502, json: { error: 'authServiceUnavailable' } }));
    const cache = new LeaderboardCache(proxy, { ttlMs: 15000, now: () => 0 });

    await cache.get('tanks', 10);
    await cache.get('tanks', 10);

    expect(proxy.getLeaderboard).toHaveBeenCalledTimes(2);
  });

  it('разные game/limit — разные записи кэша', async () => {
    const proxy = makeProxy(async () => okResult);
    const cache = new LeaderboardCache(proxy, { ttlMs: 15000, now: () => 0 });

    await cache.get('tanks', 10);
    await cache.get('tanks', 20);
    await cache.get('other', 10);

    expect(proxy.getLeaderboard).toHaveBeenCalledTimes(3);
  });
});
