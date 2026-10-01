import Panel from './meta/modules/Panel.js';
import Accolades from './meta/modules/Accolades.js';
import PlayerDataSync from './meta/modules/PlayerDataSync.js';
import Stat from './meta/modules/Stat.js';
import Chat from './meta/modules/chat/index.js';
import { registerCodes } from './meta/modules/chat/systemMessages.js';
import Vote from './meta/modules/Vote.js';
import RTTManager from './meta/modules/RTTManager.js';
import TimerManager from './meta/modules/TimerManager.js';
import ParticipantManager from './meta/player/ParticipantManager.js';
import VoteCoordinator from './meta/core/VoteCoordinator.js';
import RoundManager from './meta/core/RoundManager.js';
import CommandProcessor from './meta/core/CommandProcessor.js';
import { sanitizeMessage } from '../lib/sanitizers.js';
import closeCodes from '../config/closeCodes.js';
import clock from '../lib/clock.js';
import { createResumeKey } from '../lib/resumeKey.js';
import GameCoreAdapter from './GameCoreAdapter.js';
import DebugRecorder from './DebugRecorder.js';
import enginePkg from '../../package.json' with { type: 'json' };

// Версия формата handoff-меты эстафеты Worker'ов (Этап 5.2; →2 в Этапе 6.5 —
// добавлены gameId/gameVersion; →3 в Этапе Д3 — нейтральное поле scripted;
// →4 в host-migration этапе 5 — контрольная точка посреди раунда).
// Несовместимая версия валит init нового Worker'а — главный поток
// возобновляет старый, комната продолжает жить на прежней версии кода.
// Восстановление принимает и v3: смена кода в открытой комнате передаёт
// состояние от Worker'а предыдущей версии
export const HANDOFF_VERSION = 4;

// версии handoff-меты, которые понимает восстановление
const LEGACY_HANDOFF_VERSION = 3;

// на сколько номер кадра уходит вперёд при восстановлении из контрольной
// точки: клиенты видели кадры новее точки, и кадр со старым номером
// интерполятор отбросил бы как устаревший
const RESTORE_SEQ_GAP = 30;

// заглушка соединения отсоединённого участника (host-migration этап 4):
// рассылки RoundManager/Chat/Vote на время паузы молча пропадают
const DETACHED_SOCKET = {
  send: () => {},
  sendBinary: () => {},
  close: () => {},
};

const detachedSocketId = gameId => `detached:${gameId}`;

// причина автоматической передачи (promote.reason) → системное сообщение
// вместо HOST_CHANGED
const HOST_CHANGED_BY_REASON = {
  overload: 'HOST_CHANGED_OVERLOAD',
  hidden: 'HOST_CHANGED_HIDDEN',
  network: 'HOST_CHANGED_NETWORK',
};

// Троттлинг отправки кадров (замена SnapshotManager: ядро само копит события
// и дренирует их в pack_body, здесь нужен только контроль частоты).
class SnapshotThrottle {
  constructor(sendRate) {
    this._sendRate = Math.max(1, sendRate || 1);
    this._tick = 0;
  }

  // тик игрового цикла: true — этот кадр отправляем, false — пропуск
  shouldSend() {
    this._tick += 1;

    if (this._tick < this._sendRate) {
      return false;
    }

    this._tick = 0;

    return true;
  }

  // сброс (смена карты) — совместимость с интерфейсом SnapshotManager
  reset() {
    this._tick = 0;
  }

  // фаза троттлинга — едет в контрольной точке (host-migration этап 5),
  // чтобы ритм отправки кадров не сбился после восстановления
  get tick() {
    return this._tick;
  }

  set tick(value) {
    this._tick = Math.min(Math.max(0, value >>> 0), this._sendRate - 1);
  }
}

// Host-фасад: авторитетная часть матча в Worker'е хоста. Симуляция,
// scripted-участники и упаковка снапшотов — в Rust-ядре через GameCoreAdapter, мета (RoundManager,
// участники, чат, голосования, статистика, панель) — JS-модули ./meta/.
// Питается стандартным словарём событий ядра (adapter._drainEvents →
// panel/reportKill/shake; 'custom' — HostPlugin.onCoreEvent).
export default class HostGame {
  /**
   * @param {Object} data - конфиг игры (merge hostDefaults + игровой
   *   конфиг HostPlugin.gameConfig; см. host.worker.js).
   * @param {Object} socketManager - транспорт (per-user send/close).
   * @param {GameCore} core - экземпляр WASM-ядра.
   * @param {Object} hostPlugin - HostPlugin игры, загруженной динамически по
   *   GameManifest (Этап 6.4): onCoreEvent/createModules/chatCommands/
   *   systemMessages.
   * @param {Object} [opts]
   * @param {string} [opts.hostSocketId] - socketId хоста-игрока (loopback):
   *   исключается из kick-политик — его отключение убивает комнату для всех.
   * @param {Function} [opts.onMapChange] - вызывается с именем карты при её
   *   смене (голосование/таймер).
   * @param {Function} [opts.onLobbyInfoChange] - вызывается со строкой
   *   карточки лобби (gameConfig.lobbyInfo / lobby.setInfo) или null при её
   *   смене — для актуализации комнаты у мастера.
   * @param {Object} [opts.handoff] - handoff-мета эстафеты Worker'ов
   *   (Этап 5.2): восстановление комнаты вместо холодного старта.
   * @param {string} [opts.gameVersion] - версия игры комнаты (room.game.version,
   *   Этап 6.5): едет в handoff-мете рядом с gameId — расхождение с игрой
   *   восстанавливающего Worker'а валит init тем же путём, что и версия формата.
   * @param {number} [opts.seed] - seed мира, которым инициализировано ядро
   *   (createHostRuntime): без него записанный сценарий невоспроизводим.
   * @param {Object} [opts.checkpoint] - распакованная контрольная точка
   *   { meta, core } (host-migration этап 5): матч поднимается из неё на
   *   паузе, люди — отсоединёнными (ждут RESUME), цикл запустит
   *   startAfterRestore().
   * @param {number} [opts.seqFloor] - номер последнего кадра, который могли
   *   видеть клиенты: seq восстановленного матча уходит дальше него.
   * @param {Object} [opts.roomSettings] - настройки комнаты (карта, лимит,
   *   таймеры, friendly fire) — едут в контрольной точке.
   * @param {string} [opts.mapsVersion] - версия каталога карт мастера.
   */
  constructor(
    data,
    socketManager,
    core,
    hostPlugin,
    {
      hostSocketId = null,
      onMapChange = null,
      onLobbyInfoChange = null,
      handoff = null,
      gameVersion = null,
      playerDataFetch = null,
      seed = null,
      checkpoint = null,
      seqFloor = 0,
      roomSettings = null,
      mapsVersion = null,
    } = {},
  ) {
    this._isDevMode = data.isDevMode || false;
    this._seed = seed;

    // контрольная точка (host-migration этап 5): игра гарантирует, что дамп
    // ядра и хуки модулей переносят всё её состояние посреди раунда
    this._migrationMidRound = data.migration?.midRound === true;
    this._handoffFlushTimeoutMs = data.handoffFlushTimeoutMs ?? 3000;
    // промоушен преемника (host-migration этап 7.4): сколько восстановленный
    // матч ждёт возврата людей точки перед стартом
    this._resumeWaitMs = data.resumeWaitMs ?? 3000;
    // настройки комнаты (то, что читает applyRoomOverrides): преемник
    // собирает по ним тот же конфиг ядра
    this._roomSettings = roomSettings;
    this._mapsVersion = mapsVersion;
    this._roomId = null;

    this._hostSocketId = hostSocketId;
    this._onMapChange = onMapChange;
    this._onLobbyInfoChange = onLobbyInfoChange;
    // строка карточки лобби: 'map' — текущая карта, иначе ничего; значение
    // модулей игры (lobby.setInfo) важнее
    this._lobbyInfoMode = data.lobbyInfo === 'map' ? 'map' : null;
    this._lobbyInfoOverride = null;

    // составной codeVersion (Этап 6.5): id — из самого загруженного плагина
    // (источник истины), version — то, что заявил Worker при инициализации
    this._gameId = hostPlugin.id;
    this._gameVersion = gameVersion;

    this._maps = data.maps;
    this._mapList = Object.keys(data.maps);
    this._spectatorKeys = data.spectatorKeys;
    // команды актора: отсоединённому участнику (host-migration этап 4) их
    // все отпускают — иначе танк ехал бы и стрелял всю паузу
    this._playerKeyNames = Object.keys(data.playerKeys ?? {});
    // эпоха комнаты (setRoom) — уходит в RESUME_RESULT
    this._epoch = null;
    this._maxPlayers = data.maxPlayers;
    this._chatMaxLength = data.chatMaxLength;

    this._idleTimeoutForPlayer = data.idleKickTimeout?.player || null;
    this._idleTimeoutForSpectator = data.idleKickTimeout?.spectator || null;

    this._teams = data.teams;

    // opt-in флаги игры: noSpectators — наблюдателей нет как концепции
    // (spectatorTeam/spectatorId равны null, вход ведёт прямо в игру),
    // endlessRound — раунд не перезапускается сам. Флаги независимы
    this._noSpectators = data.noSpectators === true;
    this._endlessRound = data.endlessRound === true;
    // statMode — чем игра занимает экран по Tab. 'leaderboard' значит, что
    // клиент рисует глобальный топ, который тянет сам: движковый stat в
    // этом режиме никто не рисует, и платить за его рассылку незачем
    this._statLeaderboard = data.statMode === 'leaderboard';
    this._spectatorTeam = this._noSpectators ? null : data.spectatorTeam;
    this._spectatorId = this._noSpectators
      ? null
      : this._teams[this._spectatorTeam];

    // единый реестр участников (игроки + scripted)
    this._participants = new ParticipantManager(
      this._teams,
      this._spectatorTeam,
      this._maxPlayers,
      data.scripted,
    );

    // симуляция — в ядре; адаптер под интерфейс Game.js
    this._game = new GameCoreAdapter(core, {
      participants: this._participants,
      onCoreEvent: hostPlugin.onCoreEvent,
    });

    this._panel = new Panel(data.panel);
    this._stat = new Stat(data.stat, this._teams);
    // rank/state участников (Этап B4) — подгрузка на join, синхронизация
    // обратно на мастер по границам раунда/карты (см. RoundManager)
    this._playerDataSync = new PlayerDataSync(this._gameId, {
      defaultState: data.playerState?.defaultState ?? {},
      // headless-прогону некуда ходить за профилем (относительный URL и нет
      // мастера) — подменяется только там, в проде остаётся глобальный fetch
      ...(playerDataFetch ? { fetchImpl: playerDataFetch } : {}),
    });
    // места участников в глобальном топе (snakes-v3 этап 4): косметика для
    // parts игры, движок не знает, какой знак игра нарисует за место
    this._accolades = new Accolades({
      participants: this._participants,
      gameId: this._gameId,
      // место и очки самого участника: их привозит PlayerDataSync на входе,
      // и без них игрок вне топа-10 не увидел бы по Tab собственной строки
      getRating: (id, period) => this._playerDataSync.getRating(id, period),
      // headless-прогону некуда ходить за топом — тот же подмен, что и у
      // PlayerDataSync
      ...(playerDataFetch ? { fetchImpl: playerDataFetch } : {}),
    });
    this._chat = new Chat();
    this._vote = new Vote();

    this._socketManager = socketManager;

    this._networkSendRate = data.timers.networkSendRate;
    this._snapshotManager = new SnapshotThrottle(this._networkSendRate);

    // рекордер живого матча (этап 6 плана plan/done/ai-debug) — только в dev-режиме;
    // в проде null, и все точки записи ниже вырождаются в ?.
    this._recorder = this._isDevMode ? new DebugRecorder() : null;

    // игровые host-модули (scripted-модуль игры); весь объект нужен
    // контрольной точке — хуки serializeState/restoreState по имени модуля
    this._modules = hostPlugin.createModules({
      participants: this._participants,
      coreAdapter: this._game,
      panel: this._panel,
      stat: this._stat,
      chat: this._chat,
      socketManager: this._socketManager,
      scripted: data.scripted,
      // строка карточки комнаты в лобби; на движке старше этого поля нет —
      // игра зовёт lobby?.setInfo
      lobby: { setInfo: text => this.setLobbyInfo(text) },
    });
    this._scripted = this._modules.scripted;

    this._RTTManager = new RTTManager(data.rtt, {
      onKickForMissedPings: gameId => this._kickForMissedPings(gameId),
      onKickForMaxLatency: gameId => this._kickForMaxLatency(gameId),
    });

    this._timerManager = new TimerManager(data.timers, {
      onMapTimeEnd: () => this._roundManager.onMapTimeEnd(),
      onRoundTimeEnd: () => this._roundManager.onRoundTimeEnd(),
      onShotTick: dt => this._onShotTick(dt),
      onIdleCheck: () => this._kickIdleUsers(),
      onSendPing: () => this._sendPing(),
      onLoopStats: stats => this._onLoopStats(stats),
    });

    this._voteCoordinator = new VoteCoordinator({
      vote: this._vote,
      chat: this._chat,
      timerManager: this._timerManager,
    });

    this._roundManager = new RoundManager({
      participants: this._participants,
      game: this._game,
      panel: this._panel,
      stat: this._stat,
      chat: this._chat,
      socketManager: this._socketManager,
      timerManager: this._timerManager,
      scripted: this._scripted,
      voteCoordinator: this._voteCoordinator,
      snapshotManager: this._snapshotManager,
      playerDataSync: this._playerDataSync,
      teams: this._teams,
      spectatorTeam: this._spectatorTeam,
      spectatorId: this._spectatorId,
      noSpectators: this._noSpectators,
      endlessRound: this._endlessRound,
      maps: data.maps,
      mapList: this._mapList,
      mapsInVote: data.mapsInVote,
      mapScale: data.mapScale,
      mapSetId: data.mapSetId,
      currentMap: data.currentMap,
    });

    this._commandProcessor = new CommandProcessor({
      participants: this._participants,
      chat: this._chat,
      scripted: this._scripted,
      roundManager: this._roundManager,
      voteCoordinator: this._voteCoordinator,
      timerManager: this._timerManager,
      playerDataSync: this._playerDataSync,
      teams: this._teams,
      spectatorTeam: this._spectatorTeam,
      spectatorId: this._spectatorId,
      isDevMode: this._isDevMode,
    });

    // игровые чат-команды и коды системных сообщений из HostPlugin
    for (const command of hostPlugin.chatCommands) {
      this._commandProcessor.registerCommand(command.name, command.handler);
    }

    registerCodes(hostPlugin.systemMessages);

    // инкрементный номер snapshot-кадра
    this._seq = 0;

    // эстафета Worker'ов (Этап 5.2)
    this._handoffRestored = false;
    this._handoffMapTimeLeft = null;

    // контрольные точки (host-migration этап 5)
    this._checkpointSink = null; // ({ meta, core, final }) => void
    // здоровье хоста (host-migration этап 9a): раз в окно цикла
    this._healthSink = null; // (health) => void
    this._checkpointIntervalMs = 0; // 0 — периодических точек нет
    this._lastCheckpointAt = 0;
    this._checkpointRequest = null; // { final } — точка на ближайшем кадре
    this._checkpointCounter = 0;
    // матч поднят из точки и ждёт startAfterRestore: цикл и таймеры стоят
    this._restorePending = false;
    this._restoreMode = null; // 'midRound' | 'soft'
    this._restoredTimers = null;
    this._frozen = false;
    // точка снята на замороженном хосте: pack_body осушил тело кадра вне
    // цикла, и его события (удаления, взрывы) никому не ушли
    this._drainedWhileFrozen = false;
    // ожидание возврата людей перед стартом восстановленного матча
    // (startAfterResume): { timer, onStart, reason }
    this._resumeWait = null;

    // матч закрывается (destroy): снятие участников исход раунда не решает
    this._isDestroying = false;

    // внедрение зависимостей (ядро отдаёт панель/фасад события через адаптер)
    this._socketManager.injectServices(this._game, this._panel, this._stat);
    this._game.injectServices({ vimp: this, panel: this._panel });
    this._panel.injectTimerManager(this._timerManager);

    this._timerManager.startIdleCheckTimer();

    // эстафета Worker'ов (Этап 5.2): восстановление вместо холодного старта;
    // игровой цикл и первый раунд запустит completeHandoff() после
    // переподключения клиентов главным потоком
    if (checkpoint) {
      this._restoreFromCheckpoint(checkpoint, seqFloor);
    } else if (handoff) {
      this._restoreFromHandoff(handoff);
    } else {
      this._roundManager.createMap();
    }

    // отслеживание смены карты и строки карточки лобби
    this._lastReportedMap = this._roundManager.currentMap;
    this._lastReportedLobbyInfo = this.lobbyInfo;
  }

  // комната заполнена людьми — новые подключения отклоняются.
  // Scripted-участники место не занимают: при входе игрока в полную команду
  // один из них кикается (RoundManager.changeTeam → removeOneForHuman),
  // уступая слот
  get isFull() {
    return this._participants.getHumans().length >= this._maxPlayers;
  }

  // лимит участников комнаты (для сообщения об отказе)
  get maxPlayers() {
    return this._maxPlayers;
  }

  // текущая карта комнаты (после эстафеты может отличаться от room.map)
  get currentMap() {
    return this._roundManager.currentMap;
  }

  // строка карточки комнаты в лобби или null — показывать нечего
  get lobbyInfo() {
    if (this._lobbyInfoOverride !== null) {
      return this._lobbyInfoOverride;
    }

    return this._lobbyInfoMode === 'map'
      ? (this._roundManager?.currentMap ?? null)
      : null;
  }

  // значение модулей игры: непустая строка перекрывает gameConfig.lobbyInfo,
  // null (или пустое) снимает его
  setLobbyInfo(text) {
    this._lobbyInfoOverride =
      typeof text === 'string' && text.trim() !== '' ? text.trim() : null;
  }

  // хост-игрок не кикается: закрытие его loopback = смерть комнаты для всех
  _isHostPlayer(user) {
    return this._hostSocketId !== null && user.socketId === this._hostSocketId;
  }

  // кикает за задержку в ответе на ping
  _kickForMaxLatency(gameId) {
    const user = this._participants.get(gameId);

    if (user && !this._isHostPlayer(user)) {
      console.warn(`[RTT] Kick ${user.name} — pong latency exceeded`);
      this._socketManager.close(
        user.socketId,
        closeCodes.kickForMaxLatency,
        'kickForMaxLatency',
      );
      this.removeUser(gameId);
    }
  }

  // кикает за превышение прокусков ответа на ping
  _kickForMissedPings(gameId) {
    const user = this._participants.get(gameId);

    if (user && !this._isHostPlayer(user)) {
      console.warn(`[RTT] Kick ${user.name} — no response to pings`);
      this._socketManager.close(
        user.socketId,
        closeCodes.kickForMissedPings,
        'kickForMissedPings',
      );
      this.removeUser(gameId);
    }
  }

  // создаёт кадр игры (core-driven)
  _onShotTick(dt) {
    // номер тика — единственная временная координата сценария (этап 6)
    this._recorder?.tick(dt);

    // шаг ядра + проекция событий (kill/health/ammo/weapon/shake) в мету
    this._game.updateData(dt);

    // контроль частоты отправки
    if (!this._snapshotManager.shouldSend()) {
      return;
    }

    // смена карты (голосование/таймер) — уведомить главный поток
    const currentMap = this._roundManager.currentMap;

    if (currentMap !== this._lastReportedMap) {
      this._lastReportedMap = currentMap;
      this._onMapChange?.(currentMap);
    }

    // строка карточки лобби — уведомить главный поток (мастер)
    const lobbyInfo = this.lobbyInfo;

    if (lobbyInfo !== this._lastReportedLobbyInfo) {
      this._lastReportedLobbyInfo = lobbyInfo;
      this._onLobbyInfoChange?.(lobbyInfo);
    }

    // список удаляемых с полотна игроков ведёт RoundManager, но null-маркеры
    // в кадр кладёт само ядро (remove_actor) — здесь лишь опустошаем очередь,
    // чтобы она не росла
    const removedPlayersList = this._roundManager.removedPlayersList;

    while (removedPlayersList.length) {
      removedPlayersList.pop();
    }

    // фоновый опрос глобального топа: сам решает, пора ли (refreshInterval)
    this._accolades.tick();

    const userList = this._participants.getNetworkedReady();
    const panelUpdates = this._panel.processUpdates();
    // getLast() — ЕДИНСТВЕННЫЙ дренаж Stat: reset() в _lastBody только
    // дописывает. Поэтому буфер осушается всегда, даже когда рассылки не
    // будет: пропуск вызова в режиме leaderboard растил бы эти массивы всё
    // время жизни комнаты (endlessRound — она живёт часами), а StatBridge
    // пишет в них на каждый подобранный кристалл. Гейтится ОТПРАВКА
    const lastStat = this._stat.getLast();
    // в режиме leaderboard движковый stat не рисуется вовсе — не шлём
    const stat = this._statLeaderboard ? null : lastStat;
    const accolades = this._accolades.shift();
    const chat = this._chat.shift();
    const vote = this._vote.shift();

    const serverTime = clock.now();
    this._seq = (this._seq + 1) >>> 0;
    const seq = this._seq;
    const activeList = this._participants.getActiveList();

    // broadcast-часть кадра пакуется в ядре один раз за тик
    this._game.packBody();

    // событийные блоки тела (трассеры/бомбы/взрывы/удаления) требуют надёжной
    // доставки (WebRTC meta); чисто позиционный кадр идёт по state
    const bodyHasEvents = this._game.bodyHasEvents();

    // вычисляет камеру наблюдения для пользователя
    const getCamera = user => {
      let camera;

      if (user.isWatching === true) {
        if (activeList.length) {
          if (!activeList.includes(user.watchedGameId)) {
            user.watchedGameId = activeList[0];
          }

          camera = this._game.getPosition(user.watchedGameId);
        } else {
          camera = [0, 0];
        }
      } else {
        camera = this._game.getPosition(user.gameId);
      }

      if (user.forceCameraReset === true) {
        camera[2] = true;
        user.forceCameraReset = false;
      }

      if (user.pendingShake) {
        camera[3] = user.pendingShake;
        user.pendingShake = null;
      }

      return camera;
    };

    userList.forEach(user => {
      const gameId = user.gameId;
      const socketId = user.socketId;

      const camera = getCamera(user);

      // player-блок предикшена собирает ядро по playerId (наблюдатель → -1)
      const playerId = user.isWatching === false ? gameId : null;

      // per-user события кадра: forceReset (camera[2]) и shake (camera[3])
      // тоже требуют надёжной доставки
      const reliable =
        bodyHasEvents || camera[2] === true || Boolean(camera[3]);

      this._socketManager.sendShot(
        socketId,
        this._game.packFrame(camera, serverTime, seq, playerId),
        reliable,
      );

      if (panelUpdates[gameId]) {
        this._socketManager.sendPanel(socketId, panelUpdates[gameId]);
      }

      if (stat) {
        this._socketManager.sendStat(socketId, stat);
      }

      if (accolades) {
        this._socketManager.sendAccolades(socketId, accolades);
      }

      const chatUser = chat || this._chat.shiftByUser(gameId);
      if (chatUser) {
        this._socketManager.sendChat(socketId, chatUser);
      }

      const voteUser = vote || this._vote.shiftByUser(gameId);
      if (voteUser) {
        this._socketManager.sendVote(socketId, voteUser);
      }
    });

    // граница кадра: pack_body опустошил накопители снапшота — единственный
    // момент, когда дамп ядра корректен
    this._maybeCheckpoint();
  }

  // проверяет игроков на бездействие и кикает, если превышен порог
  _kickIdleUsers() {
    const now = clock.now();
    const usersToKick = [];

    for (const user of this._participants.getHumans()) {
      // отсоединённого снимет истечение ожидания возврата, а не бездействие
      if (
        user.isReady !== true ||
        user.detachedAt !== null ||
        this._isHostPlayer(user)
      ) {
        continue;
      }

      const idleThreshold =
        user.teamId === this._spectatorId
          ? this._idleTimeoutForSpectator
          : this._idleTimeoutForPlayer;

      if (idleThreshold !== null) {
        const idleTime = now - user.lastActionTime;

        if (idleTime > idleThreshold) {
          usersToKick.push(user);
        }
      }
    }

    usersToKick.forEach(user => {
      this._socketManager.close(user.socketId, closeCodes.kickIdle, 'kickIdle');
      this.removeUser(user.gameId);
    });
  }

  // отправляет ping всем пользователям
  _sendPing() {
    const users = this._RTTManager.scheduleNextPing();

    for (const [gameId, { pingIdCounter }] of users) {
      const user = this._participants.get(gameId);

      this._socketManager.sendPing(user.socketId, pingIdCounter);
    }
  }

  // отправляет карту (прокси к RoundManager)
  sendMap(gameId) {
    this._roundManager.sendMap(gameId);
  }

  // сообщает о загрузке карты
  mapReady(gameId) {
    const user = this._participants.get(gameId);

    if (!user) {
      return;
    }

    if (user.currentMap !== this._roundManager.currentMap) {
      this.sendMap(gameId);
      return;
    }

    if (user.isReady === false) {
      this._socketManager.sendFirstShot(user.socketId);
    }
  }

  // сообщает о готовности игрока к игре
  firstShotReady(gameId) {
    const user = this._participants.get(gameId);

    if (!user) {
      return;
    }

    const socketId = user.socketId;

    user.isReady = true;
    this._socketManager.sendTechInform(socketId);
    this._socketManager.sendFirstVote(socketId);

    // топ и места в нём — целиком и лично, как и первый кадр stat.
    // Периодическая рассылка (shift() в игровом цикле) уходит только тем,
    // кто УЖЕ готов, а места новичка посчитаны на его входе, за всю загрузку
    // карты до этой строки: та рассылка ушла бы без него и не повторилась
    // бы — места с тех пор не менялись, — и ни знак, ни таблица по Tab не
    // появились бы до первого чужого входа. В комнате, куда больше никто не
    // заходит, никогда
    const accoladesNow = this._accolades.current();

    if (Object.keys(accoladesNow.places).length) {
      this._socketManager.sendAccolades(socketId, accoladesNow);
    }

    this._chat.pushSystem('USER_JOINED', [user.name]);

    // noSpectators: голосования за вход нет — участник уже в играющей
    // команде, осталось выдать ему актора. Именно здесь, а не в createUser:
    // sendFirstShot выше шлёт keyset наблюдателя и затёр бы клавиши игрока
    if (this._noSpectators) {
      this._roundManager.admitPlayer(gameId);
    }
  }

  // обрабатывает уничтожение игрока (прокси к RoundManager; из событий ядра)
  reportKill(victimId, killerId = null) {
    this._roundManager.reportKill(victimId, killerId);
  }

  // обновляет каталог карт (Этап 5.1). Новые данные применяются со следующей
  // смены карты: _maps и _mapList правятся на месте — эти же ссылки держат
  // RoundManager (createMap) и голосования (parseVote 'maps')
  updateMaps(maps) {
    for (const [name, data] of Object.entries(maps)) {
      this._maps[name] = data;
    }

    this._mapList.length = 0;
    this._mapList.push(...Object.keys(this._maps));
  }

  // ***** отладочный контур (этап 6 плана plan/done/ai-debug) ***** //
  // Всё ниже живёт под флагом isDevMode: в проде рекордера нет, а дамп
  // отдаёт только то, что и так знает мета.

  get isRecording() {
    return this._recorder?.isRecording === true;
  }

  // начинает запись живого матча в формат сценария headless-runner'а.
  // Возвращает false, если dev-режим выключен — тишины быть не должно
  startRecording() {
    if (!this._recorder) {
      return false;
    }

    this._recorder.start({
      seed: this._seed,
      map: this._roundManager.currentMap,
      networkSendRate: this._networkSendRate,
      participants: this._participants.getHumans().map(user => ({
        gameId: user.gameId,
        name: user.name,
        model: user.model,
        socketId: user.socketId,
        team: user.team === this._spectatorTeam ? null : user.team,
      })),
    });

    this._debugConsole('recording started');

    return true;
  }

  // останавливает запись и отдаёт сценарий (parseScenario принимает как есть)
  stopRecording() {
    const scenario = this._recorder?.stop() ?? null;

    if (scenario) {
      this._debugConsole(
        `recording stopped: ${scenario.ticks} tick(s), ` +
          `${scenario.timeline.length} op(s)`,
      );
    }

    return scenario;
  }

  // курированный срез хоста: мета рядом с дампом мира ядра (этап 4) —
  // расхождение «в ядре тело есть, на холсте пусто» видно только вместе
  debugSnapshot() {
    return {
      seed: this._seed,
      seq: this._seq,
      tick: this._recorder?.tickCount ?? null,
      recording: this.isRecording,
      currentMap: this._roundManager.currentMap,
      participants: {
        humans: this._participants.getHumans().map(user => ({
          gameId: user.gameId,
          socketId: user.socketId,
          name: user.name,
          team: user.team,
          isReady: user.isReady,
          isWatching: user.isWatching,
        })),
        scripted: this._participants.getScripted().map(user => ({
          gameId: user.gameId,
          name: user.name,
          team: user.team,
        })),
        activeList: this._participants.getActiveList(),
      },
      core: this._game.debugJson(),
    };
  }

  // структурированный лог хоста в консоль клиентов (порт CONSOLE): Worker
  // изолирован от DevTools вкладки, поэтому его события иначе не видны
  _debugConsole(message) {
    if (!this._isDevMode) {
      return;
    }

    for (const user of this._participants.getNetworkedReady()) {
      this._socketManager.sendConsole(user.socketId, message);
    }
  }

  /**
   * Публичный teardown матча: останов таймеров, финальная синхронизация
   * профилей и снятие всех участников. Во вкладке матч умирает вместе с
   * Worker'ом, а долгоживущему процессу (dedicated-сервер) нужен graceful
   * shutdown — иначе таймеры держат процесс, а rank/state теряются.
   * @returns {Promise} Завершение финальной синхронизации профилей.
   */
  async destroy() {
    this._isDestroying = true;

    if (this._resumeWait) {
      clock.clearTimeout(this._resumeWait.timer);
      this._resumeWait = null;
    }

    this._timerManager.stopGameTimers();
    this._timerManager.stopIdleCheckTimer();
    this._timerManager.stopAllVoteTimers();
    this._timerManager.stopAllBlockedVoteTimers();

    // flushAll до снятия участников: removeUser чистит запись PlayerDataSync,
    // и после него синхронизировать было бы уже нечего. Ждём здесь же —
    // иначе removeUser стартует второй flush с той же накопленной дельтой
    // (двойной зачёт рейтинга), а destroy разрешился бы раньше, чем эти
    // запросы уйдут
    // незакрытые игры участников закрываются здесь: их очки иначе не
    // попали бы ни в сумму, ни в максимум и пропали бы вместе с комнатой
    // (правило 7 snakes-v3 этап 3 — запись гарантирована в destroy())
    this._playerDataSync.finishAllGames();
    await this._playerDataSync.flushAll({ urgent: true });

    // getAll() отдаёт копию — снятие внутри цикла реестр не ломает
    for (const user of this._participants.getAll()) {
      // запись уже синхронизирована — финальный flush внутри removeUser
      // не нужен и был бы повтором
      this._playerDataSync.removeUser(user.gameId);
      this.removeUser(user.gameId);
    }
  }

  // ***** эстафета Worker'ов (Этап 5.2) ***** //

  // запрашивает перенос: на ближайшей границе раунда игра останавливается
  // и cb получает handoff-мету. Ядро не дампится — мир пересоздаётся стартом
  // раунда в новом Worker'е (см. RoundManager._startRound). Перед отдачей
  // профили синхронизируются на мастер: terminate() старого Worker'а
  // оборвал бы летящие записи
  requestHandoff(cb) {
    this._roundManager.requestHandoff(() => {
      this._timerManager.stopGameTimers();
      this._timerManager.stopIdleCheckTimer();
      this._flushBeforeHandoff().then(() => cb(this._collectHandoff()));
    });
  }

  // плановая передача хоста (host-migration этап 8d): игра без
  // migration.midRound переносит только мету — передача посреди раунда
  // отняла бы его у всех, поэтому она ждёт следующего раунда. Игра с
  // midRound продолжает у преемника с того же тика — ждать нечего
  awaitRoundBoundary(cb) {
    if (this._migrationMidRound) {
      cb();
      return;
    }

    this._roundManager.onRoundBoundary(cb);
  }

  cancelRoundBoundary() {
    this._roundManager.cancelRoundBoundary();
  }

  // финальная синхронизация профилей, но не дольше handoffFlushTimeoutMs:
  // зависший auth-сервис не должен держать эстафету — неотправленное едет
  // в состоянии (playerData) и уйдёт из нового Worker'а
  _flushBeforeHandoff() {
    let timer = null;

    const timeout = new Promise(resolve => {
      timer = clock.setTimeout(resolve, this._handoffFlushTimeoutMs);
    });

    return Promise.race([
      this._playerDataSync.flushAll({ urgent: true }),
      timeout,
    ]).finally(() => clock.clearTimeout(timer));
  }

  // отказ от эстафеты (новый Worker не поднялся): вернуть таймеры и
  // продолжить жить на старой версии кода
  resumeAfterHandoff() {
    this._roundManager.cancelHandoff();
    this._timerManager.startIdleCheckTimer();
    this._timerManager.resumeGameTimers(this._timerManager.getMapTimeLeft());
    this._roundManager.initiateNewRound();
  }

  // завершение эстафеты в новом Worker'е: клиенты переподключены главным
  // потоком — вычистить не переживших паузу, вернуть таймеры (карта — с
  // остатком времени) и стартовать первый раунд
  completeHandoff(connectedSocketIds) {
    if (!this._handoffRestored) {
      return;
    }

    this._handoffRestored = false;
    this._restorePending = false;

    for (const user of this._participants.getHumans()) {
      if (!connectedSocketIds.has(user.socketId)) {
        this.removeUser(user.gameId);
      }
    }

    this._timerManager.resumeGameTimers(this._handoffMapTimeLeft);
    this._roundManager.initiateNewRound();
  }

  // мета эстафеты внутри вкладки: формат контрольной точки (kind:
  // 'boundary', всегда мягкий режим) плюс токены участников. Токены —
  // только здесь: состояние уходит postMessage'ем в соседний Worker той же
  // вкладки и никогда — по сети (сетевые точки их не несут)
  _collectHandoff() {
    const { meta } = this._collectState('boundary');
    const localTokens = {};

    for (const user of this._participants.getHumans()) {
      if (typeof user.token === 'string' && user.token !== '') {
        localTokens[user.gameId] = user.token;
      }
    }

    return { ...meta, localTokens };
  }

  // восстанавливает комнату из handoff-меты. Ошибка (несовместимый формат,
  // чужая игра, карта ушла из каталога) валит init Worker'а — главный поток
  // возобновляет старый Worker, комната живёт на прежней версии
  _restoreFromHandoff(meta) {
    if (meta && meta.version === HANDOFF_VERSION) {
      this._restoreState(meta, null, { boundary: true });
      return;
    }

    if (!meta || meta.version !== LEGACY_HANDOFF_VERSION) {
      throw new Error(`unsupported handoff version: ${meta && meta.version}`);
    }

    this._assertSameGame(meta.gameId);

    if (!this._maps[meta.currentMap]) {
      throw new Error(`handoff map missing from catalog: ${meta.currentMap}`);
    }

    this._seq = meta.seq >>> 0;
    this._handoffMapTimeLeft = meta.mapTimeLeft;

    // мета старого Worker'а поля может не нести — тогда текста модулей нет
    if (typeof meta.lobbyInfo === 'string') {
      this.setLobbyInfo(meta.lobbyInfo);
    }

    for (const record of meta.humans) {
      const user = this._participants.restoreHuman(record);

      if (!user) {
        continue;
      }

      // хендшейк уже пройден в старом Worker'е (переносятся только isReady)
      user.isReady = true;
      user.currentMap = meta.currentMap;

      this._chat.addUser(user.gameId);
      this._vote.addUser(user.gameId);
      this._panel.addUser(user.gameId);
      this._RTTManager.addUser(user.gameId);
    }

    for (const record of meta.scripted) {
      const participant = this._participants.restoreScripted(record);

      if (participant) {
        this._panel.addUser(participant.gameId);
      }
    }

    // счёт переезжает целиком; строки не переживших эстафету (не завершили
    // хендшейк в старом Worker'е) вычищаются — клиенты получат обновление
    const keepIds = new Set(this._participants.getAll().map(p => p.gameId));

    this._stat.restore(meta.stat, keepIds);

    this._roundManager.restoreMap(meta.currentMap);
    this._handoffRestored = true;
  }

  // составной codeVersion (Этап 6.5): своп меняет только версию кода в
  // рамках той же игры — смена самой игры комнаты handoff'ом не
  // предусмотрена, рассинхрон id — явный сбой конфигурации свопа
  _assertSameGame(gameId) {
    if (gameId !== undefined && gameId !== this._gameId) {
      throw new Error(
        `handoff game mismatch: expected "${this._gameId}", got "${gameId}"`,
      );
    }
  }

  // ***** здоровье хоста (host-migration этап 9a) ***** //

  /**
   * Приёмник метрик здоровья: раз в окно игрового цикла (~1 с) —
   * { tickRate, maxGapMs, lostMs, windowMs, peerRttMedian, peerCount }.
   * Пока матч заморожен или стоит, метрик нет.
   * @param {Function|null} sink
   */
  setHealthSink(sink) {
    this._healthSink = typeof sink === 'function' ? sink : null;
  }

  // RTT — только удалённые люди: хост-игрок на loopback связь хоста не мерит
  _onLoopStats(stats) {
    if (!this._healthSink) {
      return;
    }

    const { median, count } = this._RTTManager.getRttStats(gameId => {
      const user = this._participants.get(gameId);

      return Boolean(user) && !this._isHostPlayer(user);
    });

    this._healthSink({ ...stats, peerRttMedian: median, peerCount: count });
  }

  // ***** контрольная точка (host-migration этап 5) ***** //

  /**
   * Приёмник готовых точек (Worker кодирует и отдаёт главному потоку).
   * @param {Function|null} sink - ({ meta, core, final }) => void.
   */
  setCheckpointSink(sink) {
    this._checkpointSink = typeof sink === 'function' ? sink : null;
  }

  // периодические точки: снимаются на границе кадра не чаще intervalMs
  startCheckpoints(intervalMs) {
    this._checkpointIntervalMs = Math.max(0, Number(intervalMs) || 0);
    this._lastCheckpointAt = 0;
  }

  stopCheckpoints() {
    this._checkpointIntervalMs = 0;
  }

  // одна точка на ближайшей границе кадра. Цикл стоит (заморозка или матч
  // ждёт старта после восстановления) — следующего кадра не будет, точка
  // снимается сразу
  requestCheckpoint({ final = false } = {}) {
    if (this._frozen || this._restorePending) {
      this._emitCheckpoint(final === true, { packFirst: true });
      return;
    }

    this._checkpointRequest = { final: final === true };
  }

  _maybeCheckpoint() {
    if (!this._checkpointSink) {
      return;
    }

    const now = clock.now();
    let final = false;

    if (this._checkpointRequest) {
      final = this._checkpointRequest.final;
      this._checkpointRequest = null;
    } else if (
      this._checkpointIntervalMs === 0 ||
      now - this._lastCheckpointAt < this._checkpointIntervalMs
    ) {
      return;
    }

    this._emitCheckpoint(final);
  }

  _emitCheckpoint(final, { packFirst = false } = {}) {
    if (!this._checkpointSink) {
      return;
    }

    // вне цикла граница кадра не гарантирована: дренаж накопителей —
    // предусловие дампа; недоставленные события перекроет полный кадр,
    // который возобновлённый клиент получает на входе
    if (packFirst) {
      this._game.packBody();
      this._drainedWhileFrozen ||= this._frozen;
    }

    this._lastCheckpointAt = clock.now();

    const { meta, core } = this._collectState('checkpoint');

    this._checkpointSink({ meta, core, final });
  }

  /**
   * Собирает контрольную точку: мета (формат HANDOFF_VERSION 4) и дамп
   * ядра. Ядро прикладывается только у игры с migration.midRound и только
   * если дамп снялся — иначе режим 'soft' (восстановление начнёт раунд
   * заново).
   * @param {'checkpoint'|'boundary'} [kind]
   * @returns {{meta: Object, core: Uint8Array|null}}
   */
  collectCheckpoint(kind = 'checkpoint') {
    return this._collectState(kind);
  }

  _collectState(kind) {
    let core = null;
    let plugin = null;

    if (kind === 'checkpoint' && this._migrationMidRound) {
      try {
        plugin = this._serializeModules();
        core = this._game.serializeState();
      } catch (e) {
        // точка остаётся полезной и без ядра: аварийный преемник начнёт
        // раунд заново, а не потеряет комнату
        console.warn(`[checkpoint] mid-round state skipped: ${e.message}`);
        core = null;
        plugin = null;
      }
    }

    const createdAt = clock.now();
    const currentMap = this._roundManager.currentMap;
    const round = this._roundManager.serialize();
    const participants = this._participants.serialize();
    const isBoundary = kind === 'boundary';
    const dropped = [];

    this._checkpointCounter += 1;

    participants.humans = participants.humans
      .filter(record => {
        const user = this._participants.get(record.gameId);

        // внутри вкладки переносятся завершившие хендшейк (переподключатся
        // тем же socketId); по сети — те, кому есть чем вернуться (resumeKey)
        const keep = isBoundary ? user.isReady : Boolean(user.resumeKey);

        if (!keep) {
          dropped.push(record.gameId);
        }

        return keep;
      })
      .map(record => {
        const user = this._participants.get(record.gameId);

        return {
          ...record,
          isHostPlayer: this._isHostPlayer(user),
          ...(isBoundary ? { socketId: user.socketId } : {}),
        };
      });

    // не попавшие в точку люди: их акторы остаются в дампе ядра, и
    // преемник снимает их сам — иначе в мире остались бы бесхозные тела
    participants.dropped = dropped;

    const meta = {
      version: HANDOFF_VERSION,
      kind,
      mode: core ? 'midRound' : 'soft',
      gameId: this._gameId,
      gameVersion: this._gameVersion,
      engineVersion: enginePkg.version,
      createdAt,
      checkpointId: `${createdAt.toString(36)}-${this._checkpointCounter}`,
      seq: this._seq,
      snapshotTick: this._snapshotManager.tick,
      room: {
        roomId: this._roomId,
        epoch: this._epoch,
        settings: this._roomSettings,
        game: { id: this._gameId, version: this._gameVersion },
      },
      map: {
        name: currentMap,
        data: this._roundManager.baseMapData,
        mapsVersion: this._mapsVersion,
        override: round.override,
      },
      // матч поднят из точки и ещё не запущен: таймеры стоят, их остатки —
      // те, что приехали в точке
      timers: this._restorePending
        ? structuredClone(this._restoredTimers)
        : this._timerManager.serialize(),
      round: {
        isRoundEnding: round.isRoundEnding,
        wipedTeamIds: round.wipedTeamIds,
        removedPlayers: round.removedPlayers,
        startMapNumber: round.startMapNumber,
      },
      participants,
      stat: this._stat.serialize(),
      panel: this._panel.serialize(),
      playerData: this._playerDataSync.serialize(),
      plugin: plugin ?? {},
      // текст карточки лобби, выставленный модулем игры (lobby.setInfo):
      // модули нового Worker'а создаются с нуля и сами его не повторят
      lobbyInfo: this._lobbyInfoOverride,
    };

    // JSON-круг: точка уезжает по сети и в соседний Worker, ссылки на живые
    // объекты меты (stat, карта) не должны правиться задним числом
    return { meta: JSON.parse(JSON.stringify(meta)), core };
  }

  // состояние JS-модулей игры: ключ — имя модуля в объекте createModules
  _serializeModules() {
    const out = {};

    for (const [name, module] of Object.entries(this._modules ?? {})) {
      if (typeof module?.serializeState === 'function') {
        out[name] = module.serializeState();
      }
    }

    return out;
  }

  _restoreModules(state = {}) {
    for (const [name, module] of Object.entries(this._modules ?? {})) {
      if (
        Object.hasOwn(state, name) &&
        typeof module?.restoreState === 'function'
      ) {
        module.restoreState(state[name]);
      }
    }
  }

  // матч из контрольной точки, снятой (возможно) на другой машине
  _restoreFromCheckpoint({ meta, core = null } = {}, seqFloor = 0) {
    this._restoreState(meta, core, { boundary: false, seqFloor });
  }

  // общий путь восстановления формата v4: эстафета внутри вкладки
  // (boundary — клиенты переподключаются теми же socketId) и контрольная
  // точка (люди поднимаются отсоединёнными и ждут RESUME)
  _restoreState(meta, core, { boundary, seqFloor = 0 }) {
    if (!meta || meta.version !== HANDOFF_VERSION) {
      throw new Error(`unsupported handoff version: ${meta && meta.version}`);
    }

    this._assertSameGame(meta.gameId);

    const mapName = meta.map?.name;
    const mapData = meta.map?.data ?? this._maps[mapName];

    if (!mapData) {
      throw new Error(`handoff map missing from catalog: ${mapName}`);
    }

    const midRound = !boundary && meta.mode === 'midRound' && Boolean(core);

    // ядро — первым: битый дамп валит init до того, как мета что-то
    // поменяла
    if (midRound) {
      this._game.deserializeState(core);
    }

    this._seq = boundary
      ? meta.seq >>> 0
      : (Math.max(meta.seq >>> 0, seqFloor >>> 0) + RESTORE_SEQ_GAP) >>> 0;

    if (typeof meta.lobbyInfo === 'string') {
      this.setLobbyInfo(meta.lobbyInfo);
    }

    const tokens = boundary ? (meta.localTokens ?? {}) : {};
    const now = clock.now();

    for (const record of meta.participants.humans) {
      const user = this._participants.restoreHuman(
        {
          ...record,
          socketId: boundary
            ? record.socketId
            : detachedSocketId(record.gameId),
          token: tokens[record.gameId] ?? null,
        },
        { full: midRound },
      );

      if (!user) {
        continue;
      }

      user.isReady = boundary || record.isReady !== false;
      user.currentMap = mapName;

      this._chat.addUser(user.gameId);
      this._vote.addUser(user.gameId);
      this._panel.addUser(user.gameId);

      if (boundary) {
        this._RTTManager.addUser(user.gameId);
      } else {
        // место ждёт возврата участника (RESUME): рассылки уходят в заглушку
        user.detachedAt = now;
        user.lastActionTime = now;
        this._socketManager.addUser(user.socketId, DETACHED_SOCKET);
      }
    }

    for (const record of meta.participants.scripted) {
      const participant = this._participants.restoreScripted(record, {
        full: midRound,
      });

      if (participant) {
        this._panel.addUser(participant.gameId);
      }
    }

    if (midRound) {
      this._participants.restoreTopology(meta.participants);
      this._panel.restore(meta.panel);

      for (const gameId of meta.participants.dropped ?? []) {
        if (!this._participants.get(gameId)) {
          this._game.removePlayer(gameId);
        }
      }
    }

    const keepIds = new Set(this._participants.getAll().map(p => p.gameId));

    this._stat.restore(meta.stat, keepIds);

    // профили: накопленное, но не отправленное переезжает; токены — только
    // в эстафете внутри вкладки. Участник, чей профиль так и не доехал с
    // мастера, догружается сразу (иначе rank/state не писались бы до конца
    // сессии)
    const playerData = Object.fromEntries(
      Object.entries(meta.playerData ?? {}).filter(([id]) => keepIds.has(id)),
    );

    this._playerDataSync.restore(playerData, { tokens });

    for (const [gameId, token] of Object.entries(tokens)) {
      if (keepIds.has(gameId) && !this._playerDataSync.isLoaded(gameId)) {
        this._playerDataSync.load(gameId, token);
      }
    }

    this._roundManager.restoreMap(mapName, {
      mapData,
      override: midRound ? meta.map.override : null,
    });

    if (midRound) {
      this._roundManager.restoreRound(meta.round);
      this._snapshotManager.tick = meta.snapshotTick;
      this._restoreModules(meta.plugin);
    }

    this._restoreMode = midRound ? 'midRound' : 'soft';
    this._restoredTimers = meta.timers ?? {};
    this._restorePending = true;

    if (boundary) {
      this._handoffRestored = true;
      this._handoffMapTimeLeft = this._restoredTimers.mapTimeLeft ?? null;
    }
  }

  // режим восстановления матча: 'midRound' | 'soft' | null (холодный старт)
  get restoreMode() {
    return this._restoreMode;
  }

  // ждёт ли восстановленный матч запуска (startAfterRestore)
  get isRestorePending() {
    return this._restorePending;
  }

  /**
   * Запускает матч, поднятый из контрольной точки: посреди раунда —
   * таймеры с остатками и цикл с того же тика; в мягком режиме — карта с
   * остатком и новый раунд (как после эстафеты).
   * @returns {boolean} false — запускать нечего.
   */
  startAfterRestore() {
    if (!this._restorePending) {
      return false;
    }

    const timers = this._restoredTimers ?? {};

    this._restorePending = false;
    this._handoffRestored = false;

    if (this._restoreMode === 'midRound') {
      this._timerManager.resumeFromState(timers);

      for (const item of timers.pending ?? []) {
        if (item.kind === 'mapChange' && this._maps[item.targetMap]) {
          this._roundManager.scheduleMapChange(item.targetMap, item.leftMs);
        }
      }
    } else {
      this._timerManager.resumeGameTimers(timers.mapTimeLeft);
      this._roundManager.initiateNewRound();
    }

    return true;
  }

  /**
   * Старт матча, поднятого из точки преемником (host-migration этап 7.4):
   * когда возобновились все люди точки или прошло resumeWaitMs — что
   * раньше. Пауза переключения не съедает окно возврата: onStart получает
   * gameId так и не вернувшихся, их ожидание (grace) заводится с этого
   * момента.
   * @param {Function} [onStart] - (detachedGameIds) после старта.
   * @param {Object} [options]
   * @param {string|null} [options.reason] - причина миграции из promote:
   *   у автоматической передачи игроки видят её вместо «Host changed».
   * @returns {boolean} false — запускать нечего или ожидание уже идёт.
   */
  startAfterResume(onStart = null, { reason = null } = {}) {
    if (!this._restorePending || this._resumeWait) {
      return false;
    }

    this._resumeWait = { timer: null, onStart, reason };

    if (this.detachedGameIds().length === 0) {
      this._finishResumeWait();
    } else {
      this._resumeWait.timer = clock.setTimeout(
        () => this._finishResumeWait(),
        this._resumeWaitMs,
      );
    }

    return true;
  }

  _finishResumeWait() {
    const wait = this._resumeWait;

    if (!wait) {
      return;
    }

    this._resumeWait = null;
    clock.clearTimeout(wait.timer);

    if (!this.startAfterRestore()) {
      return;
    }

    this._chat.pushSystem(
      Object.hasOwn(HOST_CHANGED_BY_REASON, wait.reason)
        ? HOST_CHANGED_BY_REASON[wait.reason]
        : 'HOST_CHANGED',
    );
    wait.onStart?.(this.detachedGameIds());
  }

  // gameId людей, ждущих возобновления
  detachedGameIds() {
    return this._participants
      .getHumans()
      .filter(user => user.detachedAt !== null)
      .map(user => user.gameId);
  }

  // заморозка (финальная точка плановой передачи): цикл и все отсчёты
  // встают с остатками
  freeze() {
    if (this._frozen) {
      return;
    }

    this._frozen = true;
    this._timerManager.pause();
  }

  // разморозка (передача сорвалась): отсчёты продолжаются с остатков.
  // Если за заморозку снималась точка, события осушенного тела потеряны —
  // оставшимся на связи участникам уходит полная синхронизация (пакет входа
  // RESUME), иначе на полотне остались бы «призраки» удалённых сущностей
  unfreeze() {
    if (!this._frozen) {
      return;
    }

    this._frozen = false;
    this._timerManager.resume();

    if (this._drainedWhileFrozen) {
      this._drainedWhileFrozen = false;
      this._participants
        .getNetworkedReady()
        .forEach(user => this._sendResumeEntry(user));
    }
  }

  get isFrozen() {
    return this._frozen;
  }

  // меняет и возвращает gameId наблюдаемого игрока
  _getNextActivePlayerForUser(gameId, back) {
    const currentId = this._participants.get(gameId)?.watchedGameId;
    const activeList = this._participants.getActiveList();
    let key = activeList.indexOf(currentId);

    if (key !== -1) {
      key = back ? key - 1 : key + 1;

      if (key < 0) {
        key = activeList.length - 1;
      } else if (key >= activeList.length) {
        key = 0;
      }

      return activeList[key];
    }

    return activeList[0] || null;
  }

  // активирует тряску камеры у игрока (из события ядра)
  triggerCameraShake(gameId, shakeParams) {
    const user = this._participants.get(gameId);

    if (user) {
      user.pendingShake = `${shakeParams.intensity}:${shakeParams.duration}`;
    }
  }

  // освобождает слот под человека: если суммарный лимит (люди + scripted)
  // выбран, кикается один scripted-участник — из команды, где их больше всего
  _freeSlotForHuman() {
    if (!this._participants.isFull) {
      return;
    }

    const counts = this._scripted.getCountsPerTeam();
    const team = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];

    if (team) {
      this._scripted.removeOneForHuman(team);
      this._roundManager.checkRoundOutcome();
    }
  }

  // создаёт нового игрока
  createUser(params, socketId, cb) {
    this._freeSlotForHuman();

    const gameId = this._participants.createHuman(params, socketId);
    const name = this._participants.get(gameId).name;

    this._recorder?.noteJoin({
      gameId,
      name,
      model: params.model,
      socketId,
    });

    this._chat.addUser(gameId);
    this._vote.addUser(gameId);
    // строка stat заводится в той команде, куда участник и попал:
    // наблюдатели, а под noSpectators — сразу играющая команда
    this._stat.addUser(gameId, this._participants.joinTeamId, { name });
    this._panel.addUser(gameId);
    this._RTTManager.addUser(gameId);

    // подгрузка rank/state с мастера (Этап B4) — асинхронно, не блокирует
    // вход; сбой auth-сервиса оставляет участника с дефолтами
    this._playerDataSync.load(gameId, params.token);

    // место новичка в глобальном топе: знак должен появиться сразу, а не
    // на следующем периодическом опросе. Это пересчёт по уже известным
    // срезам, а не поход за ними — за топом ходит только tick()
    this._accolades.noteRoster();

    queueMicrotask(() => {
      cb(gameId);
    });
  }

  // удаляет игрока полностью из игры
  removeUser(gameId) {
    const user = this._participants.get(gameId);

    if (!user) {
      return;
    }

    const { team, teamId } = user;

    this._recorder?.noteLeave(gameId);

    // место не дождалось возврата — снять и заглушку соединения
    if (user.isNetworked && user.detachedAt !== null) {
      this._socketManager.removeUser(user.socketId);
    }

    this._RTTManager.removeUser(gameId);
    this._stat.removeUser(gameId, teamId);
    this._chat.removeUser(gameId);
    this._vote.removeUser(gameId);
    this._panel.removeUser(gameId);

    // финальная синхронизация профиля перед уходом участника (Этап B4):
    // незавершённая игра закрывается — второго шанса записать её очки не
    // будет, — и интервал синхронизации эта граница обходит (urgent)
    this._playerDataSync.finishGame(gameId);
    this._playerDataSync
      .flush(gameId, { urgent: true })
      .catch(err =>
        console.warn('[playerData] final flush failed:', err.message),
      )
      .finally(() => this._playerDataSync.removeUser(gameId));

    // если не наблюдатель — удалить танк из ядра (null-маркер ставит ядро)
    if (team !== this._spectatorTeam) {
      this._game.removePlayer(gameId);
    }

    this._participants.remove(gameId);

    this._chat.pushSystem('USER_LEFT', [user.name]);

    // ушёл последний живой команды, пока раунд ждал одной выжившей. При
    // закрытии матча исход не решается: таймеры уже сняты, и завершение
    // раунда взвело бы новый и повторило бы finishAllGames/flushAll
    if (!this._isDestroying) {
      this._roundManager.checkRoundOutcome();
    }
  }

  // обновляет команды (формат wire: 'seq:action:name', указатель —
  // 'seq:aim:x:y:flags')
  updateKeys(gameId, keyStr) {
    const user = this._participants.get(gameId);

    if (!user) {
      return;
    }

    const [seq, action, name, aimY, aimFlags] = keyStr.split(':');

    // ввод указателем: наблюдателю рулить нечем, живому актору — мировая
    // точка и биты состояния указателя
    if (action === 'aim') {
      this._recorder?.noteAim(
        gameId,
        Number(name),
        Number(aimY),
        Number(aimFlags) >>> 0,
      );

      user.lastActionTime = clock.now();
      user.lastInputSeq = Number(seq) >>> 0;

      if (user.isWatching !== true) {
        this._game.applyAim(
          gameId,
          user.lastInputSeq,
          Number(name),
          Number(aimY),
          Number(aimFlags) >>> 0,
        );
      }

      return;
    }

    this._recorder?.noteKey(gameId, action, name);

    user.lastActionTime = clock.now();
    user.lastInputSeq = Number(seq) >>> 0;

    if (user.isWatching === true) {
      if (action === 'down') {
        if (name === this._spectatorKeys.nextPlayer) {
          user.watchedGameId = this._getNextActivePlayerForUser(gameId);
          user.forceCameraReset = true;
        } else if (name === this._spectatorKeys.prevPlayer) {
          user.watchedGameId = this._getNextActivePlayerForUser(gameId, true);
          user.forceCameraReset = true;
        }
      }
    } else {
      this._game.applyInput(gameId, user.lastInputSeq, action, name);
    }
  }

  // добавляет сообщение
  pushMessage(gameId, message) {
    const user = this._participants.get(gameId);

    if (!user || user.isReady === false) {
      return;
    }

    user.lastActionTime = clock.now();

    message = sanitizeMessage(message);

    if (message.length > this._chatMaxLength) {
      message = message.slice(0, this._chatMaxLength);
    }

    if (message) {
      // пишется уже вычищенный текст — ровно тот, что применяется к матчу
      this._recorder?.noteChat(gameId, message);

      if (message.charAt(0) === '/') {
        this._commandProcessor.parseCommand(gameId, message);
      } else {
        this._chat.push(message, user.name, user.teamId, user.chatColor);
      }
    }
  }

  // обрабатывает vote-данные пользователя
  parseVote(gameId, data) {
    const user = this._participants.get(gameId);

    if (!user || user.isReady === false) {
      return;
    }

    this._recorder?.noteVote(gameId, data);

    user.lastActionTime = clock.now();

    if (typeof data === 'string') {
      if (data === 'teams') {
        this._vote.pushByUser(gameId, Object.keys(this._teams));
      } else if (data === 'maps') {
        this._vote.pushByUser(
          gameId,
          this._mapList.filter(map => map !== this._roundManager.currentMap),
        );
      }
    } else if (typeof data === 'object' && data !== null) {
      const [type, value] = data;

      if (type === 'mapChange') {
        if (this._participants.getHumans().length === 1) {
          this._roundManager.forceChangeMap(value);
        } else {
          this._roundManager.changeMap(gameId, value);
        }
      } else if (type === 'teamChange') {
        this._roundManager.changeTeam(gameId, value);
      } else {
        this._vote.addInVote(type, value);
        this._chat.pushSystemByUser(gameId, 'VOTE_ACCEPTED');
      }
    }
  }

  // rank/state участника (Этап B4) — для игровых модулей и чат-команды /rank
  // (Этап B5, CommandProcessor)
  getPlayerRank(gameId) {
    return this._playerDataSync.getRank(gameId);
  }

  // загружен ли ранг с мастера. getPlayerRank отвечает 0 и для незнакомого
  // id, и до ответа auth — игре, которая пишет ранг в stat колонкой '=',
  // нужно отличать «ранг 0» от «ранга ещё нет»
  isPlayerRankLoaded(gameId) {
    return this._playerDataSync.isRankLoaded(gameId);
  }

  getPlayerState(gameId) {
    return this._playerDataSync.getState(gameId);
  }

  setPlayerState(gameId, state) {
    this._playerDataSync.setState(gameId, state);
  }

  // карта, по которой движок расставляет участников на старте раунда — для
  // игр, которые пересобирают геометрию на лету, минуя смену карты (прокси к
  // RoundManager; карта комнаты и текущий раунд не трогаются)
  overrideMapData(mapData) {
    this._roundManager.overrideMapData(mapData);
  }

  // прибавка к рангу для игр, которые не эмитят CoreEvent::Death и потому
  // никогда не проходят через RoundManager.reportKill: прямая прокладка к
  // PlayerDataSync, без раунд-логики и без проверки team-wipe.
  // @deprecated snakes-v3: алиас addPlayerPoints
  addPlayerRank(gameId, delta) {
    this._playerDataSync.addRank(gameId, delta);
  }

  // ***** результат игры (snakes-v3 этап 3) ***** //

  // очки ТЕКУЩЕЙ игры участника: жизнь, раунд, матч — что игра называет
  // игрой. В рейтинги они попадают только на finishPlayerGame
  addPlayerPoints(gameId, delta) {
    this._playerDataSync.addPoints(gameId, delta);
  }

  // игра участника закончилась: накопленные очки уходят в сумму (месячный
  // рейтинг) и в максимум (дневной). Игра без раундов зовёт это сама — у
  // игры с раундами обе границы закрывает RoundManager
  finishPlayerGame(gameId) {
    this._playerDataSync.finishGame(gameId);
  }

  // значения среза для показа: { value, placement, total } или null
  getPlayerRating(gameId, period) {
    return this._playerDataSync.getRating(gameId, period);
  }

  // приехал ли СРЕЗ с мастера: ноль незагруженного рейтинга и настоящий
  // ноль — разные вещи, и игре, которая на них смотрит, надо их различать
  isPlayerRatingLoaded(gameId, period) {
    return this._playerDataSync.isRatingLoaded(gameId, period);
  }

  // точечный перезапрос места в срезе (чат-команда /rank): место меняют
  // чужие игры, локально его не пересчитать. Троттлинг — в PlayerDataSync
  refreshPlayerPlacement(gameId, period) {
    return this._playerDataSync.refreshPlacement(gameId, period);
  }

  // синхронизация профилей (rank/state) всех участников на мастер прямо
  // сейчас — для игр, у которых нет ни конца раунда, ни смены карты
  // (`endlessRound` + карта, пересобираемая через overrideMapData): обе
  // штатные границы flushAll живут в RoundManager, и такая игра не проходит
  // ни через одну из них. Без этого накопленный за матч ранг уезжает в auth
  // только на выходе участника, а закрытая вкладка хоста теряет его вовсе.
  //
  // Best-effort, как и весь PlayerDataSync: промис не отвергается, сбой
  // логируется в `[playerData]` и повторится следующим flush'ем.
  //
  // snakes-v3 этап 3: это просьба, а не команда — участник, у которого с
  // прошлой синхронизации прошло меньше lobbyConfig.playerData.
  // minFlushInterval, пропускается. Срочные границы (уход участника,
  // destroy комнаты) интервал обходят, игре они недоступны
  flushPlayerData({ urgent = false } = {}) {
    return this._playerDataSync.flushAll({ urgent });
  }

  // roomId + секрет эпохи комнаты, подтверждённые мастером в
  // host_registered — не известны при создании HostGame (Worker стартует
  // раньше ответа мастера); нужны PlayerDataSync для атрибуции
  // rank/state-flush (секрет доказывает мастеру владение комнатой)
  setRoom({ roomId, roomSecret, epoch } = {}) {
    this._roomId = roomId ?? null;
    this._epoch = epoch ?? null;
    this._playerDataSync.setRoom({ roomId, roomSecret, epoch });
  }

  // ***** возобновление сессии (host-migration этап 4) ***** //

  // выдаёт участнику секрет возобновления, если его ещё нет; ключ —
  // только для нового выданного (null — уже выдан или участника нет)
  issueResumeKey(gameId) {
    const user = this._participants.get(gameId);

    if (!user?.isNetworked || user.resumeKey) {
      return null;
    }

    user.resumeKey = createResumeKey();

    return user.resumeKey;
  }

  // транспорт участника оборвался без LEAVE: место держится до возврата.
  // Слот занят (isFull его считает), актор остаётся в мире, но все его
  // команды отпущены; RTT- и idle-кики его не трогают. false — держать
  // нечего (не вошёл в матч, хост-игрок, уже отсоединён) — снимать сразу
  detachUser(gameId) {
    const user = this._participants.get(gameId);

    if (
      !user?.isNetworked ||
      !user.resumeKey ||
      user.detachedAt !== null ||
      this._isHostPlayer(user)
    ) {
      return false;
    }

    if (user.isWatching !== true) {
      for (const name of this._playerKeyNames) {
        this._game.applyInput(gameId, user.lastInputSeq, 'up', name);
      }
    }

    this._RTTManager.removeUser(gameId);
    user.detachedAt = clock.now();

    // рассылки на это время уходят в никуда: сокета нет, а id соединения
    // мог уже достаться другому подключению
    user.socketId = detachedSocketId(gameId);
    this._socketManager.addUser(user.socketId, DETACHED_SOCKET);

    return true;
  }

  // участник ждёт возобновления
  isDetached(gameId) {
    const user = this._participants.get(gameId);

    return Boolean(user && user.detachedAt !== null);
  }

  // что нужно порт-машине для проверки RESUME_REQUEST: ник, под которым
  // участник входил, и его секрет. null — возвращаться некуда
  getResumeTarget(gameId) {
    const user = this._participants.get(gameId);

    if (!user?.isNetworked || !user.resumeKey) {
      return null;
    }

    return {
      identityName: user.identityName,
      resumeKey: user.resumeKey,
      socketId: user.socketId,
    };
  }

  // привязывает участника к новому соединению и шлёт ему всё, что нужно,
  // чтобы продолжить с того же места: RESUME_RESULT, затем пакет входа
  // (очистка, полный кадр, stat/panel/keyset/accolades) и новый секрет.
  // Участник мог быть и не отсоединён — перехват полуоткрытой сессии
  resumeUser(gameId, socketId, token) {
    const user = this._participants.get(gameId);

    if (!user) {
      return false;
    }

    if (user.detachedAt !== null) {
      this._socketManager.removeUser(user.socketId);
      this._RTTManager.addUser(gameId);
      user.detachedAt = null;
    }

    user.socketId = socketId;
    user.lastActionTime = clock.now();

    if (typeof token === 'string' && token !== '') {
      user.token = token;
      this._playerDataSync.attachToken(gameId, token);
    }

    this._socketManager.sendResumeResult(socketId, {
      ok: true,
      gameId,
      epoch: this._epoch,
    });

    if (user.isReady) {
      this._sendResumeEntry(user);
    } else {
      // карта сменилась, пока участник отсутствовал (или он вышел посреди
      // загрузки): обычный путь загрузки карты
      this.sendMap(gameId);
    }

    // ключ ротируется: прежний мог уйти вместе с полуоткрытым соединением
    user.resumeKey = createResumeKey();
    this._socketManager.sendSessionData(socketId, {
      resumeKey: user.resumeKey,
      gameId,
    });

    // вернулся последний из ожидаемых — восстановленный матч стартует сразу
    if (this._resumeWait && this.detachedGameIds().length === 0) {
      this._finishResumeWait();
    }

    return true;
  }

  // пакет входа возобновлённого участника — тот же набор, что видит игрок
  // на первом кадре (sendFirstShot) и при выдаче актора
  _sendResumeEntry(user) {
    const { socketId, gameId } = user;

    // keyset наблюдателя — до очистки полотна, как в RoundManager.createMap:
    // иначе клиентский предикт успел бы пересоздать сущность после CLEAR
    this._socketManager.sendSpectatorDefaultShot(socketId);
    this._socketManager.sendClear(socketId);
    // CLEAR без списка стирает и карту, а первый кадр несёт лишь частичные
    // данные её сущностей — карту клиент собирает заново. Не
    // RoundManager.sendMap: это не загрузка, участник остаётся готовым.
    // Метка resume — клиенту: MAP_READY не нужен (обычная загрузка
    // неготового участника тоже приходит, пока клиент возобновляется)
    this._socketManager.sendMap(socketId, {
      ...this._roundManager.currentMapData,
      resume: true,
    });
    this._socketManager.sendFirstShot(socketId);

    if (user.isWatching !== true) {
      this._socketManager.sendPlayerDefaultShot(socketId, gameId);
    }

    const accoladesNow = this._accolades.current();

    if (Object.keys(accoladesNow.places).length) {
      this._socketManager.sendAccolades(socketId, accoladesNow);
    }

    user.forceCameraReset = true;
  }

  // обновляет значение round trip time
  updateRTT(gameId, pingId) {
    const latency = this._RTTManager.handlePong(gameId, pingId);

    if (latency !== null) {
      const user = this._participants.get(gameId);

      if (user) {
        this._stat.updateUser(gameId, user.teamId, { latency });
      }
    }
  }
}
