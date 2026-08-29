import {
  assertGameConfigShape,
  checkPluginCompatibility,
} from '../lib/gamePlugin.js';
import { setBootConfig } from '../client/boot.js';
import { ensureGameShell } from '../client/views/gameShell.js';

// Standalone SDK (Этап 3 плана standalone-sdk): единственная точка входа для
// репозитория игры — `npm run dev` открывает вкладку с работающим матчем без
// мастера, без OAuth и без экрана лобби.
//
// Отличия от прода (осознанные, см. plan/standalone-sdk/README.md):
//   - хост крутится в главном потоке (inline), а не в Worker'е: HostPlugin
//     непередаваем постмесседжем, а SDK получает живой объект плагина;
//   - личность гостевая (ник из формы или из playerName), рейтинг и
//     сохранение состояния выключены;
//   - мастера нет вовсе: манифест игры собирается в памяти, каталог карт и
//     эстафета Worker'ов не участвуют, WebRTC и module-worker'ы не нужны.

/**
 * Поднимает матч во вкладке: каркас интерфейса, inline-хост и клиент движка.
 * @param {Object} options
 * @param {Object} options.hostPlugin - Живой HostPlugin игры.
 * @param {Object} options.clientPlugin - Живой ClientPlugin игры.
 * @param {string} options.wasmUrl - URL web-сборки ядра игры (?url-импорт).
 * @param {HTMLElement} [options.container] - Точка монтирования каркаса И
 *   канвасов; обязана быть полноэкранной и `position: relative`.
 * @param {string} [options.assetsBase] - База ассетов игры (звуки берутся из
 *   `${assetsBase}sounds/`).
 * @param {string} [options.playerName] - Задан → вход без формы авторизации.
 * @param {string} [options.playerModel] - Модель игрока (поле authSchema).
 * @param {Object} [options.auth] - Прочие поля авторизации игры.
 * @param {Array} [options.startupVotes] - Ответы на initialVote, например
 *   `[['teamChange', 'team1']]`; без них участник остаётся наблюдателем.
 * @param {Array<string>} [options.startupCommands] - Чат-команды игры после
 *   голосований, например `['/bot 4']`.
 * @param {Object} [options.room] - Переопределения комнаты (map, maxPlayers,
 *   roundTime, friendlyFire, seed).
 * @param {boolean} [options.devMode] - room.isDevMode: рекордер и хостовый
 *   CONSOLE-лог.
 * @returns {Promise<Object>} `{ stop() }` — останов матча.
 */
export async function startStandaloneGame({
  hostPlugin,
  clientPlugin,
  wasmUrl,
  container = document.body,
  assetsBase = '/',
  playerName,
  playerModel,
  auth = {},
  startupVotes = [],
  startupCommands = [],
  room = {},
  devMode = false,
} = {}) {
  requireOption(hostPlugin, 'hostPlugin');
  requireOption(clientPlugin, 'clientPlugin');
  requireOption(wasmUrl, 'wasmUrl');

  // возможность, которой в этой сборке движка нет, иначе всплыла бы где-то
  // в середине хендшейка непрозрачной ошибкой
  requireCompatible(hostPlugin);
  requireCompatible(clientPlugin);

  // одна view на прогон: умолчания вместо обязательных полей (И2 этапа 2)
  const configView = assertGameConfigShape(hostPlugin);

  ensureGameShell(container);

  setBootConfig({
    mode: 'solo',
    container,
    manifest: buildManifest(hostPlugin, configView, { wasmUrl, assetsBase }),
    clientPlugin,
    hostPlugin,
    room: {
      ...configView.roomDefaults,
      ...room,
      isDevMode: devMode,
    },
    autoAuth: playerName
      ? pruneUndefined({ name: playerName, model: playerModel, ...auth })
      : null,
    startupVotes,
    startupCommands,
  });

  // конфиг загрузки задан — дальше работает обычный клиент движка в
  // solo-режиме (import динамический: main.js исполняется при импорте)
  const client = await import('../client/main.js');

  return {
    stop() {
      client.stopGame();
    },
  };
}

// половина плагина просит возможность, которой в этой сборке движка нет:
// подменить её в SDK нечем — матч не поднимется
function requireCompatible(plugin) {
  const compat = checkPluginCompatibility(plugin);

  if (!compat.ok) {
    throw new Error(compat.text);
  }
}

// незаданное поле — это «взять дефолт схемы», а не «отправить undefined»:
// JSON.stringify ключ с undefined выбрасывает, и хост отвечает
// 'Property is missing' (main.js накрывает autoAuth поверх дефолтов схемы)
function pruneUndefined(source) {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  );
}

// манифест-подобный объект в памяти: мастера нет, а клиент читает из
// манифеста id/version, entries.wasm и assetsBase. entries.client/host не
// нужны — оба плагина уже живые объекты
function buildManifest(hostPlugin, configView, { wasmUrl, assetsBase }) {
  return {
    id: hostPlugin.id,
    engineApi: hostPlugin.engineApi,
    version: 'dev',
    title: configView.title ?? hostPlugin.id,
    entries: { wasm: wasmUrl },
    assetsBase,
    maps: { version: 'dev', list: Object.keys(configView.maps) },
    roomDefaults: configView.roomDefaults,
  };
}

function requireOption(value, name) {
  if (value === undefined || value === null) {
    throw new Error(`startStandaloneGame: "${name}" is required`);
  }
}
