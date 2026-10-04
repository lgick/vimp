import { describe, it, expect, vi } from 'vitest';
import { createPageReload } from '../../../packages/engine/src/client/lib/pageReload.js';

// находка код-ревью 8d: pagehide срабатывает и на программной перезагрузке —
// без exit() гость, перезагружающийся в ту же комнату, объявлял бы уход.
// Прямые reloadTo/location.reload в клиенте запрещает ESLint.

const setup = guard => {
  const calls = [];
  const reload = createPageReload({
    getGuard: () => guard,
    reloadToHash: hash => calls.push(['hash', hash]),
    reloadSame: () => calls.push(['same']),
  });

  return { reload, calls };
};

describe('createPageReload', () => {
  it('exit() защиты вызывается до перезагрузки по hash', () => {
    const order = [];
    const guard = { exit: vi.fn(() => order.push('exit')) };
    const reload = createPageReload({
      getGuard: () => guard,
      reloadToHash: hash => order.push(`hash:${hash}`),
      reloadSame: () => order.push('same'),
    });

    reload('#/tanks/r1');

    expect(order).toEqual(['exit', 'hash:#/tanks/r1']);
  });

  it('без hashPart — перезагрузка с тем же адресом, тоже после exit()', () => {
    const guard = { exit: vi.fn() };
    const { reload, calls } = setup(guard);

    reload();

    expect(guard.exit).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([['same']]);
  });

  it('пустой hash — переход на главную, а не перезагрузка того же адреса', () => {
    const { reload, calls } = setup({ exit: vi.fn() });

    reload('');

    expect(calls).toEqual([['hash', '']]);
  });

  it('без защиты (solo/dedicated) — просто перезагружает', () => {
    const { reload, calls } = setup(null);

    reload('#/tanks');
    reload();

    expect(calls).toEqual([['hash', '#/tanks'], ['same']]);
  });

  it('защита читается в момент вызова, а не при создании', () => {
    let guard = null;
    const reload = createPageReload({
      getGuard: () => guard,
      reloadToHash: () => {},
      reloadSame: () => {},
    });

    guard = { exit: vi.fn() };
    reload();

    expect(guard.exit).toHaveBeenCalledTimes(1);
  });
});
