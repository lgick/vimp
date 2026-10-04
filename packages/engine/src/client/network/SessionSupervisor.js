import wsports from '../../config/wsports.js';

// Супервизор сессии клиента (host-migration этап 4). Сессия — рендер, MVC,
// клиентское ядро, карта, свой gameId — живёт дольше конкретного
// транспорта: обрыв WebRTC в матче не перезагружает страницу, а ведёт к
// переподключению к текущему хосту комнаты (мастер маршрутизирует оффер по
// roomId) и возобновлению места RESUME_REQUEST'ом, без повторного
// рукопожатия. Смена хоста (этап 7) идёт тем же путём: host_migrating
// замораживает сессию, host_changed возобновляет её у нового хоста.
//
// Без DOM: транспорт и часы инъектируются, решения о перезагрузке и оверлее
// принимает владелец (client/main.js) по колбэкам.
//
// Состояния: connecting → handshake → inGame → reconnecting → inGame | closed;
// любое живое → migrating → reconnecting (новый хост) | closed.

const PC_RESUME_REQUEST = wsports.client.RESUME_REQUEST;

// версия формата RESUME_REQUEST (хост отвечает 'version' на чужую)
const RESUME_VERSION = 1;

// предел ожидания смены хоста, продлённого мастером (host_migrating.waitMs):
// мусорное поле не держит гостя в замороженной сессии бесконечно
const MAX_MIGRATION_WAIT_MS = 120000;

const clampWait = waitMs =>
  Number.isFinite(waitMs)
    ? Math.min(Math.max(waitMs, 0), MAX_MIGRATION_WAIT_MS)
    : 0;

export const SESSION_STATES = Object.freeze({
  connecting: 'connecting',
  handshake: 'handshake',
  inGame: 'inGame',
  reconnecting: 'reconnecting',
  migrating: 'migrating',
  closed: 'closed',
});

const S = SESSION_STATES;

const defaultClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: id => clearInterval(id),
};

export default class SessionSupervisor {
  /**
   * @param {Object} opts
   * @param {Function} opts.onMessage - входящее сообщение текущего
   *   транспорта (строка или ArrayBuffer).
   * @param {Function} opts.onTerminal - (closeCode) сессия закрыта
   *   окончательно: путь прежнего handleDisconnect.
   * @param {Function} [opts.onStateChange] - (state, prev).
   * @param {Function} [opts.onResumed] - место возвращено (RESUME_RESULT ok).
   * @param {Function} [opts.onResumeRejected] - (reason) хост отказал.
   * @param {Function} [opts.onHostLost] - транспорт к хосту оборвался в
   *   матче (до переподключения): свидетельство мастеру (host_unreachable).
   * @param {Function} [opts.onColdRestart] - новый хост поднял матч заново
   *   (host_changed cold): возобновлять нечего, только чистый вход.
   * @param {Function} [opts.isTerminalClose] - (closeCode) закрытие по
   *   политике или кику: возвращаться некуда.
   * @param {Object|null} [opts.reconnect] - null — переподключения нет
   *   (solo, dedicated, вкладка-хост на loopback). Иначе:
   *   { createTransport() → новый транспорт с resume (уже connect'нутый),
   *     getToken() → identity-токен для RESUME_REQUEST }.
   * @param {Object} [opts.timing] - { reconnectWindowMs, reconnectBaseDelayMs,
   *   reconnectMaxDelayMs, hostSilenceMs, migrationWaitMs,
   *   resumeSilenceGraceMs }
   *   (config/lobby.js → session).
   * @param {Object} [opts.clock] - часы и таймеры (тесты).
   */
  constructor({
    onMessage,
    onTerminal,
    onStateChange = () => {},
    onResumed = () => {},
    onResumeRejected = () => {},
    onHostLost = () => {},
    onColdRestart = () => {},
    isTerminalClose = () => false,
    reconnect = null,
    timing = {},
    clock = defaultClock,
  }) {
    this._onMessage = onMessage;
    this._onTerminal = onTerminal;
    this._onStateChange = onStateChange;
    this._onResumed = onResumed;
    this._onResumeRejected = onResumeRejected;
    this._onHostLost = onHostLost;
    this._onColdRestart = onColdRestart;
    this._isTerminalClose = isTerminalClose;
    this._reconnect = reconnect;
    this._getToken = reconnect?.getToken ?? null;
    this._clock = clock;

    this._windowMs = timing.reconnectWindowMs ?? 15000;
    this._baseDelayMs = timing.reconnectBaseDelayMs ?? 500;
    this._maxDelayMs = timing.reconnectMaxDelayMs ?? 4000;
    this._silenceMs = timing.hostSilenceMs ?? 3000;
    this._migrationWaitMs = timing.migrationWaitMs ?? 20000;
    this._resumeSilenceGraceMs = timing.resumeSilenceGraceMs ?? 3000;

    this._state = S.connecting;
    this._transport = null;
    this._handlers = null;

    // { gameId, resumeKey } из SESSION_DATA — без них возвращаться некуда
    this._session = null;
    this._userLeft = false;
    this._loading = false;
    this._resuming = false;

    this._lastMessageAt = 0;
    this._watchdog = null;
    // возобновились, кадра ещё не было: восстановленный матч законно стоит,
    // ожидая остальных (hostDefaults.resumeWaitMs) — сторожку фора
    this._awaitingFrame = false;

    this._attempt = 0;
    this._attemptTimer = null;
    this._windowTimer = null;
    this._migrationTimer = null;
    this._migrationDeadline = 0;
    // resumeWith({ onFailed }): сбой этого возврата — не конец сессии для
    // владельца, а его отдельный случай (преемник уже хост комнаты)
    this._onRoleResumeFailed = null;
  }

  get state() {
    return this._state;
  }

  get transport() {
    return this._transport;
  }

  // есть ли секрет места (SESSION_DATA) — без него возвращаться не с чем
  get hasSession() {
    return this._session !== null;
  }

  // место возвращено, пакет входа ещё не дочитан (до SESSION_DATA): первый
  // кадр в это время — не повод слать FIRST_SHOT_READY и автостарт
  get resuming() {
    return this._resuming;
  }

  /**
   * Берёт транспорт под надзор (первичное подключение).
   * @param {Object} transport - { publisher, send, close }.
   */
  attach(transport) {
    this._setTransport(transport);
    this._setState(S.connecting);
  }

  /**
   * Исходящее сообщение текущему транспорту.
   */
  send(data, reliable = true) {
    this._transport?.send(data, reliable);
  }

  /**
   * Пользователь уходит сам (или сессию закрывает политика): закрытие
   * транспорта терминально, переподключения не будет.
   */
  close() {
    this._userLeft = true;

    if (this._state === S.reconnecting || this._state === S.migrating) {
      this._dropTransport();
      this._terminate();
      return;
    }

    if (this._transport) {
      this._transport.close();
    } else {
      this._terminate();
    }
  }

  /**
   * Первый кадр матча применён — сессия в игре.
   */
  enterGame() {
    if (this._state === S.connecting || this._state === S.handshake) {
      this._setState(S.inGame);
      this._startWatchdog();
    }
  }

  /**
   * Загрузка карты (MAP_DATA … FIRST_SHOT): хост в это время законно
   * молчит, сторожок тишины не считает.
   */
  setLoading(loading) {
    this._loading = loading;
    this._lastMessageAt = this._clock.now();

    // новая карта — обычный путь входа: пакет возобновления закончен
    if (loading) {
      this._resuming = false;
    }
  }

  /**
   * SESSION_DATA { resumeKey, gameId }: секрет места. Возвращает true, если
   * это последнее сообщение пакета возобновления.
   */
  setSession({ resumeKey, gameId } = {}) {
    if (typeof resumeKey === 'string' && resumeKey !== '') {
      this._session = { resumeKey, gameId };
    }

    const finishedResume = this._resuming;

    this._resuming = false;

    return finishedResume;
  }

  /**
   * RESUME_RESULT от хоста.
   * @param {Object} result - { ok, gameId, epoch } | { ok: false, reason }.
   */
  resumeResult(result) {
    if (this._state !== S.reconnecting) {
      return;
    }

    if (result?.ok === true) {
      this._clearReconnectTimers();
      this._onRoleResumeFailed = null;
      this._resuming = true;
      this._awaitingFrame = true;
      this._lastMessageAt = this._clock.now();
      this._setState(S.inGame);
      this._startWatchdog();
      this._onResumed(result);
      return;
    }

    // место потеряно — дальнейшие попытки бессмысленны
    this._clearReconnectTimers();
    this._dropTransport();

    if (this._failRoleResume(result?.reason ?? 'unknown')) {
      return;
    }

    this._setState(S.closed);
    this._onResumeRejected(result?.reason ?? 'unknown');
  }

  // сбой возврата, начатого resumeWith({ onFailed }): сессия закрыта, но
  // путь владельца — его колбэк, а не onResumeRejected/onTerminal
  _failRoleResume(reason) {
    const onFailed = this._onRoleResumeFailed;

    if (!onFailed) {
      return false;
    }

    this._onRoleResumeFailed = null;
    this._stopWatchdog();
    this._clearReconnectTimers();
    this._setState(S.closed);
    onFailed(reason);

    return true;
  }

  // ***** смена хоста (host-migration этап 7) ***** //

  /**
   * host_migrating от мастера: хост комнаты сменяется. Транспорт к старому
   * хосту закрывается сразу (pc.close, без ожидания таймаутов ICE), и всё,
   * что от него ещё придёт, отбрасывается: у клиента не должно быть двух
   * источников кадров ни на миг (зомби-хост эпохи N и новый хост N+1).
   * Ждём host_changed не дольше migrationWaitMs.
   * @param {Object} [options]
   * @param {boolean} [options.keepTransport] - транспорт не закрывать: так
   *   делает только бета плановой передачи — поверх того же соединения с
   *   замороженным хостом идёт канал standby с финальной точкой. Кадры
   *   транспорта всё равно отбрасываются, его закрытие не терминально;
   *   бросят его host_changed или resumeWith.
   * @param {number} [options.waitMs] - host_migrating.waitMs: сколько мастер
   *   ещё ищет преемника; меньше migrationWaitMs ожидание не укорачивает.
   * @returns {boolean} сессия перешла в ожидание.
   */
  migrate({ keepTransport = false, waitMs } = {}) {
    if (
      this._reconnect === null ||
      this._userLeft ||
      this._state === S.closed ||
      this._state === S.migrating
    ) {
      return false;
    }

    this._stopWatchdog();
    this._clearReconnectTimers();

    if (!keepTransport) {
      this._dropTransport();
    }

    this._resuming = false;
    this._awaitingFrame = false;
    this._setState(S.migrating);
    this._armMigrationTimer(Math.max(this._migrationWaitMs, clampWait(waitMs)));

    return true;
  }

  /**
   * Повторный host_migrating той же эпохи (следующий кандидат, деградация
   * передачи): ожидание продлевается до waitMs, но не укорачивается.
   * @param {number} waitMs
   * @returns {boolean} срок продлён.
   */
  extendMigration(waitMs) {
    if (this._state !== S.migrating) {
      return false;
    }

    const left = Math.max(0, this._migrationDeadline - this._clock.now());
    const wanted = clampWait(waitMs);

    if (wanted <= left) {
      return false;
    }

    this._armMigrationTimer(wanted);

    return true;
  }

  _armMigrationTimer(ms) {
    this._clearMigrationTimer();
    this._migrationDeadline = this._clock.now() + ms;
    this._migrationTimer = this._clock.setTimeout(() => {
      this._migrationTimer = null;

      if (this._state === S.migrating) {
        this._terminate();
      }
    }, ms);
  }

  /**
   * Применён бинарный кадр хоста: восстановленный матч пошёл, фора сторожка
   * снята.
   */
  noteFrame() {
    this._awaitingFrame = false;
  }

  /**
   * host_changed {mode} от мастера: у комнаты новый (или вернувшийся) хост.
   * checkpoint/planned/reclaimed — матч продолжается, место возвращается
   * RESUME'ом у нового хоста (окно и бэкофф — как при обрыве); cold — матч
   * поднят заново, возобновлять нечего.
   * @param {Object} msg - { mode }.
   */
  hostChanged({ mode } = {}) {
    if (
      this._reconnect === null ||
      this._userLeft ||
      this._state === S.closed
    ) {
      return;
    }

    // хост вернулся сам, а этот клиент миграции не ждал: его транспорт к
    // тому же хосту (или попытки переподключения к нему) по-прежнему годны
    if (mode === 'reclaimed' && this._state !== S.migrating) {
      return;
    }

    // сообщение могло обогнать host_migrating (реконнект сигналинга) —
    // ожидание не обязательно, но старый транспорт так же бросается
    this._clearMigrationTimer();
    this._stopWatchdog();
    this._clearReconnectTimers();
    this._dropTransport();

    if (mode === 'cold') {
      this._setState(S.closed);
      this._onColdRestart();
      return;
    }

    // без секрета места (хост сменился до SESSION_DATA) возвращаться не с
    // чем — чистый вход в ту же комнату
    if (this._session === null) {
      this._setState(S.closed);
      this._onResumeRejected('noSession');
      return;
    }

    this._startReconnect({ report: false });
  }

  /**
   * Вкладка сменила роль в комнате (host-migration этап 7.4/7.5): место
   * возвращается RESUME'ом через заданный транспорт — loopback к Worker'у,
   * который эта вкладка подняла преемником, или WebRTC к новому хосту у
   * бывшего хоста. Окно возврата — как при обрыве.
   * @param {Object} transport - уже connect'нутый, с resume.
   * @param {Object} [options]
   * @param {Object|null} [options.reconnect] - фабрика следующих попыток
   *   (как в конструкторе); null — других попыток нет (свой Worker:
   *   отказ loopback'а терминален), сторожок тишины выключен.
   * @param {Function} [options.getToken] - identity-токен для
   *   RESUME_REQUEST (по умолчанию — reconnect.getToken).
   * @param {Function} [options.onFailed] - (reason) вернуть место не
   *   вышло (нет секрета, отказ, закрытие, окно истекло): сессия закрыта,
   *   но вместо onResumeRejected/onTerminal зовётся он — преемник уже хост
   *   комнаты, и сбой своего игрока не должен её гасить.
   * @returns {boolean} false — сессия уже закрыта.
   */
  resumeWith(transport, { reconnect = null, getToken, onFailed = null } = {}) {
    if (this._userLeft || this._state === S.closed) {
      return false;
    }

    this._clearMigrationTimer();
    this._stopWatchdog();
    this._clearReconnectTimers();
    this._dropTransport();

    this._reconnect = reconnect;
    this._getToken = getToken ?? reconnect?.getToken ?? null;
    this._onRoleResumeFailed = onFailed;

    // без секрета места возвращаться не с чем — чистый вход
    if (this._session === null) {
      transport.close?.();

      if (this._failRoleResume('noSession')) {
        return true;
      }

      this._setState(S.closed);
      this._onResumeRejected('noSession');
      return true;
    }

    this._resuming = false;
    this._attempt = 1;
    this._setState(S.reconnecting);
    this._startWindow();
    this._setTransport(transport);

    return true;
  }

  _clearMigrationTimer() {
    if (this._migrationTimer !== null) {
      this._clock.clearTimeout(this._migrationTimer);
      this._migrationTimer = null;
    }
  }

  // ***** транспорт ***** //

  _setTransport(transport) {
    this._dropTransport();

    const handlers = {
      message: data => this._handleMessage(transport, data),
      close: closeCode => this._handleClose(transport, closeCode),
      open: () => this._handleOpen(transport),
    };

    for (const [event, fn] of Object.entries(handlers)) {
      transport.publisher.on(event, fn);
    }

    this._transport = transport;
    this._handlers = handlers;
  }

  // отписка от брошенного транспорта; сам транспорт закрывается тихо
  // (destroy), если умеет, — его 'close' уже никому не нужен
  _dropTransport() {
    const transport = this._transport;

    if (!transport) {
      return;
    }

    for (const [event, fn] of Object.entries(this._handlers)) {
      transport.publisher.off(event, fn);
    }

    this._transport = null;
    this._handlers = null;

    transport.destroy?.();
  }

  _handleMessage(transport, data) {
    if (transport !== this._transport) {
      return;
    }

    // сохранённый транспорт к замороженному хосту (keepTransport): у
    // клиента не должно быть двух источников кадров
    if (this._state === S.migrating) {
      return;
    }

    this._lastMessageAt = this._clock.now();
    this._onMessage(data);
  }

  _handleOpen(transport) {
    if (transport !== this._transport) {
      return;
    }

    if (this._state === S.connecting) {
      this._setState(S.handshake);
      return;
    }

    // каналы новой попытки открыты — предъявить место
    if (this._state === S.reconnecting && this._session) {
      transport.send(
        JSON.stringify([
          PC_RESUME_REQUEST,
          {
            v: RESUME_VERSION,
            gameId: this._session.gameId,
            resumeKey: this._session.resumeKey,
            token: this._getToken?.() ?? null,
          },
        ]),
      );
    }
  }

  _handleClose(transport, closeCode) {
    if (transport !== this._transport) {
      return;
    }

    this._dropTransport();

    // сохранённый транспорт (keepTransport) закрылся: исход миграции решают
    // host_changed, promote или таймер ожидания
    if (this._state === S.migrating) {
      return;
    }

    if (this._state === S.reconnecting) {
      // транспорт, выданный resumeWith без фабрики попыток: повторять нечем
      if (this._reconnect === null) {
        if (!this._failRoleResume('closed')) {
          this._terminate(closeCode);
        }

        return;
      }

      this._scheduleAttempt();
      return;
    }

    if (this._canResume(closeCode)) {
      this._startReconnect();
      return;
    }

    this._terminate(closeCode);
  }

  // нетерминальным бывает только обрыв посреди матча, у которого есть место
  // для возврата и кому возвращаться
  _canResume(closeCode) {
    return (
      this._reconnect !== null &&
      !this._userLeft &&
      this._state === S.inGame &&
      this._session !== null &&
      !this._isTerminalClose(closeCode)
    );
  }

  // ***** переподключение ***** //

  // report — обрыв замечен самим клиентом: мастер узнаёт о нём раньше,
  // чем решит сам (после host_changed жаловаться не на что)
  _startReconnect({ report = true } = {}) {
    this._stopWatchdog();
    this._resuming = false;
    this._attempt = 0;
    this._setState(S.reconnecting);

    if (report) {
      this._onHostLost();
    }

    this._startWindow();
    this._runAttempt();
  }

  // окно целиком: не успели вернуться — сессия закрыта
  _startWindow() {
    this._windowTimer = this._clock.setTimeout(() => {
      this._windowTimer = null;

      if (this._state === S.reconnecting) {
        this._clearReconnectTimers();
        this._dropTransport();

        if (!this._failRoleResume('timeout')) {
          this._terminate();
        }
      }
    }, this._windowMs);
  }

  _runAttempt() {
    this._attemptTimer = null;

    if (this._state !== S.reconnecting) {
      return;
    }

    this._attempt += 1;
    this._setTransport(this._reconnect.createTransport());
  }

  _scheduleAttempt() {
    const delay = Math.min(
      this._maxDelayMs,
      this._baseDelayMs * 2 ** (this._attempt - 1),
    );

    this._attemptTimer = this._clock.setTimeout(
      () => this._runAttempt(),
      delay,
    );
  }

  _clearReconnectTimers() {
    if (this._attemptTimer !== null) {
      this._clock.clearTimeout(this._attemptTimer);
      this._attemptTimer = null;
    }

    if (this._windowTimer !== null) {
      this._clock.clearTimeout(this._windowTimer);
      this._windowTimer = null;
    }
  }

  // ***** сторожок тишины ***** //

  // в матче хост шлёт кадры ~30/с и PING раз в 3 с: долгое молчание —
  // транспорт мёртв, хотя браузер ещё не объявил 'failed'
  _startWatchdog() {
    if (this._reconnect === null || this._watchdog !== null) {
      return;
    }

    this._lastMessageAt = this._clock.now();
    this._watchdog = this._clock.setInterval(
      () => this._checkSilence(),
      Math.max(250, Math.floor(this._silenceMs / 3)),
    );
  }

  _stopWatchdog() {
    if (this._watchdog !== null) {
      this._clock.clearInterval(this._watchdog);
      this._watchdog = null;
    }
  }

  _checkSilence() {
    if (this._state !== S.inGame || this._loading || !this._transport) {
      return;
    }

    const limitMs = this._awaitingFrame
      ? this._silenceMs + this._resumeSilenceGraceMs
      : this._silenceMs;

    if (this._clock.now() - this._lastMessageAt > limitMs) {
      this._transport.close();
    }
  }

  // ***** завершение ***** //

  _terminate(closeCode) {
    if (this._state === S.closed) {
      return;
    }

    this._stopWatchdog();
    this._clearReconnectTimers();
    this._clearMigrationTimer();
    this._onRoleResumeFailed = null;
    this._setState(S.closed);
    this._onTerminal(closeCode);
  }

  _setState(state) {
    const prev = this._state;

    if (prev === state) {
      return;
    }

    this._state = state;
    this._onStateChange(state, prev);
  }
}
