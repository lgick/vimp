// Отказы по политике: коды закрытия, которыми dedicated-сервер отбивает
// соединение (`src/dedicated/main.js` — 4001 invalidOrigin, 4008
// handshakeTimeout, 4009 tooManyConnections) и которыми порт-машина отбивает
// полную комнату (`src/host/PortMachine.js` — 4006 roomFull).
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
//   - какой текст показать. Только там, где сервер его не прислал сам: 4006
//     приносит причину TECH_INFORM'ом непосредственно перед закрытием, и
//     затирать её нельзя. Тексты здесь, а не в `techInformList`: список
//     переопределяет игра, и движковый индекс дал бы у неё «Unknown error».

const NO_RELOAD_CLOSE_CODES = new Set([4001, 4006, 4008, 4009]);

export const POLICY_CLOSE_INFORMS = {
  4001: 'This page is not allowed by the game server. Check the address you opened.',
  4008: 'Idle connection closed before the match started. Reload the page when you are ready to play.',
  4009: 'Too many connections from your address. Wait a minute and reload the page.',
};

/**
 * @param {number} [closeCode] - Код закрытия транспорта. Его отдаёт только
 *   WebSocket-транспорт (dedicated); в P2P и solo кода нет вовсе.
 * @returns {boolean} Уместна ли перезагрузка страницы после разрыва.
 */
export function shouldReloadAfterClose(closeCode) {
  return !NO_RELOAD_CLOSE_CODES.has(closeCode);
}
