// Отчёт хоста room_peers мастеру (host-migration-review этап 4): memberId
// гостей, у которых открыты оба канала к хосту. Мастер по нему считает
// игроков в лобби и кандидатов в беты — сигнальная сессия без WebRTC-пира
// (фантом) не раздувает счётчик и не становится преемником. Состав пиров
// меняется пачками (вход, реконнект) — отправка отложена на debounceMs; раз
// в intervalMs отчёт повторяется (мастер мог перезапуститься).
//
// Без DOM: отправку, комнату, состав и таймеры инъектирует владелец
// (client/main.js).

export default class RoomPeersReporter {
  /**
   * @param {Object} options
   * @param {Function} options.send - ({ roomId, epoch, memberIds }).
   * @param {Function} options.getRoom - () → { roomId, epoch } | null.
   * @param {Function} options.getMemberIds - () → string[].
   * @param {number} options.intervalMs
   * @param {number} [options.debounceMs]
   * @param {Object} [options.timers] - { setTimeout, clearTimeout,
   *   setInterval, clearInterval } (тесты).
   */
  constructor({
    send,
    getRoom,
    getMemberIds,
    intervalMs,
    debounceMs = 500,
    timers = globalThis,
  }) {
    this._send = send;
    this._getRoom = getRoom;
    this._getMemberIds = getMemberIds;
    this._debounceMs = debounceMs;
    this._timers = timers;
    this._debounceTimer = null;
    this._destroyed = false;
    this._interval = timers.setInterval(() => this.refresh(), intervalMs);
  }

  // состав пиров изменился — отчёт через debounceMs
  notify() {
    if (this._destroyed || this._debounceTimer !== null) {
      return;
    }

    this._debounceTimer = this._timers.setTimeout(() => {
      this._debounceTimer = null;
      this.refresh();
    }, this._debounceMs);
  }

  // отчёт сейчас (хост только что зарегистрирован)
  refresh() {
    this._cancelDebounce();

    const room = this._getRoom();

    if (this._destroyed || !room) {
      return;
    }

    this._send({
      roomId: room.roomId,
      epoch: room.epoch,
      memberIds: this._getMemberIds(),
    });
  }

  destroy() {
    this._destroyed = true;
    this._cancelDebounce();
    this._timers.clearInterval(this._interval);
  }

  _cancelDebounce() {
    if (this._debounceTimer !== null) {
      this._timers.clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }
}
