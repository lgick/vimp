// Базовый класс участника — источник истины полей, общих для людей и ботов
class Participant {
  constructor({ gameId, name, model, team, teamId }) {
    this.gameId = gameId;
    this.name = name;
    this.model = model;
    this.team = team;
    this.teamId = teamId;
    this.status = 'spectator'; // 'spectator' | 'active' | 'dead'
    // индекс точки респауна, занятой этим участником, или null. Раздаёт и
    // освобождает его RoundManager: размер команды для этого не годится —
    // он меняется на входах и выходах, а между попаданием в команду и
    // выдачей актора может пройти вся загрузка карты клиентом
    this.respawnIndex = null;
  }

  // участник, управляемый кодом (ИИ), а не сетевым игроком
  get isScripted() {
    return false;
  }

  get isNetworked() {
    return false;
  }
}

export default Participant;
