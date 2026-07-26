import { isValidName } from '../../../lib/validators.js';

// масштабирование данных карты (физика, респауны) под mapScale
function scaleMapData(mapData) {
  const scale = mapData.scale;
  const step = mapData.step * scale;

  const physicsDynamic = (mapData.physicsDynamic || []).map(item => ({
    ...item,
    position: item.position.map(v => v * scale),
    width: item.width * scale,
    height: item.height * scale,
  }));

  const respawns = Object.fromEntries(
    Object.entries(mapData.respawns || {}).map(([team, arr]) => [
      team,
      arr.map(([x, y, angle]) => [x * scale, y * scale, angle]),
    ]),
  );

  return {
    ...mapData,
    step,
    physicsDynamic,
    respawns,
    scale,
  };
}

// Менеджер раундов, команд и карт. Владеет жизненным циклом раунда/карты
// и состоянием: currentMap/currentMapData/scaledMapData, isRoundEnding,
// startMapNumber и списком игроков для удаления с полотна.
class RoundManager {
  constructor(deps) {
    this._participants = deps.participants;
    this._game = deps.game;
    this._panel = deps.panel;
    this._stat = deps.stat;
    this._chat = deps.chat;
    this._socketManager = deps.socketManager;
    this._timerManager = deps.timerManager;
    this._scripted = deps.scripted;
    this._voteCoordinator = deps.voteCoordinator;
    this._snapshotManager = deps.snapshotManager;
    this._playerDataSync = deps.playerDataSync || null;

    // конфигурация
    this._teams = deps.teams;
    this._spectatorTeam = deps.spectatorTeam;
    this._spectatorId = deps.spectatorId;
    this._maps = deps.maps;
    this._mapList = deps.mapList;
    this._mapsInVote = deps.mapsInVote;
    this._mapScale = deps.mapScale;
    this._mapSetId = deps.mapSetId;

    // состояние раунда/карты
    this._currentMap = deps.currentMap;
    this._currentMapData = null;
    this._scaledMapData = null;
    this._startMapNumber = 0;
    this._isRoundEnding = false;
    this._removedPlayersList = []; // gameId игроков для удаления с полотна

    // эстафета Worker'ов (Этап 5.2): колбэк переноса на границе раунда
    this._handoffCallback = null;
  }

  get currentMap() {
    return this._currentMap;
  }

  get currentMapData() {
    return this._currentMapData;
  }

  get removedPlayersList() {
    return this._removedPlayersList;
  }

  // запускает голосование за смену карты по истечении времени карты
  onMapTimeEnd() {
    this._voteCoordinator.reset();
    this.changeMap();
  }

  // подготавливает данные текущей карты (масштабирование) без пересоздания
  // мира — общий шаг createMap и восстановления эстафеты (Этап 5.2)
  _prepareMapData() {
    this._currentMapData = {
      scale: this._mapScale,
      ...this._maps[this._currentMap],
    };

    // если нет индивидуального конструктора для создания карты
    if (!this._currentMapData.setId) {
      this._currentMapData.setId = this._mapSetId;
    }

    this._scaledMapData = scaleMapData(this._currentMapData);
  }

  // восстанавливает карту после эстафеты Worker'ов (Этап 5.2): без
  // пересоздания мира и рассылки клиентам — мир соберёт первый
  // initiateNewRound после переноса
  restoreMap(mapName) {
    this._currentMap = mapName;
    this._prepareMapData();
    this._scripted.createMap(this._scaledMapData);
  }

  // создает карту
  createMap() {
    this._prepareMapData();
    this._scripted.createMap(this._scaledMapData);
    const scriptedCounts = this._scripted.getCountsPerTeam();
    this._scripted.removeScripted();

    // остановка всех игровых таймеров и отложенных вызовов
    this._timerManager.stopGameTimers();

    this._participants.resetTeamSizes();

    this._participants.clearActive();
    this._removedPlayersList = [];

    this._panel.reset();
    this._stat.reset();
    this._voteCoordinator.reset();

    // синхронизация накопленных rank/state на мастер перед сменой карты
    // (Этап B4) — естественная граница жизненного цикла
    this._playerDataSync?.flushAll();

    this._snapshotManager.reset();

    this._game.clear();
    this._game.createMap(this._scaledMapData);

    for (const user of this._participants.getHumans()) {
      const gameId = user.gameId;

      this._socketManager.sendClear(user.socketId);

      // перемещение пользователя в наблюдатели
      this._stat.moveUser(gameId, user.teamId, this._spectatorId);

      // обнулить параметры
      user.team = this._spectatorTeam;
      user.teamId = this._spectatorId;
      user.status = 'spectator';
      user.isWatching = true;
      user.watchedGameId = this._participants.getActiveList()[0] || null;
      user.forceCameraReset = true;

      this._participants.addToTeam(gameId, this._spectatorTeam);

      this.sendMap(gameId);
    }

    // воссоздание scripted-участников на новой карте
    for (const [team, count] of Object.entries(scriptedCounts)) {
      if (count > 0) {
        this._scripted.createScripted(count, team);
      }
    }

    this._timerManager.startGameTimers();
  }

  // отправляет карту игроку
  sendMap(gameId) {
    const user = this._participants.get(gameId);
    const socketId = user.socketId;

    user.isReady = false;
    user.currentMap = this._currentMap;
    this._socketManager.sendTechInform(socketId, 'loading');
    this._socketManager.sendMap(socketId, this._currentMapData);
  }

  // немедленная смена карты (когда голосование не требуется)
  forceChangeMap(mapName) {
    this._currentMap = mapName;
    this.createMap();
  }

  // эстафета Worker'ов (Этап 5.2): запросить перенос на ближайшей границе
  // раунда — вместо старта нового раунда сработает колбэк (сбор состояния)
  requestHandoff(cb) {
    this._handoffCallback = cb;
  }

  // отмена запрошенного переноса (своп не состоялся)
  cancelHandoff() {
    this._handoffCallback = null;
  }

  // запуск нового раунда
  initiateNewRound() {
    this._timerManager.stopRoundTimer();

    // граница раунда достигнута — отдать состояние эстафете; новый раунд
    // стартует уже новый Worker после переноса
    if (this._handoffCallback) {
      const cb = this._handoffCallback;

      this._handoffCallback = null;
      cb();
      return;
    }

    this._startRound();
    this._timerManager.startRoundTimer();
  }

  // начало раунда
  _startRound() {
    this._isRoundEnding = false; // сброс флага завершения раунда

    const respawns = this._scaledMapData.respawns;
    const respId = Object.keys(this._teams)
      .filter(key => key !== this._spectatorTeam)
      .reduce((acc, key) => ({ ...acc, [key]: 0 }), {});

    function getRespawnData(team) {
      const number = respId[team];

      respId[team] += 1;

      return respawns[team][number];
    }

    // очищение списка играющих
    this._participants.clearActive();

    this._panel.reset();

    const setIdList = this._game.removePlayersAndShots();

    this._game.createMap(this._scaledMapData);

    for (const user of this._participants.getHumans()) {
      if (user.isReady === false) {
        continue;
      }

      const socketId = user.socketId;
      const team = user.team;

      this._socketManager.sendClear(socketId, setIdList);

      if (team === this._spectatorTeam) {
        user.isWatching = true;
        user.forceCameraReset = true;
        this._socketManager.sendSpectatorDefaultShot(socketId);
      } else {
        this._setActivePlayer(user, getRespawnData(team));
      }

      this._socketManager.sendSoundCue(socketId, 'roundStart');
      this._socketManager.sendGameInform(socketId, 'roundStart');
    }

    // размещение scripted-участников на карте
    for (const participant of this._participants.getScripted()) {
      this._setActivePlayer(participant, getRespawnData(participant.team));
    }
  }

  // меняет ник игрока
  changeName(gameId, name) {
    const user = this._participants.get(gameId);
    const oldName = user.name;

    if (isValidName(name)) {
      name = this._participants.checkName(name);
      user.name = name;
      this._game.changeName(gameId, name);
      this._stat.updateUser(gameId, user.teamId, { name });
      this._chat.pushSystem('NAME_CHANGED', [oldName, name]);
      this._socketManager.sendName(user.socketId, name);
    } else {
      this._chat.pushSystemByUser(gameId, 'NAME_INVALID');
    }
  }

  // меняет команду игрока
  changeTeam(gameId, newTeam) {
    const user = this._participants.get(gameId);
    const currentTeam = user.team;
    const respawns = this._scaledMapData.respawns;

    // если игрок выбирает свою текущую команду
    if (newTeam === currentTeam) {
      this._chat.pushSystemByUser(gameId, 'TEAMS_YOUR_TEAM', [newTeam]);
      return;
    }

    // если новая команда не наблюдатель и нет свободных респаунов
    if (
      newTeam !== this._spectatorTeam &&
      respawns[newTeam].length <= this._participants.getTeamSize(newTeam)
    ) {
      // попытка удалить одного scripted-участника, чтобы освободить место
      const slotFreed = this._scripted.removeOneForHuman(newTeam);

      if (!slotFreed) {
        this._chat.pushSystemByUser(gameId, 'TEAMS_TEAM_FULL', [
          newTeam,
          currentTeam,
        ]);

        return;
      }
    }

    // на этом этапе смена команды доступна
    this._participants.removeFromTeam(gameId, currentTeam);
    this._participants.addToTeam(gameId, newTeam);

    const oldTeamId = user.teamId;
    const newTeamId = this._teams[newTeam];

    user.team = newTeam;
    user.teamId = newTeamId;

    this._stat.moveUser(gameId, oldTeamId, newTeamId);

    // если активных игроков меньше 2-х, рестарт раунда
    if (
      this._participants
        .getHumans()
        .filter(u => u.teamId !== this._spectatorId && u.gameId !== gameId)
        .length < 2
    ) {
      this._stat.reset();
      this.initiateNewRound();
      this._chat.pushSystemByUser(gameId, 'TEAMS_NEW_TEAM', [newTeam]);
      return;
    }

    // если переход из активного игрока в наблюдатели
    if (newTeamId === this._spectatorId) {
      this._setSpectatorFromActivePlayer(user);
      this._chat.pushSystemByUser(gameId, 'TEAMS_NOW_SPECTATOR');
      return;
    }

    // сообщение о смене команды
    this._chat.pushSystemByUser(gameId, 'TEAMS_NEW_TEAM', [newTeam]);

    // если игра активным игроком невозможна в текущем раунде
    if (!this._timerManager.canChangeTeamInCurrentRound()) {
      this._stat.updateUser(gameId, newTeamId, {
        status: 'dead',
      });

      // если пользователь был активным игроком,
      // перевести его в наблюдатели до следующего раунда
      if (oldTeamId !== this._spectatorId) {
        this._setSpectatorFromActivePlayer(user);
      }
      // игра активным игроком возможна в текущем раунде
    } else {
      const respawnIndex = this._participants.getTeamSize(newTeam) - 1;
      const respawnData = respawns[newTeam][respawnIndex];

      // переход из наблюдателя в игрока
      if (oldTeamId === this._spectatorId) {
        this._setActivePlayer(user, respawnData);
        // смена игровой команды
      } else {
        this._game.changePlayerData(gameId, {
          respawnData,
          teamId: newTeamId,
          gameId,
        });
      }
    }
  }

  // перевод активного игрока в наблюдатели
  _setSpectatorFromActivePlayer(user) {
    const gameId = user.gameId;
    const model = user.model;

    user.status = 'spectator';
    user.isWatching = true;
    user.watchedGameId = this._participants.getActiveList()[0] || null;
    user.forceCameraReset = true;

    this._participants.removeActive(gameId);
    this._removedPlayersList.push({ gameId, model });
    this._game.removePlayer(gameId);
    this._socketManager.sendSpectatorDefaultShot(user.socketId);
  }

  // перевод игрока в активные игроки
  _setActivePlayer(user, respawnData) {
    const gameId = user.gameId;
    const teamId = user.teamId;
    const name = user.name;
    const model = user.model;

    user.status = 'active';
    user.isWatching = false;
    user.watchedGameId = null;
    user.forceCameraReset = true;

    // если это реальный игрок (есть сокет)
    if (user.isNetworked) {
      this._socketManager.sendPlayerDefaultShot(user.socketId, gameId);
    }

    this._stat.updateUser(gameId, teamId, { status: '' });
    this._game.createPlayer(gameId, model, name, teamId, respawnData);
    this._participants.addActive(gameId);
  }

  // обрабатывает уничтожение игрока, обновляет статистику
  reportKill(victimId, killerId = null) {
    const victimUser = this._participants.get(victimId);

    if (!victimUser) {
      return;
    }

    victimUser.status = 'dead';
    victimUser.isWatching = true;
    this._stat.updateUser(victimId, victimUser.teamId, {
      deaths: 1,
      status: 'dead',
    });

    // отмена всех запланированных обновлений панели
    this._panel.invalidate(victimId);

    if (victimUser.isNetworked) {
      this._socketManager.sendSpectatorDefaultShot(victimUser.socketId);
      this._socketManager.sendSoundCue(victimUser.socketId, 'death');
    }

    if (killerId) {
      const killerUser = this._participants.get(killerId);

      // убийца мог покинуть игру до попадания (например, взрыв его бомбы) —
      // фраг не начисляется, но раунд обязан корректно завершиться
      if (!killerUser) {
        this._checkTeamWipe(victimUser.teamId, null);
        return;
      }

      // если это не самоубийство
      if (victimId !== killerId) {
        // отслеживание противника
        victimUser.watchedGameId = killerId;
        victimUser.forceCameraReset = true;

        // если кто-то наблюдал за victimId — переназначить на killerId
        this._participants.replaceWatched(victimId, killerId);

        // если это не убийство игрока своей команды
        if (victimUser.teamId !== killerUser.teamId) {
          this._stat.updateUser(killerId, killerUser.teamId, { score: 1 });
          this._playerDataSync?.addRank(killerId, 1);
          // иначе если это огонь по своим
        } else {
          this._stat.updateUser(killerId, killerUser.teamId, { score: -1 });
          this._playerDataSync?.addRank(killerId, -1);
        }

        if (killerUser.isNetworked) {
          this._socketManager.sendSoundCue(killerUser.socketId, 'frag');
        }
      }

      this._chat.pushSystem('REPORT_KILL', [killerUser.name, victimUser.name]);

      // проверка на уничтожение всей команды противника
      this._checkTeamWipe(victimUser.teamId, killerUser.teamId);
    }
  }

  // проверяет уничтожение всей команды
  _checkTeamWipe(victimTeamId, killerTeamId) {
    // если раунд уже в процессе завершения
    if (this._isRoundEnding) {
      return;
    }

    let winnerTeam = null;

    // если команда наблюдателей, проверка не требуется
    if (victimTeamId === this._spectatorId) {
      return;
    }

    // проверка на живых участников в команде (люди и scripted)
    for (const participant of this._participants.getAll()) {
      // если нашелся живой участник, команда не уничтожена
      if (
        participant.teamId === victimTeamId &&
        this._game.isAlive(participant.gameId)
      ) {
        return;
      }
    }

    // активация флага завершения раунда
    this._isRoundEnding = true;

    // запись поражения команде
    this._stat.updateHead(victimTeamId, 'deaths', 1);

    // если убийца из другой команды, фраг для команды-победителя
    if (killerTeamId && killerTeamId !== victimTeamId) {
      this._stat.updateHead(killerTeamId, 'score', 1);

      winnerTeam = Object.keys(this._teams).find(
        key => this._teams[key] === killerTeamId,
      );
    }

    // синхронизация накопленных rank/state на мастер по итогам раунда
    // (Этап B4) — естественная граница жизненного цикла
    this._playerDataSync?.flushAll();

    if (winnerTeam) {
      this._participants.getHumans().forEach(user => {
        const socketId = user.socketId;

        if (user.teamId === victimTeamId) {
          this._socketManager.sendSoundCue(socketId, 'defeat');
        } else {
          this._socketManager.sendSoundCue(socketId, 'victory');
        }

        this._socketManager.sendRoundEnd(socketId, winnerTeam);
      });
    } else {
      this._participants.getHumans().forEach(user => {
        const socketId = user.socketId;

        this._socketManager.sendSoundCue(socketId, 'defeat');
        this._socketManager.sendRoundEnd(socketId);
      });
    }

    this._timerManager.stopRoundTimer();
    this._timerManager.startRoundRestartDelay(); // отложенный перезапуск раунда
  }

  // возвращает список карт для голосования
  _getMapList() {
    if (this._mapList.length <= this._mapsInVote) {
      return this._mapList;
    }

    let endNumber = this._startMapNumber + this._mapsInVote;
    let maps = this._mapList.slice(this._startMapNumber, endNumber);

    if (maps.length < this._mapsInVote) {
      endNumber = this._mapsInVote - maps.length;
      maps = maps.concat(this._mapList.slice(0, endNumber));
    }

    this._startMapNumber = endNumber;

    return maps;
  }

  // отправляет голосование за новую карту
  changeMap(gameId, mapName) {
    const voteCategory = 'mapChange';

    if (!this._voteCoordinator.canCreateVote(voteCategory, gameId)) {
      return;
    }

    // если есть gameId и карта (голосование создает пользователь)
    if (typeof gameId !== 'undefined' && typeof mapName === 'string') {
      const voteName = 'mapChangeByUser';

      const userName = this._participants.get(gameId).name;
      const userList = this._participants
        .getHumans()
        .map(u => u.gameId)
        .filter(id => id !== gameId);
      const payload = { name: voteName, params: [userName, mapName] };

      this._voteCoordinator.createVote({
        voteName,
        voteCategory,
        payload,
        resultFunc: result => {
          if (result === 'Yes' && this._maps[mapName]) {
            this._chat.pushSystem('VOTE_PASSED');
            this._chat.pushSystem('MAP_NEXT', [mapName]);
            this._timerManager.startMapChangeDelay(() => {
              this._currentMap = mapName;
              this.createMap();
            });
          } else {
            this._chat.pushSystem('VOTE_FAILED');
          }
        },
        userList,
        gameId,
      });

      // иначе голосование создает игра
    } else {
      const voteName = 'mapChangeBySystem';

      const mapList = this._getMapList(); // список карт

      const payload = { name: voteName, values: mapList };

      this._voteCoordinator.createVote({
        voteName,
        voteCategory,
        payload,
        resultFunc: resultingMapName => {
          if (resultingMapName && this._maps[resultingMapName]) {
            this._chat.pushSystem('VOTE_PASSED');
            this._chat.pushSystem('MAP_NEXT', [resultingMapName]);
            this._timerManager.startMapChangeDelay(() => {
              this._currentMap = resultingMapName;
              this.createMap();
            });
          } else {
            // если никто не проголосовал, продлеваем время текущей карты
            this._timerManager.stopMapTimer();
            this._timerManager.startMapTimer();
            this._chat.pushSystem('VOTE_FAILED');
            this._chat.pushSystem('MAP_CURRENT', [this._currentMap]);
          }
        },
      });
    }
  }
}

export default RoundManager;
