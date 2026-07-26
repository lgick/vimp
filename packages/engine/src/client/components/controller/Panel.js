// Singleton PanelCtrl

let panelCtrl;

export default class PanelCtrl {
  constructor(model, view) {
    if (panelCtrl) {
      return panelCtrl;
    }

    panelCtrl = this;

    this._model = model;
    this._view = view;

    this._vPublic = view.publisher;
  }

  // обновляет пользовательскую панель
  update(dataArr) {
    this._model.update(dataArr);
  }
}
