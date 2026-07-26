import Participant from './Participant.js';

// Scripted-участник: управляется игровым модулем, всегда active-или-удалён,
// наблюдателем не бывает
class ScriptedParticipant extends Participant {
  constructor({ gameId, name, model, team, teamId }) {
    super({ gameId, name, model, team, teamId });

    // в статистику добавляется как 'dead' до старта раунда
    this.status = 'dead';
    this.controller = null;
  }

  get isScripted() {
    return true;
  }
}

export default ScriptedParticipant;
