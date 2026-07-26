// Singleton controlsView

let controlsView;

export default class ControlsView {
  constructor(model) {
    if (controlsView) {
      return controlsView;
    }

    controlsView = this;

    this._model = model;

    this._cursorTimerId = null;
  }

  // показывает курсор и запускает таймер его скрытия
  resetCursorHideTimer() {
    // сбрасывает старый таймер
    clearTimeout(this._cursorTimerId);

    document.body.classList.remove('hide-cursor');

    // запускает новый таймер через 3 секунды бездействия мыши
    this._cursorTimerId = setTimeout(() => {
      document.body.classList.add('hide-cursor');
    }, 3000);
  }
}
