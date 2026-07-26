// Координатор голосований: создание, кулдаун и сброс опросов.
// Инфраструктура поверх Vote + TimerManager; не знает о round/map-логике
// (вызывающие передают готовые payload и resultFunc).
class VoteCoordinator {
  constructor({ vote, chat, timerManager }) {
    this._vote = vote;
    this._chat = chat;
    this._timerManager = timerManager;
  }

  // проверяет возможность создать голосование в данной категории
  canCreateVote(voteCategory, gameId) {
    if (
      this._timerManager.isVoteBlocked(voteCategory) ||
      this._vote.hasVoteCategory(voteCategory)
    ) {
      if (gameId) {
        this._chat.pushSystemByUser(gameId, 'VOTE_UNAVAILABLE');
      }

      return false;
    }

    return true;
  }

  // создаёт опрос
  createVote(data) {
    const { voteName, voteCategory, payload, resultFunc, userList, gameId } =
      data;

    // если голосование инициировано пользователем
    if (gameId) {
      this._chat.pushSystemByUser(gameId, 'VOTE_CREATED');
    }

    const onStart = () => {
      if (gameId) {
        this._chat.pushSystemByUser(gameId, 'VOTE_STARTED');
        this._vote.addInVote(voteName, 'Yes');
      }

      // таймер на сбор результатов
      this._timerManager.startVoteTimer(voteName, () => {
        // таймер временной блокировки повторного голосования
        this._timerManager.startVoteBlockTimer(voteCategory, () => {});

        const result = this._vote.getResult(voteName);

        resultFunc(result);
      });
    };

    this._vote.createVote({
      name: voteName,
      category: voteCategory,
      payload,
      userList,
      onStartCallback: onStart,
    });
  }

  // сбрасывает активные и запланированные опросы и таймеры по ним
  reset() {
    this._timerManager.stopAllVoteTimers();
    this._timerManager.stopAllBlockedVoteTimers();
    this._vote.reset();
  }
}

export default VoteCoordinator;
