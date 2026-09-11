import {
  SPATIAL_DEFAULTS,
  SPATIAL_NUMERIC,
  SPATIAL_MODES,
  SPATIAL_KEYS,
  PANNING_MODELS,
  DISTANCE_MODELS,
} from '../../../config/spatialDefaults.js';
import { WARN, skip, verdict } from '../result.js';

// verticalFactor, объявленный не при sideScroller, здесь НЕ отмечается: он
// входит в полный блок дефолтов, который документация показывает как
// образец, и правило кричало бы на честный копипаст из неё. Лишний ключ
// безвреден, а неверное число ловится проверкой знака.
//
// Блок spatial необязателен: игра без него получает движковые дефолты и
// звучит правильно. Но объявленный блок с опечаткой — это тихий отказ:
// движок падает на дефолт и ничего не говорит. Списки допустимых значений,
// знаки чисел и сами дефолты берутся из src/config/spatialDefaults.js —
// того же модуля, что читает SoundManager, иначе правило и рантайм
// разошлись бы и проверка пропускала бы то, что движок молча откатывает.
export default {
  id: 'E6',
  name: 'soundSpatial',
  level: WARN,
  title: 'the spatial sound block is well-formed',

  check(ctx) {
    const sounds = ctx.clientConfig?.parts?.sounds;

    if (!sounds) {
      return skip('no client sound config');
    }

    const spatial = sounds.spatial;

    if (spatial === undefined) {
      return skip('no spatial block — engine defaults apply');
    }

    if (!spatial || typeof spatial !== 'object' || Array.isArray(spatial)) {
      return verdict(['parts.sounds.spatial must be a plain object']);
    }

    const violations = [];

    for (const key of Object.keys(spatial)) {
      if (!SPATIAL_KEYS.includes(key)) {
        violations.push(
          `unknown key "${key}": valid keys are ${SPATIAL_KEYS.join(', ')}`,
        );
      }
    }

    if (spatial.mode !== undefined && !SPATIAL_MODES.includes(spatial.mode)) {
      violations.push(
        `mode "${spatial.mode}" is unknown: valid modes are ${SPATIAL_MODES.join(', ')}`,
      );
    }

    if (
      spatial.panningModel !== undefined &&
      !PANNING_MODELS.includes(spatial.panningModel)
    ) {
      violations.push(
        `panningModel "${spatial.panningModel}" is unknown: valid models are ${PANNING_MODELS.join(', ')}`,
      );
    }

    if (
      spatial.distanceModel !== undefined &&
      !DISTANCE_MODELS.includes(spatial.distanceModel)
    ) {
      violations.push(
        `distanceModel "${spatial.distanceModel}" is unknown: valid models are ${DISTANCE_MODELS.join(', ')}`,
      );
    }

    for (const [key, sign] of Object.entries(SPATIAL_NUMERIC)) {
      const value = spatial[key];

      if (value === undefined) {
        continue;
      }

      const ok =
        Number.isFinite(value) &&
        (sign === 'positive' ? value > 0 : value >= 0);

      if (!ok) {
        violations.push(`${key} must be a ${sign} number, got ${value}`);
      }
    }

    // Сравниваются РАЗРЕШЁННЫЕ значения, как в
    // SoundManager._resolveSpatialConfig: объявить одну дистанцию против
    // дефолта второй — то же нарушение, и рантайм откатит обе молча
    const refDistance = Number.isFinite(spatial.refDistance)
      ? spatial.refDistance
      : SPATIAL_DEFAULTS.refDistance;
    const maxDistance = Number.isFinite(spatial.maxDistance)
      ? spatial.maxDistance
      : SPATIAL_DEFAULTS.maxDistance;

    if (maxDistance <= refDistance) {
      violations.push(
        `maxDistance (${maxDistance}) must be greater than refDistance ` +
          `(${refDistance}); an undeclared distance falls back to the ` +
          `engine default, and the engine resets both at runtime`,
      );
    }

    return verdict(violations);
  },
};
