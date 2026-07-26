// Singleton ControlsCtrl

let controlsCtrl;

export default class ControlsCtrl {
  constructor(model, view) {
    if (controlsCtrl) {
      return controlsCtrl;
    }

    controlsCtrl = this;

    this._model = model;
    this._view = view;
  }

  // добавляет клавишу
  add(event) {
    this._model.addKey(event);
  }

  // удаляет клавишу
  remove(event) {
    this._model.removeKey(event);
  }

  // задает текущий режим
  switchMode(data) {
    this._model.setMode(data.name, data.status);
  }

  // меняет набор клавиш
  changeKeySet(keySet) {
    this._model.changeKeySet(keySet);
  }

  // разблокирует возможность нажатия клавиш
  enableKeys() {
    this._model.setKeysEnabled(true);
  }

  // блокирует возможность нажатия клавиш
  disableKeys() {
    this._model.setKeysEnabled(false);
  }

  // скрывает курсор
  resetCursorHideTimer() {
    this._view.resetCursorHideTimer();
  }
}
