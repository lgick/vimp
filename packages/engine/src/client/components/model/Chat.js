import Publisher from '../../../lib/Publisher.js';

// Singleton ChatModel

let chatModel;

export default class ChatModel {
  constructor(data) {
    if (chatModel) {
      return chatModel;
    }

    chatModel = this;

    this._listLimit = data.listLimit || 5;
    this._lineTime = data.lineTime || 15000;
    this._cacheMin = data.cacheMin || 200;
    this._cacheMax = data.cacheMax || 300;
    this._messages = data.messages || {};
    this._defaults = data.defaultMessages || {};

    this._formatMessage = data.formatMessage;
    this._sanitizeMessage = data.sanitizeMessage;

    this._cache = []; // хранилище сообщений
    this._list = []; // активный чат-лист
    this._counter = 0; // id для сообщения чат-листа

    this.publisher = new Publisher();
  }

  // открывает cmd
  open() {
    this.publisher.emit('open');
    this.publisher.emit('mode', { name: 'chat', status: 'opened' });
  }

  // закрывает cmd
  close(success) {
    this.publisher.emit('close', success ? true : false);
    this.publisher.emit('mode', { name: 'chat', status: 'closed' });
  }

  // отправляет сообщение на сервер
  sendMessage(message) {
    message = this._sanitizeMessage(message);

    if (message) {
      this.publisher.emit('socket', message);
    }
  }

  // текст шаблона: строка игры важнее умолчания движка; '' — игра
  // заглушила сообщение; null/нет индекса — английское умолчание
  _template(group, index) {
    const own = this._messages[group]?.[index];

    if (typeof own === 'string') {
      return own === '' ? null : own;
    }

    const fallback = this._defaults[group]?.[index];

    return typeof fallback === 'string' && fallback !== '' ? fallback : null;
  }

  // обновляет чат-лист. Данные могут быть 2-х видов:
  // - в виде строки '<группа шаблонов>:<номер шаблона>:<параметры>'
  // - в виде массива [<текст сообщения>,<имя автора>,<тип для класса>,
  //   <цвет ника>?]
  updateChat(arr) {
    // если данные - строка
    if (typeof arr === 'string') {
      arr = arr.split(':');

      const template = this._template(arr[0], arr[1]);

      // если сообщений не найдено
      if (template === null) {
        return;
      }

      let message = template;
      const params = arr[2];

      // если есть параметры
      if (params) {
        message = this._formatMessage(message, params.split(','));
      }

      arr = [message];
    }

    // если количество сообщений в хранилище достигло предела -
    // удалить лишние
    if (this._cache.length === this._cacheMax) {
      this._cache.splice(0, this._cache.length - this._cacheMin);
    }

    // добавить объект сообщения в хранилище
    this._cache.push(arr);

    // если количество выделенных линий исчерпано -
    // удалить линию принудительно
    if (this._list.length === this._listLimit) {
      this.removeFromList(true);
    }

    this.publisher.emit('newLine', {
      id: this._counter,
      message: arr,
    });

    this.publisher.emit('newTimer', {
      id: this._counter,
      time: this._lineTime,
    });

    this._counter += 1;
  }

  // добавляет объект в чат-лист
  addToList(data) {
    this._list.push(data);
  }

  // удаляет объект из чат-листа
  removeFromList(sync) {
    const data = this._list.shift();

    this.publisher.emit('oldLine', data.messageId);

    if (sync) {
      this.publisher.emit('oldTimer', data.timerId);
    }
  }
}
