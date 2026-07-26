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
    this._spectatorTeam = spectatorTeam;
    this._spectatorId = teams[spectatorTeam];
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

  // создаёт участника-человека (спектатор), возвращает gameId
  createHuman(params, socketId) {
    const gameId = this._nextGameId();
    const name = this.checkName(params.name);

    const participant = new HumanParticipant({
      gameId,
      name,
      model: params.model,
      team: this._spectatorTeam,
      teamId: this._spectatorId,
      socketId,
      watchedGameId: this._activePlayersList[0] || null,
      token: params.token,
    });

    this._participants.set(gameId, participant);
    this._teamSizes[this._spectatorTeam].add(gameId);

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
  // занятый id или неизвестная команда — null (запись пропускается)
  restoreHuman({ gameId, socketId, name, model, team, teamId }) {
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
    });

    this._participants.set(gameId, participant);
    this._teamSizes[team].add(gameId);

    return participant;
  }

  // восстанавливает scripted-участника с исходным gameId
  // (эстафета Worker'ов, Этап 5.2)
  restoreScripted({ gameId, name, model, team, teamId }) {
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

    this._participants.set(gameId, participant);
    this._teamSizes[team].add(gameId);

    return participant;
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

  // люди, готовые к игре (получатели сетевого кадра)
  getNetworkedReady() {
    return this.getHumans().filter(p => p.isReady);
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
}

export default ParticipantManager;
