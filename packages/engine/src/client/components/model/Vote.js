import Publisher from '../../../lib/Publisher.js';

// Singleton VoteModel

// имя с '@' — голосование движка (host-migration этап 10: '@changeHost'):
// его ведёт мастер, а не хост, и игра таких имён не объявляет
const isEngineVote = name => typeof name === 'string' && name.startsWith('@');

let voteModel;

export default class VoteModel {
  constructor(data) {
    if (voteModel) {
      return voteModel;
    }

    voteModel = this;

    this._formatMessage = data.formatMessage;
    this._now = data.now ?? (() => Date.now());

    // игра может не объявлять голосований вовсе (noSpectators): меню по 'm'
    // тогда пустое, а не падение на длине undefined
    this._menu = data.menu || []; // меню
    this._templates = data.templates || {}; // шаблоны голосований

    this._type = ''; // тип ('menu', 'vote')
    this._waitingValues = false; // ожидания значений

    this._time = data.time || 10000; // время жизни голосования
    this._timerId = null; // id таймера

    this._timeOff = false; // флаг отключения времени жизни голосования

    this._voteName = ''; // название голосования
    this._deadline = null; // конец голосования движка (окно — на остаток)
    this._showing = false; // окно (голосование или меню) открыто

    // голосования, ждущие закрытия открытого окна: голосование движка не
    // затирает чужое и не затирается им (этап 10)
    this._queue = [];

    this._title = null; // заголовок голосования
    this._values = []; // все значения голосования

    this._back = false; // флаг back
    this._more = false; // флаг more
    this._currentPage = 0; // текущая страница вывода значений
    this._currentValues = []; // значения текущей страницы

    this.publisher = new Publisher();
  }

  // открывает голосование
  open() {
    this.publisher.emit('mode', { name: 'vote', status: 'opened' });
  }

  // голосование хоста по шаблону; false — встало в очередь за открытым
  // голосованием движка
  createWithTemplate({ name, params, values }) {
    if (
      this._showing &&
      this._type === 'vote' &&
      isEngineVote(this._voteName)
    ) {
      this._queue.push({ template: { name, params, values } });
      return false;
    }

    const templateArr = this._templates[name];

    if (templateArr) {
      let title = templateArr[0];
      values = values || templateArr[1];
      const timeOff = templateArr[2] ? true : false;

      if (params) {
        title = this._formatMessage(title, params);
      }

      this.createVote(name, title, values, timeOff);
    }

    return true;
  }

  /**
   * Голосование движка (имя с '@'): окно живёт до deadline; открыто другое
   * окно — ждёт в очереди.
   * @param {Object} vote - { name, title, values, deadline }.
   * @returns {boolean} окно открыто сразу.
   */
  createEngineVote(vote) {
    if (this._showing || this._waitingValues) {
      this._queue.push({ engine: { ...vote } });
      return false;
    }

    this._startEngineVote(vote);

    return true;
  }

  /**
   * Голосование движка завершилось (итог от мастера): окно закрывается или
   * снимается из очереди.
   * @param {string} name
   */
  closeEngineVote(name) {
    this._queue = this._queue.filter(item => item.engine?.name !== name);

    if (this._showing && this._type === 'vote' && this._voteName === name) {
      this.complete();
    }
  }

  // голосования хоста не пережили переподключение: открытое закрывается,
  // ждущие отбрасываются; голосование движка (его ведёт мастер) остаётся
  removeHostVotes() {
    this._queue = this._queue.filter(item => item.engine);

    if (!(this._type === 'vote' && isEngineVote(this._voteName))) {
      this.complete();
    }
  }

  _startEngineVote({ name, title, values, deadline }) {
    this.createVote(name, title, values, false, deadline);
    this.open();
  }

  // создает голосование; deadline — только у голосований движка
  createVote(name, title, values, timeOff, deadline = null) {
    if (this._waitingValues) {
      return;
    }

    this._deadline = deadline;

    this._type = 'vote';
    this._back = false;
    this._more = false;
    this._currentPage = 0;

    this._voteName = name;
    this._timeOff = timeOff;
    this._title = title;

    if (typeof values === 'string') {
      this._waitingValues = true;
      this.publisher.emit('socket', values);
    } else {
      this._values = values;
      this.show();
    }
  }

  // создает меню
  createMenu() {
    if (this._waitingValues) {
      return;
    }

    // меню открывается поверх голосования движка — оно вернётся следом
    if (
      this._showing &&
      this._type === 'vote' &&
      isEngineVote(this._voteName)
    ) {
      this._queue.unshift({
        engine: {
          name: this._voteName,
          title: this._title,
          values: this._values,
          deadline: this._deadline,
        },
      });
    }

    this._timeOff = false;
    this._deadline = null;

    this._type = 'menu';
    this._back = false;
    this._more = false;
    this._currentPage = 0;

    this._title = 'Menu';
    this._values = [];
    this._voteName = '';

    for (let i = 0, len = this._menu.length; i < len; i += 1) {
      this._values.push(this._menu[i][1][0]);
    }

    this.show();
  }

  // обновляет массив значений
  updateValues(values) {
    if (this._waitingValues) {
      this._values = values;
      this._waitingValues = false;
      this.show();
    }
  }

  // обновляет голосование
  update(keyCode) {
    let number;

    if (this._waitingValues) {
      return;
    }

    // если keyCode это число от 0 до 9
    if (48 <= keyCode && keyCode <= 57) {
      number = String.fromCharCode(keyCode);
      number = parseInt(number, 10);

      // exit
      if (number === 0) {
        this.complete();
        // back
      } else if (number === 8) {
        if (this._back) {
          this._currentPage -= 1;
          this.show();
        }
        // more
      } else if (number === 9) {
        if (this._more) {
          this._currentPage += 1;
          this.show();
        }

        // иначе, число от 1 до 7
      } else {
        number = number - 1;

        // если тип данных для голосования это массив
        if (this._type === 'menu') {
          const data = this._menu[number];

          // если число есть в массиве значений
          if (data) {
            const [name, [title, values, timeOff]] = data;

            this.createVote(name, title, values, timeOff);
          }

          // иначе, если тип данных для голосования это объект
        } else if (this._type === 'vote') {
          const value = this._currentValues[number];

          if (value) {
            const name = this._voteName;

            // Своё голосование закрывается ДО отправки ответа. Транспорт
            // бывает синхронным (solo/standalone — хост живёт в том же
            // потоке), и тогда ответ хоста приходит прямо внутри
            // emit('socket'): смена карты сразу присылает новое
            // голосование (initialVote, «выбери команду»), оно ставит
            // _waitingValues и запрашивает значения. Прежний порядок
            // «отправить, потом complete()» сбрасывал этот флаг уже
            // ПОСЛЕ создания нового голосования, и пришедшие значения
            // отбрасывались в updateValues — диалог не открывался вовсе
            this.complete();
            this.publisher.emit('socket', [name, value]);
          }
        }
      }
    }
  }

  // отображает голосование
  show() {
    const begin = this._currentPage * 7;
    const max = begin + 7;
    let currentValues = [];

    this._currentValues = this._values.slice(begin, max);
    this._back = this._currentPage > 0 ? true : false;
    this._more = this._values.length > max ? true : false;

    if (this._type === 'vote') {
      for (let i = 0, len = this._currentValues.length; i < len; i += 1) {
        currentValues.push(this._currentValues[i]);
      }
    } else {
      currentValues = this._currentValues;
    }

    this._showing = true;
    this.publisher.emit('clear', this._timerId);

    this.publisher.emit('vote', {
      title: this._title,
      list: currentValues,
      back: this._back,
      more: this._more,
      time: this._timeOff === true ? null : this._windowTime(),
    });
  }

  // время окна: у голосования движка — остаток до его конца
  _windowTime() {
    return this._deadline === null
      ? this._time
      : Math.max(0, this._deadline - this._now());
  }

  // завершает голосование; следом открывается ждущее в очереди
  complete() {
    this._waitingValues = false;
    this._showing = false;
    this._deadline = null;
    this.publisher.emit('clear', this._timerId);
    this.publisher.emit('mode', { name: 'vote', status: 'closed' });
    this._openNext();
  }

  // первое ждущее голосование; голосование движка, чьё время вышло, —
  // пропускается
  _openNext() {
    while (this._queue.length > 0) {
      const { engine, template } = this._queue.shift();

      if (engine) {
        if (engine.deadline - this._now() > 0) {
          this._startEngineVote(engine);
          return;
        }
      } else {
        this.createWithTemplate(template);
        this.open();
        return;
      }
    }
  }

  // добавляет id таймера голосования
  assignTimer(timerId) {
    this._timerId = timerId || null;
  }
}
