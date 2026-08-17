// Режим загрузки клиента движка (Этап 2 плана standalone-sdk). Клиент один
// на все контуры, а различает их этот модуль:
//
//   lobby      — прод: каталог игр и сигналинг мастера, лобби за OAuth-гейтом;
//   solo       — standalone SDK: хост в этой же вкладке (inline, без Worker'а),
//                мастера нет вовсе;
//   dedicated  — Node-сервер: прямой WebSocket к игровому процессу.
//
// Канал передачи конфига от SDK к main.js — модульное состояние: и SDK, и
// main.js резолвят этот модуль в один экземпляр графа бандлера. Глобалов на
// window не вводим: они переживают перезагрузку бандла и ломают вторую
// вкладку SDK в том же документе.

// эндпоинт режима: его отдаёт dedicated-сервер, у мастера его нет —
// 404/сеть/мусор означают прод-лобби (обратная совместимость)
const CONFIG_URL = '/config';

// умолчание игрового WS dedicated-сервера: тот же хост, путь /game
const DEDICATED_WS_PATH = '/game';

/**
 * Конфиг загрузки:
 * {
 *   mode: 'lobby' | 'solo' | 'dedicated',
 *   container,       // solo: точка монтирования каркаса и канвасов
 *   manifest,        // solo: манифест-подобный объект в памяти
 *   clientPlugin,    // solo: живой ClientPlugin (минуя dynamic import)
 *   hostPlugin,      // solo: живой HostPlugin (для inline-хоста)
 *   room,            // solo: переопределения комнаты (map/maxPlayers/seed/…)
 *   autoAuth,        // solo: { name, model, … } → AUTH_RESPONSE без формы
 *   startupVotes,    // solo: ответы на initialVote (выход из наблюдателей)
 *   startupCommands, // solo: чат-команды игры (спавн ботов)
 *   wsUrl,           // dedicated: адрес игрового WS
 *   gameId,          // dedicated: какую игру каталога считать активной
 * }
 */
let bootConfig = null;

/**
 * Задаёт конфиг загрузки. SDK вызывает его до import('./main.js') — main.js
 * читает уже готовое состояние и сети не касается.
 * @param {Object} cfg - Конфиг загрузки (см. выше).
 */
export function setBootConfig(cfg) {
  bootConfig = cfg;
}

/**
 * Текущий конфиг загрузки (null, пока не задан и не разрешён).
 * @returns {Object|null}
 */
export function getBootConfig() {
  return bootConfig;
}

/**
 * Сбрасывает состояние модуля. Нужен тестам: модульный синглтон переживает
 * отдельный it().
 */
export function resetBootConfig() {
  bootConfig = null;
}

/**
 * Разрешает режим загрузки: инъекция SDK → GET /config → лобби.
 * @param {Function} [fetchImpl] - Реализация fetch (тесты подставляют свою).
 * @returns {Promise<Object>} Конфиг загрузки.
 */
export async function resolveBootConfig(fetchImpl) {
  if (bootConfig) {
    return bootConfig;
  }

  const doFetch = fetchImpl ?? ((...args) => fetch(...args));

  try {
    const res = await doFetch(CONFIG_URL);

    if (res.ok) {
      bootConfig = normalize(await res.json());
    }
  } catch (e) {
    // сети/эндпоинта нет — это и есть прод-лобби, шуметь не о чем
  }

  bootConfig = bootConfig ?? { mode: 'lobby' };

  return bootConfig;
}

// приводит ответ /config к валидному конфигу; всё, что не dedicated, —
// лобби: неизвестный режим не должен уронить клиент в чёрный экран
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || raw.mode !== 'dedicated') {
    return null;
  }

  return {
    ...raw,
    mode: 'dedicated',
    wsUrl: raw.wsUrl || defaultDedicatedWsUrl(),
  };
}

function defaultDedicatedWsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  return `${protocol}//${location.host}${DEDICATED_WS_PATH}`;
}
