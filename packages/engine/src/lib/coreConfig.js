import { SNAPSHOT_FORMAT_VERSION } from '../config/opcodes.js';
import hostDefaults from '../config/hostDefaults.js';
import wsports from '../config/wsports.js';

// Сборка JSON-конфига Rust-ядра (packages/engine/core + core/ в репозитории
// игры, например vimp-tanks): движковая половина
// (timeStep/mapScale/mapSetId/snapshot/seed) + игровая
// (models/weapons/playerKeys/panel/friendlyFire) — форма {engine, game} из
// PLAN.md §3.4. Единственная точка соответствия JS-конфигов и ABI ядра
// (см. docs/core.md).

/**
 * Собирает объект конфигурации ядра.
 * @param {Object} gameConfig - Представление HostPlugin.gameConfig
 *   (lib/gameConfigView.js): поля игры плюс движковые умолчания. Прямой
 *   gameConfig сюда не передаётся — он обходит умолчания (И2). Поле
 *   `coreParams` (необязательное) — непрозрачный словарь параметров
 *   ядра игры: попадает в игровую половину конфига как есть, движок его
 *   не читает и не валидирует; известные движку ключи имеют приоритет.
 * @param {Object} [overrides] - Переопределения плоским объектом (например,
 *   seed для воспроизводимых прогонов или friendlyFire) — распределяются
 *   по движковой/игровой половине автоматически.
 * @returns {Object} Конфиг для `hostPlugin.createCore(JSON.stringify(config))`.
 */
export const buildCoreConfig = (gameConfig, overrides = {}) => {
  const { models, weapons } = gameConfig.parts;

  const flat = {
    timeStep: hostDefaults.timers.timeStep / 1000,
    friendlyFire: gameConfig.parts.friendlyFire,
    mapScale: gameConfig.mapScale,
    mapSetId: gameConfig.mapSetId,
    models,
    weapons,
    playerKeys: gameConfig.playerKeys,
    panel: gameConfig.panel.fields,
    coreParams: gameConfig.coreParams,
    // keys — игровая схема (gameConfig.snapshot); version/port — движковые
    snapshot: {
      version: SNAPSHOT_FORMAT_VERSION,
      port: wsports.server.SHOT_DATA,
      keys: gameConfig.snapshot,
    },
    seed: undefined,
    ...overrides,
  };

  return {
    engine: {
      timeStep: flat.timeStep,
      mapScale: flat.mapScale,
      mapSetId: flat.mapSetId,
      snapshot: flat.snapshot,
      seed: flat.seed,
    },
    game: {
      // собственные параметры ядра игры: движок их не читает и не
      // валидирует — он лишь довозит их до `GameSim::new`. Известные ключи
      // ниже перекрывают одноимённые, чтобы игра не могла подменить
      // движковую часть контракта
      ...(flat.coreParams || {}),
      friendlyFire: flat.friendlyFire,
      models: flat.models,
      weapons: flat.weapons,
      playerKeys: flat.playerKeys,
      panel: flat.panel,
    },
  };
};
