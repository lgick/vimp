import { ERROR, skip, verdict } from '../result.js';

// Ключ снапшот-схемы без записи в gameSets — чёрный холст: клиент получает
// строки кадра и не знает, чем их рисовать. То же для setId карты: без него
// статика полотна не создаётся. Раннер ловит это только для ключей, ожив-
// ших в конкретном прогоне, — статически видно все.
export default {
  id: 'C3',
  name: 'gameSetsCoverage',
  level: ERROR,
  title: 'every snapshot key and map setId has a gameSets entry',

  check(ctx) {
    const gameSets = ctx.clientConfig?.parts?.gameSets;
    const snapshot = ctx.gameConfig?.snapshot;

    if (!gameSets || !snapshot) {
      return skip('no client parts.gameSets or gameConfig.snapshot');
    }

    const violations = Object.keys(snapshot)
      .filter(key => !gameSets[key])
      .map(key => `snapshot key "${key}" has no parts.gameSets entry`);

    for (const [name, map] of Object.entries(ctx.gameConfig.maps ?? {})) {
      if (map?.setId !== undefined && !gameSets[map.setId]) {
        violations.push(
          `map "${name}": setId "${map.setId}" has no parts.gameSets entry`,
        );
      }
    }

    return verdict(violations);
  },
};
