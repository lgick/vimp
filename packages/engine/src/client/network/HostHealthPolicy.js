// Политика автоматической передачи хоста (host-migration этап 9b): из потока
// здоровья Worker'а (HostController.onHealth, сэмпл раз в ~1 с), видимости
// вкладки и наличия беты решает, когда отдать роль бете.
//
// - Мягкая перегрузка (среднее tickRate последних сэмплов окна
//   overloadWindowMs ниже overloadTickRate) — передача, отложенная до
//   границы раунда (PlannedHandoff defer).
// - Жёсткая (среднее окна criticalWindowMs ниже criticalTickRate или lostMs
//   > 0 у lostWindows сэмплов подряд) и скрытая вкладка дольше
//   hiddenHandoffMs — передача сразу; ждущую границы раунда — ускорить.
// - Пока своя отложенная передача ждёт границы, а все сэмплы окна
//   recoverWindowMs выше recoverTickRate (гистерезис над порогом входа) —
//   отменить её: иначе передача сработала бы вхолостую на границе раунда.
//
// Новая передача — только при бете, после minHostTenureMs в роли хоста и
// autoHandoffCooldownMs с прошлой авто-передачи этой вкладки (с её запуска,
// при любом исходе). Отмена по нормализации кулдаун возвращает: от мигания
// защищают гистерезис и окна. Политика живёт дольше роли хоста — кулдаун
// переживает смену ролей.
//
// Без DOM: передачу, часы и таймеры инъектирует владелец
// (client/session/HandoffFlow.js).

export const AUTO_HANDOFF_REASONS = ['overload', 'hidden'];

// сэмпла нет дольше этого (в интервалах здоровья) — матч стоял, окна заново
const SAMPLE_GAP_INTERVALS = 2;

const average = values => values.reduce((a, b) => a + b, 0) / values.length;

export default class HostHealthPolicy {
  /**
   * @param {Object} options
   * @param {Object} options.config - lobby.migration.auto.
   * @param {Object} options.handoff - передача: { start({ reason, defer })
   *   → boolean, hurry(reason) → boolean, cancelDeferred() → boolean,
   *   deferredReason() → string|null (причина передачи, ждущей границы) }.
   * @param {number} [options.healthIntervalMs] - период сэмплов Worker'а.
   * @param {Function} [options.now] - монотонные часы, мс.
   * @param {Object} [options.timers] - { setTimeout, clearTimeout } (тесты).
   */
  constructor({
    config,
    handoff,
    healthIntervalMs = 1000,
    now = () => performance.now(),
    timers = globalThis,
  }) {
    this._config = config;
    this._handoff = handoff;
    this._intervalMs = healthIntervalMs;
    this._now = now;
    this._timers = timers;

    this._hostSince = null;
    this._successor = false;
    this._hiddenSince = null;
    this._hiddenTimer = null;
    this._lastAutoAt = null;
    this._cooldownBefore = null;
    this._samples = [];
    this._lastSampleAt = null;
  }

  // число сэмплов в окне длиной ms
  _count(ms) {
    return Math.max(1, Math.ceil(ms / this._intervalMs));
  }

  /**
   * Вкладка получила или потеряла роль хоста.
   * @param {boolean} isHost
   */
  setHost(isHost) {
    if (isHost === (this._hostSince !== null)) {
      return;
    }

    this._hostSince = isHost ? this._now() : null;
    this._successor = false;
    this._resetSamples();

    // роль получена скрытой вкладкой: скрытие отсчитывается от получения
    if (isHost && this._hiddenSince !== null) {
      this._hiddenSince = this._hostSince;
      this._armHiddenTimer();
    } else if (!isHost) {
      this._clearHiddenTimer();
    }
  }

  // назначена ли бета (successor_assigned)
  setSuccessor(available) {
    this._successor = Boolean(available);
    this._checkHidden();
  }

  setHidden(hidden) {
    if (hidden && this._hiddenSince === null) {
      this._hiddenSince = this._now();
      this._armHiddenTimer();
    } else if (!hidden) {
      this._hiddenSince = null;
      this._clearHiddenTimer();
    }
  }

  // сэмпл здоровья Worker'а
  addHealth(health) {
    if (this._hostSince === null || !health) {
      return;
    }

    const now = this._now();

    if (
      this._lastSampleAt !== null &&
      now - this._lastSampleAt > SAMPLE_GAP_INTERVALS * this._intervalMs
    ) {
      this._samples = [];
    }

    this._lastSampleAt = now;
    this._samples.push({ tickRate: health.tickRate, lostMs: health.lostMs });

    const keep = Math.max(
      this._count(this._config.overloadWindowMs),
      this._count(this._config.criticalWindowMs),
      this._count(this._config.recoverWindowMs),
      this._config.lostWindows,
    );

    if (this._samples.length > keep) {
      this._samples.splice(0, this._samples.length - keep);
    }

    this._evaluate();
  }

  destroy() {
    this._clearHiddenTimer();
    this._hostSince = null;
  }

  _evaluate() {
    if (this._checkHidden()) {
      return;
    }

    if (this._critical()) {
      this._handOverNow('overload');
      return;
    }

    const ownDeferred = AUTO_HANDOFF_REASONS.includes(
      this._handoff.deferredReason(),
    );

    if (ownDeferred) {
      if (this._recovered() && this._handoff.cancelDeferred()) {
        this._lastAutoAt = this._cooldownBefore;
      }

      return;
    }

    if (this._overloaded() && this._mayStart()) {
      this._start('overload', true);
    }
  }

  // скрытая вкладка дольше порога: передача сразу. true — сработало.
  // Отказ из-за срока роли или кулдауна — повторить, когда они истекут:
  // у стоящего матча сэмплов, которые перепроверили бы условие, нет
  _checkHidden() {
    if (
      this._hostSince === null ||
      this._hiddenSince === null ||
      this._now() - this._hiddenSince < this._config.hiddenHandoffMs
    ) {
      return false;
    }

    if (this._handOverNow('hidden')) {
      return true;
    }

    const waitMs = this._blockedForMs();

    if (waitMs > 0 && this._hiddenTimer === null) {
      this._armHiddenTimer(waitMs);
    }

    return false;
  }

  // немедленная передача: ждущую границы — ускорить, иначе начать
  _handOverNow(reason) {
    if (!this._enabled() || !this._successor) {
      return false;
    }

    if (this._handoff.deferredReason() !== null) {
      return this._handoff.hurry(reason);
    }

    return this._mayStart() && this._start(reason, false);
  }

  _start(reason, defer) {
    if (!this._handoff.start({ reason, defer })) {
      return false;
    }

    this._cooldownBefore = this._lastAutoAt;
    this._lastAutoAt = this._now();

    return true;
  }

  _enabled() {
    return this._config.enabled !== false && this._hostSince !== null;
  }

  // через сколько истекут срок роли и кулдаун (0 — не мешают)
  _blockedForMs() {
    const now = this._now();
    const tenureLeft = this._hostSince + this._config.minHostTenureMs - now;
    const cooldownLeft =
      this._lastAutoAt === null
        ? 0
        : this._lastAutoAt + this._config.autoHandoffCooldownMs - now;

    return Math.max(0, tenureLeft, cooldownLeft);
  }

  _mayStart() {
    const now = this._now();

    return (
      this._enabled() &&
      this._successor &&
      now - this._hostSince >= this._config.minHostTenureMs &&
      (this._lastAutoAt === null ||
        now - this._lastAutoAt >= this._config.autoHandoffCooldownMs)
    );
  }

  // последние n сэмплов (null — окно ещё не набрано)
  _last(n) {
    return this._samples.length >= n ? this._samples.slice(-n) : null;
  }

  _overloaded() {
    const window = this._last(this._count(this._config.overloadWindowMs));

    return (
      window !== null &&
      average(window.map(s => s.tickRate)) < this._config.overloadTickRate
    );
  }

  _critical() {
    const window = this._last(this._count(this._config.criticalWindowMs));
    const lost = this._last(this._config.lostWindows);

    return (
      (window !== null &&
        average(window.map(s => s.tickRate)) < this._config.criticalTickRate) ||
      (lost !== null && lost.every(s => s.lostMs > 0))
    );
  }

  _recovered() {
    const window = this._last(this._count(this._config.recoverWindowMs));

    return (
      window !== null &&
      window.every(s => s.tickRate > this._config.recoverTickRate)
    );
  }

  _resetSamples() {
    this._samples = [];
    this._lastSampleAt = null;
  }

  _armHiddenTimer(delayMs = this._config.hiddenHandoffMs) {
    this._clearHiddenTimer();

    if (this._hostSince === null) {
      return;
    }

    this._hiddenTimer = this._timers.setTimeout(() => {
      this._hiddenTimer = null;
      this._checkHidden();
    }, delayMs);
  }

  _clearHiddenTimer() {
    if (this._hiddenTimer !== null) {
      this._timers.clearTimeout(this._hiddenTimer);
      this._hiddenTimer = null;
    }
  }
}
