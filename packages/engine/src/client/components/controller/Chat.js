// Singleton ChatCtrl

let chatCtrl;

export default class ChatCtrl {
  constructor(model, view) {
    if (chatCtrl) {
      return chatCtrl;
    }

    chatCtrl = this;

    this._model = model;
    this._view = view;

    this._vPublic = view.publisher;

    this._vPublic.on('newTimer', 'createTimer', this);
    this._vPublic.on('oldTimer', 'removeTimer', this);
    this._vPublic.on('message', 'sendMessage', this);
  }

  // открывает cmd
  open() {
    this._model.open();
  }

  // обновление состояния cmd по команде
  updateCmd(cmd) {
    if (cmd === 'enter') {
      this._model.close(true);
    } else if (cmd === 'escape') {
      this._model.close(false);
    }
  }

  // отправляет сообщение
  sendMessage(message) {
    this._model.sendMessage(message);
  }

  // добавляет сообщения
  add(message) {
    this._model.updateChat(message);
  }

  // добавляет таймер
  createTimer(data) {
    this._model.addToList(data);
  }

  // удаляет таймер
  removeTimer() {
    this._model.removeFromList();
  }
}
