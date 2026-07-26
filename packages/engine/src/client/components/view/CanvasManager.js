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
