const TECH_CODES = {
  fullServer: [0],
  anotherDevice: [1],
  loading: [2],
  kickIdle: [3],
  kickForMaxLatency: [4],
  kickForMissedPings: [5],
  roomFull: [6], // P2P-комната заполнена (отказ без очереди ожидания)
};

const GAME_CODES = {
  winnerTeam: [0],
  roundStart: [1],
  gameOver: [2],
};

export default class SocketManager {
  /**
   * @param {Object} ports - карта портов host→client (wsports.server).
   * @param {Object} [gameOpts] - игровая параметризация (конфиг игры).
   * @param {Object} [gameOpts.soundCues] - маппинг движковых событий на
   *   имена звуков игры: { roundStart, victory, defeat, frag, death }.
   * @param {string} [gameOpts.initialVote] - имя голосования, отправляемого
   *   игроку после первого кадра (у танков — выбор команды).
   */
  constructor(ports, { soundCues = {}, initialVote = null } = {}) {
    this._PORT_CONFIG_DATA = ports.CONFIG_DATA;
    this._PORT_AUTH_DATA = ports.AUTH_DATA;
    this._PORT_AUTH_RESULT = ports.AUTH_RESULT;
    this._PORT_MAP_DATA = ports.MAP_DATA;
    this._PORT_FIRST_SHOT_DATA = ports.FIRST_SHOT_DATA;
    this._PORT_SHOT_DATA = ports.SHOT_DATA;
    this._PORT_SOUND_DATA = ports.SOUND_DATA;
    this._PORT_GAME_INFORM_DATA = ports.GAME_INFORM_DATA;
    this._PORT_TECH_INFORM_DATA = ports.TECH_INFORM_DATA;
    this._PORT_MISC = ports.MISC;
    this._PORT_PING = ports.PING;
    this._PORT_CLEAR = ports.CLEAR;
    this._PORT_CONSOLE = ports.CONSOLE;
    this._PORT_PANEL_DATA = ports.PANEL_DATA;
    this._PORT_STAT_DATA = ports.STAT_DATA;
    this._PORT_CHAT_DATA = ports.CHAT_DATA;
    this._PORT_VOTE_DATA = ports.VOTE_DATA;
    this._PORT_KEYSET_DATA = ports.KEYSET_DATA;

    this._soundCues = soundCues;
    this._initialVote = initialVote;

    this._game = null;
    this._panel = null;
    this._stat = null;

    this._senders = new Map();
    this._binarySenders = new Map();
    this._closers = new Map();
  }

  /**
   * Инъекция игровых сервисов для формирования сложных сообщений.
   * @param {Object} game - Экземпляр игрового менеджера.
   * @param {Object} panel - Экземпляр менеджера панели.
   * @param {Object} stat - Экземпляр менеджера статистики.
   */
  injectServices(game, panel, stat) {
    this._game = game;
    this._panel = panel;
    this._stat = stat;
  }

  /**
   * Регистрация пользователя в менеджере.
   * @param {string} socketId - ID соединения.
   * @param {Object} socket - Транспорт клиента с методами send и close.
   */
  addUser(socketId, socket) {
    this._senders.set(socketId, socket.send.bind(socket));
    this._binarySenders.set(socketId, socket.sendBinary.bind(socket));
    this._closers.set(socketId, socket.close.bind(socket));
  }

  /**
   * Удаление пользователя из менеджера.
   * @param {string} socketId - ID соединения.
   */
  removeUser(socketId) {
    this._senders.delete(socketId);
    this._binarySenders.delete(socketId);
    this._closers.delete(socketId);
  }

  /**
   * Логирование ошибки отправки сообщения.
   * @private
   * @param {string} socketId
   * @param {number} port
   * @param {*} data
   */
  _logSendError(socketId, port, data) {
    console.warn(`
      [SocketManager Error]:
        Attempted to send data to a non-existent or already closed socket.
        - Socket ID: ${socketId}
        - Port: ${port}
        - Data (sample): ${JSON.stringify(data)?.substring(0, 300)}
      `);
  }

  /**
   * Логирование ошибки закрытия соединения.
   * @private
   * @param {string} socketId
   * @param {number} code
   * @param {*} data
   */
  _logCloseError(socketId, code, data) {
    console.warn(`
      [SocketManager Error]:
        Attempted to close a non-existent or already closed socket.
        - Socket ID: ${socketId}
        - Close Code: ${code}
        - Data (sample): ${JSON.stringify(data)?.substring(0, 300)}
      `);
  }

  /**
   * Отправка данных на клиент с проверкой наличия соединения.
   * @private
   * @param {string} socketId
   * @param {number} port
   * @param {*} data
   * @param {boolean} [reliable] - надёжная ли доставка (WebRTC meta vs
   *   state).
   */
  _send(socketId, port, data, reliable = true) {
    const sender = this._senders.get(socketId);

    if (sender) {
      sender(port, data, reliable);
    } else {
      this._logSendError(socketId, port, data);
    }
  }

  /**
   * Отправка бинарного кадра на клиент с проверкой наличия соединения.
   * @private
   * @param {string} socketId
   * @param {ArrayBuffer} buffer - Кадр (порт — первый байт буфера).
   * @param {boolean} [reliable] - надёжный ли кадр (WebRTC meta vs state).
   */
  _sendBinary(socketId, buffer, reliable) {
    const sender = this._binarySenders.get(socketId);

    if (sender) {
      sender(buffer, reliable);
    } else {
      this._logSendError(socketId, 'binary', `<${buffer.byteLength} bytes>`);
    }
  }

  /**
   * Закрытие соединения клиента с проверкой.
   * @private
   * @param {string} socketId
   * @param {number} code
   * @param {*} data
   */
  _close(socketId, code, data) {
    const closer = this._closers.get(socketId);

    if (closer) {
      closer(code, data);
    } else {
      this._logCloseError(socketId, code, data);
    }
  }

  /**
   * Закрытие соединения с отправкой технического сообщения.
   * @param {string} socketId
   * @param {number} code - Код закрытия.
   * @param {string} [key] - Ключ технического события (TECH_CODES).
   * @param {Array|undefined} [arr] - Дополнительные параметры.
   */
  close(socketId, code, key, arr) {
    if (key) {
      const data = Array.isArray(arr)
        ? [...TECH_CODES[key], arr]
        : TECH_CODES[key];

      this._close(socketId, code, data);
    } else {
      this._close(socketId, code);
    }
  }

  /**
   * Отправка конфигурационных данных.
   * @param {string} socketId
   * @param {*} config
   */
  sendConfig(socketId, config) {
    this._send(socketId, this._PORT_CONFIG_DATA, config);
  }

  /**
   * Отправка данных для авторизации.
   * @param {string} socketId
   * @param {*} authData
   */
  sendAuthData(socketId, authData) {
    this._send(socketId, this._PORT_AUTH_DATA, authData);
  }

  /**
   * Отправка данных о результате авторизации.
   * @param {string} socketId
   * @param {*} data
   */
  sendAuthResult(socketId, data) {
    this._send(socketId, this._PORT_AUTH_RESULT, data);
  }

  /**
   * Отправка ping для измерения RTT. Идёт ненадёжным каналом (WebRTC state):
   * замер отражает реальный сетевой путь, а не reliable-поток meta с его
   * ретрансмиссиями; потерянный ping покрывается допуском maxMissedPings.
   * @param {string} socketId
   * @param {number} pingIdCounter
   */
  sendPing(socketId, pingIdCounter) {
    this._send(socketId, this._PORT_PING, pingIdCounter, false);
  }

  /**
   * Отправка команды очистки данных.
   * @param {string} socketId
   * @param {Array|string} [setIdList]
   */
  sendClear(socketId, setIdList) {
    if (setIdList) {
      this._send(socketId, this._PORT_CLEAR, setIdList);
    } else {
      this._send(socketId, this._PORT_CLEAR);
    }
  }

  /**
   * Отправка технического сообщения.
   * @param {string} socketId
   * @param {string} [key] - Ключ технического события (TECH_CODES).
   * @param {Array|undefined} [arr] - Дополнительные параметры.
   */
  sendTechInform(socketId, key, arr) {
    if (key) {
      const data = Array.isArray(arr)
        ? [...TECH_CODES[key], arr]
        : TECH_CODES[key];

      this._send(socketId, this._PORT_TECH_INFORM_DATA, data);
    } else {
      this._send(socketId, this._PORT_TECH_INFORM_DATA);
    }
  }

  /**
   * Отправка данных карты.
   * @param {string} socketId
   * @param {*} mapData
   */
  sendMap(socketId, mapData) {
    this._send(socketId, this._PORT_MAP_DATA, mapData);
  }

  /**
   * Отправка первого кадра игры. Snapshot идёт на FIRST_SHOT_DATA,
   * полная статистика, панель и набор клавиш — своими каналами.
   * @param {string} socketId
   */
  sendFirstShot(socketId) {
    // camera = 0 (координат на первом кадре нет); seq = 0 (одноразовый кадр)
    this._send(socketId, this._PORT_FIRST_SHOT_DATA, [
      this._game.getPlayersData(), // gameSnapshot
      0, // camera
      Date.now(), // serverTime
      0, // seq
    ]);
    this.sendStat(socketId, this._stat.getFull());
    this.sendPanel(socketId, this._panel.getEmptyPanel());
    this.sendKeySet(socketId, 0); // наблюдатель
  }

  /**
   * Отправка первого голосования (initialVote из конфига игры).
   * @param {string} socketId
   */
  sendFirstVote(socketId) {
    if (this._initialVote) {
      this.sendVote(socketId, { name: this._initialVote });
    }
  }

  /**
   * Отправка игровых данных (бинарный snapshot-кадр).
   * @param {string} socketId
   * @param {ArrayBuffer} frameBuffer - Кадр из pack_frame ядра.
   * @param {boolean} [reliable] - событийный ли кадр (WebRTC meta) или
   *   позиционный (state).
   */
  sendShot(socketId, frameBuffer, reliable) {
    this._sendBinary(socketId, frameBuffer, reliable);
  }

  /**
   * Отправка данных панели.
   * @param {string} socketId
   * @param {*} data
   */
  sendPanel(socketId, data) {
    this._send(socketId, this._PORT_PANEL_DATA, data);
  }

  /**
   * Отправка данных статистики.
   * @param {string} socketId
   * @param {*} data
   */
  sendStat(socketId, data) {
    this._send(socketId, this._PORT_STAT_DATA, data);
  }

  /**
   * Отправка сообщения чата.
   * @param {string} socketId
   * @param {*} data
   */
  sendChat(socketId, data) {
    this._send(socketId, this._PORT_CHAT_DATA, data);
  }

  /**
   * Отправка данных голосования.
   * @param {string} socketId
   * @param {*} data
   */
  sendVote(socketId, data) {
    this._send(socketId, this._PORT_VOTE_DATA, data);
  }

  /**
   * Отправка набора клавиш (смена режима спектатор/игрок).
   * @param {string} socketId
   * @param {number} keySet - 0 (наблюдатель) | 1 (игрок)
   */
  sendKeySet(socketId, keySet) {
    this._send(socketId, this._PORT_KEYSET_DATA, keySet);
  }

  /**
   * Отправка базовых данных игрока (полная панель + набор клавиш игрока).
   * @param {string} socketId
   * @param {string} gameId - ID игрока в игре.
   */
  sendPlayerDefaultShot(socketId, gameId) {
    this.sendPanel(socketId, this._panel.getFullPanel(gameId));
    this.sendKeySet(socketId, 1);
  }

  /**
   * Отправка базовых данных наблюдателя (пустая панель + набор клавиш наблюдателя).
   * @param {string} socketId
   */
  sendSpectatorDefaultShot(socketId) {
    this.sendPanel(socketId, this._panel.getEmptyPanel());
    this.sendKeySet(socketId, 0);
  }

  /**
   * Отправка звукового сигнала движкового события. Маппинг события на имя
   * звука задаёт игра (soundCues); незамапленный сигнал не отправляется.
   * @param {string} socketId
   * @param {string} cue - движковое событие (roundStart, victory, defeat,
   *   frag, death).
   */
  sendSoundCue(socketId, cue) {
    const sound = this._soundCues[cue];

    if (sound) {
      this._send(socketId, this._PORT_SOUND_DATA, sound);
    }
  }

  /**
   * Отправка игрового информера.
   * @param {string} socketId
   * @param {string} key - Ключ игрового события (GAME_CODES).
   * @param {Array|undefined} [arr] - Дополнительные параметры.
   */
  sendGameInform(socketId, key, arr) {
    const data = Array.isArray(arr)
      ? [...GAME_CODES[key], arr]
      : GAME_CODES[key];

    this._send(socketId, this._PORT_GAME_INFORM_DATA, data);
  }

  /**
   * Отправка информации об окончании раунда.
   * @param {string} socketId
   * @param {string|number} [winnerTeam] - Победившая команда.
   */
  sendRoundEnd(socketId, winnerTeam) {
    if (winnerTeam) {
      this.sendGameInform(socketId, 'winnerTeam', [winnerTeam]);
    } else {
      this.sendGameInform(socketId, 'gameOver');
    }
  }

  /**
   * Отправка команды смены имени.
   * @param {string} socketId
   * @param {string} name
   */
  sendName(socketId, name) {
    this._send(socketId, this._PORT_MISC, {
      key: 'localstorageNameReplace',
      value: name,
    });
  }
}
