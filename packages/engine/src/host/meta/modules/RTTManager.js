/**
 * @class RTTManager
 * @description Управляет расчетом Round Trip Time (RTT) для пользователя,
 * отслеживает пропущенные пинги и инициирует кик игроков за высокую задержку
 * или отсутствие ответов.
 */
export default class RTTManager {
  /**
   * @param {object} params - Параметры конфигурации RTT.
   * @param {number} params.maxMissedPings - Максимальное количество
   * пропущенных пингов перед киком.
   * @param {number} params.maxLatency - Максимально допустимая
   * задержка RTT (в мс) перед киком.
   * @param {object} callbacks - Колбэки для взаимодействия с внешним модулем.
   * @param {function(string): void} callbacks.onKickForMissedPings -
   * Колбэк при кике за пропущенные пинги.
   * @param {function(string): void} callbacks.onKickForMaxLatency -
   * Колбэк при кике за высокую задержку.
   */
  constructor(params, callbacks) {
    this._maxMissedPings = params.maxMissedPings;
    this._maxLatency = params.maxLatency;
    this._callbacks = callbacks;

    /**
     * @private
     * @description Коэффициент сглаживания для
     * экспоненциального скользящего среднего (EMA).
     * Определяет, насколько сильно новый замер RTT влияет на текущее значение.
     */
    this._alpha = 0.1;

    /**
     * @private
     * @description Коллекция Map для хранения RTT-данных
     * по каждому пользователю.
     * @type {Map<string, {
     *     rtt: number,
     *     missedPings: number,
     *     outstandingPings: Map<number, number>,
     *     pingIdCounter: number
     *   }>
     * }
     * - rtt: сглаженное значение RTT
     * - missedPings: счетчик пропущенных пингов подряд
     * - outstandingPings: Map для отслеживания отправленных,
     *   но еще не отвеченных пингов { pingID: time }
     * - pingIdCounter: счетчик ID для следующего пинга
     */
    this._users = new Map();
  }

  /**
   * @description Добавляет нового пользователя в систему отслеживания RTT.
   * @param {string} gameId - Уникальный идентификатор пользователя.
   */
  addUser(gameId) {
    this._users.set(gameId, {
      rtt: 100, // начальное значение RTT (предположение)
      missedPings: 0,
      outstandingPings: new Map(),
      pingIdCounter: 0,
    });
  }

  /**
   * @description Удаляет пользователя из системы отслеживания RTT.
   * @param {string} gameId - Уникальный идентификатор пользователя.
   */
  removeUser(gameId) {
    this._users.delete(gameId);
  }

  /**
   * @description Планирует следующий пинг для всех пользователей.
   * Обновляет счетчики пропущенных пингов и готовит новые ID для отправки.
   * Инициирует кик для игроков, превысивших лимит пропущенных пингов.
   * @returns {Iterator<[string, object]>} -
   * Итератор пар [gameId, userData] для отправки пингов.
   */
  scheduleNextPing() {
    const toKick = [];

    this._users.forEach((user, gameId) => {
      // если с прошлого раза остался неотвеченный пинг,
      // он считается пропущенным
      if (user.outstandingPings.size > 0) {
        user.missedPings += 1;

        // если пользователь превысил лимит пропущенных пингов
        if (this._maxMissedPings && user.missedPings >= this._maxMissedPings) {
          toKick.push(gameId);
          return; // пропускается отправка нового пинга
        }
      }

      // новый пинг
      user.pingIdCounter += 1;
      const time = Date.now();

      // удаление старых пингов и запись нового
      // `outstandingPings` содержит только один, последний отправленный пинг
      user.outstandingPings.clear();
      user.outstandingPings.set(user.pingIdCounter, time);
    });

    // кики после завершения итерации по коллекции
    toKick.forEach(gameId => {
      this._callbacks.onKickForMissedPings(gameId);
    });

    // итератор для внешнего модуля, для отправки пингов
    return this._users.entries();
  }

  /**
   * @description Обрабатывает ответное сообщение 'pong' от клиента.
   * Вычисляет новый RTT, обновляет статистику и проверяет
   * на превышение максимальной задержки.
   * @param {string} gameId - Идентификатор пользователя,
   * от которого пришел 'pong'.
   * @param {number} pingId - ID пинга, на который пришел ответ.
   * @returns {number|null} - Рассчитанное значение RTT (latency) или null,
   * если 'pong' некорректен.
   */
  handlePong(gameId, pingId) {
    const user = this._users.get(gameId);

    // если пользователь был удален, пока 'pong' был в пути
    if (!user) {
      return null;
    }

    // игнорование ответов на устаревшие пинги,
    // чтобы избежать ложных срабатываний
    // обработка ответа на самый последний отправленный пинг
    if (pingId !== user.pingIdCounter) {
      return null;
    }

    const time = user.outstandingPings.get(pingId);

    if (time) {
      const newRttSample = Date.now() - time;
      const oldRtt = user.rtt;

      // сглаживание значения RTT
      // с помощью экспоненциального скользящего среднего (EMA)
      // (предотвращает резкие скачки RTT из-за единичных сетевых флуктуаций)
      user.rtt = oldRtt * (1 - this._alpha) + newRttSample * this._alpha;

      // если замер RTT превышает установленный порог
      if (this._maxLatency && user.rtt > this._maxLatency) {
        this._callbacks.onKickForMaxLatency(gameId);
        return null; // не возвращается RTT, т.к. игрок будет кикнут
      }

      // сброс счетчика пропущенных пингов, т.к. игрок ответил
      user.missedPings = 0;
      user.outstandingPings.delete(pingId);

      return Math.round(newRttSample);
    }

    // `pong` пришел для пинга, который уже не отслеживается (маловероятно)
    return null;
  }
}
