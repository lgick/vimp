import Publisher from '../../../lib/Publisher.js';
import { nickKey } from '../../../lib/validators.js';

// Singleton StatModel

let statModel;

export default class StatModel {
  // data — params схемы игры; deps — то, чего у модуля своего нет: топ,
  // привезённый хостом, свой gameId и свой ник (режим 'leaderboard')
  constructor(data, deps = {}) {
    // Синглтон переиспользуется, но НЕ замораживается: runModules зовётся на
    // каждый вход в матч (порт CONFIG_DATA), и вернуть старый экземпляр
    // как есть значило бы играть в snakes с параметрами tanks — режим,
    // период и число строк приезжают из схемы КОНКРЕТНОЙ игры
    if (statModel) {
      statModel._configure(data, deps);

      return statModel;
    }

    statModel = this;

    this.publisher = new Publisher();
    this._configure(data, deps);
  }

  // всё, что зависит от схемы игры и её сервисов: выделено из конструктора
  // ровно затем, чтобы переиспользованный синглтон обновлялся, а не врал
  _configure(data, deps = {}) {
    this._heads = data.heads;
    this._bodies = data.bodies;
    this._sortList = data.sortList;

    // snakes-v3 этап 4: режим 'leaderboard' — по Tab показывается не
    // таблица комнаты, а глобальный топ игры. Данные хоста в этом режиме не
    // рисуются (хост их и не шлёт), список приезжает портом ACCOLADES_DATA
    this._mode = data.mode ?? null;
    this._period = data.period ?? 'day';
    this._limit = data.limit ?? 10;

    // сервисы движка, а не сеть: топ уже привезён хостом (см.
    // client/lib/accolades.js), свой gameId знает клиентское ядро
    this._accolades = deps.accolades ?? null;
    this._localPlayer = deps.localPlayer ?? null;
    this._getNick = deps.getNick ?? (() => null);

    this._rows = [];
  }

  get isLeaderboard() {
    return this._mode === 'leaderboard';
  }

  // открывает статистику
  open() {
    this.publisher.emit('open');
    this.publisher.emit('mode', { name: 'stat', status: 'opened' });

    if (this.isLeaderboard) {
      // сети здесь нет вовсе: рисуется последняя рассылка хоста, а
      // следующая перерисует список сама (см. applyAccolades)
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

  // пришла новая рассылка мест и топа (порт ACCOLADES_DATA). Перерисовывать
  // список стоит только пока статистика открыта? — нет: сборка строк это
  // десяток объектов, а держать модель в актуальном виде дешевле, чем
  // объяснять, почему первый Tab показывает вчерашнее
  applyAccolades() {
    if (this.isLeaderboard) {
      this.refreshLeaderboard();
    }
  }

  // Пересобирает список из того, что привёз хост. Ни одного запроса: в
  // матче клиент с мастером не разговаривает (см. client/lib/accolades.js).
  // Пустой список до первой рассылки — нормальное состояние
  refreshLeaderboard() {
    if (!this._accolades) {
      return;
    }

    const board = this._accolades.boardOf(this._period);
    const rows = board.slice(0, this._limit).map(row => ({
      place: row.place,
      nick: row.nick,
      score: row.score,
      isSelf: false,
    }));

    this._rows = this._withSelf(rows);

    this.publisher.emit('leaderboard', this._rows);
  }

  // Своя строка: если игрок в топе — подсвечивается на своём месте, если
  // нет — заменяет последнюю (решение пользователя 7). Неранжированный за
  // период получает прочерк вместо места и свои очки (то есть 0).
  //
  // `rows` здесь ВСЕГДА чистый топ от хоста, а не результат прошлого прохода:
  // подставленная своя строка в него не попадает, и сравнение по нику
  // поэтому честное. Раньше список пересобирался поверх самого себя, и
  // синтетическая строка выдавала себя за строку из топа — своё место потом
  // не обновлялось никогда
  _withSelf(rows) {
    const nick = this._getNick();
    const lower = nick ? nickKey(nick) : null;
    const marked = rows.map(row => ({
      ...row,
      isSelf: lower !== null && nickKey(row.nick) === lower,
    }));

    if (marked.some(row => row.isSelf)) {
      return marked;
    }

    // в топе игрока нет — его собственное место знает только рассылка хоста
    const myId = this._localPlayer?.id ?? null;
    const mine = myId === null ? null : this._accolades.selfOf(myId, this._period);

    if (!mine || !nick) {
      return marked;
    }

    const self = {
      place: mine.place ?? null,
      nick,
      score: mine.score ?? 0,
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
