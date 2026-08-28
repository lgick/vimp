import Publisher from '../../../lib/Publisher.js';
import { nickKey } from '../../../lib/validators.js';

// Singleton StatModel

let statModel;

export default class StatModel {
  // data — params схемы игры; deps — то, чего у модуля своего нет: доступ к
  // публичному топу мастера и ник вызывающего (режим 'leaderboard')
  constructor(data, deps = {}) {
    if (statModel) {
      return statModel;
    }

    statModel = this;

    this._heads = data.heads;
    this._bodies = data.bodies;
    this._sortList = data.sortList;

    // snakes-v3 этап 4: режим 'leaderboard' — по Tab показывается не
    // таблица комнаты, а глобальный топ игры. Данные хоста в этом режиме не
    // рисуются (хост их и не шлёт), список клиент тянет сам
    this._mode = data.mode ?? null;
    this._period = data.period ?? 'day';
    this._limit = data.limit ?? 10;
    this._refreshMs = data.refreshMs ?? 15000;

    this._gameId = deps.gameId ?? null;
    this._fetchLeaderboard = deps.fetchLeaderboard ?? null;
    this._fetchPlacement = deps.fetchPlacement ?? null;
    this._getNick = deps.getNick ?? (() => null);
    this._now = deps.now ?? (() => Date.now());

    // null, а не 0: первый запрос обязан пройти при любом начале отсчёта
    this._lastFetchAt = null;
    this._rows = [];

    this.publisher = new Publisher();
  }

  get isLeaderboard() {
    return this._mode === 'leaderboard';
  }

  // открывает статистику
  open() {
    this.publisher.emit('open');
    this.publisher.emit('mode', { name: 'stat', status: 'opened' });

    if (this.isLeaderboard) {
      // фон: открытие не ждёт сети — рисуется последнее известное
      // состояние, пришедший ответ перерисует список
      this.refreshLeaderboard();
    }
  }

  // закрывает статистику
  close() {
    this.publisher.emit('close');
    this.publisher.emit('mode', { name: 'stat', status: 'closed' });
  }

  // обновляет данные статистики
  update(data) {
    // в режиме 'leaderboard' данные комнаты не рисуются вовсе
    if (this.isLeaderboard) {
      return;
    }

    const tBodiesData = data[0];
    const tHeadData = data[1];
    const fullStatFlag = data[2];

    // если обновление полное, требуется очистить таблицы <tbody>
    // очищать <thead> не требуется, в tHeadData есть актуальные данные
    if (fullStatFlag === true) {
      this.publisher.emit('clearBodies', Object.values(this._bodies));
    }

    // если есть данные для <tbody>
    if (tBodiesData) {
      for (let i = 0, len = tBodiesData.length; i < len; i += 1) {
        const tableId = this._bodies[tBodiesData[i][1]];

        if (tableId) {
          this.publisher.emit('tBody', {
            id: tBodiesData[i][0],
            tableId,
            cellsData: tBodiesData[i][2],
            sortData: this._sortList[tableId],
            bodyNumber: tBodiesData[i][3] || 0,
          });
        }
      }
    }

    // если есть данные для <thead>
    if (tHeadData) {
      for (let i = 0, len = tHeadData.length; i < len; i += 1) {
        const tableId = this._heads[tHeadData[i][0]];

        if (tableId) {
          this.publisher.emit('tHead', {
            tableId,
            cellsData: tHeadData[i][1],
            rowNumber: tHeadData[i][2] || 0,
          });
        }
      }
    }
  }

  // тянет топ и свою позицию у мастера не чаще refreshMs (Tab жмут часто, а
  // топ на мастере всё равно схлопнут TTL-кэшем). 304, сетевой сбой или
  // отсутствие токена оставляют последнее известное состояние — на первом
  // открытии это пустой список, и это нормально
  async refreshLeaderboard() {
    const now = this._now();

    if (this._lastFetchAt !== null && now - this._lastFetchAt < this._refreshMs) {
      return;
    }

    // метка ставится ДО запроса и на сбое не сбрасывается: Tab жмут часто, и
    // лежащий мастер не должен превращать каждое нажатие в запрос. Цена в
    // том, что после сбоя список обновится не раньше refreshMs
    this._lastFetchAt = now;

    const [board, placement] = await Promise.all([
      this._fetchLeaderboard?.(this._gameId, this._period) ?? null,
      this._fetchPlacement?.(this._gameId, this._period) ?? null,
    ]);

    if (board) {
      this._rows = this._buildRows(board, placement);
    } else if (placement) {
      // список тот же (304), но своя строка могла сдвинуться
      this._rows = this._withSelf(this._rows, placement);
    } else {
      return;
    }

    this.publisher.emit('leaderboard', this._rows);
  }

  _buildRows(board, placement) {
    const rows = (board.leaderboard ?? [])
      .slice(0, this._limit)
      .map(row => ({
        place: row.place,
        nick: row.nick,
        score: row.rank,
        isSelf: false,
      }));

    return this._withSelf(rows, placement);
  }

  // своя строка: если игрок в топе — подсвечивается на своём месте, если
  // нет — заменяет последнюю (решение пользователя 7). Неранжированный за
  // сегодня получает прочерк вместо места и свои очки (то есть 0)
  _withSelf(rows, placement) {
    const nick = this._getNick();

    if (!nick) {
      return rows;
    }

    const lower = nickKey(nick);
    const marked = rows.map(row => ({
      ...row,
      isSelf: nickKey(row.nick) === lower,
    }));

    if (marked.some(row => row.isSelf) || !placement) {
      return marked;
    }

    const self = {
      place: placement.placement ?? null,
      nick,
      score: Number(placement.rank) || 0,
      isSelf: true,
    };

    if (marked.length < this._limit) {
      marked.push(self);
    } else {
      marked[this._limit - 1] = self;
    }

    return marked;
  }
}
