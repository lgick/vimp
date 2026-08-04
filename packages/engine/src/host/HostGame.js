import Panel from './meta/modules/Panel.js';
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
import clock from '../lib/clock.js';
import GameCoreAdapter from './GameCoreAdapter.js';
import DebugRecorder from './DebugRecorder.js';

// Версия формата handoff-меты эстафеты Worker'ов (Этап 5.2; →2 в Этапе 6.5 —
// добавлены gameId/gameVersion; →3 в Этапе Д3 — нейтральное поле scripted).
// Несовместимая версия валит init нового Worker'а — главный поток
// возобновляет старый, комната продолжает жить на прежней версии кода
export const HANDOFF_VERSION = 3;

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
   *   смене (голосование/таймер) — для актуализации комнаты у мастера.
   * @param {Object} [opts.handoff] - handoff-мета эстафеты Worker'ов
   *   (Этап 5.2): восстановление комнаты вместо холодного старта.
   * @param {string} [opts.gameVersion] - версия игры комнаты (room.game.version,
   *   Этап 6.5): едет в handoff-мете рядом с gameId — расхождение с игрой
   *   восстанавливающего Worker'а валит init тем же путём, что и версия формата.
   * @param {number} [opts.seed] - seed мира, которым инициализировано ядро
   *   (createHostRuntime): без него записанный сценарий невоспроизводим.
   */
  constructor(
    data,
    socketManager,
    core,
    hostPlugin,
    {
      hostSocketId = null,
      onMapChange = null,
      handoff = null,
      gameVersion = null,
      playerDataFetch = null,
      seed = null,
    } = {},
  ) {
    this._isDevMode = data.isDevMode || false;
    this._seed = seed;

    this._hostSocketId = hostSocketId;
    this._onMapChange = onMapChange;

    // составной codeVersion (Этап 6.5): id — из самого загруженного плагина
    // (источник истины), version — то, что заявил Worker при инициализации
    this._gameId = hostPlugin.id;
    this._gameVersion = gameVersion;

    this._maps = data.maps;
    this._mapList = Object.keys(data.maps);
    this._spectatorKeys = data.spectatorKeys;
    this._maxPlayers = data.maxPlayers;
    this._chatMaxLength = data.chatMaxLength;

    this._idleTimeoutForPlayer = data.idleKickTimeout?.player || null;
    this._idleTimeoutForSpectator = data.idleKickTimeout?.spectator || null;

    this._teams = data.teams;
    this._spectatorTeam = data.spectatorTeam;
    this._spectatorId = this._teams[this._spectatorTeam];

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
    this._chat = new Chat();
    this._vote = new Vote();

    this._socketManager = socketManager;

    this._networkSendRate = data.timers.networkSendRate;
    this._snapshotManager = new SnapshotThrottle(this._networkSendRate);

    // рекордер живого матча (этап 6 плана plan/ai-debug) — только в dev-режиме;
    // в проде null, и все точки записи ниже вырождаются в ?.
    this._recorder = this._isDevMode ? new DebugRecorder() : null;

    // игровые host-модули (scripted-модуль игры)
    this._scripted = hostPlugin.createModules({
      participants: this._participants,
      coreAdapter: this._game,
      panel: this._panel,
      stat: this._stat,
      chat: this._chat,
      socketManager: this._socketManager,
      scripted: data.scripted,
    }).scripted;

    this._RTTManager = new RTTManager(data.rtt, {
      onKickForMissedPings: gameId => this._kickForMissedPings(gameId),
      onKickForMaxLatency: gameId => this._kickForMaxLatency(gameId),
    });

    this._timerManager = new TimerManager(data.timers, {
      onMapTimeEnd: () => this._roundManager.onMapTimeEnd(),
      onRoundTimeEnd: () => this._roundManager.initiateNewRound(),
      onShotTick: dt => this._onShotTick(dt),
      onIdleCheck: () => this._kickIdleUsers(),
      onSendPing: () => this._sendPing(),
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

    // внедрение зависимостей (ядро отдаёт панель/фасад события через адаптер)
    this._socketManager.injectServices(this._game, this._panel, this._stat);
    this._game.injectServices({ vimp: this, panel: this._panel });
    this._panel.injectTimerManager(this._timerManager);

    this._timerManager.startIdleCheckTimer();

    // эстафета Worker'ов (Этап 5.2): восстановление вместо холодного старта;
    // игровой цикл и первый раунд запустит completeHandoff() после
    // переподключения клиентов главным потоком
    if (handoff) {
      this._restoreFromHandoff(handoff);
    } else {
      this._roundManager.createMap();
    }

    // отслеживание смены карты (для актуализации комнаты в лобби мастера)
    this._lastReportedMap = this._roundManager.currentMap;
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

  // хост-игрок не кикается: закрытие его loopback = смерть комнаты для всех
  _isHostPlayer(user) {
    return this._hostSocketId !== null && user.socketId === this._hostSocketId;
  }

  // кикает за задержку в ответе на ping
  _kickForMaxLatency(gameId) {
    const user = this._participants.get(gameId);

    if (user && !this._isHostPlayer(user)) {
      console.warn(`[RTT] Kick ${user.name} — pong latency exceeded`);
      this._socketManager.close(user.socketId, 4003, 'kickForMaxLatency');
      this.removeUser(gameId);
    }
  }

  // кикает за превышение прокусков ответа на ping
  _kickForMissedPings(gameId) {
    const user = this._participants.get(gameId);

    if (user && !this._isHostPlayer(user)) {
      console.warn(`[RTT] Kick ${user.name} — no response to pings`);
      this._socketManager.close(user.socketId, 4004, 'kickForMissedPings');
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

    // список удаляемых с полотна игроков ведёт RoundManager, но null-маркеры
    // в кадр кладёт само ядро (remove_actor) — здесь лишь опустошаем очередь,
    // чтобы она не росла
    const removedPlayersList = this._roundManager.removedPlayersList;

    while (removedPlayersList.length) {
      removedPlayersList.pop();
    }

    const userList = this._participants.getNetworkedReady();
    const panelUpdates = this._panel.processUpdates();
    const stat = this._stat.getLast();
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

      const chatUser = chat || this._chat.shiftByUser(gameId);
      if (chatUser) {
        this._socketManager.sendChat(socketId, chatUser);
      }

      const voteUser = vote || this._vote.shiftByUser(gameId);
      if (voteUser) {
        this._socketManager.sendVote(socketId, voteUser);
      }
    });
  }

  // проверяет игроков на бездействие и кикает, если превышен порог
  _kickIdleUsers() {
    const now = clock.now();
    const usersToKick = [];

    for (const user of this._participants.getHumans()) {
      if (user.isReady !== true || this._isHostPlayer(user)) {
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
      this._socketManager.close(user.socketId, 4005, 'kickIdle');
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
    this._chat.pushSystem('USER_JOINED', [user.name]);
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

  // ***** отладочный контур (этап 6 плана plan/ai-debug) ***** //
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

  // ***** эстафета Worker'ов (Этап 5.2) ***** //

  // запрашивает перенос: на ближайшей границе раунда игра останавливается
  // и cb получает handoff-мету. Ядро не дампится — мир пересоздаётся стартом
  // раунда в новом Worker'е (см. RoundManager._startRound)
  requestHandoff(cb) {
    this._roundManager.requestHandoff(() => {
      this._timerManager.stopGameTimers();
      this._timerManager.stopIdleCheckTimer();
      cb(this._collectHandoff());
    });
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

    for (const user of this._participants.getHumans()) {
      if (!connectedSocketIds.has(user.socketId)) {
        this.removeUser(user.gameId);
      }
    }

    this._timerManager.resumeGameTimers(this._handoffMapTimeLeft);
    this._roundManager.initiateNewRound();
  }

  // собирает переносимую мету: участники, счёт, карта с остатком времени,
  // seq кадров. Осознанно не переносятся: чат-история, активные голосования,
  // RTT-статистика, panel (значения живут в ядре и сбрасываются раундом)
  _collectHandoff() {
    const humans = this._participants
      .getHumans()
      .filter(user => user.isReady)
      .map(user => ({
        gameId: user.gameId,
        socketId: user.socketId,
        name: user.name,
        model: user.model,
        team: user.team,
        teamId: user.teamId,
      }));

    const scripted = this._participants.getScripted().map(participant => ({
      gameId: participant.gameId,
      name: participant.name,
      model: participant.model,
      team: participant.team,
      teamId: participant.teamId,
    }));

    return {
      version: HANDOFF_VERSION,
      gameId: this._gameId,
      gameVersion: this._gameVersion,
      seq: this._seq,
      currentMap: this._roundManager.currentMap,
      mapTimeLeft: this._timerManager.getMapTimeLeft(),
      humans,
      scripted,
      stat: this._stat.serialize(),
    };
  }

  // восстанавливает комнату из handoff-меты. Ошибка (несовместимый формат,
  // чужая игра, карта ушла из каталога) валит init Worker'а — главный поток
  // возобновляет старый Worker, комната живёт на прежней версии
  _restoreFromHandoff(meta) {
    if (!meta || meta.version !== HANDOFF_VERSION) {
      throw new Error(`unsupported handoff version: ${meta && meta.version}`);
    }

    // составной codeVersion (Этап 6.5): своп меняет только версию кода в
    // рамках той же игры — смена самой игры комнаты handoff'ом не
    // предусмотрена, рассинхрон id — явный сбой конфигурации свопа
    if (meta.gameId !== undefined && meta.gameId !== this._gameId) {
      throw new Error(
        `handoff game mismatch: expected "${this._gameId}", got "${meta.gameId}"`,
      );
    }

    if (!this._maps[meta.currentMap]) {
      throw new Error(`handoff map missing from catalog: ${meta.currentMap}`);
    }

    this._seq = meta.seq >>> 0;
    this._handoffMapTimeLeft = meta.mapTimeLeft;

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
    this._stat.addUser(gameId, this._spectatorId, { name });
    this._panel.addUser(gameId);
    this._RTTManager.addUser(gameId);

    // подгрузка rank/state с мастера (Этап B4) — асинхронно, не блокирует
    // вход; сбой auth-сервиса оставляет участника с дефолтами
    this._playerDataSync.load(gameId, params.token);

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

    this._RTTManager.removeUser(gameId);
    this._stat.removeUser(gameId, teamId);
    this._chat.removeUser(gameId);
    this._vote.removeUser(gameId);
    this._panel.removeUser(gameId);

    // финальная синхронизация rank/state перед уходом участника (Этап B4)
    this._playerDataSync
      .flush(gameId)
      .catch(err => console.warn('[playerData] final flush failed:', err.message))
      .finally(() => this._playerDataSync.removeUser(gameId));

    // если не наблюдатель — удалить танк из ядра (null-маркер ставит ядро)
    if (team !== this._spectatorTeam) {
      this._game.removePlayer(gameId);
    }

    this._participants.remove(gameId);

    this._chat.pushSystem('USER_LEFT', [user.name]);
  }

  // обновляет команды (формат wire: 'seq:action:name')
  updateKeys(gameId, keyStr) {
    const user = this._participants.get(gameId);

    if (!user) {
      return;
    }

    const [seq, action, name] = keyStr.split(':');

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
        this._chat.push(message, user.name, user.teamId);
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

  getPlayerState(gameId) {
    return this._playerDataSync.getState(gameId);
  }

  setPlayerState(gameId, state) {
    this._playerDataSync.setState(gameId, state);
  }

  // hostId + per-room секрет комнаты, подтверждённые мастером при
  // register_host (кодревью №1) — не известны при создании HostGame (Worker
  // стартует раньше ответа мастера); нужны PlayerDataSync для атрибуции
  // rank/state-flush (секрет доказывает мастеру владение комнатой)
  setHostId(hostId, hostSecret) {
    this._playerDataSync.setHostId(hostId, hostSecret);
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
