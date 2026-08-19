import Publisher from '../../../lib/Publisher.js';

// Singleton CanvasManagerView

let canvasManagerView;

export default class CanvasManagerView {
  constructor(model, apps) {
    if (canvasManagerView) {
      return canvasManagerView;
    }

    canvasManagerView = this;

    this._model = model;
    this._apps = apps;

    this.publisher = new Publisher();

    this._mPublic = this._model.publisher;

    this._mPublic.on('resize', 'resize', this);
    this._mPublic.on('updateCoords', 'updateCoords', this);
  }

  // изменяет размеры canvas
  resize({ id, sizes }) {
    const app = this._apps[id];

    app.renderer.resize(sizes.width, sizes.height);
  }

  // переводит экранную точку (clientX/clientY указателя) в мировую
  //
  // Считается по фактическому состоянию сцены, а не по копии камеры: stage
  // уже несёт и смещение, и масштаб последнего updateCoords, а
  // getBoundingClientRect закрывает случай, когда CSS растянул полотно
  // не один к одному с его буфером.
  toWorld(id, clientX, clientY) {
    const app = this._apps[id];

    if (!app) {
      return null;
    }

    const rect = app.canvas.getBoundingClientRect();

    if (!rect.width || !rect.height) {
      return null;
    }

    const px = ((clientX - rect.left) * app.canvas.width) / rect.width;
    const py = ((clientY - rect.top) * app.canvas.height) / rect.height;
    const { position, scale } = app.stage;

    if (!scale.x || !scale.y) {
      return null;
    }

    return {
      x: (px - position.x) / scale.x,
      y: (py - position.y) / scale.y,
    };
  }

  // вычисляет координаты для отображения и обновляет полотно
  updateCoords({ id, coords, scale }) {
    const app = this._apps[id];
    const { width, height } = app.canvas;
    const x = width / 2 - coords.x * scale;
    const y = height / 2 - coords.y * scale;

    app.stage.position.set(x, y);
    app.stage.scale.set(scale);
    app.render();
  }
}
