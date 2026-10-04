// Мост главного потока между Worker'ом хоста (авторитетная симуляция) и
// транспортами клиентов. Worker не имеет доступа к RTCPeerConnection — главный
// поток роутит пакеты: исходящие кадры Worker'а (to_client) → нужному клиенту,
// входящие сообщения клиентов → в Worker. В Фазе 1 единственный клиент —
// хост-игрок через LoopbackTransport; в Фазе 2 сюда же подключается
// HostConnectionManager (удалённые клиенты по WebRTC).
//
// Эстафета Worker'ов (Этап 5.2): swapWorker(url) заменяет Worker на новую
// версию кода без разрыва P2P — старый Worker отдаёт handoff-состояние на
// границе раунда, новый поднимается с ним, клиенты переподключаются
// внутренними connect'ами (WebRTC-каналы живут здесь и не трогаются).

// предохранитель от зависшего init нового Worker'а: не дождались ready —
// своп отменяется, комната продолжает жить на старом Worker'е
const SWAP_INIT_TIMEOUT = 15000;

// кап очереди клиентских сообщений, копящихся за паузу эстафеты
const SWAP_QUEUE_LIMIT = 2000;

// предел ожидания ответа Worker'а на отладочный запрос (dump/запись)
const DEBUG_TIMEOUT = 5000;

// ErrorEvent Worker'а в главном потоке: `error` там null (исключение между
// потоками не клонируется) — есть только message и filename/lineno/colno.
// Кадр собирается из них: без него у отчёта нет верхнего кадра, то есть ни
// различимого отпечатка, ни расшифровки по source map. Пустой message
// (Worker не загрузился) бокс отбросил бы — отсюда запасной текст
function workerErrorReport(event) {
  if (typeof event?.error?.stack === 'string') {
    return event.error;
  }

  const message = event?.message || 'Worker error';
  const stack = event?.filename
    ? `${message}\n    at ${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
    : null;

  return { message, stack };
}

export default class HostController {
  /**
   * @param {Object} room - настройки комнаты (имя/карта/лимит/таймеры).
   * @param {Object} [opts]
   * @param {Function} [opts.workerFactory] - фабрика Worker'а (для тестов);
   *   вызывается и при эстафете (с url новой версии).
   * @param {string} [opts.workerUrl] - URL worker-бандла из манифеста мастера
   *   (Этап 5.2); без него — бандловый URL (dev, обновлений кода нет).
   * @param {Function} [opts.onReady] - вызывается, когда Worker готов
   *   (авторитетная часть поднята) — момент регистрации хоста у мастера.
   *   При эстафете повторно не вызывается.
   * @param {Function} [opts.onError] - сбой инициализации Worker'а
   *   (WASM/конфиг): комната не поднялась, нужно вернуть пользователя в лобби.
   * @param {Function} [opts.onMapChange] - смена карты в комнате (голосование/
   *   таймер).
   * @param {Function} [opts.onLobbyInfoChange] - смена строки карточки
   *   комнаты в лобби (string|null) — для актуализации info у мастера.
   * @param {Object} [opts.diagnostics] - журнал клиентских ошибок
   *   (lib/diagnostics.js, plan/client-reports): туда уходят ошибки Worker'а.
   * @param {Uint8Array} [opts.checkpoint] - сжатая контрольная точка
   *   (host-migration этап 5): Worker поднимает матч из неё на паузе, старт —
   *   startAfterRestore(). Буфер передаётся списком переноса — после
   *   конструктора он у вызывающего пуст.
   * @param {number} [opts.seqFloor] - номер последнего кадра, который видели
   *   клиенты: восстановленный матч продолжит нумерацию дальше него.
   * @param {boolean} [opts.preload] - прогрев преемника (host-migration этап
   *   6): Worker импортирует плагин и компилирует wasm, матч не создаёт;
   *   готовность — onPreloaded.
   * @param {Function} [opts.onPreloaded] - Worker прогрет ({ gameId,
   *   gameVersion, wasmCompiled }).
   */
  constructor(
    room,
    {
      workerFactory,
      workerUrl,
      onReady,
      onError,
      onMapChange,
      onLobbyInfoChange,
      diagnostics,
      checkpoint = null,
      seqFloor = 0,
      preload = false,
      onPreloaded,
    } = {},
  ) {
    this._room = room;
    this._workerFactory = workerFactory;
    this._diagnostics = diagnostics ?? null;
    this._worker = this._createWorker(workerUrl);
    this._watchWorkerErrors(this._worker);

    this._onReady = onReady;
    this._onError = onError;
    this._onMapChange = onMapChange;
    this._onLobbyInfoChange = onLobbyInfoChange;
    this._onPreloaded = onPreloaded;
    this._ready = false;
    this._deliveries = new Map(); // socketId → { onMessage, onClose }
    this._pendingConnects = []; // connect-сообщения до готовности Worker'а

    this._swap = null; // состояние эстафеты (Этап 5.2)

    // ожидание границы раунда плановой передачей (host-migration этап 8d)
    this._roundBoundaryCallback = null;

    // подписчики готовых контрольных точек (host-migration этап 5)
    this._checkpointListeners = new Set();
    // период включённых периодических точек (null — выключены): новый Worker
    // эстафеты получает его заново, иначе поток точек бете молча встал бы
    this._checkpointIntervalMs = null;

    // подписчики метрик здоровья хоста (host-migration этап 9a)
    this._healthListeners = new Set();

    // отладочные запросы в Worker (этап 6 плана plan/done/ai-debug):
    // requestId → { resolve, reject }
    this._debugRequests = new Map();
    this._debugRequestId = 0;

    // ожидание ответа Worker'а на shutdown (закрытие комнаты)
    this._shutdownResolve = null;
    this._shutdownPromise = null;

    this._worker.onmessage = e => this._onWorkerMessage(e.data);

    // старт авторитетной части в Worker'е; контрольная точка — без копии
    if (preload) {
      this._worker.postMessage({ type: 'preload', room });
    } else if (checkpoint) {
      this._worker.postMessage({ type: 'init', room, checkpoint, seqFloor }, [
        checkpoint.buffer,
      ]);
    } else {
      this._worker.postMessage({ type: 'init', room });
    }
  }

  _createWorker(url) {
    if (this._workerFactory) {
      return this._workerFactory(url);
    }

    return url
      ? new Worker(url, { type: 'module' })
      : new Worker(new URL('../../host/host.worker.js', import.meta.url), {
          type: 'module',
        });
  }

  // журнал клиентских ошибок (plan/client-reports): неперехваченная ошибка
  // Worker'а приходит сюда. preventDefault не зовётся — консольный вывод
  // браузера остаётся как есть
  _watchWorkerErrors(worker) {
    worker.onerror = event =>
      this._diagnostics?.capture(workerErrorReport(event), {
        source: 'host-worker',
        kind: 'worker',
      });
    worker.onmessageerror = () =>
      this._diagnostics?.capture('messageerror', {
        source: 'host-worker',
        kind: 'worker',
      });
  }

  // регистрирует клиента и (при готовности) поднимает его соединение в Worker'е
  // resume — переподключение гостя к матчу (host-migration этап 4): Worker
  // ждёт RESUME_REQUEST вместо хендшейка. Флаг едет только когда поднят —
  // сообщение остаётся тем же, что понимал Worker до этапа 4
  open(socketId, { onMessage, onClose, resume = false }) {
    this._deliveries.set(socketId, { onMessage, onClose });

    const msg = resume
      ? { type: 'connect', socketId, resume: true }
      : { type: 'connect', socketId };

    if (!this._ready) {
      this._pendingConnects.push(msg);
      return;
    }

    // пауза эстафеты: connect доедет в новый Worker (или в старый при отмене)
    if (this._swap?.paused) {
      this._enqueueSwapMessage(msg);
      return;
    }

    this._worker.postMessage(msg);
  }

  // пересылает входящее сообщение клиента в Worker
  send(socketId, data) {
    const msg = { type: 'message', socketId, data };

    if (this._swap?.paused) {
      this._enqueueSwapMessage(msg);
      return;
    }

    this._worker.postMessage(msg);
  }

  // отключает клиента
  disconnect(socketId) {
    this._deliveries.delete(socketId);

    const msg = { type: 'disconnect', socketId };

    if (this._swap?.paused) {
      this._enqueueSwapMessage(msg);
      return;
    }

    this._worker.postMessage(msg);
  }

  // сообщает Worker'у roomId + секрет эпохи, подтверждённые мастером в
  // host_registered — не известны при создании Worker'а (постится в него
  // раньше ответа мастера). Сохраняются в _room, чтобы эстафета (swapWorker)
  // тоже понесла их в новый Worker через 'init'
  setRoom({ roomId, roomSecret, epoch }) {
    this._room.roomId = roomId;
    this._room.roomSecret = roomSecret;
    this._room.epoch = epoch;
    this._worker.postMessage({ type: 'set_room', roomId, roomSecret, epoch });
  }

  // передаёт обновлённый каталог карт мастера в Worker (Этап 5.1);
  // применится со следующей смены карты
  updateMaps(maps) {
    // новый Worker эстафеты должен подняться на актуальных картах
    this._room.maps = maps;

    const msg = { type: 'update_maps', maps };

    if (this._swap?.paused) {
      this._enqueueSwapMessage(msg);
      return;
    }

    this._worker.postMessage(msg);
  }

  /**
   * Эстафета Worker'ов (Этап 5.2): заменяет Worker на бандл новой версии.
   * Старый Worker останавливается на ближайшей границе раунда и отдаёт
   * handoff-состояние; новый поднимается с ним, все живые клиенты
   * переподключаются внутренними connect'ами. Сбой нового Worker'а —
   * откат: старый возобновляется, комната живёт на прежней версии.
   * @param {string} url - URL worker-бандла из манифеста мастера.
   * @param {Object} [game] - свежий room.game (Этап 6.5: {id, version,
   *   hostEntryUrl, wasmUrl}) — подменяет закэшированный с момента создания
   *   комнаты перед init нового Worker'а, чтобы деплой игры тоже подхватывался
   *   эстафетой, а не только деплой движка.
   * @returns {Promise<void>}
   */
  swapWorker(url, game) {
    if (this._swap) {
      return Promise.reject(new Error('worker swap already in progress'));
    }

    if (!this._ready) {
      return Promise.reject(new Error('worker is not ready'));
    }

    return new Promise((resolve, reject) => {
      this._swap = {
        url,
        game,
        paused: false,
        queue: [],
        next: null,
        timeout: null,
        resolve,
        reject,
      };

      this._worker.postMessage({ type: 'prepare_handoff' });
    });
  }

  /**
   * Снять эстафету, ждущую границы раунда (плановая передача хоста
   * важнее). Своп уже переносит состояние — снять нельзя.
   * @returns {boolean} эстафета снята.
   */
  cancelPendingSwap() {
    if (!this._swap || this._swap.paused) {
      return false;
    }

    const { reject } = this._swap;

    this._swap = null;
    this._worker.postMessage({ type: 'cancel_handoff' });
    reject(new Error('swap preempted'));

    return true;
  }

  // ***** контрольные точки (host-migration этап 5) ***** //

  /**
   * Периодические контрольные точки: Worker снимает их на границе кадра не
   * чаще intervalMs и отдаёт подписчикам onCheckpoint.
   * @param {number} intervalMs
   */
  startCheckpoints(intervalMs) {
    this._checkpointIntervalMs = intervalMs;

    // пауза эстафеты: состояние доедет до нужного Worker'а в конце свопа
    if (!this._swap?.paused) {
      this._worker.postMessage({ type: 'checkpoint_start', intervalMs });
    }
  }

  stopCheckpoints() {
    this._checkpointIntervalMs = null;

    if (!this._swap?.paused) {
      this._worker.postMessage({ type: 'checkpoint_stop' });
    }
  }

  // текущее состояние периодических точек — Worker'у после эстафеты
  _postCheckpointState(worker) {
    worker.postMessage(
      this._checkpointIntervalMs === null
        ? { type: 'checkpoint_stop' }
        : {
            type: 'checkpoint_start',
            intervalMs: this._checkpointIntervalMs,
          },
    );
  }

  /**
   * Одна точка на ближайшей границе кадра.
   * @param {Object} [options]
   * @param {boolean} [options.final] - финальная (перед плановой передачей).
   */
  requestCheckpoint({ final = false } = {}) {
    const msg = { type: 'checkpoint_request', final };

    if (this._swap?.paused) {
      this._enqueueSwapMessage(msg);
      return;
    }

    this._worker.postMessage(msg);
  }

  /**
   * Подписка на готовые точки: cb({ checkpointId, seq, createdAt, final,
   * mode, bytes }).
   * @param {Function} cb
   * @returns {Function} Отписка.
   */
  onCheckpoint(cb) {
    this._checkpointListeners.add(cb);

    return () => this._checkpointListeners.delete(cb);
  }

  /**
   * Подписка на метрики здоровья хоста (host-migration этап 9a): раз в ~1 с,
   * пока матч идёт — cb({ tickRate, maxGapMs, lostMs, windowMs,
   * peerRttMedian, peerCount }). Переживает эстафету Worker'ов.
   * @param {Function} cb
   * @returns {Function} Отписка.
   */
  onHealth(cb) {
    this._healthListeners.add(cb);

    return () => this._healthListeners.delete(cb);
  }

  /**
   * Плановая передача хоста (host-migration этап 8d): cb сработает на
   * ближайшей границе раунда — у игры с migration.midRound сразу (решает
   * Worker). Новый вызов заменяет прежний колбэк.
   * @param {Function} cb
   */
  awaitRoundBoundary(cb) {
    this._roundBoundaryCallback = cb;
    this._worker.postMessage({ type: 'round_boundary_wait' });
  }

  cancelRoundBoundary() {
    if (this._roundBoundaryCallback) {
      this._roundBoundaryCallback = null;
      this._worker.postMessage({ type: 'round_boundary_cancel' });
    }
  }

  // заморозка матча: цикл и отсчёты встают с остатками
  freeze() {
    this._worker.postMessage({ type: 'freeze' });
  }

  unfreeze() {
    this._worker.postMessage({ type: 'unfreeze' });
  }

  // матч поднят из контрольной точки — запустить цикл и таймеры.
  // waitForResume — промоушен преемника: Worker ждёт возврата людей точки
  // (не дольше resumeWaitMs) и заводит не вернувшимся ожидание; reason —
  // причина передачи из promote (сообщение игрокам о смене хоста)
  startAfterRestore({ waitForResume = false, reason = null } = {}) {
    if (!waitForResume) {
      this._worker.postMessage({ type: 'start_after_restore' });
      return;
    }

    this._worker.postMessage(
      reason
        ? { type: 'start_after_restore', waitForResume: true, reason }
        : { type: 'start_after_restore', waitForResume: true },
    );
  }

  /**
   * Поднимает матч из контрольной точки в прогретом Worker'е (режим
   * preload, host-migration этап 7.4). Колбэки — те же, что у конструктора:
   * у прогрева они были свои.
   * @param {Object} room - настройки комнаты (roomId, epoch, game, …).
   * @param {Uint8Array} checkpoint - сжатая точка; буфер передаётся
   *   списком переноса.
   * @param {Object} [opts] - { seqFloor, onReady, onError, onMapChange,
   *   onLobbyInfoChange }.
   */
  initFromCheckpoint(
    room,
    checkpoint,
    { seqFloor = 0, onReady, onError, onMapChange, onLobbyInfoChange } = {},
  ) {
    this._room = room;
    this._onReady = onReady;
    this._onError = onError;
    this._onMapChange = onMapChange;
    this._onLobbyInfoChange = onLobbyInfoChange;
    this._worker.postMessage({ type: 'init', room, checkpoint, seqFloor }, [
      checkpoint.buffer,
    ]);
  }

  /**
   * Отладочный контур (этап 6 плана plan/done/ai-debug): начинает запись живого
   * матча в формат сценария headless-runner'а.
   * @returns {Promise<boolean>} false — dev-режим в комнате выключен.
   */
  startRecording() {
    return this._debug('startRecording');
  }

  /**
   * Останавливает запись и отдаёт сценарий (`npm run sim:replay`).
   * @returns {Promise<Object|null>}
   */
  stopRecording() {
    return this._debug('stopRecording');
  }

  /**
   * Дамп авторитетной половины: мета хоста + мир ядра (этап 4).
   * @returns {Promise<Object>}
   */
  dump() {
    return this._debug('dump');
  }

  // запрос/ответ с Worker'ом по requestId: postMessage односторонний, а
  // отладке нужен именно результат, а не факт отправки. Таймаут обязателен:
  // отладка нужна ровно на зависшем Worker'е, а там ответа не будет никогда —
  // молча висящий await в консоли и есть тот отказ, против которого всё это
  // писалось
  _debug(action, timeoutMs = DEBUG_TIMEOUT) {
    if (this._swap?.paused) {
      return Promise.reject(new Error('worker swap in progress'));
    }

    this._debugRequestId += 1;

    const requestId = this._debugRequestId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._debugRequests.delete(requestId);
        reject(
          new Error(
            `debug request '${action}' timed out after ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);

      this._debugRequests.set(requestId, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this._worker.postMessage({ type: 'debug', action, requestId });
    });
  }

  // ответы приходят от конкретного Worker'а: его смерть (destroy, эстафета)
  // означает, что ждать нечего — висящий промис хуже честной ошибки
  _rejectDebugRequests(reason) {
    for (const { reject } of this._debugRequests.values()) {
      reject(new Error(reason));
    }

    this._debugRequests.clear();
  }

  /**
   * Корректное закрытие комнаты: Worker закрывает игры участников и пишет
   * профили (HostGame.destroy). Разрешается по ответу Worker'а или по
   * таймауту — Worker не гасится, это делает destroy().
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<void>}
   */
  shutdown({ timeoutMs = 3000 } = {}) {
    // эстафета переносит состояние в новый Worker, закрывать нечего
    if (this._swap) {
      return Promise.resolve();
    }

    // повторный вызов (второй клик «Leave server») — тот же промис: второй
    // HostGame.destroy() поверх идущего повторил бы flush (двойной зачёт)
    if (this._shutdownPromise) {
      return this._shutdownPromise;
    }

    this._shutdownPromise = new Promise(resolve => {
      // страховка поверх таймаута Worker'а: зависший Worker не ответит вовсе
      const timer = setTimeout(
        () => this._shutdownResolve?.(),
        timeoutMs + 500,
      );

      this._shutdownResolve = () => {
        clearTimeout(timer);
        this._shutdownResolve = null;
        resolve();
      };
      this._worker.postMessage({ type: 'shutdown', timeoutMs });
    });

    return this._shutdownPromise;
  }

  // останавливает Worker (закрытие комнаты)
  destroy() {
    this._shutdownResolve?.();

    this._rejectDebugRequests('host destroyed');

    if (this._swap) {
      this._swap.next?.terminate();
      this._clearSwapTimeout();
      this._swap = null;
    }

    this._worker.terminate();
  }

  _enqueueSwapMessage(msg) {
    if (this._swap.queue.length >= SWAP_QUEUE_LIMIT) {
      return; // пауза затянулась — свежие сообщения дропаются
    }

    this._swap.queue.push(msg);
  }

  _clearSwapTimeout() {
    if (this._swap?.timeout) {
      clearTimeout(this._swap.timeout);
      this._swap.timeout = null;
    }
  }

  // старый Worker достиг границы раунда и отдал состояние: поднять новый
  _onHandoffState(state) {
    // своп снят (cancelPendingSwap), а Worker успел отдать состояние раньше,
    // чем получил cancel_handoff: его таймеры стоят — вернуть к игре. После
    // destroy() Worker остановлен, сообщение ничего не сделает
    if (!this._swap) {
      this._worker.postMessage({ type: 'resume' });
      return;
    }

    this._swap.paused = true;

    // запись/дамп относятся к останавливаемому Worker'у — новый их не знает
    this._rejectDebugRequests('worker swap in progress');

    // Этап 6.5: своп несёт свежий манифест игры — новый Worker должен
    // грузить актуальный hostEntryUrl/wasmUrl, а не тот, с которым комната
    // стартовала (иначе деплой игры без деплоя движка не подхватился бы)
    if (this._swap.game) {
      this._room.game = this._swap.game;
    }

    const next = this._createWorker(this._swap.url);

    this._swap.next = next;
    this._swap.timeout = setTimeout(
      () => this._abortSwap('swap init timeout'),
      SWAP_INIT_TIMEOUT,
    );

    next.onmessage = e => this._onNextWorkerMessage(e.data);
    this._watchWorkerErrors(next);
    next.postMessage({ type: 'init', room: this._room, handoff: state });
  }

  // сообщения нового Worker'а до завершения свопа: ждём только ready/error,
  // но его сбои (в том числе провал init) попадают в журнал ошибок так же,
  // как у рабочего Worker'а
  _onNextWorkerMessage(msg) {
    if (msg.type === 'ready') {
      this._finishSwap();

      // новый Worker своё начальное значение отдельным lobby_info не шлёт
      // (считает его уже сообщённым), а оно могло измениться: новая версия
      // игры включила lobbyInfo, или карта/текст модулей другие. Worker без
      // поля (старше этапа 2 host-migration) карточку не трогает
      if ('lobbyInfo' in msg) {
        this._onLobbyInfoChange?.(msg.lobbyInfo ?? null);
      }
    } else if (msg.type === 'error') {
      this._reportWorkerMessage(msg, 'error');
      this._abortSwap(msg.message);
    } else if (msg.type === 'diagnostic') {
      this._reportWorkerMessage(msg, msg.kind);
    }
  }

  // сбой Worker'а, присланный сообщением ('error' — провал init,
  // 'diagnostic' — необработанный reject): стек — самого Worker'а, а не
  // главного потока
  _reportWorkerMessage(msg, kind) {
    this._diagnostics?.capture(
      { message: msg.message, stack: msg.stack ?? null },
      { source: 'host-worker', kind },
    );
  }

  // новый Worker готов: переподключить клиентов, дослать накопленное,
  // завершить эстафету и погасить старый Worker
  _finishSwap() {
    const { next, queue, resolve } = this._swap;

    this._clearSwapTimeout();

    for (const socketId of this._deliveries.keys()) {
      next.postMessage({ type: 'connect', socketId });
    }

    // накопленное за паузу — после connect'ов (порт-машины уже подняты);
    // дубль connect безвреден (Worker игнорирует повторные)
    for (const msg of queue) {
      next.postMessage(msg);
    }

    next.postMessage({ type: 'handoff_complete' });

    // новый Worker не знает, что точки были включены
    if (this._checkpointIntervalMs !== null) {
      this._postCheckpointState(next);
    }

    this._worker.terminate();
    this._worker = next;
    this._worker.onmessage = e => this._onWorkerMessage(e.data);
    this._swap = null;

    resolve();
  }

  // новый Worker не поднялся: вернуть старый к жизни, комната продолжает
  // жить на прежней версии кода
  _abortSwap(reason) {
    const { next, queue, reject } = this._swap;

    this._clearSwapTimeout();
    next?.terminate();

    this._worker.postMessage({ type: 'resume' });

    for (const msg of queue) {
      this._worker.postMessage(msg);
    }

    // за паузу точки могли включить или выключить
    this._postCheckpointState(this._worker);

    this._swap = null;

    reject(new Error(reason || 'worker swap failed'));
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this._ready = true;

        for (const msg of this._pendingConnects) {
          this._worker.postMessage(msg);
        }

        this._pendingConnects.length = 0;
        this._onReady?.(msg);
        break;

      case 'error':
        this._reportWorkerMessage(msg, 'error');
        this._onError?.(msg);
        break;

      case 'preloaded':
        this._onPreloaded?.(msg);
        break;

      case 'diagnostic':
        this._reportWorkerMessage(msg, msg.kind);
        break;

      case 'map_changed':
        this._onMapChange?.(msg.mapName);
        break;

      case 'lobby_info':
        this._onLobbyInfoChange?.(msg.info ?? null);
        break;

      case 'handoff_state':
        this._onHandoffState(msg.state);
        break;

      case 'round_boundary': {
        const cb = this._roundBoundaryCallback;

        this._roundBoundaryCallback = null;
        cb?.();
        break;
      }

      case 'checkpoint': {
        const checkpoint = { ...msg };

        delete checkpoint.type;

        for (const listener of this._checkpointListeners) {
          listener(checkpoint);
        }

        break;
      }

      case 'health':
        for (const listener of this._healthListeners) {
          listener(msg.health);
        }

        break;

      case 'shutdown_done':
        this._shutdownResolve?.();
        break;

      case 'debug_result': {
        const pending = this._debugRequests.get(msg.requestId);

        if (pending) {
          this._debugRequests.delete(msg.requestId);

          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }

        break;
      }

      case 'to_client':
        this._deliveries
          .get(msg.socketId)
          ?.onMessage(msg.payload, msg.reliable);
        break;

      case 'close_client':
        this._deliveries.get(msg.socketId)?.onClose(msg.code, msg.data);
        break;
    }
  }
}
