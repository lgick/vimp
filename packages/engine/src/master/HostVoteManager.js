import crypto from 'crypto';

const VOTE_VALUES = ['yes', 'no'];

// Голосование «Change host» (host-migration этап 10). Голоса считает мастер,
// а не хост: хост исполняет матч и мог бы отфильтровать голосование против
// себя. Прошедшее голосование просит хоста отдать роль (request_handoff
// vote) и через voteForceAfterMs снимает его принудительно — аварийным
// путём MigrationCoordinator. Состояние голосований — здесь, отметка
// demotedUntil смещённого хоста — в участнике комнаты реестра.
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
      ...deps.timings,
    };

    // roomId -> { voteId, epoch, initiatorMemberId, eligible, yes, no,
    // endsAt, timer }
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
        reason,
      });
    };

    if (!member) {
      return; // не участник — ответить некому
    }

    if (room.status !== 'online') {
      return reject('migrating');
    }

    if (memberId === room.host.memberId) {
      return reject('host');
    }

    if (this._votes.has(room.roomId) || this._forces.has(room.roomId)) {
      return reject('active');
    }

    const now = this._now();
    const timings = this._timings;
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
      this._sendTo(member.sessionId, { type: 'error', code: 'noSuccessor' });
      return;
    }

    starts.set(member.userId, now);
    this._lastStartByUser.set(room.roomId, starts);
    this._lastVoteAt.set(room.roomId, now);

    const eligible = new Set(
      this._registry
        .liveMembers(room.roomId, now)
        .map(live => live.memberId)
        .filter(id => id !== room.host.memberId),
    );
    const vote = {
      voteId: this._randomBytes(8).toString('hex'),
      epoch: room.epoch,
      initiatorMemberId: memberId,
      eligible,
      yes: new Set([memberId]),
      no: new Set(),
      endsAt: now + timings.hostVoteDurationMs,
      timer: null,
    };

    vote.timer = this._setTimer(
      () => this._onTimeout(room.roomId, vote.voteId),
      timings.hostVoteDurationMs,
    );
    this._votes.set(room.roomId, vote);

    // хосту окно не шлётся: голосование идёт мимо него
    for (const id of eligible) {
      if (id !== memberId) {
        this._sendTo(room.members.get(id)?.sessionId, {
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

    if (
      !vote ||
      vote.voteId !== voteId ||
      !vote.eligible.has(memberId) ||
      !VOTE_VALUES.includes(value)
    ) {
      return;
    }

    // повторный ответ меняет мнение
    vote.yes.delete(memberId);
    vote.no.delete(memberId);
    vote[value].add(memberId);

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
    for (const id of vote.eligible) {
      if (!room.members.has(id)) {
        vote.eligible.delete(id);
        vote.yes.delete(id);
        vote.no.delete(id);
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

  _sendTo(sessionId, message) {
    if (sessionId && this._hasSession(sessionId)) {
      this._send(sessionId, message);
    }
  }
}
