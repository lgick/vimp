import clientDefaults from '../config/clientDefaults.js';
import wsports from '../config/wsports.js';
import { applyRoomOverrides } from './applyRoomOverrides.js';
import { buildClientConfig } from './buildClientConfig.js';
import { buildCoreConfig } from './coreConfig.js';
import { assertGameConfigShape } from './gamePlugin.js';
import clock from './clock.js';
import SocketManager from '../host/meta/SocketManager.js';
import HostGame from '../host/HostGame.js';

// Боевая инициализация авторитетного матча, вынутая из host.worker.js:onInit.
// Вызывается и Worker'ом, и headless-runner'ом (devtools/ScenarioRunner.js):
// собственная копия у runner'а неизбежно разъехалась бы с Worker'ом, а
// расхождение здесь означало бы, что отладочный прогон проверяет не тот код,
// который крутится в проде.

/**
 * Поднимает HostPlugin игры, ядро, SocketManager и HostGame.
 * @param {Object} room - Описание комнаты (game.hostEntryUrl, game.wasmUrl,
 *   game.version, hostSocketId, hostId/hostSecret, seed, переопределения).
 * @param {Object} [options]
 * @param {Function} [options.loadHostPlugin] - Загрузчик плагина; по умолчанию
 *   динамический import по room.game.hostEntryUrl.
 * @param {Function} [options.createSocketManager] - Фабрика транспорта; по
 *   умолчанию боевой SocketManager (runner подставляет записывающий).
 * @param {Object} [options.hostOptions] - Опции HostGame (onMapChange, handoff).
 * @param {Function} [options.overrideGameConfig] - Правка собранного конфига
 *   игры перед созданием ядра; в проде не задаётся, нужна отладочному
 *   прогону (сценарий подкручивает networkSendRate и таймеры).
 * @returns {Promise<Object>} { hostPlugin, game, seed, core, clientCfg,
 *   socketManager, host }.
 */
export async function createHostRuntime(room, options = {}) {
  const {
    loadHostPlugin = defaultLoadHostPlugin,
    createSocketManager = defaultCreateSocketManager,
    hostOptions = {},
    overrideGameConfig = null,
  } = options;

  const hostPlugin = await loadHostPlugin(room);

  // одна view на прогон: она же валидирует обязательные поля gameConfig и
  // подставляет умолчания для всего остального (lib/gameConfigView.js)
  const configView = assertGameConfigShape(hostPlugin);

  const game = applyRoomOverrides(room, hostPlugin, configView);

  if (overrideGameConfig) {
    overrideGameConfig(game);
  }

  // seed уезжает наружу вызывающему: без него прогон матча невоспроизводим
  // (реплей задаёт room.seed и получает тот же мир)
  const seed =
    room?.seed !== undefined && room.seed !== null
      ? room.seed >>> 0
      : (clock.random() * 2 ** 32) >>> 0;

  const core = await hostPlugin.createCore(
    JSON.stringify(
      buildCoreConfig(configView, {
        friendlyFire: game.parts.friendlyFire,
        seed,
      }),
    ),
    { wasmUrl: room.game?.wasmUrl },
  );

  const clientCfg = buildClientConfig(
    game,
    clientDefaults,
    hostPlugin.buildClientGameConfig(),
  );

  const socketManager = createSocketManager(wsports.server, {
    soundCues: game.soundCues,
    initialVote: game.initialVote,
  });

  const host = new HostGame(game, socketManager, core, hostPlugin, {
    hostSocketId: room?.hostSocketId ?? null,
    gameVersion: room.game?.version ?? null,
    // рекордер (этап 6 плана plan/done/ai-debug) кладёт seed в сценарий — без него
    // записанный матч невоспроизводим
    seed,
    ...hostOptions,
  });

  // эстафета Worker'ов несёт уже известные hostId+секрет в room — новый
  // Worker не должен ждать повторного register_host, чтобы возобновить
  // атрибуцию rank/state-flush; при холодном старте они придут позже
  if (room?.hostId) {
    host.setHostId(room.hostId, room.hostSecret);
  }

  return { hostPlugin, game, seed, core, clientCfg, socketManager, host };
}

// до onInit движок игру не знает вовсе — только URL её host-бандла из
// GameManifest
function defaultLoadHostPlugin(room) {
  return import(/* @vite-ignore */ room.game.hostEntryUrl).then(
    module => module.default,
  );
}

function defaultCreateSocketManager(ports, opts) {
  return new SocketManager(ports, opts);
}
