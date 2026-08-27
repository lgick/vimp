import { describe, it, expect, vi } from 'vitest';
import PlacementCache from '../../packages/engine/src/master/PlacementCache.js';

const okResult = { status: 200, json: { placement: 3, total: 100, rank: 40 } };

const makeProxy = impl => ({ getPlacement: vi.fn(impl) });

// Место игрока меняется медленно, а запрос за ним тяжелее топа (оконная
// функция по всему леджеру), и каждый вход участника стоит трёх срезов —
// агрегирующий GET /auth/placements ходит через этот кэш (snakes-v3 3.3)
describe('PlacementCache', () => {
  it('промах — зовёт proxy и отдаёт результат', async () => {
    const proxy = makeProxy(async () => okResult);
    const cache = new PlacementCache(proxy);

    expect(await cache.get('tok', 'tanks', 'day')).toBe(okResult);
    expect(proxy.getPlacement).toHaveBeenCalledWith('tok', 'tanks', 'day');
  });

  it('в пределах TTL повторно proxy не зовёт', async () => {
    const proxy = makeProxy(async () => okResult);
    let now = 0;
    const cache = new PlacementCache(proxy, { ttlMs: 30000, now: () => now });

    await cache.get('tok', 'tanks', 'day');
    now += 29999;
    await cache.get('tok', 'tanks', 'day');

    expect(proxy.getPlacement).toHaveBeenCalledTimes(1);
  });

  it('после TTL идёт за свежим', async () => {
    const proxy = makeProxy(async () => okResult);
    let now = 0;
    const cache = new PlacementCache(proxy, { ttlMs: 30000, now: () => now });

    await cache.get('tok', 'tanks', 'day');
    now += 30000;
    await cache.get('tok', 'tanks', 'day');

    expect(proxy.getPlacement).toHaveBeenCalledTimes(2);
  });

  // ключ — (токен, игра, срез): три среза одного участника это три разных
  // ответа, и чужой ответ отдать нельзя даже на миллисекунду
  it('разные токены, игры и срезы не делят запись', async () => {
    const proxy = makeProxy(async () => okResult);
    const cache = new PlacementCache(proxy);

    await cache.get('tok', 'tanks', 'day');
    await cache.get('tok', 'tanks', 'month');
    await cache.get('tok', 'snakes', 'day');
    await cache.get('other', 'tanks', 'day');

    expect(proxy.getPlacement).toHaveBeenCalledTimes(4);
  });

  it('неуспешный ответ не кэшируется: сбой auth не залипает на весь TTL', async () => {
    let status = 502;
    const proxy = makeProxy(async () => ({ status, json: null }));
    const cache = new PlacementCache(proxy, { ttlMs: 30000, now: () => 0 });

    await cache.get('tok', 'tanks', 'all');
    status = 200;
    await cache.get('tok', 'tanks', 'all');
    await cache.get('tok', 'tanks', 'all');

    // два похода до успеха, третий — уже из кэша
    expect(proxy.getPlacement).toHaveBeenCalledTimes(2);
  });

  it('sweep убирает протухшие записи', async () => {
    const proxy = makeProxy(async () => okResult);
    let now = 0;
    const cache = new PlacementCache(proxy, { ttlMs: 30000, now: () => now });

    await cache.get('tok', 'tanks', 'all');
    now += 30000;
    cache.sweep();

    expect(cache._cache.size).toBe(0);
  });
});
