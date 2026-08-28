import { describe, it, expect, vi } from 'vitest';
import RankDistribution from '../../packages/auth/src/db/RankDistribution.js';

// Лестница РАЗЛИЧНЫХ значений среза по убыванию: `atOrAbove` — сколько
// игроков стоит на этой ступени и выше. Место = 1 + сколько СТРОГО выше,
// то есть в точности `RANK() OVER (ORDER BY rank DESC)` из getLeaderboard
const ladder = (steps, { total, complete = true }) => ({
  steps: steps.map(([score, atOrAbove]) => ({ score, atOrAbove })),
  total,
  complete,
});

describe('RankDistribution.placementOf', () => {
  //   100 очков — 2 игрока (места 1–2)
  //    90 очков — 3 игрока (места 3–5)
  //    10 очков — 4 игрока (места 6–9)
  const nine = ladder([[100, 2], [90, 5], [10, 9]], { total: 9 });

  it('значение верхней ступени — первое место', () => {
    expect(RankDistribution.placementOf(nine, 100)).toBe(1);
  });

  it('значение выше всей лестницы — тоже первое', () => {
    expect(RankDistribution.placementOf(nine, 500)).toBe(1);
  });

  it('разделившие значение делят место', () => {
    // выше 90 стоят двое — значит третье, и оно у всех троих
    expect(RankDistribution.placementOf(nine, 90)).toBe(3);
    expect(RankDistribution.placementOf(nine, 10)).toBe(6);
  });

  // значения между ступенями бывают: лестница может отстать на TTL, а своё
  // значение читается живым
  it('значение между ступенями считается по ближайшей сверху', () => {
    expect(RankDistribution.placementOf(nine, 95)).toBe(3);
    expect(RankDistribution.placementOf(nine, 11)).toBe(6);
  });

  it('неранжированный (0 и меньше) места не имеет', () => {
    expect(RankDistribution.placementOf(nine, 0)).toBeNull();
    expect(RankDistribution.placementOf(nine, -5)).toBeNull();
  });

  it('пустой срез: первый же ранжированный — первый', () => {
    expect(RankDistribution.placementOf(ladder([], { total: 0 }), 7)).toBe(1);
  });

  it('непрогретая лестница ответа не даёт', () => {
    expect(RankDistribution.placementOf(null, 50)).toBeNull();
  });

  // потолок ступеней держит память кэша: игра, что в него не уместилась,
  // отвечает глубокому хвосту точным запросом
  it('обрезанный хвост: ниже последней ступени ответа нет, на ней — есть', () => {
    const cut = ladder([[100, 2], [90, 5]], { total: 900, complete: false });

    expect(RankDistribution.placementOf(cut, 90)).toBe(3);
    expect(RankDistribution.placementOf(cut, 89)).toBeNull();
    expect(RankDistribution.placementOf(cut, 100)).toBe(1);
  });
});

describe('RankDistribution: кэш', () => {
  const value = ladder([[10, 1]], { total: 1 });

  it('в пределах TTL грузит один раз, после — заново', async () => {
    let now = 1000;
    const load = vi.fn(async () => value);
    const cache = new RankDistribution(load, { ttlMs: 30000, now: () => now });

    await cache.get('tanks', 'day');
    await cache.get('tanks', 'day');
    expect(load).toHaveBeenCalledTimes(1);

    now += 30000;
    await cache.get('tanks', 'day');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('игра и срез — разные ключи', async () => {
    const load = vi.fn(async () => value);
    const cache = new RankDistribution(load, { ttlMs: 30000, now: () => 0 });

    await cache.get('tanks', 'day');
    await cache.get('tanks', 'month');
    await cache.get('snakes', 'day');

    expect(load).toHaveBeenCalledTimes(3);
  });

  // наплыв входов в комнату на холодный ключ: без этого первая же секунда
  // после протухания стоит столько, сколько кэш и экономит
  it('одновременные вызовы делят одну загрузку', async () => {
    let release;
    const load = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const cache = new RankDistribution(load, { ttlMs: 30000, now: () => 0 });

    const all = Promise.all([
      cache.get('tanks', 'day'),
      cache.get('tanks', 'day'),
      cache.get('tanks', 'day'),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    release(value);
    expect(await all).toEqual([value, value, value]);
  });

  // отказ не залипает на весь TTL: вызывающий уходит на точный запрос, а
  // следующий пробует снова
  it('сбой загрузки отдаёт null и не кэшируется', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(value);
    const cache = new RankDistribution(load, { ttlMs: 30000, now: () => 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await cache.get('tanks', 'day')).toBeNull();
    expect(await cache.get('tanks', 'day')).toEqual(value);
    expect(load).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });

  it('sweep убирает протухшие ключи', async () => {
    let now = 0;
    const load = vi.fn(async () => value);
    const cache = new RankDistribution(load, { ttlMs: 30000, now: () => now });

    await cache.get('tanks', 'day');
    now = 30000;
    cache.sweep();
    await cache.get('tanks', 'day');

    expect(load).toHaveBeenCalledTimes(2);
  });
});
