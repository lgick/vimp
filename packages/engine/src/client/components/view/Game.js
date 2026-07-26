import Publisher from '../../../lib/Publisher.js';

// GameView

export default class GameView {
  constructor(model, app) {
    this._app = app;

    this._model = model;

    this.publisher = new Publisher();

    // подписка на события модели
    this._mPublic = this._model.publisher;

    this._mPublic.on('create', 'add', this);
    this._mPublic.on('createEffect', 'addEffect', this);
    this._mPublic.on('remove', 'remove', this);
  }

  // создает экземпляр на полотне
  add(instance) {
    this._app.stage.addChild(instance);

    this._app.stage.sortChildren((a, b) => {
      if (a.layer < b.layer) {
        return -1;
      }

      if (a.layer > b.layer) {
        return 1;
      }

      return 0;
    });
  }

  // создаёт эффект и запускает его
  addEffect(instance) {
    this.add(instance);
    instance.run();
  }

  // удаляет экземпляр с полотна
  remove(instance) {
    instance.destroy();
  }
}
