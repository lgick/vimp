import { describe, it, expect } from 'vitest';
import clientDefaults from '../../packages/engine/src/config/clientDefaults.js';
import {
  SPATIAL_DEFAULTS,
  SPATIAL_NUMERIC,
  SPATIAL_MODES,
  SPATIAL_KEYS,
} from '../../packages/engine/src/config/spatialDefaults.js';
import e6 from '../../packages/engine/src/devtools/contract/rules/e6-sound-spatial.js';
import { SPATIAL_PROFILES } from '../../packages/engine/src/client/SoundManager.js';

// Дефолты пространственного звука читают три независимых потребителя:
// движковый конфиг игры, SoundManager и правило контракта E6. Пока они
// брали значения из своих копий, расхождение проявлялось только на слух и
// было неотличимо от «звук просто другой» — эти проверки и есть замена той
// договорённости.
describe('spatialDefaults: один источник на три потребителя', () => {
  it('движковый конфиг отдаёт ровно объявленные дефолты', () => {
    expect(clientDefaults.parts.sounds.spatial).toEqual(SPATIAL_DEFAULTS);
  });

  it('panningModel в дефолтах отсутствует намеренно', () => {
    // его приносит профиль проекции: жёсткий дефолт перекрыл бы у
    // sideScroller его equalpower на уровне слияния конфигов
    expect('panningModel' in SPATIAL_DEFAULTS).toBe(false);
    expect('panningModel' in clientDefaults.parts.sounds.spatial).toBe(false);
  });

  it('список профилей совпадает с их реализацией', () => {
    expect(Object.keys(SPATIAL_PROFILES)).toEqual(SPATIAL_MODES);

    for (const mode of SPATIAL_MODES) {
      expect(typeof SPATIAL_PROFILES[mode].mapCoords).toBe('function');
      expect(typeof SPATIAL_PROFILES[mode].panningModel).toBe('string');
    }
  });

  it('каждый дефолт объявлен как ключ и каждое число — со знаком', () => {
    for (const key of Object.keys(SPATIAL_DEFAULTS)) {
      expect(SPATIAL_KEYS).toContain(key);
    }

    for (const key of Object.keys(SPATIAL_NUMERIC)) {
      expect(typeof SPATIAL_DEFAULTS[key]).toBe('number');
      expect(['positive', 'non-negative']).toContain(SPATIAL_NUMERIC[key]);
    }
  });

  it('движковые дефолты сами проходят правило E6', () => {
    const result = e6.check({
      clientConfig: { parts: { sounds: { spatial: SPATIAL_DEFAULTS } } },
    });

    expect(result.violations ?? []).toEqual([]);
  });
});
