// Обработчик чат-команд. Движковое ядро: /name, /nr, /timeleft, /mapname,
// /rank; игровые команды (HostPlugin.chatCommands) регистрируются через
// registerCommand и получают контекст меты: handler(ctx, gameId, args).
class CommandProcessor {
  constructor(deps) {
    this._chat = deps.chat;
    this._roundManager = deps.roundManager;
    this._timerManager = deps.timerManager;
    this._playerDataSync = deps.playerDataSync;
    this._isDevMode = deps.isDevMode;

    // контекст игровых команд (participants, chat, scripted, roundManager,
    // voteCoordinator, teams, spectatorTeam, spectatorId, …)
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

    switch (cmd) {
      // смена ника
      case '/name':
        this._roundManager.changeName(gameId, arr.join(' '));
        break;

      // новый раунд
      case '/nr':
        if (this._isDevMode) {
          this._roundManager.initiateNewRound();
        } else {
          this._chat.pushSystemByUser(gameId, 'COMMANDS_NOT_FOUND');
        }
        break;

      // время карты
      case '/timeleft': {
        function getTime(ms) {
          const totalSeconds = Math.floor(ms / 1000);
          let minutes = Math.floor(totalSeconds / 60);
          let seconds = totalSeconds % 60;

          if (minutes < 10) {
            minutes = '0' + minutes;
          }

          if (seconds < 10) {
            seconds = '0' + seconds;
          }

          return `${minutes}:${seconds}`;
        }

        this._chat.pushSystemByUser(gameId, [
          getTime(this._timerManager.getMapTimeLeft()),
        ]);
        break;
      }

      // название текущей карты
      case '/mapname':
        this._chat.pushSystemByUser(gameId, [this._roundManager.currentMap]);
        break;

      // ранг игрока (Этап B4/B5: PlayerDataSync, подгружен с auth-сервиса)
      case '/rank':
        this._chat.pushSystemByUser(gameId, 'RANK', [
          this._playerDataSync.getRank(gameId),
        ]);
        break;

      default: {
        const handler = this._commands.get(cmd);

        if (handler) {
          handler(this._ctx, gameId, arr);
        } else {
          this._chat.pushSystemByUser(gameId, 'COMMANDS_NOT_FOUND');
        }
      }
    }
  }
}

export default CommandProcessor;
