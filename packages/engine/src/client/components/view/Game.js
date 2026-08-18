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
    // порядок отрисовки задаёт только zIndex парта. sortChildren() в
    // PixiJS 8 компаратор не принимает (сортирует по zIndex) и выходит на
    // первой строке, пока не поднят sortDirty; сам Pixi поднимает его лишь
    // при записи zIndex уже добавленному в сцену объекту, а парты ставят
    // zIndex в конструкторе — без sortableChildren сортировки не будет
    // вовсе, и слои лягут в порядке добавления
    this._app.stage.sortableChildren = true;
    this._app.stage.addChild(instance);
    this._app.stage.sortChildren();
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
