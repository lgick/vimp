import { describe, it, expect } from 'vitest';
import { buildCoreConfig } from '../../packages/engine/src/lib/coreConfig.js';

// buildCoreConfig — единственная точка соответствия JS-конфигов и ABI ядра.
// Здесь проверяется её игровая половина: непрозрачный проброс coreParams
// (движок не знает имён параметров игрового ядра) и то, что он не может
// подменить движковую часть контракта.

const makeView = (extra = {}) => ({
  mapScale: 1,
  mapSetId: 'c1',
  playerKeys: { forward: 0 },
  panel: { fields: { health: { key: 'h', value: 100 } } },
  snapshot: { m1: {} },
  parts: {
    friendlyFire: false,
    models: { m1: {} },
    weapons: { w1: {} },
  },
  ...extra,
});

describe('buildCoreConfig', () => {
  it('coreParams доезжают до игровой половины', () => {
    const config = buildCoreConfig(
      makeView({ coreParams: { levels: { fallTime: 0.35, fallDamage: 15 } } }),
    );

    expect(config.game.levels).toEqual({ fallTime: 0.35, fallDamage: 15 });
  });

  it('coreParams не перетирают движковые ключи', () => {
    const config = buildCoreConfig(
      makeView({ coreParams: { models: { hacked: {} }, friendlyFire: true } }),
    );

    expect(config.game.models).toEqual({ m1: {} });
    expect(config.game.friendlyFire).toBe(false);
  });

  it('mapFallTime — движковый ключ, игровая половина его не видит', () => {
    // траектория падения общая для танков и тел карты: подмена её игровым
    // coreParams развела бы ящик и танк молча
    const config = buildCoreConfig(
      makeView({ mapFallTime: 0.5, coreParams: { mapFallTime: 9 } }),
    );

    expect(config.engine.mapFallTime).toBe(0.5);
    expect(config.game.mapFallTime).toBe(9);
  });

  it('карта без coreParams собирается как раньше', () => {
    const config = buildCoreConfig(makeView());

    expect(Object.keys(config.game).sort()).toEqual([
      'friendlyFire',
      'models',
      'panel',
      'playerKeys',
      'weapons',
    ]);
  });
});
