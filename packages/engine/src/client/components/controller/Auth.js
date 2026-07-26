// Singleton AuthCtrl

let authCtrl;

export default class AuthCtrl {
  constructor(model, view) {
    if (authCtrl) {
      return authCtrl;
    }

    authCtrl = this;

    this._model = model;
    this._view = view;

    this._vPublic = view.publisher;

    this._vPublic.on('input', 'update', this);
    this._vPublic.on('enter', 'send', this);
  }

  // инициализация
  init(data) {
    for (const item of data) {
      this._model.add(item);
    }
    this._view.showAuth();
  }

  // обновление
  update(data) {
    this._model.update(data);
  }

  // отправка данных
  send() {
    this._model.send();
  }

  // разбор ответа сервера
  parseRes(err) {
    this._model.parseRes(err);
  }
}
