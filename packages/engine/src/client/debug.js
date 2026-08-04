// Браузерная половина отладочного контура (этап 6 плана plan/ai-debug).
//
// Всё, что headless-прогон не воспроизводит — реальный WebRTC, PixiJS, живой
// ввод человека — читается и записывается отсюда: `window.__vimpDebug`
// вызывается из DevTools или через Chrome MCP (javascript_tool,
// read_console_messages), без участия человека в разборе.
//
// Записанный сценарий уезжает на мастер (POST /debug/report, только dev) в
// тот же `.debug/`, откуда его берёт `npm run sim:replay` — браузерный баг
// становится headless-прогоном.

// Единый префикс структурированного лога: по нему Chrome MCP фильтрует
// консоль (read_console_messages pattern) вместо чтения всего потока.
export const DEBUG_PREFIX = '[vimp:debug]';

export function debugLog(...args) {
  console.log(DEBUG_PREFIX, ...args);
}

/**
 * Собирает отладочный API вкладки.
 * @param {Object} params
 * @param {Function} params.getHostController - Текущий HostController (null,
 *   если вкладка не хостит комнату).
 * @param {Function} params.getClientCore - Текущий ClientCore.
 * @param {string} params.reportUrl - Эндпоинт выгрузки на мастере.
 * @param {Function} [params.fetchImpl] - fetch (подменяется в тестах).
 * @param {Function} [params.log] - Логгер (подменяется в тестах).
 * @returns {Object} API для window.__vimpDebug.
 */
export function createDebugApi({
  getHostController,
  getClientCore,
  reportUrl,
  fetchImpl,
  log = debugLog,
}) {
  const post = fetchImpl ?? ((...args) => fetch(...args));

  // отладка не должна молча возвращать null там, где вкладка просто не
  // хостит комнату: причина «нечего дампить» и «дамп сломался» — разные
  const requireHost = () => {
    const hostController = getHostController();

    if (!hostController) {
      throw new Error('this tab is not hosting a room');
    }

    return hostController;
  };

  /**
   * Выгружает произвольную полезную нагрузку на мастер.
   * @param {string} kind - scenario | dump | divergence.
   * @param {*} payload
   * @param {string} [note] - Пометка человека («танк в стене на respawn»).
   * @returns {Promise<Object>} Ответ мастера ({ file, bytes }).
   */
  const save = async (kind, payload, note) => {
    const res = await post(reportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, payload, note }),
    });

    const body = await res.json();

    if (!res.ok) {
      throw new Error(`debug report rejected: ${body.error ?? res.status}`);
    }

    log(`${kind} saved to .debug/${body.file}`);

    return body;
  };

  return {
    save,

    /**
     * Дамп авторитетной половины (мета хоста + мир ядра, этап 4) рядом со
     * сценой этого клиента — «в ядре тело есть, на холсте пусто» видно
     * только при обеих половинах разом.
     * @param {Object} [options]
     * @param {boolean} [options.save] - Выгрузить на мастер.
     * @param {string} [options.note]
     * @returns {Promise<Object>}
     */
    async dump({ save: doSave = false, note } = {}) {
      const host = await requireHost().dump();

      log('dump', host);

      if (doSave) {
        await save('dump', host, note);
      }

      return host;
    },

    /**
     * Начинает запись живого матча в формат сценария.
     * @returns {Promise<boolean>} false — комната поднята без dev-режима.
     */
    async startRecording() {
      const started = await requireHost().startRecording();

      log(started ? 'recording started' : 'recording unavailable (no dev mode)');

      return started;
    },

    /**
     * Останавливает запись и (по умолчанию) выгружает сценарий на мастер.
     * @param {Object} [options]
     * @param {boolean} [options.save]
     * @param {string} [options.note]
     * @returns {Promise<Object|null>} { scenario, file } или null.
     */
    async stopRecording({ save: doSave = true, note } = {}) {
      const scenario = await requireHost().stopRecording();

      if (!scenario) {
        log('recording was not running');

        return null;
      }

      log(
        `recording stopped: ${scenario.ticks} tick(s), ` +
          `${scenario.timeline.length} op(s)`,
      );

      const saved = doSave ? await save('scenario', scenario, note) : null;

      return { scenario, file: saved?.file ?? null };
    },

    /**
     * Записи детектора рассинхрона предикта (этап 5) этого клиента.
     * Вычерпывающая операция: ядро отдаёт накопленное и обнуляет буфер.
     * @returns {Object|null} null — ядро без детектора/секции divergence.
     */
    divergence() {
      const core = getClientCore();

      if (!core || typeof core.take_divergence !== 'function') {
        return null;
      }

      const dump = JSON.parse(core.take_divergence());

      log('divergence', dump);

      return dump;
    },
  };
}
