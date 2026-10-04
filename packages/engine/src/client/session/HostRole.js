import { sanitizeRoomSettings } from '../../lib/roomSettings.js';
import HiddenHostHealthLog from '../network/HiddenHostHealthLog.js';
import HostConnectionManager from '../network/HostConnectionManager.js';
import HostController from '../network/HostController.js';
import HostHealthReporter from '../network/HostHealthReporter.js';
import LoopbackTransport from '../network/LoopbackTransport.js';
import RoomPeersReporter from '../network/RoomPeersReporter.js';
import StandbySender from '../network/StandbySender.js';
import { supportsModuleWorker } from '../network/workerSupport.js';

// Роль хоста (общая для создания комнаты и промоушена, host-migration этап
// 7.4): Worker комнаты, приём офферов, поток контрольных точек бете,
// регистрация у мастера и её возврат после реконнекта сигналинга,
// обновление карт и эстафета Worker'ов на новую версию кода.
//
// Без DOM: сигналинг, плановую передачу, промоушен, UI-действия и фабрики
// инъектирует сборщик (client/main.js).

// сравнимый ключ составного codeVersion (Этап 6.5): движок + игра —
// расхождение любой половины (деплой движка ИЛИ деплой игры) запускает
// эстафету
export function codeVersionKey(cv) {
  return cv
    ? `${cv.engine ?? ''}:${cv.game?.id ?? ''}:${cv.game?.version ?? ''}`
    : null;
}

export function codeVersionChanged(remote, local) {
  return codeVersionKey(remote) !== codeVersionKey(local);
}

export default class HostRole {
  /**
   * @param {Object} deps
   * @param {Object} deps.signaling - SignalingClient.
   * @param {Object} deps.ctx - client/session/roomContext.js.
   * @param {Object} deps.membership - client/session/Membership.js.
   * @param {Object} deps.config - lobby-конфиг.
   * @param {Object} deps.diagnostics
   * @param {Object} deps.prep - client/session/hostRoomPrep.js.
   * @param {Function} deps.getActiveGame - () → манифест активной игры.
   * @param {Function} deps.getToken - () → identity-токен.
   * @param {Function} deps.getHandoff - () → HandoffFlow.
   * @param {Function} deps.onPromotionRegistered - (hostPromotion) комната
   *   занята преемником (PromotionFlow.finish).
   * @param {Object} deps.ui - { showRoomLink(gameId, roomId),
   *   refreshRoomControls(), setHandoffMenu(state), isHidden(),
   *   informTech(text), ensureWebRtc() → bool, startSession(transport),
   *   closeLobby(), onStartFailed(msg) }.
   * @param {boolean} [deps.isLobbyMode]
   * @param {Function|null} [deps.debug] - debugLog dev-сборки.
   * @param {Object} [deps.factories] - конструкторы (тесты).
   * @param {Object} [deps.timers] - { setInterval, clearInterval }.
   */
  constructor({
    signaling,
    ctx,
    membership,
    config,
    diagnostics,
    prep,
    getActiveGame,
    getToken,
    getHandoff,
    onPromotionRegistered,
    ui,
    isLobbyMode = true,
    debug = null,
    factories = {},
    timers = globalThis,
  }) {
    this._signaling = signaling;
    this._ctx = ctx;
    this._membership = membership;
    this._config = config;
    this._diagnostics = diagnostics;
    this._prep = prep;
    this._getActiveGame = getActiveGame;
    this._getToken = getToken;
    this._getHandoff = getHandoff;
    this._onPromotionRegistered = onPromotionRegistered;
    this._ui = ui;
    this._isLobbyMode = isLobbyMode;
    this._debug = debug;
    this._timers = timers;
    this._factories = {
      supportsModuleWorker,
      controller: (room, options) => new HostController(room, options),
      connections: (sig, controller, options) =>
        new HostConnectionManager(sig, controller, options),
      peersReporter: options => new RoomPeersReporter(options),
      standbySender: options => new StandbySender(options),
      hiddenLog: options => new HiddenHostHealthLog(options),
      healthReporter: options => new HostHealthReporter(options),
      loopback: (controller, socketId, options) =>
        new LoopbackTransport(controller, socketId, options),
      ...factories,
    };

    this._controller = null;
    this._connections = null;
    this._heartbeat = null;
    // { roomId, epoch, roomSecret } из host_registered — с ними реконнект
    // сигналинга возвращает ту же комнату (reclaim_host)
    this._room = null;
    // настройки комнаты, которую хостит вкладка (поля register_host)
    this._roomConfig = null;
    // строка карточки комнаты в лобби (из 'ready'; далее — lobby_info
    // Worker'а): её задаёт игра (gameConfig.lobbyInfo), null — показывать
    // нечего
    this._lobbyInfo = null;
    // промоушен, ждущий host_registered: { mode: 'checkpoint'|'cold',
    // promotion: { roomId, epoch, promotionToken }, reason }
    this._promotion = null;
    // повторная регистрация комнаты у мастера (reconnect сигналинга)
    this._registration = null;
    // версия каталога карт мастера, с которой поднята комната (Этап 5.1)
    this._mapsVersion = null;
    // составной codeVersion комнаты (Этап 5.2/6.5): { engine, game: { id,
    // version } }; null — обновления кода отключены (манифест недоступен)
    this._codeVersion = null;
    // версия, своп на которую не удался — не ретраить её на каждом
    // re-register
    this._failedCodeVersion = null;
    // защита от параллельных эстафет Worker'ов
    this._swapInProgress = false;
    // бета, назначенная мастером комнате этой вкладки (successor_assigned)
    this._successorMemberId = null;

    // канал standby к бете и поток контрольных точек
    this._standbySender = null;
    // сводка здоровья матча за эпизод скрытой вкладки (этап 9a)
    this._hiddenLog = null;
    // host_health мастеру (этап 9c; лобби-режим): правило сетевого лага
    this._healthReporter = null;
    // room_peers мастеру: кто подключён к хосту по WebRTC (счётчик лобби и
    // кандидаты в беты — только они)
    this._peersReporter = null;
  }

  get controller() {
    return this._controller;
  }

  get room() {
    return this._room;
  }

  get roomConfig() {
    return this._roomConfig;
  }

  get promotion() {
    return this._promotion;
  }

  get codeVersion() {
    return this._codeVersion;
  }

  get swapInProgress() {
    return this._swapInProgress;
  }

  get successorMemberId() {
    return this._successorMemberId;
  }

  // число людей, подключённых к хосту по WebRTC
  get peerCount() {
    return this._connections?.peerCount ?? 0;
  }

  /**
   * Поднимает комнату в этой же вкладке (Worker хоста): хост-игрок играет
   * через loopback, удалённые клиенты — по WebRTC (answerer). promotion —
   * отложенный холодный промоушен (этап 7.4): вместо новой комнаты — занять
   * существующую.
   * @param {Object} room - настройки комнаты.
   * @param {Object} [options]
   * @param {Object|null} [options.promotion] - { roomId, epoch,
   *   promotionToken }.
   * @returns {Promise<void>}
   */
  async createRoom(room, { promotion = null } = {}) {
    // фича-детект вместо classic-фолбэка (запретил бы ESM/инлайн WASM,
    // см. PLAN.md риск №5): честная ошибка, join остаётся доступен
    if (!this._factories.supportsModuleWorker()) {
      this._ui.informTech(
        'This browser cannot be a host: ES module Web Workers are ' +
          'unsupported. You can still join existing rooms.',
      );

      return;
    }

    if (!this._ui.ensureWebRtc()) {
      return;
    }

    this._ctx.entered = true;

    const prepared = await this._prep.prepareHostRoom(room);

    const controller = this._factories.controller(room, {
      workerUrl: prepared.workerUrl,
      diagnostics: this._diagnostics,
      onReady: readyMsg => {
        // seed мира приезжает в 'ready' (этап 1): без него запись матча
        // невоспроизводима, поэтому он виден в консоли сразу
        this._debug?.('room ready', {
          map: readyMsg?.mapName,
          seed: readyMsg?.seed,
        });

        this.startRegistration(readyMsg?.lobbyInfo ?? null);
      },

      onLobbyInfoChange: info => this.handleLobbyInfo(info),

      // Worker не поднялся (WASM/конфиг): гасим комнату и возвращаемся в
      // лобби
      onError: msg => {
        // холодный преемник не справился — мастер возьмёт следующего
        if (this._promotion) {
          this._signaling.promoteFailed(this._promotion.promotion);
          this._promotion = null;
        }

        this._ui.onStartFailed(msg);
      },
    });

    this.adopt(controller, room, prepared, {
      promotion: promotion ? { mode: 'cold', promotion } : null,
    });

    // хост-игрок в этой же вкладке (socketId согласован с kick-исключением)
    // свой клиент хоста на loopback не рвётся: супервизор для него сквозной
    const transport = this._factories.loopback(
      controller,
      this._config.create.hostSocketId,
    );

    this._ui.startSession(transport);
    transport.connect();

    this._ui.closeLobby();
  }

  /**
   * Вкладка становится хостом для готового (или поднимающегося) Worker'а:
   * приём офферов, поток контрольных точек бете, регистрация у мастера.
   * Обработчики сигналинга роли — в bind (подписаны один раз).
   * @param {HostController} controller
   * @param {Object} room - настройки комнаты (room.game — манифест игры).
   * @param {Object} prepared - prepareHostRoom: { mapsVersion, codeVersion }.
   * @param {Object} [options]
   * @param {Object|null} [options.promotion] - { mode, promotion, reason } —
   *   занять комнату преемником (reason — причина передачи из promote).
   */
  adopt(controller, room, prepared, { promotion = null } = {}) {
    const migration = this._config.migration;
    const handoff = this._getHandoff();

    this._mapsVersion = prepared.mapsVersion;
    this._codeVersion = prepared.codeVersion;
    this._controller = controller;
    this._roomConfig = room;
    this._lobbyInfo = null;
    this._promotion = promotion;
    this._room = null;
    // хост — участник своей комнаты через register_host, не join_room
    this._membership.forget();
    this._membership.armTokenCapsTimer();
    handoff.armTokenHandoff();

    this._diagnostics.setContext({ role: 'host' });

    // удалённые клиенты по WebRTC
    this._connections = this._factories.connections(
      this._signaling,
      controller,
      {
        iceServers: this._signaling.iceServers,
        // бета могла подключиться позже назначения или переподключиться;
        // число людей в комнате — меню и защите закрытия
        onPeersChange: () => {
          this._standbySender?.refresh();
          this._peersReporter?.notify();
          this._ui.refreshRoomControls();
        },
      },
    );
    this._peersReporter = this._factories.peersReporter({
      send: report => this._signaling.roomPeers(report),
      getRoom: () => this._room,
      getMemberIds: () => this._connections?.connectedMemberIds() ?? [],
      intervalMs: migration.peersReportIntervalMs,
    });

    // преемник (host-migration этап 6): канал standby к бете, назначенной
    // мастером, и поток контрольных точек по нему
    this._standbySender = this._factories.standbySender({
      controller,
      connections: this._connections,
      intervalMs: migration.checkpointIntervalMs,
      chunkBytes: migration.standbyChunkBytes,
      highWaterBytes: migration.standbyHighWaterBytes,
      reopenDelayMs: migration.standbyReopenDelayMs,
      reopenMaxDelayMs: migration.standbyReopenMaxDelayMs,
      diagnostics: this._diagnostics,
      onStats: this._debug ? stats => this._debug('standby sent', stats) : null,
    });

    // метрики здоровья Worker'а (этап 9a): скрытая вкладка троттлит цикл —
    // насколько, уходит в журнал одной сводкой за эпизод
    this._hiddenLog = this._factories.hiddenLog({
      warn: (code, summary) =>
        this._diagnostics.warn(code, summary, { source: 'client' }),
      hidden: this._ui.isHidden(),
    });
    this._healthReporter = this._isLobbyMode
      ? this._factories.healthReporter({
          send: report => this._signaling.hostHealth(report),
          getRoom: () => this._room,
          intervalMs: migration.auto.hostHealthIntervalMs,
        })
      : null;
    controller.onHealth(health => {
      this._hiddenLog?.add(health);
      this._getHandoff().addHealth(health);
      this._healthReporter?.add(health);
    });
    handoff.setHost(true);
  }

  // Worker готов: регистрация комнаты у мастера и heartbeat
  startRegistration(lobbyInfo) {
    this._lobbyInfo = lobbyInfo;

    // периодический heartbeat/актуализация карточки у мастера; число
    // игроков мастер считает по участникам комнаты сам
    const update = () => this._signaling.updateHost({ info: this._lobbyInfo });

    // регистрация комнаты; при reconnect сигналинга — возврат той же
    // комнаты (reclaim_host), а fresh=true — новая комната, когда вернуть
    // прежнюю нельзя (её id занят или секрет не принят). Преемник до
    // host_registered занимает комнату promotionToken'ом
    this._registration = ({ fresh = false } = {}) => {
      const room = this._roomConfig;
      const fields = {
        gameId: room.game.id,
        gameVersion: room.game.version,
        maxPlayers: room.maxPlayers,
        info: this._lobbyInfo,
        token: this._getToken(),
        memberId: this._membership.memberId,
        caps: this._membership.caps(),
        // для холодного перезапуска комнаты преемником (этап 7.6)
        settings: sanitizeRoomSettings(room),
      };

      if (this._promotion) {
        this._signaling.registerHost({
          ...fields,
          promotion: this._promotion.promotion,
        });
      } else if (this._room && !fresh) {
        this._signaling.reclaimHost({ ...fields, ...this._room });
      } else {
        this._room = null;
        this._signaling.registerHost(fields);
      }

      this._timers.clearInterval(this._heartbeat);
      this._heartbeat = this._timers.setInterval(
        update,
        this._config.create.heartbeatInterval,
      );
    };

    this._registration();
  }

  // повтор регистрации (welcome после реконнекта; fresh — новая комната)
  reRegister(options) {
    this._registration?.(options);
  }

  // строка карточки сменилась (карта, опция игры) — сразу отразить в лобби
  // мастера
  handleLobbyInfo(info) {
    this._lobbyInfo = info;

    if (this._registration) {
      this._signaling.updateHost({ info });
    }
  }

  // скрытая вкладка: эпизод сводки здоровья (этап 9a)
  setHidden(hidden) {
    this._hiddenLog?.setHidden(hidden);
  }

  // закрытие скрытой вкладки: эпизод закрывается сводкой сейчас. true —
  // сводка была (вкладка хостит)
  flushHiddenLog() {
    if (!this._hiddenLog) {
      return false;
    }

    this._hiddenLog.flush();

    return true;
  }

  // снимает роль хоста: heartbeat, WebRTC-пиры, поток точек, Worker
  teardown() {
    const handoff = this._getHandoff();

    handoff.abort();
    handoff.cancelTokenHandoff();
    this._timers.clearInterval(this._heartbeat);
    this._heartbeat = null;
    this._standbySender?.destroy();
    this._standbySender = null;
    this._hiddenLog?.flush();
    this._hiddenLog = null;
    this._healthReporter = null;
    this._peersReporter?.destroy();
    this._peersReporter = null;
    handoff.setHost(false);
    this._connections?.destroy();
    this._connections = null;
    this._controller?.destroy();
    this._controller = null;
    this._diagnostics.setContext({ role: 'client' });
    this._registration = null;
    this._room = null;
    this._roomConfig = null;
    this._promotion = null;
    this._successorMemberId = null;
    this._ui.setHandoffMenu(null);
    this._ui.refreshRoomControls();
  }

  // подписки сигналинга роли хоста (лобби-режим, один раз на страницу: роль
  // может прийти и уйти несколько раз — создание, промоушен, host_revoked)
  bind() {
    const publisher = this._signaling.publisher;

    // хост: к кому открыть канал standby
    publisher.on('successor_assigned', msg => {
      if (this._standbySender && msg.roomId === this._room?.roomId) {
        this._successorMemberId = msg.successorMemberId ?? null;
        this._standbySender.setSuccessor(this._successorMemberId);
        this._getHandoff().setSuccessor(this._successorMemberId !== null);
        this._ui.refreshRoomControls();

        // в окне передачи по сроку входа бета появилась — передать сразу
        if (this._successorMemberId !== null) {
          this._getHandoff().armTokenHandoff();
        }
      }
    });

    // мастер отвечает актуальными версиями каталога карт и worker-бандла:
    // расхождение (деплой, пока комната жила) — подтянуть каталог к
    // следующей смене карты / заменить Worker эстафетой на границе раунда
    // (Этап 5.2)
    publisher.on('host_registered', msg => {
      if (!this._controller) {
        return; // комната уже погашена
      }

      this._room = {
        roomId: msg.roomId,
        epoch: msg.epoch,
        roomSecret: msg.roomSecret,
      };
      this._ctx.roomId = msg.roomId;
      this._ctx.epoch = msg.epoch;
      this._ui.showRoomLink(this._roomConfig.game.id, msg.roomId);

      // roomId + секрет эпохи не известны Worker'у до этого момента —
      // прокидываем их, чтобы PlayerDataSync атрибутировал последующие
      // rank/state-flush к этой комнате (секрет доказывает мастеру владение)
      this._controller.setRoom(this._room);
      // мастер (новый или после рестарта) узнаёт подключённых сразу
      this._peersReporter?.refresh();

      if (this._promotion) {
        const promotion = this._promotion;

        this._promotion = null;
        this._onPromotionRegistered(promotion);
      }

      if (msg.mapsVersion && msg.mapsVersion !== this._mapsVersion) {
        this.refreshMaps();
      }

      if (
        msg.codeVersion &&
        this._codeVersion &&
        codeVersionChanged(msg.codeVersion, this._codeVersion)
      ) {
        this.refreshWorker();
      }
    });

    // проба мастера (host-migration этап 7.3): гости жалуются, что хост
    // недоступен — главный поток подтверждает, что жив. Отвечает сразу, без
    // Worker'а: проба проверяет вкладку и её сигналинг, не матч
    publisher.on('probe', msg => {
      if (this._controller && msg.roomId === this._room?.roomId) {
        this._signaling.probeAck(msg.nonce);
      }
    });

    // сигнал мастера об обновлении каталога карт/кода
    publisher.on('update_available', msg => {
      if (!this._controller) {
        return;
      }

      if (!msg.mapsVersion || msg.mapsVersion !== this._mapsVersion) {
        this.refreshMaps();
      }

      if (
        msg.codeVersion &&
        this._codeVersion &&
        codeVersionChanged(msg.codeVersion, this._codeVersion)
      ) {
        this.refreshWorker();
      }
    });
  }

  // перечитывает каталог карт мастера и передаёт в Worker: применится со
  // следующей смены карты (текущий раунд не трогается)
  async refreshMaps() {
    try {
      const catalog = await this._prep.fetchMasterMaps();

      this._mapsVersion = catalog.version;
      this._controller?.updateMaps(catalog.maps);
    } catch (e) {
      console.warn('[maps] refresh from master failed:', e);
    }
  }

  // Этап 5.2/6.5: эстафета Worker'ов — новая версия кода (движка ИЛИ игры)
  // у мастера. Worker заменяется на границе раунда без разрыва P2P; сбой
  // свопа не смертелен — комната продолжает жить на прежней версии
  async refreshWorker() {
    if (
      this._swapInProgress ||
      !this._controller ||
      this._getHandoff().active
    ) {
      return;
    }

    this._swapInProgress = true;

    let manifest = null;
    let game = null;

    try {
      manifest = await this._prep.fetchWorkerManifest();
      const gameManifest = await this._prep.fetchGameManifest(
        this._getActiveGame().id,
      );

      game = {
        id: gameManifest.id,
        version: gameManifest.version,
        hostEntryUrl: gameManifest.entries.host,
        wasmUrl: gameManifest.entries.wasm,
      };

      const nextCodeVersion = {
        engine: manifest.version,
        game: { id: game.id, version: game.version },
      };
      const nextKey = codeVersionKey(nextCodeVersion);

      if (
        !manifest.version ||
        !manifest.url ||
        nextKey === codeVersionKey(this._codeVersion) ||
        nextKey === codeVersionKey(this._failedCodeVersion)
      ) {
        return;
      }

      await this._controller.swapWorker(manifest.url, game);

      this._codeVersion = nextCodeVersion;
      this._failedCodeVersion = null;
      console.info(`[worker] room migrated to code version ${nextKey}`);
    } catch (e) {
      // эстафету вытеснила плановая передача хоста — версия не сломана:
      // сорвётся передача — HandoffFlow запустит своп снова
      if (e.message === 'swap preempted') {
        console.info('[worker] swap preempted by planned host handoff');
        return;
      }

      if (manifest?.version) {
        this._failedCodeVersion = { engine: manifest.version, game };
      }

      console.warn('[worker] swap to new version failed:', e);
    } finally {
      this._swapInProgress = false;
    }
  }
}
