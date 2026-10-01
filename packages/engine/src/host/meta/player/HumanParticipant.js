import Participant from './Participant.js';
import clock from '../../../lib/clock.js';

// Участник-человек: поля и поведение, специфичные для реального игрока
class HumanParticipant extends Participant {
  constructor({
    gameId,
    name,
    model,
    team,
    teamId,
    socketId,
    watchedGameId,
    token = null,
    identityName = null,
  }) {
    super({ gameId, name, model, team, teamId });

    this.socketId = socketId;
    // identity-токен участника (Этап B4): переиспользуется для
    // авторизованной синхронизации rank/state с мастером
    this.token = token;
    this.isReady = false;
    this.currentMap = null;
    this.isWatching = true;
    this.watchedGameId = watchedGameId ?? null;
    this.forceCameraReset = true;
    this.pendingShake = null;
    this.lastActionTime = clock.now();
    this.lastInputSeq = 0; // номер последнего обработанного ввода (предикшен)

    // возобновление сессии (host-migration этап 4). identityName — ник от
    // стратегии идентичности до разведения дублей (#2): с ним сверяется
    // токен RESUME_REQUEST. resumeKey — секрет места (выдаётся на входе в
    // матч, не логируется). detachedAt — транспорт оборвался, место ждёт
    // возврата (null — подключён)
    this.identityName = identityName ?? name;
    this.resumeKey = null;
    this.detachedAt = null;
  }

  get isNetworked() {
    return true;
  }
}

export default HumanParticipant;
