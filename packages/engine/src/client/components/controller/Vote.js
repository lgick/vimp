// Singleton VoteCtrl

let voteCtrl;

export default class VoteCtrl {
  constructor(model, view) {
    if (voteCtrl) {
      return voteCtrl;
    }

    voteCtrl = this;

    this._model = model;
    this._view = view;

    this._vPublic = view.publisher;

    this._vPublic.on('timer', 'assignTimer', this);
    this._vPublic.on('clear', 'removeVote', this);
  }

  // включить
  // data может быть:
  // {name: 'templateName', params: ['p1',..], values: ['v1',..] || 'values'}
  // ['val1', 'val2'];
  open(data) {
    // если данные - массив (values для созданного голосования)
    if (Array.isArray(data)) {
      this._model.updateValues(data);
      // если данные - объект (данные для создания голосования)
    } else if (typeof data === 'object' && data !== null) {
      this._model.createWithTemplate(data);
      this._model.open();
      // иначе открыть меню
    } else {
      this._model.createMenu();
      this._model.open();
    }
  }

  // назначает ключ
  assignKey(keyCode) {
    this._model.update(keyCode);
  }

  // добавляет таймер
  assignTimer(timerId) {
    this._model.assignTimer(timerId);
  }

  // удаляет голосование
  removeVote() {
    this._model.complete();
  }
}
