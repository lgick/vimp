// Диспетчеризация входящего JSON-сообщения [portId, payload] по разрежённому
// массиву обработчиков (client/main.js: socketMethods).
//
// Порт без обработчика — не исключение, а тишина (этап 3 плана
// plugin-forward-compat). До этого `socketMethods[msg[0]](msg[1])` бросал
// `TypeError: ... is not a function` и ронял обработку сообщения целиком:
// получатель падал от того, что отправитель знает больше. Это не плагинная
// ось (хост и клиент комнаты — один бандл движка, их расхождение ловится
// codeVersion), но хрупкость ровно та же, и лечится она веткой по умолчанию.

/**
 * Отдаёт сообщение обработчику своего порта.
 * @param {Array<Function>} methods - Обработчики по номеру порта.
 * @param {Array} msg - Сообщение [portId, payload].
 * @returns {boolean} Было ли сообщение обработано.
 */
export function dispatchSocketMessage(methods, msg) {
  const port = msg?.[0];
  const method = methods?.[port];

  if (typeof method !== 'function') {
    // console.debug, а не error: неизвестный порт — штатная встреча со
    // «стороной, которая знает больше», а не дефект
    console.debug(`client: no handler for port ${port} — message ignored`);

    return false;
  }

  method(msg[1]);

  return true;
}

export default dispatchSocketMessage;
