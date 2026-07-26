// Singleton CanvasManagerCtrl

let canvasManagerCtrl;

export default class CanvasManagerCtrl {
  constructor(model, view) {
    if (canvasManagerCtrl) {
      return canvasManagerCtrl;
    }

    canvasManagerCtrl = this;

    this._model = model;
    this._view = view;
  }

  // обновляет представление относительно пользователя
  updateCoords([x, y, cameraReset, shakeData]) {
    this._model.updateCoords(x, y, cameraReset, shakeData);
  }

  // обновляет размеры
  resize(data) {
    this._model.resize(data);
  }
}
