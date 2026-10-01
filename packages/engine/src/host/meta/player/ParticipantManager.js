import HumanParticipant from './HumanParticipant.js';
import ScriptedParticipant from './ScriptedParticipant.js';

// Единый источник истины об участниках игры (люди + scripted-участники).
// Владеет реестром, размерами команд, списком активных игроков,
// генерацией id (единое числовое пространство) и проверкой имён.
class ParticipantManager {
  // scripted — параметры scripted-участников из конфига игры:
  // { namePrefix, defaultModel }
  constructor(teams, spectatorTeam, maxPlayers, scripted = {}) {
    this._teams = teams; // { team1: 1, team2: 2, spectators: 3 }

    // noSpectators (opt-in движка): наблюдателей нет как концепции, и
    // spectatorTeam приходит null. Команда входа тогда — единственная
    // играющая, а не резервная: человек заходит сразу в игру
    this._spectatorTeam = spectatorTeam ?? null;
    this._spectatorId =
      this._spectatorTeam === null ? null : teams[spectatorTeam];
    this._joinTeam = this._spectatorTeam ?? Object.keys(teams)[0];
    this._joinTeamId = teams[this._joinTeam];
    this._maxPlayers = maxPlayers;
    this._scripted = scripted;

    this._participants = new Map(); // gameId -> Participant
    this._teamSizes = {}; // team -> Set<gameId>
    this._activePlayersList = []; // gameId[]

    this.resetTeamSizes();
  }

  // наименьший свободный числовой id (единое пространство людей и scripted)
  _nextGameId() {
    let counter = 0;

    while (this._participants.has(counter.toString(10))) {
      counter += 1;
    }

    return counter.toString(10);
  }

  // команда, в которую попадает подключившийся человек: наблюдатели, а под
  // noSpectators — единственная играющая команда
  get joinTeam() {
    return this._joinTeam;
  }

  get joinTeamId() {
    return this._joinTeamId;
  }

  // создаёт участника-человека (наблюдателя, а под noSpectators — игрока),
  // возвращает gameId
  createHuman(params, socketId) {
    const gameId = this._nextGameId();
    const name = this.checkName(params.name);

    const participant = new HumanParticipant({
      gameId,
      name,
      model: params.model,
      team: this._joinTeam,
      teamId: this._joinTeamId,
      socketId,
      watchedGameId: this._activePlayersList[0] || null,
      token: params.token,
      identityName: params.name,
    });

    this._participants.set(gameId, participant);
    this._teamSizes[this._joinTeam].add(gameId);

    return gameId;
  }

  // создаёт scripted-участника в команде, возвращает gameId
  createScripted({ team, model }) {
    const gameId = this._nextGameId();
    const name = this.checkName(`${this._scripted.namePrefix}${gameId}`);
    const teamId = this._teams[team];

    const participant = new ScriptedParticipant({
      gameId,
      name,
      model: model ?? this._scripted.defaultModel,
      team,
      teamId,
    });

    this._participants.set(gameId, participant);
    this._teamSizes[team].add(gameId);

    return gameId;
  }

  // восстанавливает человека с исходным gameId (эстафета Worker'ов, Этап 5.2);
  // занятый id или неизвестная команда — null (запись пропускается).
  // Поля личности (ник входа, секрет места, цвет ника, токен) переносятся
  // всегда; игровое состояние (статус, камера, слот респауна, номер ввода) —
  // только при full: восстановлении посреди раунда (host-migration этап 5),
  // иначе раунд всё равно начнётся заново
  restoreHuman(record, { full = false } = {}) {
    const { gameId, socketId, name, model, team, teamId } = record;

    if (this._participants.has(gameId) || !this._teamSizes[team]) {
      return null;
    }

    const participant = new HumanParticipant({
      gameId,
      name,
      model,
      team,
      teamId,
      socketId,
      watchedGameId: this._activePlayersList[0] || null,
      token: record.token ?? null,
      identityName: record.identityName ?? null,
    });

    participant.chatColor = record.chatColor ?? null;
    participant.resumeKey = record.resumeKey ?? null;

    if (full) {
      this._applyPlayState(participant, record);
      participant.isWatching = record.isWatching !== false;
      participant.watchedGameId = record.watchedGameId ?? null;
      participant.lastInputSeq = record.lastInputSeq >>> 0;
    }

    this._participants.set(gameId, participant);
    this._teamSizes[team].add(gameId);

    return participant;
  }

  // восстанавливает scripted-участника с исходным gameId
  // (эстафета Worker'ов, Этап 5.2)
  restoreScripted(record, { full = false } = {}) {
    const { gameId, name, model, team, teamId } = record;

    if (this._participants.has(gameId) || !this._teamSizes[team]) {
      return null;
    }

    const participant = new ScriptedParticipant({
      gameId,
      name,
      model,
      team,
      teamId,
    });

    participant.chatColor = record.chatColor ?? null;

    if (full) {
      this._applyPlayState(participant, record);
    }

    this._participants.set(gameId, participant);
    this._teamSizes[team].add(gameId);

    return participant;
  }

  _applyPlayState(participant, record) {
    if (typeof record.status === 'string') {
      participant.status = record.status;
    }

    participant.respawnIndex = Number.isInteger(record.respawnIndex)
      ? record.respawnIndex
      : null;
  }

  // ***** контрольная точка (host-migration этап 5) ***** //

  // участники и топология команд. Токенов здесь нет: точка уезжает по сети
  // к другому игроку, токен — личный секрет участника
  serialize() {
    return {
      humans: this.getHumans().map(p => ({
        gameId: p.gameId,
        name: p.name,
        model: p.model,
        team: p.team,
        teamId: p.teamId,
        status: p.status,
        isReady: p.isReady,
        isWatching: p.isWatching,
        watchedGameId: p.watchedGameId,
        respawnIndex: p.respawnIndex,
        lastInputSeq: p.lastInputSeq,
        chatColor: p.chatColor,
        resumeKey: p.resumeKey,
        identityName: p.identityName,
      })),
      scripted: this.getScripted().map(p => ({
        gameId: p.gameId,
        name: p.name,
        model: p.model,
        team: p.team,
        teamId: p.teamId,
        status: p.status,
        respawnIndex: p.respawnIndex,
        chatColor: p.chatColor,
      })),
      teamSizes: Object.fromEntries(
        Object.entries(this._teamSizes).map(([team, ids]) => [team, [...ids]]),
      ),
      activePlayers: [...this._activePlayersList],
    };
  }

  // состав команд и список активных из точки — после restoreHuman/
  // restoreScripted; id, не пережившие восстановление, отбрасываются
  restoreTopology({ teamSizes = {}, activePlayers = [] } = {}) {
    for (const [team, ids] of Object.entries(teamSizes)) {
      if (this._teamSizes[team]) {
        this._teamSizes[team] = new Set(
          ids.filter(id => this._participants.has(id)),
        );
      }
    }

    this._activePlayersList = activePlayers.filter(id =>
      this._participants.has(id),
    );
  }

  // полностью удаляет участника из реестра (команда + список активных)
  remove(gameId) {
    const participant = this._participants.get(gameId);

    if (!participant) {
      return;
    }

    this.removeActive(gameId);
    this._teamSizes[participant.team]?.delete(gameId);
    this._participants.delete(gameId);
  }

  // задаёт цвет ника в чате: '#rgb'/'#rrggbb' или null (цвет команды).
  // Единственный вход для игры — HostGame отдаёт это значение в chat.push,
  // а клиентская view кладёт его инлайновой переменной на строку
  setChatColor(gameId, color) {
    const participant = this._participants.get(gameId);

    if (!participant) {
      return;
    }

    participant.chatColor =
      typeof color === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)
        ? color
        : null;
  }

  get(gameId) {
    return this._participants.get(gameId);
  }

  getAll() {
    return [...this._participants.values()];
  }

  getHumans() {
    return this.getAll().filter(p => p.isNetworked);
  }

  getScripted() {
    return this.getAll().filter(p => p.isScripted);
  }

  // люди, готовые к игре (получатели сетевого кадра); отсоединённые
  // (ждут возобновления, host-migration этап 4) кадров не получают
  getNetworkedReady() {
    return this.getHumans().filter(p => p.isReady && p.detachedAt === null);
  }

  // проверяет уникальность имени по всему реестру (люди + scripted)
  checkName(name, number = 1) {
    for (const participant of this._participants.values()) {
      if (participant.name === name) {
        if (number > 1) {
          name = name.slice(0, name.lastIndexOf('#')) + '#' + number;
        } else {
          name = name + '#' + number;
        }

        return this.checkName(name, number + 1);
      }
    }

    return name;
  }

  // команды
  getPlayableTeams() {
    return Object.keys(this._teams).filter(t => t !== this._spectatorTeam);
  }

  getTeamSize(team) {
    return this._teamSizes[team].size;
  }

  addToTeam(gameId, team) {
    this._teamSizes[team].add(gameId);
  }

  removeFromTeam(gameId, team) {
    this._teamSizes[team].delete(gameId);
  }

  resetTeamSizes() {
    this._teamSizes = Object.keys(this._teams).reduce((acc, key) => {
      acc[key] = new Set();
      return acc;
    }, {});
  }

  // активные игроки (на полотне, для наблюдения)
  addActive(gameId) {
    if (!this._activePlayersList.includes(gameId)) {
      this._activePlayersList.push(gameId);
    }
  }

  removeActive(gameId) {
    this._activePlayersList = this._activePlayersList.filter(
      id => id !== gameId,
    );

    // перецепление наблюдателей на другого активного игрока
    for (const participant of this._participants.values()) {
      if (participant.watchedGameId === gameId) {
        participant.watchedGameId = this._activePlayersList[0] || null;
      }
    }
  }

  clearActive() {
    this._activePlayersList = [];
  }

  getActiveList() {
    return this._activePlayersList;
  }

  // заменяет наблюдаемого игрока (victimId) на killerId
  replaceWatched(victimId, killerId) {
    if (!this._activePlayersList.includes(killerId)) {
      return;
    }

    for (const participant of this._participants.values()) {
      if (participant.watchedGameId === victimId) {
        participant.watchedGameId = killerId;
      }
    }
  }

  // суммарно люди + scripted (для лимита maxPlayers)
  get totalCount() {
    return this._participants.size;
  }

  get isFull() {
    return this._maxPlayers ? this.totalCount >= this._maxPlayers : false;
  }

  // потолок комнаты: игре он нужен, чтобы ограничивать пользовательский
  // ввод до цикла (`/spawn 1e9`), а не упираться в isFull на каждой итерации
  get maxPlayers() {
    return this._maxPlayers;
  }
}

export default ParticipantManager;
