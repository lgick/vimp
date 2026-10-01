import Publisher from '../../../lib/Publisher.js';

// Singleton RoomMenuView

let roomMenuView;

export default class RoomMenuView {
  // config — lobbyConfig.roomMenu: { elems: { panelId, menuId, toggleId,
  // listId, leaveId, handoverId, statusId } }
  constructor(model, config) {
    if (roomMenuView) {
      return roomMenuView;
    }

    roomMenuView = this;

    const { elems } = config;

    this._menu = document.getElementById(elems.menuId);
    this._list = document.getElementById(elems.listId);
    this._leave = document.getElementById(elems.leaveId);
    this._handover = document.getElementById(elems.handoverId);
    this._status = document.getElementById(elems.statusId);
    this._panel = document.getElementById(elems.panelId);
    this._home = this._menu.parentElement;

    this.publisher = new Publisher();

    document
      .getElementById(elems.toggleId)
      .addEventListener('click', () => this.publisher.emit('toggle'));
    this._leave.addEventListener('click', () => this.publisher.emit('leave'));
    this._handover.addEventListener('click', () =>
      this.publisher.emit('handover'),
    );

    this._mPublic = model.publisher;
    this._mPublic.on('state', 'showState', this);
    this._mPublic.on('open', 'showOpen', this);
  }

  showState({ visible, leave, handover, status }) {
    this._menu.style.display = visible ? 'block' : 'none';
    showItem(this._leave, leave);
    showItem(this._handover, handover);
    this._status.textContent = status ?? '';
    this._status.style.display = status ? 'block' : 'none';
  }

  // меню — часть панели (справа от таблицы), но разметка отдельная: каркас
  // панели общий со standalone SDK, где меню комнаты нет. Игра без панели в
  // initIdList держит её скрытой — тогда меню остаётся кнопкой в углу
  placeInPanel(inPanel) {
    const parent = inPanel && this._panel ? this._panel : this._home;

    if (this._menu.parentElement !== parent) {
      parent.appendChild(this._menu);
    }
  }

  showOpen(open) {
    this._list.style.display = open ? 'block' : 'none';
  }
}

function showItem(elem, { visible, disabled }) {
  elem.style.display = visible ? 'block' : 'none';
  elem.disabled = disabled;
}
