// Singleton Stat

let stat;

class Stat {
  constructor(config, teams) {
    if (stat) {
      return stat;
    }

    stat = this;

    this._config = config;

    this._head = {};
    this._body = {};

    this._lastHead = [];
    this._lastBody = [];

    for (const p in teams) {
      if (Object.hasOwn(teams, p)) {
        this._head[teams[p]] = [teams[p], []];
        this._body[teams[p]] = {};
      }
    }
  }

  // сбрасывает статистику
  reset() {
    for (const teamId in this._body) {
      if (Object.hasOwn(this._body, teamId)) {
        const bodyStats = this._body[teamId];

        for (const gameId in bodyStats) {
          if (Object.hasOwn(bodyStats, gameId)) {
            const stat = bodyStats[gameId];
            stat[2] = this._getDefaultBody(stat[2]);
            this._lastBody.push(stat);
          }
        }
      }
    }

    for (const teamId in this._head) {
      if (Object.hasOwn(this._head, teamId)) {
        const stat = this._head[teamId];

        for (const p in this._config) {
          if (Object.hasOwn(this._config, p)) {
            const conf = this._config[p];

            if (conf.headSync) {
              this._updateHeadSync(teamId, p);
            } else if (typeof conf.headValue !== 'undefined') {
              stat[1][conf.key] = conf.headValue;
            }
          }
        }

        this._lastHead.push(stat);
      }
    }
  }

  // возвращает дефолтные данные для body
  _getDefaultBody(stat = []) {
    for (const p in this._config) {
      if (Object.hasOwn(this._config, p)) {
        const conf = this._config[p];

        if (typeof conf.bodyValue !== 'undefined') {
          stat[conf.key] = conf.bodyValue;
        }
      }
    }

    return stat;
  }

  // добавляет пользователя
  addUser(gameId, teamId, data) {
    // добавление данных по умолчанию из конфига
    this._body[teamId][gameId] = [gameId, teamId, this._getDefaultBody()];

    // обновление данных игрока (имя, статус...)
    this.updateUser(gameId, teamId, data);
  }

  // удаляет пользователя и возвращает его данные
  removeUser(gameId, teamId) {
    let data = this._body[teamId][gameId];
    const stat = {};

    delete this._body[teamId][gameId];
    this._lastBody.push([data[0], data[1], null]);

    data = data[2];

    // преобразование данных пользователя из массива в объект и
    // обновление head
    for (const p in this._config) {
      if (Object.hasOwn(this._config, p)) {
        const conf = this._config[p];
        const value = data[conf.key];

        stat[p] = value;

        if (conf.headSync === true) {
          this._updateHeadSync(teamId, p, true);
        }
      }
    }

    return stat;
  }

  // перемещает пользователя в новую команду
  moveUser(gameId, teamId, newTeamId, data = {}) {
    const userData = this.removeUser(gameId, teamId);

    this.addUser(gameId, newTeamId, { ...userData, ...data });
  }

  // обновляет статистику пользователя
  updateUser(gameId, teamId, data) {
    const stat = this._body[teamId][gameId];

    for (const p in data) {
      if (Object.hasOwn(data, p)) {
        const conf = this._config[p];

        // колонки объявляет схема игры (Д7): движковые записи
        // (status/score/deaths/latency) в необъявленные колонки игнорируются
        if (!conf) {
          continue;
        }

        const method = conf.bodyMethod;
        const value = data[p];

        // если метод 'замена'
        if (method === '=') {
          stat[2][conf.key] = value;

          // иначе если метод 'добавление'
        } else if (method === '+') {
          stat[2][conf.key] += value;
        }

        if (conf.headSync === true) {
          this._updateHeadSync(teamId, p, true);
        }
      }
    }

    this._lastBody.push(stat);
  }

  // обновляет статистику head
  updateHead(teamId, param, value) {
    const stat = this._head[teamId];
    const conf = this._config[param];

    // необъявленная схемой колонка — запись игнорируется (Д7)
    if (!conf) {
      return;
    }

    const method = conf.headMethod;
    const key = conf.key;

    // если метод 'добавление'
    if (method === '+') {
      stat[1][key] += value;

      // если метод 'замена'
    } else if (method === '=') {
      stat[1][key] = value;
    }

    this._lastHead.push(stat);
  }

  // обновляет статистику head синхронизированную с body
  _updateHeadSync(teamId, param, save) {
    const stat = this._head[teamId];
    const bodyStats = this._body[teamId];
    const conf = this._config[param];
    const method = conf.headMethod;
    const key = conf.key;
    let value;

    // если метод 'количество'
    if (method === '#') {
      value = Object.keys(bodyStats).length;

      // иначе если метод 'добавление'
    } else if (method === '+') {
      value = 0;

      for (const p in bodyStats) {
        if (Object.hasOwn(bodyStats, p)) {
          value += bodyStats[p][2][key];
        }
      }
    }

    stat[1][key] = value;

    if (save === true) {
      this._lastHead.push(stat);
    }
  }

  // снимок статистики для эстафеты Worker'ов (Этап 5.2)
  serialize() {
    return { head: this._head, body: this._body };
  }

  // восстанавливает статистику из снимка эстафеты; строки участников вне
  // keepIds (не пережившие перенос) удаляются штатно — клиенты получат
  // обновление на первом же кадре
  restore({ head, body }, keepIds = null) {
    this._head = head;
    this._body = body;

    if (keepIds) {
      for (const teamId in this._body) {
        if (Object.hasOwn(this._body, teamId)) {
          for (const gameId in this._body[teamId]) {
            if (
              Object.hasOwn(this._body[teamId], gameId) &&
              !keepIds.has(gameId)
            ) {
              this.removeUser(gameId, teamId);
            }
          }
        }
      }
    }
  }

  // возвращает последние изменения
  getLast() {
    let stat = [this._lastBody, this._lastHead];

    this._lastBody = [];
    this._lastHead = [];

    if (!stat[0].length && !stat[1].length) {
      stat = 0;
    }

    return stat;
  }

  // возвращает полную статистику
  getFull() {
    let stat = [];

    stat[0] = [];
    stat[1] = [];

    for (const teamId in this._body) {
      if (Object.hasOwn(this._body, teamId)) {
        const bodyStats = this._body[teamId];

        for (const gameId in bodyStats) {
          if (Object.hasOwn(bodyStats, gameId)) {
            stat[0].push(bodyStats[gameId]);
          }
        }
      }
    }

    for (const teamId in this._head) {
      if (Object.hasOwn(this._head, teamId)) {
        stat[1].push(this._head[teamId]);
      }
    }

    if (!stat[0].length && !stat[1].length) {
      stat = 0;
    }

    // true указывает, что обновление статистики полное
    stat[2] = true;

    return stat;
  }
}

export default Stat;
