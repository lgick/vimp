import Publisher from '../../../lib/Publisher.js';

// Singleton RoomMenuModel
//
// Меню комнаты внутри матча (host-migration, этапы 3 и 8d). Ссылка на
// текущую комнату — признак «вкладка в комнате». Пункты:
// - «Leave server» — у всех;
// - «Hand over host» — только у текущего хоста, когда в комнате есть другие
//   люди и мастер назначил бету (иначе передавать некому).
// Пока идёт передача, пункты заблокированы, на их месте статус. Только
// лобби-режим: в solo/dedicated ссылки на комнату нет

// handoff: null | 'pending' | 'slow' | 'failed'
const STATUS_TEXT = {
  pending: 'Handing over…',
  slow: 'Slow connection…',
  failed: 'Host handover failed',
};

let roomMenuModel;

export default class RoomMenuModel {
  constructor() {
    if (roomMenuModel) {
      return roomMenuModel;
    }

    roomMenuModel = this;

    this._link = null;
    this._open = false;
    this._role = null; // null | 'host' | 'guest'
    this._othersPresent = false;
    this._hasSuccessor = false;
    this._handoff = null;
    this.publisher = new Publisher();
  }

  // абсолютная ссылка на комнату; null — вкладка не в комнате, меню скрыто
  setLink(link) {
    this._link = link || null;

    if (!this._link) {
      this.setOpen(false);
    }

    this._emitState();
  }

  getLink() {
    return this._link;
  }

  /**
   * Роль вкладки в комнате.
   * @param {Object} state
   * @param {'host'|'guest'|null} state.role
   * @param {boolean} [state.othersPresent] - в комнате есть другие люди.
   * @param {boolean} [state.hasSuccessor] - мастер назначил бету.
   */
  setRole({ role, othersPresent = false, hasSuccessor = false }) {
    this._role = role ?? null;
    this._othersPresent = othersPresent === true;
    this._hasSuccessor = hasSuccessor === true;
    this._emitState();
  }

  // ход плановой передачи: null | 'pending' | 'slow' | 'failed'
  setHandoff(status) {
    this._handoff = status ?? null;
    this._emitState();
  }

  setOpen(open) {
    const next = Boolean(open) && this._link !== null;

    if (next === this._open) {
      return;
    }

    this._open = next;
    this.publisher.emit('open', next);

    // ошибка передачи показана — закрытое меню её забывает
    if (!next && this._handoff === 'failed') {
      this.setHandoff(null);
    }
  }

  toggle() {
    this.setOpen(!this._open);
  }

  /**
   * Что показывать.
   * @returns {{ visible: boolean, leave: Object, handover: Object,
   *   status: string|null }} leave/handover — { visible, disabled }.
   */
  getState() {
    const inRoom = this._link !== null;
    const busy = this._handoff === 'pending' || this._handoff === 'slow';

    return {
      visible: inRoom,
      leave: { visible: inRoom, disabled: busy },
      handover: {
        visible:
          inRoom &&
          this._role === 'host' &&
          this._othersPresent &&
          this._hasSuccessor,
        disabled: busy,
      },
      status: STATUS_TEXT[this._handoff] ?? null,
    };
  }

  _emitState() {
    this.publisher.emit('state', this.getState());
  }
}
