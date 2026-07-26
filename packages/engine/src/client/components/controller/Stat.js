// Singleton StatCtrl

let statCtrl;

export default class StatCtrl {
  constructor(model, view) {
    if (statCtrl) {
      return statCtrl;
    }

    statCtrl = this;

    this._model = model;
    this._view = view;

    this._vPublic = view.publisher;
  }

  // открывает статистику
  open() {
    this._model.open();
  }

  // закрывает статистику
  close() {
    this._model.close();
  }

  // обновляет
  update(data) {
    this._model.update(data);
  }
}
