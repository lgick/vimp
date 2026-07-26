import Publisher from '../../../lib/Publisher.js';

// Singleton VoteModel

let voteModel;

export default class VoteModel {
  constructor(data) {
    if (voteModel) {
      return voteModel;
    }

    voteModel = this;

    this._formatMessage = data.formatMessage;

    this._menu = data.menu; // меню
    this._templates = data.templates; // шаблоны голосований

    this._type = ''; // тип ('menu', 'vote')
    this._waitingValues = false; // ожидания значений

    this._time = data.time || 10000; // время жизни голосования
    this._timerId = null; // id таймера

    this._timeOff = false; // флаг отключения времени жизни голосования

    this._voteName = ''; // название голосования

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

  createWithTemplate({ name, params, values }) {
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
  }

  // создает голосование
  createVote(name, title, values, timeOff) {
    if (this._waitingValues) {
      return;
    }

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

    this._timeOff = false;

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
            this.publisher.emit('socket', [this._voteName, value]);
            this.complete();
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

    this.publisher.emit('clear', this._timerId);

    this.publisher.emit('vote', {
      title: this._title,
      list: currentValues,
      back: this._back,
      more: this._more,
      time: this._timeOff === true ? null : this._time,
    });
  }

  // завершает голосование
  complete() {
    this._waitingValues = false;
    this.publisher.emit('clear', this._timerId);
    this.publisher.emit('mode', { name: 'vote', status: 'closed' });
  }

  // добавляет id таймера голосования
  assignTimer(timerId) {
    this._timerId = timerId || null;
  }
}
