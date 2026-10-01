// Singleton RoomMenuCtrl

let roomMenuCtrl;

export default class RoomMenuCtrl {
  // actions — { onLeave, onHandover }: действия пунктов (client/main.js)
  constructor(model, view, actions = {}) {
    if (roomMenuCtrl) {
      return roomMenuCtrl;
    }

    roomMenuCtrl = this;

    this._model = model;
    this._view = view;

    this._vPublic = view.publisher;
    this._vPublic.on('toggle', () => model.toggle());
    // меню остаётся открытым: на месте пунктов — статус передачи
    this._vPublic.on('leave', () => actions.onLeave?.());
    this._vPublic.on('handover', () => actions.onHandover?.());
  }

  // абсолютная ссылка на комнату, в которой вкладка; null — скрыть меню
  setLink(link) {
    this._model.setLink(link);
  }

  // { role, othersPresent, hasSuccessor } — см. RoomMenuModel.setRole
  setRole(state) {
    this._model.setRole(state);
  }

  // true — кнопка внутри панели (игра её показывает), false — в углу
  setInPanel(inPanel) {
    this._view.placeInPanel(inPanel);
  }

  // null | 'pending' | 'slow' | 'failed'
  setHandoff(status) {
    this._model.setHandoff(status);
  }
}
