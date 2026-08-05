import { ALL_KEYS_UNAUDITED } from './invariants.js';
import { FIXTURE_SOURCE } from './pluginLoader.js';

// Встроенный сценарий headless-прогона: один участник заходит, едет вперёд,
// отпускает клавишу. Этого хватает, чтобы контур доказал, что он замкнут
// (хост → кадр → клиентское ядро → сцена), и не хватает ни на что больше.
//
// Идентификаторы берутся из gameConfig самой игры: имя модели, команды и
// клавиши — часть игры, а не движка. Захардкоженные фикстурные 'm1' /
// 'team1' / 'forward' на чужом плагине означают падение в ядре («unknown
// model») либо красный инвариант 8 у исправного плагина.

// Ввод начинается на 40-м тике, а не сразу: кадр спавна с force_reset
// приходит примерно на interpolation.delay (движковый дефолт — 100 мс, тут
// ~3× запаса) позже входа и чистит удержанные клавиши предиктора
// (docs/en/debugging.md) — встроенный сценарий не должен демонстрировать
// ровно ту ловушку, от которой предостерегает документация
const INPUT_DOWN_TICK = 40;
const INPUT_UP_TICK = 100;
const TICKS = 120;

// событийный ключ фикстуры в этом сценарии не стреляет — объявлено явно,
// иначе инвариант 2 честно посчитает это «сущность не спавнится»
const FIXTURE_UNUSED_KEYS = ['e1'];

const firstKey = dict => Object.keys(dict ?? {})[0];

/**
 * Собирает встроенный смоук-сценарий под конкретную игру.
 * @param {Object} plugin - Результат loadGameForSim.
 * @returns {Object} Сценарий в формате runScenario.
 */
export function builtinScenario(plugin) {
  const config = plugin.hostPlugin.gameConfig;
  const model = firstKey(config.parts?.models);
  const key = firstKey(config.playerKeys);
  const team = Object.keys(config.teams ?? {}).find(
    name => name !== config.spectatorTeam,
  );

  if (!model || !key || !team) {
    throw new Error(
      `game "${plugin.id}": the built-in scenario has nothing to drive ` +
        `(model: ${model ?? '—'}, playable team: ${team ?? '—'}, ` +
        `player key: ${key ?? '—'}) — write a scenario for this game and ` +
        `pass --scenario <file>`,
    );
  }

  const scenario = {
    version: 1,
    seed: 3812,
    participants: [{ id: 'p1', name: 'P1', model }],
    timeline: [
      { tick: 0, op: 'join', who: 'p1', team },
      {
        tick: INPUT_DOWN_TICK,
        op: 'key',
        who: 'p1',
        action: 'down',
        name: key,
      },
      { tick: INPUT_UP_TICK, op: 'key', who: 'p1', action: 'up', name: key },
    ],
    ticks: TICKS,
  };

  if (plugin.source === FIXTURE_SOURCE) {
    return { ...scenario, unusedSnapshotKeys: FIXTURE_UNUSED_KEYS };
  }

  // На чужой игре это смоук контура, а не аудит контракта: сценарий не знает
  // ни ключей её схемы, ни её порогов дрейфа (у каждой игры своя раскладка
  // player-блока и свои единицы). Судить исправный плагин по фикстурным
  // значениям значит выдавать ему красный вердикт, поэтому проверки 2 и 9
  // честно пропускаются, а не притворяются пройденными.
  return {
    ...scenario,
    unusedSnapshotKeys: ALL_KEYS_UNAUDITED,
    divergence: null,
  };
}
