// Singleton Vote
let vote;

class Vote {
  constructor() {
    if (vote) {
      return vote;
    }

    vote = this;

    this._list = []; // данные для всех игроков
    this._userList = {}; // данные для игрока

    this._activeVoteName = null; // имя активного голосования
    this._activeVoteCategory = null; // категория активного голосования
    this._activeVoteData = null; // данные активного голосования
    this._voteQueue = []; // очередь для голосований
  }

  // сбрасывает данные
  reset() {
    this._list = [];

    for (const gameId in this._userList) {
      if (Object.hasOwn(this._userList, gameId)) {
        this._userList[gameId] = [];
      }
    }

    this._activeVoteName = null;
    this._activeVoteCategory = null;
    this._activeVoteData = null;
    this._voteQueue = [];
  }

  // добавляет пользователя
  addUser(gameId) {
    this._userList[gameId] = [];
  }

  // удаляет пользователя
  removeUser(gameId) {
    delete this._userList[gameId];
  }

  // добавляет данные голосования
  _push(arr) {
    this._list.push(arr);
  }

  // добавляет данные голосования для пользователя
  pushByUser(gameId, arr) {
    this._userList[gameId].push(arr);
  }

  // возвращает данные
  shift() {
    return this._list.shift();
  }

  // возвращает данные для пользователя
  shiftByUser(gameId) {
    return this._userList[gameId].shift();
  }

  // запуск голосования и рассылки данных
  _startVote({ name, category, payload, userList, onStartCallback }) {
    this._activeVoteName = name;
    this._activeVoteCategory = category;
    this._activeVoteData = {};

    if (userList) {
      for (let i = 0, len = userList.length; i < len; i += 1) {
        this.pushByUser(userList[i], payload);
      }
    } else {
      this._push(payload);
    }

    if (onStartCallback) {
      onStartCallback();
    }
  }

  // проверяет использование категории голосования
  hasVoteCategory(categoryName) {
    if (this._activeVoteCategory === categoryName) {
      return true;
    }

    return (
      this._voteQueue.find(voteData => voteData.category === categoryName) !==
      undefined
    );
  }

  // создает голосование или ставит его в очередь
  createVote(data) {
    // если есть активное голосование, добавляем новое в очередь
    if (this._activeVoteName) {
      this._voteQueue.push(data);
      return;
    }

    // если активного голосования нет, запускаем это
    this._startVote(data);
  }

  // добавляет голос в голосование
  addInVote(name, value) {
    // если голосование не активное
    if (this._activeVoteName !== name) {
      return;
    }

    if (this._activeVoteData[value]) {
      this._activeVoteData[value] += 1;
    } else {
      this._activeVoteData[value] = 1;
    }
  }

  // возвращает результат голосования, обрабатывает ничью и запускает следующее
  getResult(name) {
    // если голосование не активное
    if (this._activeVoteName !== name) {
      return;
    }

    const results = this._activeVoteData;
    let maxVotes = 0;
    let winners = []; // массив для хранения победителей

    // удаление завершенного голосования перед подсчетом
    this._activeVoteName = null;
    this._activeVoteCategory = null;
    this._activeVoteData = null;

    // если есть следующее голосование из очереди
    if (this._voteQueue.length > 0) {
      const nextVote = this._voteQueue.shift();
      this._startVote(nextVote);
    }

    // если никто не проголосовал
    if (!results || Object.keys(results).length === 0) {
      return;
    }

    // поиск победителей
    for (const option in results) {
      if (Object.hasOwn(results, option)) {
        const currentVotes = results[option];

        // если текущий вариант набрал больше голосов,
        // он становится единственным лидером
        if (currentVotes > maxVotes) {
          maxVotes = currentVotes;
          winners = [option];
          // если голосов столько же, добавляем в список победителей (ничья)
        } else if (currentVotes === maxVotes) {
          winners.push(option);
        }
      }
    }

    // если победитель один
    if (winners.length === 1) {
      return winners[0];
    }

    // случайный выбор, если победителей несколько
    const randomIndex = Math.floor(Math.random() * winners.length);
    return winners[randomIndex];
  }
}

export default Vote;
