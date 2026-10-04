import { mergeRoomDefaults } from '../lib/formBuilder.js';
import {
  classifyRoomPoll,
  decideRouteAction,
  parseRoute,
  pickQuickPlayRoom,
  quickPlayCreateDelay,
} from '../lib/roomLink.js';
import { takePendingPromotion } from '../network/Promotion.js';

// Прямые ссылки (host-migration, этап 3): без hash — лобби, #/<gameId> —
// быстрая игра, #/<gameId>/<roomId> — вход в комнату (client/lib/roomLink.js).
// Разбор маршрута после логина и welcome, ожидание мигрирующей комнаты,
// холодный промоушен после перезагрузки и смена hash.
//
// Без глобального DOM: адрес, лобби, информер, сеть и вход в комнату
// инъектирует сборщик (client/main.js).

// ожидание брошено: hash сменился, маршрут разбирается заново
export const ROUTE_ABANDONED = Symbol('routeAbandoned');

// дефолты формы создания комнаты — то, что ушло бы в комнату по Create без
// правки полей: roomDefaults манифеста + default'ы самой схемы формы
export function roomDefaultsOf(manifest) {
  const defaults = { ...manifest.roomDefaults };

  if (Array.isArray(manifest.roomForm)) {
    for (const field of mergeRoomDefaults(
      manifest.roomForm,
      manifest.roomDefaults ?? {},
    )) {
      if (field.default !== undefined) {
        defaults[field.name] = field.default;
      }
    }
  }

  return defaults;
}

export default class RouteBoot {
  /**
   * @param {Object} deps
   * @param {Object} deps.ctx - client/session/roomContext.js.
   * @param {Object} deps.signaling - SignalingClient.
   * @param {Object} deps.membership - client/session/Membership.js.
   * @param {Object} deps.config - lobby-конфиг (session, quickPlay, create,
   *   roomUrl, quickPlayUrl).
   * @param {Map} deps.gamesById - каталог манифестов вкладки.
   * @param {Function} deps.selectActiveGame - (gameId, { report }) → bool.
   * @param {Function} deps.connectToRoom - (roomId) вход гостем.
   * @param {Function} deps.createRoom - (room, { promotion }) поднять
   *   комнату в этой вкладке.
   * @param {Function} deps.fetchServers - ({ search }) → список | null.
   * @param {Object} deps.ui - { initLobby(), selectLobbyGame(gameId),
   *   informTech(text?), onInformerClick(handler), getHash(),
   *   setRoute(hash), reloadPage(hash) }.
   * @param {Function} [deps.fetch]
   * @param {Function} [deps.getStorage] - () → sessionStorage (может бросить).
   * @param {Function} [deps.sleep] - (ms) → Promise.
   * @param {Function} [deps.now] - монотонные часы, мс.
   */
  constructor({
    ctx,
    signaling,
    membership,
    config,
    gamesById,
    selectActiveGame,
    connectToRoom,
    createRoom,
    fetchServers,
    ui,
    fetch = (...args) => globalThis.fetch(...args),
    getStorage = () => window.sessionStorage,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => performance.now(),
  }) {
    this._ctx = ctx;
    this._signaling = signaling;
    this._membership = membership;
    this._config = config;
    this._gamesById = gamesById;
    this._selectActiveGame = selectActiveGame;
    this._connectToRoom = connectToRoom;
    this._createRoom = createRoom;
    this._fetchServers = fetchServers;
    this._ui = ui;
    this._fetch = fetch;
    this._getStorage = getStorage;
    this._sleep = sleep;
    this._now = now;

    // маршрут разбирается один раз: повторный welcome (реконнект
    // сигналинга) бутстрап не повторяет
    this._booted = false;
    // маршрут в работе (ждёт /rooms или /servers): hashchange в это время не
    // запускает второй бутстрап — тот дошёл бы до connectToRoom/createRoom
    // параллельно первому (два транспорта в одной вкладке). Новый hash
    // разбирается после текущего, если вкладка так и не вошла в комнату
    this._running = false;
    this._rerun = false;
  }

  get booted() {
    return this._booted;
  }

  // первый разбор маршрута (после логина и welcome)
  boot() {
    if (this._booted) {
      return;
    }

    this._booted = true;
    this.run();
  }

  async run() {
    if (this._running) {
      this._rerun = true;

      return;
    }

    this._running = true;

    try {
      do {
        this._rerun = false;
        await this._bootRoute();
      } while (this._rerun && !this._ctx.entered);
    } finally {
      this._running = false;
    }
  }

  // hashchange: вне комнаты — новый маршрут бутстрапом; в комнате — ссылка на
  // неё же ничего не меняет, любой другой маршрут — перезагрузкой (матч не
  // разбирается без неё). replaceState (setRoute) это событие не порождает
  handleHashChange() {
    if (!this._booted) {
      return; // бутстрап ещё впереди и сам прочитает hash
    }

    if (!this._ctx.entered) {
      this.run();

      return;
    }

    const hash = this._ui.getHash();
    const route = parseRoute(hash);

    if (route.kind === 'room' && route.roomId === this._ctx.roomId) {
      return;
    }

    this._ui.reloadPage(hash);
  }

  // разбор маршрута после логина и welcome (только лобби-режим)
  async _bootRoute() {
    const route = parseRoute(this._ui.getHash());
    const pending = this._takeRoutePromotion(route);

    if (pending && (await this._promoteCold(pending))) {
      return;
    }

    let roomInfo =
      route.kind === 'room' ? await this._fetchRoom(route.roomId) : null;
    let decision = decideRouteAction(route, roomInfo, this._gamesById);

    if (decision.action === 'wait') {
      roomInfo = await this._waitRoomOnline(decision.roomId);

      if (roomInfo === ROUTE_ABANDONED) {
        return;
      }

      decision = decideRouteAction(route, roomInfo, this._gamesById);
    }

    switch (decision.action) {
      case 'join':
        await this._joinFromRoute(decision.gameId, decision.roomId);
        break;

      case 'quickPlay':
        await this._quickPlay(decision.gameId);
        break;

      default:
        if (route.kind === 'none') {
          this._ui.initLobby();
        } else {
          this._showLobby({ informer: decision.informer });
        }
    }
  }

  // комната по прямому id; null — её нет или мастер не ответил (тогда —
  // быстрая игра той же игры, как для мёртвой ссылки)
  async _fetchRoom(roomId) {
    return (await this._pollRoom(roomId)).info;
  }

  // GET /rooms/:roomId со статусом: ожиданию миграции важно отличить
  // «комнаты нет» (404) от сбоя запроса. status null — запрос не дошёл
  async _pollRoom(roomId) {
    try {
      const res = await this._fetch(this._config.roomUrl(roomId));

      return { status: res.status, info: res.ok ? await res.json() : null };
    } catch {
      return { status: null, info: null };
    }
  }

  // информер, который игрок закрывает кликом: причина отказа маршрута видна
  // поверх лобби, но лобби остаётся рабочим
  _showDismissibleInformer(text) {
    if (text) {
      this._ui.informTech(text);
    }

    this._ui.onInformerClick(() => this._ui.informTech());
  }

  // лобби вместо маршрута: адрес — без hash (иначе F5 повторил бы маршрут),
  // игра маршрута — выбрана в селекторе
  _showLobby({ gameId, informer } = {}) {
    this._ui.setRoute('');
    this._ui.initLobby();

    if (gameId && this._gamesById.has(gameId)) {
      this._ui.selectLobbyGame(gameId);
    }

    if (informer) {
      this._showDismissibleInformer(informer);
    }
  }

  // активация игры маршрута: лобби ещё нет (строку формы, куда пишет
  // selectActiveGame по умолчанию, initLobby тут же перетёр бы), поэтому
  // отказ показывается поверх лобби информером
  async _activateRouteGame(gameId) {
    let failure = null;

    if (
      await this._selectActiveGame(gameId, {
        report: text => (failure = text),
      })
    ) {
      return true;
    }

    this._showLobby({ gameId, informer: failure });

    return false;
  }

  // вход по маршруту — лобби не показывается вовсе: игрок сразу видит экран
  // авторизации игры (AUTH_DATA → #auth)
  async _joinFromRoute(gameId, roomId) {
    if (await this._activateRouteGame(gameId)) {
      this._connectToRoom(roomId);
    }
  }

  // самая наполненная неполная комната игры: её выбирает мастер; мастер без
  // роута или сбой — выбор по полному списку, как раньше
  async _findQuickPlayRoom(gameId) {
    try {
      const res = await this._fetch(this._config.quickPlayUrl(gameId));

      if (res.ok) {
        const { room } = await res.json();

        return room && typeof room.roomId === 'string' ? room : null;
      }
    } catch {
      // ниже — запасной путь
    }

    const list = await this._fetchServers({ search: gameId });

    return pickQuickPlayRoom(list?.servers, gameId);
  }

  // быстрая игра: самая наполненная неполная комната игры, иначе своя
  async _quickPlay(gameId) {
    const quickPlay = this._config.quickPlay;
    let room = await this._findQuickPlayRoom(gameId);

    // гости закрытой комнаты приходят сюда разом: случайная пауза и второй
    // взгляд на список — комнату создаст первый, остальные в неё войдут
    if (!room && quickPlay.autoCreate) {
      await this._sleep(quickPlayCreateDelay(quickPlay));
      room = await this._findQuickPlayRoom(gameId);
    }

    if (room) {
      await this._joinFromRoute(gameId, room.roomId);

      return;
    }

    if (!quickPlay.autoCreate) {
      this._showLobby({ gameId });

      return;
    }

    const manifest = this._gamesById.get(gameId);

    if (!(await this._activateRouteGame(gameId))) {
      return;
    }

    await this._createRoom({
      hostSocketId: this._config.create.hostSocketId,
      ...roomDefaultsOf(manifest),
    });

    // браузер не может быть хостом (createRoom уже показал причину): лобби
    // под ней, войти в чужую комнату он всё ещё может
    if (!this._ctx.entered) {
      this._showLobby({ gameId });
      this._showDismissibleInformer();
    }
  }

  // комната по ссылке меняет хоста: ждём, пока она снова станет online.
  // null — комната пропала или так и не дождались (тогда — быстрая игра);
  // ROUTE_ABANDONED — игрок ушёл по другой ссылке (run повторит разбор)
  async _waitRoomOnline(roomId) {
    // крайний срок — с запасом на цепочку кандидатов (дедлайн каждого — у
    // мастера); 404 обрывает ожидание раньше
    const { linkWaitMaxMs, migrationPollMs } = this._config.session;
    const deadline = this._now() + linkWaitMaxMs;

    this._ui.informTech('Switching host…');

    try {
      while (this._now() < deadline) {
        await this._sleep(migrationPollMs);

        if (this._rerun) {
          return ROUTE_ABANDONED;
        }

        const poll = await this._pollRoom(roomId);

        if (this._rerun) {
          return ROUTE_ABANDONED;
        }

        switch (classifyRoomPoll(poll)) {
          case 'online':
            return poll.info;
          case 'gone':
            return null;
        }
      }

      return null;
    } finally {
      this._ui.informTech();
    }
  }

  // холодный промоушен (host-migration этап 7.4): страница перезагружена в
  // комнату, чтобы поднять её матч заново. Запись снимается при любом исходе
  _takeRoutePromotion(route) {
    let storage = null;

    try {
      storage = this._getStorage();
    } catch {
      return null;
    }

    const pending = takePendingPromotion(storage);

    return pending &&
      route.kind === 'room' &&
      route.gameId === pending.gameId &&
      route.roomId === pending.roomId
      ? pending
      : null;
  }

  // занимает комнату холодным промоушеном. false — вкладка хостить не может,
  // маршрут разбирается как обычный вход гостем
  async _promoteCold(pending) {
    // вход истёк за время перезагрузки — комнату займёт другой кандидат
    if (!this._membership.tokenAllowsHostRole()) {
      this._signaling.promoteFailed(pending);

      return false;
    }

    if (!(await this._activateRouteGame(pending.gameId))) {
      this._signaling.promoteFailed(pending);

      return true;
    }

    this._ctx.roomId = pending.roomId;

    await this._createRoom(
      {
        hostSocketId: this._config.create.hostSocketId,
        ...roomDefaultsOf(this._gamesById.get(pending.gameId)),
        ...pending.settings,
      },
      { promotion: pending },
    );

    if (this._ctx.entered) {
      return true;
    }

    this._ctx.roomId = null;
    this._signaling.promoteFailed(pending);

    return false;
  }
}
