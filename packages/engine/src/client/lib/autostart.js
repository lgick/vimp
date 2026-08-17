// Автостарт клиента в solo-режиме (Этап 2 плана standalone-sdk): без лобби и
// без живого игрока за клавиатурой матч должен сам довести себя до игрового
// состояния — выйти из наблюдателей и позвать ботов игры.
//
// Порядок «сначала голоса, потом чат-команды» обязателен, и он не про гонку
// доставки:
//   - порт CHAT_DATA открывается ещё на MODULES_READY, а реальный гейт —
//     HostGame.pushMessage: он отбрасывает сообщение, пока user.isReady=false
//     (флаг ставится синхронно в firstShotReady);
//   - настоящая блокировка — команда: участник входит наблюдателем, а игра
//     вправе требовать активной команды (у танков /bot отбивается
//     наблюдателю). Выйти из наблюдателей можно только ответом на initialVote
//     (['teamChange', '<team>'] на порт VOTE_DATA).
// Отсюда: голоса строго раньше команд, и вся пачка — после FIRST_SHOT_READY.
//
// Дробить команды по кадрам не нужно: лимита частоты чата на хосте нет,
// ограничение только по длине (chatMaxLength).

/**
 * @param {Object} deps
 * @param {Array} [deps.votes] - Ответы на initialVote (VOTE_DATA).
 * @param {Array<string>} [deps.commands] - Чат-команды игры (CHAT_DATA).
 * @param {Function} deps.sendVote - (payload) => void.
 * @param {Function} deps.sendCommand - (message) => void.
 * @param {Function} deps.schedule - (fn) => void: отложить на первый
 *   renderTick (страховка поверх синхронного гейта isReady и симметрия с
 *   задержкой интерполяции).
 * @returns {Function} start(): запускает автостарт не более одного раза.
 */
export default function createAutostart({
  votes = [],
  commands = [],
  sendVote,
  sendCommand,
  schedule,
}) {
  let started = false;

  return () => {
    // FIRST_SHOT_DATA приходит и после смены карты — автостарт разовый
    if (started) {
      return;
    }

    started = true;

    if (!votes.length && !commands.length) {
      return;
    }

    schedule(() => {
      for (const vote of votes) {
        sendVote(vote);
      }

      for (const command of commands) {
        sendCommand(command);
      }
    });
  };
}
