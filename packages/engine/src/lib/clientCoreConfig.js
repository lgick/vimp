import { SNAPSHOT_FORMAT_VERSION } from '../config/opcodes.js';
import wsports from '../config/wsports.js';

// Сборка JSON-конфига клиентского ядра (ClientCore, срез 2.6): данные
// prediction/interpolation из CONFIG_DATA хоста + бандловый реестр
// снапшот-ключей. Отдельный модуль (не coreConfig.js): тот тянет
// game.js/models.js/weapons.js, которым не место в клиентском бандле —
// клиент получает параметры по порту 0.

/**
 * Собирает объект конфигурации клиентского ядра — форма {engine, game}
 * (PLAN.md §3.4): движковая половина (timeStepMs/snapshot/interpolation) +
 * игровая (models/weapons/playerKeys/seed трассеров).
 * @param {Object} options
 * @param {Object} options.prediction - Секция prediction CONFIG_DATA
 *   (timeStep в мс, playerKeys, models, weapons, coreParams). Поле
 *   `coreParams` (необязательное) — непрозрачный словарь параметров ядра
 *   игры: попадает в игровую половину как есть, движок его не читает;
 *   известные движку ключи имеют приоритет.
 * @param {Object} options.interpolation - Секция interpolation CONFIG_DATA
 *   (delay, maxFrameAge в мс).
 * @param {Object} options.snapshot - Секция snapshot CONFIG_DATA —
 *   игровая схема ключей (гоняется хостом, не из бандла клиента).
 * @param {Object} [overrides] - Переопределения плоским объектом (например,
 *   seed для воспроизводимых прогонов) — распределяются автоматически.
 * @returns {Object} Конфиг для `new ClientCore(JSON.stringify(config))`.
 */
export const buildClientCoreConfig = (
  { prediction, interpolation, snapshot },
  overrides = {},
) => {
  const flat = {
    // имя поля фиксирует единицы: prediction.timeStep приходит в мс
    timeStepMs: prediction.timeStep,
    playerKeys: prediction.playerKeys,
    models: prediction.models,
    weapons: prediction.weapons,
    coreParams: prediction.coreParams,
    // keys — игровая схема из CONFIG_DATA; version/port — движковые
    snapshot: {
      version: SNAPSHOT_FORMAT_VERSION,
      port: wsports.server.SHOT_DATA,
      keys: snapshot,
    },
    interpolation,
    seed: undefined,
    // детектор рассинхрона предикта: в боевом конфиге секции нет (undefined
    // не попадает в JSON) — ядро тогда не делает на пути кадра ничего лишнего
    divergence: undefined,
    ...overrides,
  };

  return {
    engine: {
      timeStepMs: flat.timeStepMs,
      snapshot: flat.snapshot,
      interpolation: flat.interpolation,
      divergence: flat.divergence,
    },
    game: {
      // собственные параметры ядра игры: движок их не читает и не
      // валидирует — он лишь довозит их до `GameClientDef::new`. Известные
      // ключи ниже перекрывают одноимённые, чтобы игра не могла подменить
      // движковую часть контракта (то же правило, что в lib/coreConfig.js)
      ...(flat.coreParams || {}),
      playerKeys: flat.playerKeys,
      models: flat.models,
      weapons: flat.weapons,
      seed: flat.seed,
    },
  };
};
