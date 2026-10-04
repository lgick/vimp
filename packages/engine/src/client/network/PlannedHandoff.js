// Плановая передача роли хоста (host-migration этап 8.2): вкладка-хост
// отдаёт комнату бете без отката. handoff_begin мастеру → handoff_go →
// заморозка Worker'а и финальная контрольная точка (её везёт StandbySender
// с приоритетом) → host_released: бета заняла комнату с того же тика.
// Дальше — владелец (client/session/HandoffFlow.js): stay — свой игрок
// возвращается гостем RESUME'ом к новому хосту, иначе — уход в лобби.
//
// Исход у передачи один, и объявляется он один раз. Дедлайн deadlineMs
// отсчитывается от handoff_begin и перекрывает handoffTimeoutMs мастера с
// запасом на дорогу ответа: обычно отмену объявляет мастер
// (handoff_aborted), дедлайн — страховка. Медленный ответ (нет handoff_go за
// slowAfterMs) — не отказ, а повод показать «медленная связь» (onSlow):
// поздний handoff_go до дедлайна штатно замораживает матч и шлёт финальную
// точку — иначе бета откатила бы всех к периодической.
//
// Отмена: handoff_unavailable (матч не замораживался), handoff_aborted,
// обрыв сигналинга или дедлайн — замороженный матч размораживается, вкладка
// остаётся хостом. Уходящий хост (stay: false) уходит всё равно:
// host_leaving мастеру — аварийная миграция с последней периодической
// точкой (при обрыве сигналинга без него: обрыв WS мастер видит сам).
//
// Отложенная передача (defer, этап 8d): handoff_begin уходит на границе
// раунда (HostController.awaitRoundBoundary — игра без migration.midRound
// иначе отняла бы раунд у всех; у игры с midRound Worker отвечает сразу),
// но не позже deferMaxMs. Пока ожидание идёт, передача уже начата: повтор
// игнорируется, а дедлайн и onSlow отсчитываются от handoff_begin.
// Автотриггеры (этап 9b) ожидание сокращают (hurry — жёсткая перегрузка,
// скрытая вкладка) или снимают (cancelDeferred — нагрузка нормализовалась).
//
// Без DOM: сигналинг, Worker хоста и таймеры инъектируются.

const SIGNALING_EVENTS = [
  ['handoff_go', '_onGo'],
  ['handoff_unavailable', '_onUnavailable'],
  ['handoff_aborted', '_onAborted'],
  ['host_released', '_onReleased'],
  ['close', '_onSignalingClose'],
];

/**
 * Что вернуть своему игроку после отменённой передачи. Оверлей паузы
 * передачи снимается всегда, а ввод и звук — только живому месту в матче:
 * игрок, потерянный раньше (handleOwnPlayerLost), остаётся без них.
 * @param {Object} params
 * @param {boolean} params.frozen - матч замораживался (был оверлей).
 * @param {string|null} params.sessionState - состояние SessionSupervisor.
 * @returns {{ hideOverlay: boolean, restoreInput: boolean }}
 */
export function controlsAfterAbort({ frozen, sessionState }) {
  return {
    hideOverlay: frozen,
    restoreInput: frozen && sessionState === 'inGame',
  };
}

export default class PlannedHandoff {
  /**
   * @param {Object} options
   * @param {SignalingClient} options.signaling
   * @param {Function} options.getRoom - () => { roomId, epoch } | null —
   *   комната, которую вкладка хостит сейчас.
   * @param {Function} options.getController - () => HostController | null.
   * @param {number} [options.slowAfterMs] - нет handoff_go за это время —
   *   onSlow (передача продолжается).
   * @param {number} [options.deadlineMs] - общий дедлайн передачи от
   *   handoff_begin (больше handoffTimeoutMs мастера).
   * @param {number} [options.deferMaxMs] - потолок ожидания границы раунда
   *   отложенной передачи.
   * @param {Function} [options.onSlow] - () мастер отвечает медленно.
   * @param {Function} [options.onFrozen] - ({ epoch }) матч заморожен,
   *   финальная точка запрошена; epoch — эпоха преемника.
   * @param {Function} [options.onReleased] - ({ stay, epoch }) роль отдана.
   * @param {Function} [options.onAborted] - ({ reason, frozen }) передача
   *   окончательно отменена, вкладка остаётся хостом (только stay).
   * @param {Function} [options.onLeave] - ({ reason }) передать не вышло, а
   *   хост уходит (stay: false) — дальше аварийный путь мастера.
   * @param {Object} [options.timers] - { setTimeout, clearTimeout } (тесты).
   */
  constructor({
    signaling,
    getRoom,
    getController,
    slowAfterMs = 3000,
    deadlineMs = 10000,
    deferMaxMs = 30000,
    onSlow = () => {},
    onFrozen = () => {},
    onReleased = () => {},
    onAborted = () => {},
    onLeave = () => {},
    timers = globalThis,
  }) {
    this._signaling = signaling;
    this._getRoom = getRoom;
    this._getController = getController;
    this._slowAfterMs = slowAfterMs;
    this._deadlineMs = deadlineMs;
    this._deferMaxMs = deferMaxMs;
    this._onSlow = onSlow;
    this._onFrozen = onFrozen;
    this._onReleasedCb = onReleased;
    this._onAbortedCb = onAborted;
    this._onLeave = onLeave;
    this._timers = timers;

    // null | 'deferred' (ждём границы раунда) | 'requested' (ждём
    // handoff_go) | 'frozen' (ждём host_released)
    this._phase = null;
    this._room = null;
    this._reason = null;
    this._stay = true;
    this._slowTimer = null;
    this._deadlineTimer = null;
    this._deferTimer = null;
  }

  // передача идёт: повторный start игнорируется
  get active() {
    return this._phase !== null;
  }

  // передача ждёт границы раунда: матч ещё идёт, мастер ещё не спрошен
  get deferred() {
    return this._phase === 'deferred';
  }

  // причина идущей передачи (null — передачи нет)
  get reason() {
    return this._reason;
  }

  // идёт передача уходящего хоста (stay: false)
  get leaving() {
    return this.active && !this._stay;
  }

  /**
   * Начать передачу.
   * @param {Object} options
   * @param {string} options.reason - 'leave' | 'handover' | 'overload' |
   *   'hidden' | 'network' (этап 9) | 'vote' (этап 10).
   * @param {boolean} [options.stay] - остаться в комнате гостем.
   * @param {boolean} [options.defer] - дождаться границы раунда.
   * @returns {boolean} false — передача уже идёт или вкладка не хост.
   */
  start({ reason, stay = true, defer = false }) {
    const room = this._getRoom();
    const controller = this._getController();

    if (this.active || !room || !controller) {
      return false;
    }

    this._room = { roomId: room.roomId, epoch: room.epoch };
    this._reason = reason;
    this._stay = stay === true;

    for (const [type, handler] of SIGNALING_EVENTS) {
      this._signaling.publisher.on(type, handler, this);
    }

    if (!defer) {
      this._begin();
      return true;
    }

    this._phase = 'deferred';
    this._deferTimer = this._timers.setTimeout(() => {
      this._deferTimer = null;
      this._getController()?.cancelRoundBoundary();
      this._begin();
    }, this._deferMaxMs);
    controller.awaitRoundBoundary(() => this._onBoundary());

    return true;
  }

  /**
   * Не ждать границы раунда: вопрос мастеру сразу, с новой причиной.
   * @param {string} [reason] - причина вместо исходной.
   * @returns {boolean} false — передача не в ожидании границы.
   */
  hurry(reason = this._reason) {
    if (this._phase !== 'deferred') {
      return false;
    }

    this._clearDeferTimer();
    this._getController()?.cancelRoundBoundary();
    this._reason = reason;
    this._begin();

    return true;
  }

  /**
   * Снять передачу, ждущую границы раунда, — тихо, без колбэков (мастер
   * ещё не спрашивался, матч не замораживался).
   * @returns {boolean} false — передача не в ожидании границы.
   */
  cancelDeferred() {
    if (this._phase !== 'deferred') {
      return false;
    }

    this._finish();

    return true;
  }

  // граница раунда наступила (у игры с midRound — сразу)
  _onBoundary() {
    if (this._phase !== 'deferred') {
      return;
    }

    this._clearDeferTimer();
    this._begin();
  }

  // вопрос мастеру: с этого момента идут onSlow и дедлайн
  _begin() {
    const room = this._room;

    this._phase = 'requested';

    this._slowTimer = this._timers.setTimeout(() => {
      this._slowTimer = null;
      this._onSlow();
    }, this._slowAfterMs);

    this._deadlineTimer = this._timers.setTimeout(() => {
      this._deadlineTimer = null;
      this._cancel('timeout');
    }, this._deadlineMs);

    this._signaling.handoffBegin({
      roomId: room.roomId,
      epoch: room.epoch,
      reason: this._reason,
      stay: this._stay,
    });
  }

  // владелец снимает роль хоста сам (teardown): тихо, без колбэков
  abort() {
    this._finish();
  }

  _ownRoom(msg) {
    return this.active && msg?.roomId === this._room.roomId;
  }

  _onGo(msg) {
    if (!this._ownRoom(msg) || this._phase !== 'requested') {
      return;
    }

    this._clearSlowTimer();
    this._phase = 'frozen';

    // цикл встаёт на границе кадра, точка снимается сразу — с того же тика
    const controller = this._getController();

    controller?.freeze();
    controller?.requestCheckpoint({ final: true });

    this._onFrozen({ epoch: msg.epoch });
  }

  _onUnavailable(msg) {
    if (this._ownRoom(msg) && this._phase === 'requested') {
      this._cancel(msg.reason ?? 'unavailable');
    }
  }

  // бета не заняла комнату: эпоха прежняя, матч продолжается здесь.
  // Отложенная передача мастера ещё не спрашивала — отмена не про неё
  _onAborted(msg) {
    if (this._ownRoom(msg) && this._phase !== 'deferred') {
      this._cancel('aborted');
    }
  }

  _onReleased(msg) {
    if (!this._ownRoom(msg)) {
      return;
    }

    const stay = this._stay;

    this._finish();
    this._onReleasedCb({ stay, epoch: msg.epoch });
  }

  // мастер пропал: сорвалась ли передача, узнаем после реконнекта
  // (reclaim_host → staleEpoch, если бета успела). До тех пор матч идёт здесь
  _onSignalingClose() {
    if (this.active) {
      this._cancel('signalingLost', { notify: false });
    }
  }

  // окончательная отмена: остающийся хост размораживает матч (если
  // замораживал), уходящий уходит всё равно
  _cancel(reason, { notify = true } = {}) {
    const room = this._room;
    const stay = this._stay;
    const frozen = this._phase === 'frozen';

    this._finish();

    if (stay) {
      if (frozen) {
        this._getController()?.unfreeze();
      }

      this._onAbortedCb({ reason, frozen });
      return;
    }

    if (notify) {
      this._signaling.hostLeaving(room.roomId, room.epoch);
    }

    this._onLeave({ reason });
  }

  _finish() {
    this._clearSlowTimer();

    if (this._phase === 'deferred') {
      this._clearDeferTimer();
      this._getController()?.cancelRoundBoundary();
    }

    if (this._deadlineTimer !== null) {
      this._timers.clearTimeout(this._deadlineTimer);
      this._deadlineTimer = null;
    }

    if (this._phase !== null) {
      for (const [type, handler] of SIGNALING_EVENTS) {
        this._signaling.publisher.off(type, handler, this);
      }
    }

    this._phase = null;
    this._room = null;
    this._reason = null;
  }

  _clearDeferTimer() {
    if (this._deferTimer !== null) {
      this._timers.clearTimeout(this._deferTimer);
      this._deferTimer = null;
    }
  }

  _clearSlowTimer() {
    if (this._slowTimer !== null) {
      this._timers.clearTimeout(this._slowTimer);
      this._slowTimer = null;
    }
  }
}
