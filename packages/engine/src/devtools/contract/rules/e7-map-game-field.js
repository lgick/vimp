import { ERROR, skip, verdict } from '../result.js';

// Поле карты `game` (и `physicsDynamic[i].game`) — пространство игры:
// движок его не читает и не масштабирует, но фиксирует форму. Ядро
// (`MapConfig::validate`) отвергает не-объект при загрузке карты, то есть в
// уже запущенном матче; здесь то же ловится до сборки.
export default {
  id: 'E7',
  name: 'mapGameField',
  level: ERROR,
  title: 'map game field is a plain object',

  check(ctx) {
    const maps = ctx.gameConfig?.maps;

    if (!maps) {
      return skip('no gameConfig.maps');
    }

    const declared = Object.entries(maps).filter(
      ([, map]) =>
        map?.game !== undefined ||
        (map?.physicsDynamic ?? []).some(object => object?.game !== undefined),
    );

    if (!declared.length) {
      return skip('no map declares game');
    }

    const violations = [];

    for (const [name, map] of declared) {
      if (map.game !== undefined && !isPlainObject(map.game)) {
        violations.push(`map "${name}": game is not a plain object`);
      }

      for (const [index, object] of (map.physicsDynamic ?? []).entries()) {
        if (object?.game !== undefined && !isPlainObject(object.game)) {
          violations.push(
            `map "${name}": physicsDynamic ${index} game is not a plain object`,
          );
        }
      }
    }

    return verdict(violations);
  },
};

// `null` ядро принимает как «не объявлено», но в исходнике карты это почти
// всегда опечатка — правило требует либо объект, либо отсутствие поля
function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
