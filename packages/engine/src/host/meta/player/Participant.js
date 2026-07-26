// Базовый класс участника — источник истины полей, общих для людей и ботов
class Participant {
  constructor({ gameId, name, model, team, teamId }) {
    this.gameId = gameId;
    this.name = name;
    this.model = model;
    this.team = team;
    this.teamId = teamId;
    this.status = 'spectator'; // 'spectator' | 'active' | 'dead'
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
