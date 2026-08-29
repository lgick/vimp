import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES,
  ENGINE_CAPABILITIES,
} from '../../packages/engine/src/lib/capabilities.js';
import {
  checkPluginCompatibility,
  assertEngineApiCompatible,
} from '../../packages/engine/src/lib/gamePlugin.js';

// Реестр возможностей и переговоры о совместимости (этап 5 плана
// plugin-forward-compat): плагин отвергается только за то, что он НОВЕЕ
// движка, и никогда за возраст.

describe('capabilities: реестр', () => {
  it('непустой и отдаёт плоский список активных имён', () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    expect(CAPABILITIES).toContain('accolades');
    expect(ENGINE_CAPABILITIES.has('accolades')).toBe(true);
  });

  it('не знает имён, которых не объявлял', () => {
    expect(ENGINE_CAPABILITIES.has('телепортация')).toBe(false);
  });
});

describe('gamePlugin: checkPluginCompatibility', () => {
  it('манифест без requires совместим — все опубликованные до этапа 5', () => {
    expect(checkPluginCompatibility({ id: 'tanks' })).toEqual({ ok: true });
  });

  it('старое поколение engineApi больше не причина отказа', () => {
    expect(
      checkPluginCompatibility({ id: 'tanks', engineApi: 1, requires: [] }).ok,
    ).toBe(true);
  });

  it('известные возможности принимаются', () => {
    expect(
      checkPluginCompatibility({ id: 'tanks', requires: CAPABILITIES }).ok,
    ).toBe(true);
  });

  it('неизвестная возможность — отказ с именем и «update the engine»', () => {
    const compat = checkPluginCompatibility({
      id: 'tanks',
      requires: ['accolades', 'телепортация'],
    });

    expect(compat.ok).toBe(false);
    expect(compat.reason).toBe('engine-too-old');
    expect(compat.missing).toEqual(['телепортация']);
    expect(compat.text).toContain('tanks');
    expect(compat.text).toContain('update the engine');
  });
});

describe('gamePlugin: assertEngineApiCompatible', () => {
  it('обёртка бросает текстом вердикта', () => {
    expect(() =>
      assertEngineApiCompatible({ id: 'tanks', requires: ['телепортация'] }),
    ).toThrow(/update the engine/);
  });

  it('плагин прошлого поколения проходит', () => {
    expect(() =>
      assertEngineApiCompatible({ id: 'tanks', engineApi: 3 }),
    ).not.toThrow();
  });
});

describe('gamePlugin: битая форма requires', () => {
  // `requires` пишет ЧУЖОЙ репозиторий игры. До правки .filter по строке или
  // объекту давал TypeError, который уходил из конструктора GameCatalog и не
  // давал стартовать мастеру целиком — одна битая игра уносила весь каталог
  it.each([
    ['строка', 'accolades'],
    ['объект', {}],
    ['число', 5],
    ['массив с не-строкой', ['accolades', null]],
  ])('%s → вердикт bad-manifest, а не исключение', (_name, requires) => {
    const compat = checkPluginCompatibility({ id: 'tanks', requires });

    expect(compat.ok).toBe(false);
    expect(compat.reason).toBe('bad-manifest');
    expect(compat.missing).toEqual([]);
    expect(compat.text).toMatch(/must be an array of capability names/);
  });

  it('null и undefined — это «ничего сверх базового», а не битый манифест', () => {
    expect(checkPluginCompatibility({ id: 'tanks', requires: null })).toEqual({
      ok: true,
    });
    expect(
      checkPluginCompatibility({ id: 'tanks', requires: undefined }),
    ).toEqual({ ok: true });
  });

  it('assertEngineApiCompatible бросает на битой форме тем же текстом', () => {
    expect(() =>
      assertEngineApiCompatible({ id: 'tanks', requires: 'accolades' }),
    ).toThrow(/must be an array of capability names/);
  });
});
