// Обработчик чат-команд. Своих команд у движка НЕТ: реестр целиком наполняет
// игра через HostPlugin.chatCommands, а обработчик получает контекст меты —
// handler(ctx, gameId, args). Одно и то же имя (/name, /bot, /timeleft …) в
// разных играх может делать разное или отсутствовать вовсе; незнакомая
// команда — COMMANDS_NOT_FOUND.
//
// Всё, что раньше разбирал движковый switch, доступно играм через контекст:
// roundManager (смена ника, новый раунд, текущая карта), timerManager
// (остаток времени карты), playerDataSync (ранг), chat, isDevMode.
class CommandProcessor {
  constructor(deps) {
    this._chat = deps.chat;

    // контекст игровых команд (participants, chat, scripted, roundManager,
    // voteCoordinator, timerManager, playerDataSync, teams, spectatorTeam,
    // spectatorId, isDevMode)
    this._ctx = deps;

    this._commands = new Map();
  }

  /**
   * Регистрирует игровую команду.
   * @param {string} name - имя команды (с ведущим '/').
   * @param {Function} handler - обработчик (ctx, gameId, args) => void.
   */
  registerCommand(name, handler) {
    this._commands.set(name, handler);
  }

  // обрабатывает команду от пользователя
  parseCommand(gameId, message) {
    message = message.replace(/\s\s+/g, ' ');

    const arr = message.split(' ');
    const cmd = arr.shift();
    const handler = this._commands.get(cmd);

    if (handler) {
      handler(this._ctx, gameId, arr);
    } else {
      this._chat.pushSystemByUser(gameId, 'COMMANDS_NOT_FOUND');
    }
  }
}

export default CommandProcessor;
