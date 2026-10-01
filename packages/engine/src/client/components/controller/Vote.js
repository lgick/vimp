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
      // false — ждёт закрытия открытого голосования движка
      if (this._model.createWithTemplate(data) !== false) {
        this._model.open();
      }
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

  // голосование движка (host-migration этап 10: «Change host?» от мастера)
  openEngineVote(vote) {
    this._model.createEngineVote(vote);
  }

  closeEngineVote(name) {
    this._model.closeEngineVote(name);
  }

  // голосования хоста не пережили переподключение
  removeHostVotes() {
    this._model.removeHostVotes();
  }
}
