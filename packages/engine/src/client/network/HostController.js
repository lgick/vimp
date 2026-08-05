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
   *   таймер) — для актуализации mapName у мастера.
   */
  constructor(
    room,
    { workerFactory, workerUrl, onReady, onError, onMapChange } = {},
  ) {
    this._room = room;
    this._workerFactory = workerFactory;
    this._worker = this._createWorker(workerUrl);

    this._onReady = onReady;
    this._onError = onError;
    this._onMapChange = onMapChange;
    this._ready = false;
    this._deliveries = new Map(); // socketId → { onMessage, onClose }
    this._pendingConnects = []; // socketId, ожидающие готовности Worker'а

    this._swap = null; // состояние эстафеты (Этап 5.2)

    // отладочные запросы в Worker (этап 6 плана plan/done/ai-debug):
    // requestId → { resolve, reject }
    this._debugRequests = new Map();
    this._debugRequestId = 0;

    this._worker.onmessage = e => this._onWorkerMessage(e.data);

    // старт авторитетной части в Worker'е
    this._worker.postMessage({ type: 'init', room });
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

  // регистрирует клиента и (при готовности) поднимает его соединение в Worker'е
  open(socketId, { onMessage, onClose }) {
    this._deliveries.set(socketId, { onMessage, onClose });

    if (!this._ready) {
      this._pendingConnects.push(socketId);
      return;
    }

    // пауза эстафеты: connect доедет в новый Worker (или в старый при отмене)
    if (this._swap?.paused) {
      this._enqueueSwapMessage({ type: 'connect', socketId });
      return;
    }

    this._worker.postMessage({ type: 'connect', socketId });
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

  // сообщает Worker'у hostId + per-room секрет, подтверждённые мастером при
  // register_host (кодревью №1, plan/server-rating/review.md) — не известны
  // при создании Worker'а (постится в него раньше ответа мастера).
  // Сохраняются в _room, чтобы эстафета (swapWorker) тоже понесла их в новый
  // Worker через 'init'
  setHostId(hostId, hostSecret) {
    this._room.hostId = hostId;
    this._room.hostSecret = hostSecret;
    this._worker.postMessage({ type: 'set_host_id', hostId, hostSecret });
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
  // отладке нужен именно результат, а не факт отправки
  _debug(action) {
    if (this._swap?.paused) {
      return Promise.reject(new Error('worker swap in progress'));
    }

    this._debugRequestId += 1;

    const requestId = this._debugRequestId;

    return new Promise((resolve, reject) => {
      this._debugRequests.set(requestId, { resolve, reject });
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

  // останавливает Worker (закрытие комнаты)
  destroy() {
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
    if (!this._swap) {
      return; // своп уже отменён (destroy)
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
    next.postMessage({ type: 'init', room: this._room, handoff: state });
  }

  // сообщения нового Worker'а до завершения свопа: ждём только ready/error
  _onNextWorkerMessage(msg) {
    if (msg.type === 'ready') {
      this._finishSwap();
    } else if (msg.type === 'error') {
      this._abortSwap(msg.message);
    }
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

    this._swap = null;

    reject(new Error(reason || 'worker swap failed'));
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this._ready = true;

        for (const socketId of this._pendingConnects) {
          this._worker.postMessage({ type: 'connect', socketId });
        }

        this._pendingConnects.length = 0;
        this._onReady?.(msg);
        break;

      case 'error':
        this._onError?.(msg);
        break;

      case 'map_changed':
        this._onMapChange?.(msg.mapName);
        break;

      case 'handoff_state':
        this._onHandoffState(msg.state);
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
        this._deliveries.get(msg.socketId)?.onMessage(msg.payload, msg.reliable);
        break;

      case 'close_client':
        this._deliveries.get(msg.socketId)?.onClose(msg.code, msg.data);
        break;
    }
  }
}
