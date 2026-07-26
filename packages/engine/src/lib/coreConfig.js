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
 * @param {Object} gameConfig - HostPlugin.gameConfig игры, загруженной
 *   динамически по GameManifest (Этап 6.4) — движок больше не знает игру
 *   статически.
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
      friendlyFire: flat.friendlyFire,
      models: flat.models,
      weapons: flat.weapons,
      playerKeys: flat.playerKeys,
      panel: flat.panel,
    },
  };
};
