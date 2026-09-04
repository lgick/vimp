import { ERROR, skip, verdict } from '../result.js';

// Радар рисует стены не из физики, а из рендер-слоя: парт слоя берётся за
// работу, только если его тайл-лист (`layers`) называет хотя бы один тайл из
// `physicsStatic`/`walls`. Карта, где тайл стены не назван ни в одном слое,
// физически стены имеет, а на радаре — нет, и ни одной строки в консоли при
// этом не появляется. Правило безвредно для карты без `layers`: проверять
// тогда нечего.
export default {
  id: 'E5',
  name: 'mapRadarWalls',
  level: ERROR,
  title: 'solid tiles are named by a render layer',

  check(ctx) {
    const maps = ctx.gameConfig?.maps;

    if (!maps) {
      return skip('no gameConfig.maps');
    }

    const violations = [];
    let checked = 0;

    for (const [name, map] of Object.entries(maps)) {
      checked += checkMap(`map "${name}"`, map, violations);
    }

    if (!checked) {
      return skip('no map declares render layers');
    }

    return verdict(violations);
  },
};

/**
 * @param {string} at - Человекочитаемое место нарушения.
 * @param {Object} map - Карта из gameConfig.maps.
 * @param {Array<string>} violations - Копилка нарушений.
 * @returns {number} Сколько гридов удалось проверить (0 — слоёв нет).
 */
function checkMap(at, map, violations) {
  let checked = 0;

  checked += checkGrid(at, 'level 0', map?.layers, map?.physicsStatic, violations);

  for (const [key, level] of Object.entries(map?.levels ?? {})) {
    checked += checkGrid(
      at,
      `level ${key}`,
      level?.layers,
      level?.walls,
      violations,
    );
  }

  return checked;
}

function checkGrid(at, where, layers, solid, violations) {
  if (!layers || !Object.keys(layers).length) {
    return 0;
  }

  const named = new Set(Object.values(layers).flat());

  for (const tile of solid ?? []) {
    if (!named.has(tile)) {
      violations.push(
        `${at}: ${where} solid tile ${tile} is not named by any render ` +
          'layer — MapRadar draws walls only from a layer that lists a ' +
          'solid tile, so the wall silently disappears from the radar',
      );
    }
  }

  return 1;
}
