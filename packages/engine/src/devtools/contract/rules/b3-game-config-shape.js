import { assertGameConfigShape } from '../../../lib/gamePlugin.js';
import { ERROR, skip, verdict } from '../result.js';

// Тот же гейт, что стоит на боевом пути загрузки плагина
// (lib/gamePlugin.js): обязательные пути gameConfig плюс связь
// spectatorTeam ↔ teams (под noSpectators — «ровно одна команда»).
// Дублировать его список здесь нельзя — он обязан эволюционировать в одном
// месте.
export default {
  id: 'B3',
  name: 'gameConfigShape',
  level: ERROR,
  title: 'gameConfig has the paths the engine reads before any logic',

  check(ctx) {
    if (!ctx.hostPlugin) {
      return skip('host plugin not loaded');
    }

    try {
      assertGameConfigShape(ctx.hostPlugin);
    } catch (error) {
      return verdict([error.message]);
    }

    return verdict([]);
  },
};
