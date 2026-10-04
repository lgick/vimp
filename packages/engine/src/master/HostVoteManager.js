import crypto from 'crypto';

const VOTE_VALUES = ['yes', 'no'];

// Голосование «Change host» (host-migration этап 10). Голоса считает мастер,
// а не хост: хост исполняет матч и мог бы отфильтровать голосование против
// себя. Прошедшее голосование просит хоста отдать роль (request_handoff
// vote) и через voteForceAfterMs снимает его принудительно — аварийным
// путём MigrationCoordinator. Состояние голосований — здесь, отметка
// demotedUntil смещённого хоста — в участнике комнаты реестра. Голос — у
// аккаунта (userId), а не у вкладки: N вкладок одного пользователя — один
// голос, и голосует только пробывший в комнате minVoterAgeMs.
export default class HostVoteManager {
  /**
   * @param {Object} deps
   * @param {Object} deps.registry - RoomRegistry.
   * @param {Object} deps.migration - MigrationCoordinator.
   * @param {Function} deps.send - (sessionId, message) отправка сессии.
   * @param {Function} deps.hasSession - (sessionId) жива ли сессия.
   * @param {Object} [deps.timings] - пороги master.room.vote.*.
   */
  constructor(deps) {
    this._registry = deps.registry;
    this._migration = deps.migration;
    this._send = deps.send;
    this._hasSession = deps.hasSession;
    this._now = deps.now ?? (() => Date.now());
    this._randomBytes = deps.randomBytes ?? crypto.randomBytes;
    this._setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);

        timer.unref?.();

        return timer;
      });
    this._clearTimer = deps.clearTimer ?? (timer => clearTimeout(timer));

    this._timings = {
      hostVoteDurationMs: 15000,
      roomVoteCooldownMs: 120000,
      userStartCooldownMs: 60000,
      voteForceAfterMs: 5000,
      demotedCooldownMs: 600000,
      minVoterAgeMs: 30000,
      ...deps.timings,
    };

    // roomId -> { voteId, epoch, initiatorMemberId, eligible, yes, no,
    // endsAt, timer }; eligible/yes/no — множества userId
    this._votes = new Map();
    // roomId -> время старта последнего голосования
    this._lastVoteAt = new Map();
    // roomId -> Map<userId, время его последнего старта>
    this._lastStartByUser = new Map();
    // roomId -> { epoch, timer } — прошедшее голосование ждёт передачи
    this._forces = new Map();
  }

  /**
   * host_vote_start {roomId} от участника комнаты.
   * @param {Object|undefined} room
   * @param {string} memberId - участник-отправитель.
   */
  start(room, memberId) {
    const member = room?.members.get(memberId);
    const reject = reason => {
      this._sendTo(member?.sessionId, {
        type: 'error',
        code: 'voteRejected',
        re: 'host_vote_start',
        roomId: room.roomId,
        reason,
      });
    };

    if (!member) {
      return; // не участник — ответить некому
    }

    if (room.status !== 'online') {
      return reject('migrating');
    }

    // любая вкладка пользователя хоста — тоже хост
    if (
      memberId === room.host.memberId ||
      (member.userId !== null && member.userId === room.host.userId)
    ) {
      return reject('host');
    }

    const now = this._now();
    const timings = this._timings;

    if (!this._isVoter(room, member, now)) {
      return reject('tooNew');
    }

    if (this._votes.has(room.roomId) || this._forces.has(room.roomId)) {
      return reject('active');
    }

    const lastVoteAt = this._lastVoteAt.get(room.roomId);

    if (
      lastVoteAt !== undefined &&
      now - lastVoteAt < timings.roomVoteCooldownMs
    ) {
      return reject('roomCooldown');
    }

    const starts = this._lastStartByUser.get(room.roomId) ?? new Map();
    const lastStart = starts.get(member.userId);

    if (
      lastStart !== undefined &&
      now - lastStart < timings.userStartCooldownMs
    ) {
      return reject('userCooldown');
    }

    // снимать хоста некуда — голосование бессмысленно
    if (!this._migration.hasCandidate(room)) {
      this._sendTo(member.sessionId, {
        type: 'error',
        code: 'noSuccessor',
        re: 'host_vote_start',
        roomId: room.roomId,
      });
      return;
    }

    starts.set(member.userId, now);
    this._lastStartByUser.set(room.roomId, starts);
    this._lastVoteAt.set(room.roomId, now);

    const voters = this._registry
      .liveMembers(room.roomId, now)
      .filter(live => this._isVoter(room, live, now));
    const eligible = new Set(voters.map(live => live.userId));
    const vote = {
      voteId: this._randomBytes(8).toString('hex'),
      epoch: room.epoch,
      initiatorMemberId: memberId,
      eligible,
      yes: new Set([member.userId]),
      no: new Set(),
      endsAt: now + timings.hostVoteDurationMs,
      timer: null,
    };

    vote.timer = this._setTimer(
      () => this._onTimeout(room.roomId, vote.voteId),
      timings.hostVoteDurationMs,
    );
    this._votes.set(room.roomId, vote);

    // хосту окно не шлётся: голосование идёт мимо него. Каждой вкладке
    // голосующего пользователя — своё окно, ответ любой из них — его голос
    for (const voter of voters) {
      if (voter.memberId !== memberId) {
        this._sendTo(voter.sessionId, {
          type: 'host_vote',
          roomId: room.roomId,
          voteId: vote.voteId,
          initiatorNick: member.nick,
          endsAt: vote.endsAt,
          durationMs: timings.hostVoteDurationMs,
          eligibleCount: eligible.size,
        });
      }
    }

    // инициатору — подтверждение старта (в чате «Voting has started», как у
    // голосований хоста)
    this._sendTo(member.sessionId, {
      type: 'host_vote_started',
      roomId: room.roomId,
      voteId: vote.voteId,
      endsAt: vote.endsAt,
      durationMs: timings.hostVoteDurationMs,
      eligibleCount: eligible.size,
    });

    // комната 1+1: голос инициатора уже решает
    this._evaluate(room, vote, false);
  }

  /**
   * host_vote_answer {roomId, voteId, value} от участника комнаты.
   */
  answer(room, memberId, { voteId, value }) {
    const vote = this._votes.get(room?.roomId);
    const userId = room?.members.get(memberId)?.userId ?? null;

    if (
      !vote ||
      vote.voteId !== voteId ||
      userId === null ||
      !vote.eligible.has(userId) ||
      !VOTE_VALUES.includes(value)
    ) {
      return;
    }

    // повторный ответ (с любой вкладки пользователя) меняет мнение
    vote.yes.delete(userId);
    vote.no.delete(userId);
    vote[value].add(userId);

    // голос принят — «Your vote has been accepted», как у голосований хоста
    this._sendTo(room.members.get(memberId)?.sessionId, {
      type: 'host_vote_accepted',
      roomId: room.roomId,
      voteId,
    });

    this._evaluate(room, vote, false);
  }

  /**
   * Состав комнаты изменился (leave_room, уборка grace): ушедшие перестают
   * голосовать, большинство считается от оставшихся.
   * @param {string} roomId
   */
  membersChanged(roomId) {
    const vote = this._votes.get(roomId);
    const room = this._registry.get(roomId);

    if (!vote) {
      return;
    }

    if (!room) {
      this.forget(roomId);
      return;
    }

    this._evaluate(room, vote, false);
  }

  // все активные голосования — после уборки реестра
  pruneAll() {
    for (const roomId of [...this._votes.keys()]) {
      this.membersChanged(roomId);
    }
  }

  /**
   * Хост комнаты начал меняться (миграция или плановая передача): идущее
   * голосование теряет смысл.
   * @param {Object} room
   */
  cancel(room) {
    const vote = this._votes.get(room?.roomId);

    if (vote) {
      this._finish(room, vote, { cancelled: true });
    }
  }

  // комната удалена — голосование, кулдауны и отложенное снятие не нужны
  forget(roomId) {
    const vote = this._votes.get(roomId);

    if (vote) {
      this._clearTimer(vote.timer);
      this._votes.delete(roomId);
    }

    const force = this._forces.get(roomId);

    if (force) {
      this._clearTimer(force.timer);
      this._forces.delete(roomId);
    }

    this._lastVoteAt.delete(roomId);
    this._lastStartByUser.delete(roomId);
  }

  _onTimeout(roomId, voteId) {
    const vote = this._votes.get(roomId);
    const room = this._registry.get(roomId);

    if (vote?.voteId !== voteId) {
      return;
    }

    if (!room) {
      this.forget(roomId);
      return;
    }

    this._evaluate(room, vote, true);
  }

  // исход: строгое большинство «за» от текущего eligible; досрочно — как
  // только он определён, по таймеру — молчание считается «против»
  _evaluate(room, vote, final) {
    // пользователь ушёл, если в комнате не осталось ни одной его вкладки
    const present = new Set();

    for (const member of room.members.values()) {
      present.add(member.userId);
    }

    for (const userId of vote.eligible) {
      if (!present.has(userId)) {
        vote.eligible.delete(userId);
        vote.yes.delete(userId);
        vote.no.delete(userId);
      }
    }

    const total = vote.eligible.size;

    if (total === 0) {
      this._finish(room, vote, { cancelled: true });
      return;
    }

    const yes = vote.yes.size;
    const undecided = total - yes - vote.no.size;

    if (yes > total / 2) {
      this._finish(room, vote, { passed: true });
    } else if (final || yes + undecided <= total / 2) {
      this._finish(room, vote, { passed: false });
    }
  }

  _finish(room, vote, { passed = false, cancelled = false }) {
    this._clearTimer(vote.timer);
    this._votes.delete(room.roomId);

    const yes = vote.yes.size;
    const result = {
      type: 'host_vote_result',
      roomId: room.roomId,
      voteId: vote.voteId,
      passed,
      yes,
      // молчание — «против»
      no: vote.eligible.size - yes,
      eligibleCount: vote.eligible.size,
    };

    if (cancelled) {
      result.cancelled = true;
    }

    for (const member of room.members.values()) {
      this._sendTo(member.sessionId, result);
    }

    if (passed) {
      this._demote(room, vote);
    }
  }

  // хост снят: не может быть ни бетой, ни хостом комнаты demotedCooldownMs;
  // просьба отдать роль, через voteForceAfterMs — принудительно
  _demote(room, vote) {
    const until = this._now() + this._timings.demotedCooldownMs;
    const { userId } = room.host;

    // по пользователю: перезагрузка вкладки (новый memberId) запрет не снимает
    if (userId !== null) {
      room.demotedUsers.set(userId, until);
    }

    for (const member of room.members.values()) {
      if (
        member.memberId === room.host.memberId ||
        (userId !== null && member.userId === userId)
      ) {
        member.demotedUntil = until;
      }
    }

    // мастер помнит снятие сам: любая передача этого хоста — причина vote,
    // её срыв — принудительная миграция (причине от клиента не верим)
    room.votedOutEpoch = room.epoch;

    this._sendTo(room.host.sessionId, {
      type: 'request_handoff',
      roomId: room.roomId,
      epoch: room.epoch,
      reason: 'vote',
      defer: false,
    });

    const timer = this._setTimer(
      () => this._onForceTimeout(room.roomId, vote.epoch),
      this._timings.voteForceAfterMs,
    );

    this._forces.set(room.roomId, { epoch: vote.epoch, timer });
  }

  // хост не начал передачу (старая страница, отказ мастера) — снять его
  // аварийным путём. Идущую передачу не трогать: её срыв координатор
  // превратит в принудительную миграцию сам (_abortHandoff по
  // room.votedOutEpoch)
  _onForceTimeout(roomId, epoch) {
    this._forces.delete(roomId);

    const room = this._registry.get(roomId);

    if (room?.status === 'online' && room.epoch === epoch) {
      this._migration.forceHostChange(room, 'vote');
    }
  }

  // голосует аккаунт гостя (не хоста), пробывший в комнате minVoterAgeMs:
  // свежие вкладки не накручивают голосование
  _isVoter(room, member, now) {
    return (
      member.userId !== null &&
      member.userId !== room.host.userId &&
      now - member.joinedAt >= this._timings.minVoterAgeMs
    );
  }

  _sendTo(sessionId, message) {
    if (sessionId && this._hasSession(sessionId)) {
      this._send(sessionId, message);
    }
  }
}
