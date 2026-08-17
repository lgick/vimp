// Отказы по политике: коды закрытия, которыми dedicated-сервер отбивает
// соединение (`src/dedicated/main.js` — invalidOrigin, handshakeTimeout,
// tooManyConnections) и которыми порт-машина отбивает полную комнату
// (`src/host/PortMachine.js` — roomFull). Числа берутся из общей карты
// `src/config/closeCodes.js`, чтобы серверные контуры и клиент не разъехались
// молча; тест модуля требует явного решения по каждому коду карты.
//
// Клиенту от кода нужны два разных ответа, и совпадают они не всегда, поэтому
// знание разведено на два экспорта (review-4.md, R4-2):
//
//   - перезагружаться ли. Ни на одном из этих кодов перезагрузка не помогает:
//     лимит частоты подключений съел бы ей же очередное соединение, таймаут
//     хендшейка запустился бы заново, origin страницы не меняется вовсе, а
//     слот в полной комнате перезагрузка не освобождает. Брошенная вкладка
//     перезагружалась бы вечно, а ждущий слот игрок за 30 витков сам упёрся бы
//     в лимит подключений и получил бы чужую причину отказа;
//   - какой текст показать. Тексты запасные: `handleDisconnect` берёт их
//     только тогда, когда сервер причину не прислал сам (`terminalInformShown`
//     — `client/main.js`). Полная комната, например, приезжает с причиной от
//     порт-машины (TECH_INFORM перед `close`), и она всегда побеждает —
//     запись 4006 ниже отработает, только если тот кадр не доехал. Тексты
//     здесь, а не в `techInformList`: список переопределяет игра, и движковый
//     индекс дал бы у неё «Unknown error».

import closeCodes from '../../config/closeCodes.js';

const { invalidOrigin, roomFull, handshakeTimeout, tooManyConnections } =
  closeCodes;

const NO_RELOAD_CLOSE_CODES = new Set([
  invalidOrigin,
  roomFull,
  handshakeTimeout,
  tooManyConnections,
]);

export const POLICY_CLOSE_INFORMS = {
  [invalidOrigin]:
    'This page is not allowed by the game server. Check the address you opened.',
  [roomFull]: 'The room is full. Try again later.',
  [handshakeTimeout]:
    'Idle connection closed before the match started. Reload the page when you are ready to play.',
  [tooManyConnections]:
    'Too many connections from your address. Wait a minute and reload the page.',
};

/**
 * @param {number} [closeCode] - Код закрытия транспорта. Его отдаёт только
 *   WebSocket-транспорт (dedicated); в P2P и solo кода нет вовсе.
 * @returns {boolean} Уместна ли перезагрузка страницы после разрыва.
 */
export function shouldReloadAfterClose(closeCode) {
  return !NO_RELOAD_CLOSE_CODES.has(closeCode);
}
