import {
  REQUIRED_GAME_CONFIG_PATHS,
  createGameConfigView,
} from '../../../lib/gameConfigView.js';
import { ERROR, WARN, skip, verdict } from '../result.js';

// Тот же гейт, что стоит на боевом пути загрузки плагина
// (lib/gameConfigView.js): обязательные пути gameConfig плюс связь
// spectatorTeam ↔ teams (под noSpectators — «ровно одна команда»).
// Дублировать его список здесь нельзя — он обязан эволюционировать в одном
// месте.
//
// Всё, что не в REQUIRED, движок подставляет сам (И2 этапа 2 плана
// plugin-forward-compat) — это не отказ. Но полагаться на движковое
// умолчание разработчик должен осознанно, поэтому необъявленные поля
// перечисляются предупреждением.
const DEFAULTED = [
  'roomDefaults.maxPlayers',
  'parts.weapons',
  'parts.friendlyFire',
  'panel.fields',
  'spectatorTeam',
];

function getPath(source, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => value?.[key], source);
}

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
      createGameConfigView(ctx.hostPlugin.gameConfig, ctx.hostPlugin.id);
    } catch (error) {
      return verdict([error.message]);
    }

    // noSpectators — своя ветка контракта: spectatorTeam там не бывает
    const declared = ctx.hostPlugin.gameConfig;
    const paths =
      declared?.noSpectators === true
        ? DEFAULTED.filter(path => path !== 'spectatorTeam')
        : DEFAULTED;

    const relied = paths.filter(path => {
      const value = getPath(declared, path);

      return value === undefined || value === null;
    });

    return verdict(
      relied.map(
        path =>
          `gameConfig.${path} is not declared — the engine falls back to ` +
          'its own default; declare it if the game means something else',
      ),
      `required: ${REQUIRED_GAME_CONFIG_PATHS.join(', ')}`,
      WARN,
    );
  },
};
