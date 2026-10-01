// Защита комнаты от случайного закрытия вкладки хоста (host-migration этап
// 8.4).
//
// beforeunload висит, только пока вкладка — текущий хост и в комнате есть
// другие люди: Ctrl+W/F5 спросит «Leave site?». Финального дампа во время
// диалога не будет — пока он открыт, главный поток стоит, а именно он
// ретранслирует Worker → DataChannel; гости это время видят замерший матч.
//
// pagehide срабатывает и после «Leave», и при закрытии без диалога (на
// мобильных beforeunload ненадёжен — там остаётся только он): хост сразу
// говорит мастеру host_leaving (аварийная миграция без ожидания обрыва WS),
// гость — LEAVE хосту и leave_room мастеру (его место освобождается сразу,
// а не через resumeGraceMs). Всё best-effort: недошедшее перекроет обрыв
// соединений.
//
// exit() — вкладка уходит сама («Leave server», переход в лобби): диалог не
// нужен, уход уже объявлен.

export default class HostUnloadGuard {
  /**
   * @param {Object} options
   * @param {Function} options.onHostLeave - () pagehide у хоста.
   * @param {Function} options.onGuestLeave - () pagehide у гостя комнаты.
   * @param {EventTarget} [options.target] - window (тесты — свой).
   */
  constructor({ onHostLeave, onGuestLeave, target = globalThis }) {
    this._onHostLeave = onHostLeave;
    this._onGuestLeave = onGuestLeave;
    this._target = target;

    // null — не в комнате | 'host' | 'guest'
    this._role = null;
    this._othersPresent = false;
    this._armed = false;
    this._exiting = false;

    this._onBeforeUnload = event => {
      event.preventDefault();
      // старые браузеры показывают диалог только по returnValue
      event.returnValue = '';
    };
    this._onPageHide = () => this._pageHide();

    target.addEventListener('pagehide', this._onPageHide);
  }

  // диалог закрытия сейчас висит
  get armed() {
    return this._armed;
  }

  /**
   * Роль вкладки в комнате и есть ли в ней другие люди.
   * @param {Object} state
   * @param {'host'|'guest'|null} state.role
   * @param {boolean} [state.othersPresent]
   */
  update({ role, othersPresent = false }) {
    this._role = role ?? null;
    this._othersPresent = othersPresent === true;
    this._sync();
  }

  // вкладка уходит сама: ни диалога, ни повторного объявления ухода
  exit() {
    this._exiting = true;
    this._sync();
  }

  destroy() {
    this.exit();
    this._target.removeEventListener('pagehide', this._onPageHide);
  }

  _sync() {
    const armed =
      !this._exiting && this._role === 'host' && this._othersPresent;

    if (armed === this._armed) {
      return;
    }

    this._armed = armed;

    if (armed) {
      this._target.addEventListener('beforeunload', this._onBeforeUnload);
    } else {
      this._target.removeEventListener('beforeunload', this._onBeforeUnload);
    }
  }

  _pageHide() {
    if (this._exiting) {
      return;
    }

    // страница уходит: второй pagehide (bfcache) ничего не повторит
    this._exiting = true;

    if (this._role === 'host') {
      this._onHostLeave();
    } else if (this._role === 'guest') {
      this._onGuestLeave();
    }

    this._sync();
  }
}
