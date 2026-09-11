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
  //
  // Единицы — `renderer.screen`, а не пиксели буфера полотна: трансформ
  // сцены живёт именно в них, а `canvas.width` умножен на `resolution`
  // рендерера. Сегодня она равна единице, и числа совпадают, но стоит
  // включить resolution/autoDensity — и указатель промахнётся ровно во
  // столько же раз (та же причина, что у updateCoords ниже)
  toWorld(id, clientX, clientY) {
    const app = this._apps[id];

    if (!app) {
      return null;
    }

    const rect = app.canvas.getBoundingClientRect();

    if (!rect.width || !rect.height) {
      return null;
    }

    const screen = app.renderer.screen;
    const px = ((clientX - rect.left) * screen.width) / rect.width;
    const py = ((clientY - rect.top) * screen.height) / rect.height;
    const { position, scale } = app.stage;

    if (!scale.x || !scale.y) {
      return null;
    }

    return {
      x: (px - position.x) / scale.x,
      y: (py - position.y) / scale.y,
    };
  }

  // Вычисляет координаты для отображения и двигает сцену.
  //
  // Размер берётся у `renderer.screen`, а не у `canvas`: сцену двигают в
  // ЕЁ единицах, а буфер полотна умножен на `resolution` рендерера.
  // Совпадают они только пока resolution равен единице, и промах здесь
  // тихий — он не ломает картинку, а уводит центр камеры, который по
  // трансформу сцены восстанавливают части игры (проекция высоты 2.5D в
  // `vimp-tanks`).
  //
  // Отрисовки здесь НЕТ. Полотно рисует тикер — `TickerPlugin` держит
  // `app.render` на `Ticker.shared` с приоритетом LOW, то есть после
  // `renderTick` движка, когда кадр применён целиком. Собственный
  // `app.render()` означал бы отрисовку на КАЖДЫЙ кадр камеры (за тик их
  // два и больше: сперва камера дискретного кадра, следом предсказанная),
  // то есть два-три полных обхода сцены на один видимый кадр — и, что
  // хуже, промежуточные состояния кадра, на которых части считают своё
  // `onRender`.
  updateCoords({ id, coords, scale }) {
    const app = this._apps[id];
    const { width, height } = app.renderer.screen;
    const x = width / 2 - coords.x * scale;
    const y = height / 2 - coords.y * scale;

    app.stage.position.set(x, y);
    app.stage.scale.set(scale);
  }
}
