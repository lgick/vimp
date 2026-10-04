// Отчёт здоровья хоста мастеру (host-migration этап 9c): из сэмплов health
// Worker'а (раз в ~1 с) не чаще раза в intervalMs уходит host_health с
// последним сэмплом. Мастер по нему решает, не отдать ли роль бете из-за
// сетевого лага. Пока матч заморожен, Worker сэмплов не шлёт — отчётов нет,
// и мастер видит разрыв «непрерывности» лага.
//
// Без DOM: отправку, комнату и часы инъектирует владелец
// (client/session/HostRole.js).

export default class HostHealthReporter {
  /**
   * @param {Object} options
   * @param {Function} options.send - ({ roomId, epoch, tickRate,
   *   peerRttMedian, peerCount }) отправка мастеру.
   * @param {Function} options.getRoom - () → { roomId, epoch } | null.
   * @param {number} options.intervalMs
   * @param {Function} [options.now] - монотонные часы, мс.
   */
  constructor({ send, getRoom, intervalMs, now = () => performance.now() }) {
    this._send = send;
    this._getRoom = getRoom;
    this._intervalMs = intervalMs;
    this._now = now;
    this._lastSentAt = null;
  }

  /**
   * Сэмпл health Worker'а.
   * @param {Object} health - { tickRate, peerRttMedian, peerCount, … }.
   * @returns {boolean} отчёт отправлен.
   */
  add(health) {
    const room = this._getRoom();
    const now = this._now();

    if (
      !room ||
      (this._lastSentAt !== null && now - this._lastSentAt < this._intervalMs)
    ) {
      return false;
    }

    this._lastSentAt = now;
    this._send({
      roomId: room.roomId,
      epoch: room.epoch,
      tickRate: health.tickRate ?? null,
      peerRttMedian: health.peerRttMedian ?? null,
      peerCount: health.peerCount ?? 0,
    });

    return true;
  }
}
