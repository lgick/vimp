import Publisher from '../../../lib/Publisher.js';

// Singleton ChatView

let chatView;

export default class ChatView {
  constructor(model, elems) {
    if (chatView) {
      return chatView;
    }

    chatView = this;

    this._chat = document.getElementById(elems.chatBox);
    this._cmd = document.getElementById(elems.cmd);

    this.publisher = new Publisher();

    this._mPublic = model.publisher;

    this._mPublic.on('open', 'openCmd', this);
    this._mPublic.on('close', 'closeCmd', this);
    this._mPublic.on('newLine', 'createLine', this);
    this._mPublic.on('oldLine', 'removeLine', this);
    this._mPublic.on('newTimer', 'createTimer', this);
    this._mPublic.on('oldTimer', 'removeTimer', this);
  }

  // открывает командную строку
  openCmd() {
    this._cmd.value = '';
    this._cmd.style.display = 'block';
    this._cmd.focus();
  }

  // закрывает командную строку
  closeCmd(success) {
    if (success) {
      this.publisher.emit('message', this._cmd.value);
    }

    this._cmd.style.display = 'none';
    this._cmd.value = '';
  }

  // добавляет сообщение в чат-лист
  createLine(data) {
    const line = document.createElement('div');
    const id = data.id;
    const message = data.message;
    const text = message[0];
    const name = message[1] || 'System';
    const type = typeof message[2] === 'number' ? message[2] : '';

    line.id = `line_${id}`;
    line.className = `line${type}`;
    line.setAttribute('data-name', `${name}: `);
    line.textContent = text;

    this._chat.appendChild(line);
  }

  // удаляет сообщение в чат-листе
  removeLine(id) {
    const line = document.getElementById(`line_${id}`);

    line.style.opacity = 0;

    setTimeout(() => {
      this._chat.removeChild(line);
    }, 2000);
  }

  // устанавливает таймер
  createTimer(data) {
    const messageId = data.id;
    const time = data.time;
    const timerId = setTimeout(() => {
      this.publisher.emit('oldTimer');
    }, time);

    this.publisher.emit('newTimer', { messageId, timerId });
  }

  // снимает таймер
  removeTimer(timer) {
    clearTimeout(timer);
  }
}
