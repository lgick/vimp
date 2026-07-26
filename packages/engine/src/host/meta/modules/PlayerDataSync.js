import lobbyConfig from '../../../config/lobby.js';

// Rank/state участника (Этап B4). Игрок приходит в игру с ником из JWT —
// rank (числовой рейтинг) и state (непрозрачный для движка JSON, "скиллы")
// подгружаются с мастера (прокси central auth-сервиса) при входе и
// синхронизируются обратно по естественным границам жизненного цикла
// (RoundManager: смена карты, конец раунда). Схему/дефолты state объявляет
// игра — здесь это чёрный ящик.
export default class PlayerDataSync {
  constructor(gameId, { fetchImpl = fetch, defaultState = {} } = {}) {
    this._gameId = gameId;
    this._fetch = fetchImpl;
    this._defaultState = defaultState;
    this._entries = new Map(); // participantId -> { token, rank, state }
  }

  _authedFetch(url, token, { method = 'GET', body } = {}) {
    return this._fetch(`${url}?game=${this._gameId}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // подгружает rank+state с мастера при входе игрока. Сбой auth-сервиса не
  // должен блокировать вход — участник стартует с дефолтами (rank 0, пустой
  // state) и попробует синхронизироваться на следующем flush.
  // rankLoaded/stateLoaded (F4 кодревью) отражают, был ли реально получен
  // серверный rank/state — flush не должен PUT'ить дефолт поверх настоящих
  // сохранённых значений, если загрузка не удалась (auth недоступен на join)
  async load(participantId, token) {
    const entry = this._entries.get(participantId) ?? {
      token,
      rank: 0,
      // server-rating этап 1: PUT /auth/rank шлёт дельту матча, не абсолют
      // (auth ведёт леджер) — pendingRankDelta копит то, что ещё не flush'нуто
      pendingRankDelta: 0,
      state: structuredClone(this._defaultState),
      rankLoaded: false,
      stateLoaded: false,
    };

    entry.token = token;
    this._entries.set(participantId, entry);

    try {
      const [rankRes, stateRes] = await Promise.all([
        this._authedFetch(lobbyConfig.auth.rankUrl, token),
        this._authedFetch(lobbyConfig.auth.stateUrl, token),
      ]);

      if (rankRes.ok && !entry.rankLoaded) {
        // F9: во время await мог накопиться addRank-дельта поверх
        // стартового 0 — прибавляем, а не перетираем серверным значением
        entry.rank += (await rankRes.json()).rank ?? 0;
        entry.rankLoaded = true;
      }

      if (stateRes.ok && !entry.stateLoaded) {
        const { state } = await stateRes.json();

        entry.state =
          state && Object.keys(state).length ? state : structuredClone(this._defaultState);
        entry.stateLoaded = true;
      }
    } catch {
      // недоступность auth-сервиса — остаёмся на дефолтах, следующий
      // flush повторит load() перед синхронизацией (см. flush)
    }

    return entry;
  }

  getRank(participantId) {
    return this._entries.get(participantId)?.rank ?? 0;
  }

  getState(participantId) {
    return this._entries.get(participantId)?.state ?? this._defaultState;
  }

  // прибавляет к рангу игрока (вызывается из RoundManager.reportKill —
  // тот же чокпоинт, что и Stat score)
  addRank(participantId, delta) {
    const entry = this._entries.get(participantId);

    if (entry) {
      entry.rank += delta;
      entry.pendingRankDelta += delta;
    }
  }

  setState(participantId, state) {
    const entry = this._entries.get(participantId);

    if (entry) {
      entry.state = state;
    }
  }

  removeUser(participantId) {
    this._entries.delete(participantId);
  }

  // синхронизирует накопленные rank+state участника на мастер. Сбой не
  // бросается дальше — следующий flush попробует снова с уже накопленными
  // (не потерянными) данными. F4: если исходная load() не удалась, PUT
  // дефолтом затёр бы реальный сохранённый rank/state — вместо этого
  // повторяем load() и шлём PUT только для того, что реально загрузилось
  async flush(participantId) {
    let entry = this._entries.get(participantId);

    if (!entry) {
      return;
    }

    if (!entry.rankLoaded || !entry.stateLoaded) {
      entry = await this.load(participantId, entry.token);
    }

    const { token, state, rankLoaded, stateLoaded } = entry;
    const requests = [];

    if (rankLoaded) {
      // отправляем именно накопленную на этот момент дельту и вычитаем её
      // же после успеха — addRank во время await не теряется (тот же
      // паттерн, что F9 в load())
      const delta = entry.pendingRankDelta;

      requests.push(
        this._authedFetch(lobbyConfig.auth.rankUrl, token, {
          method: 'PUT',
          body: { delta },
        }).then(res => {
          if (res.ok) {
            entry.pendingRankDelta -= delta;
          }
        }),
      );
    }

    if (stateLoaded) {
      requests.push(this._authedFetch(lobbyConfig.auth.stateUrl, token, {
        method: 'PUT',
        body: { state },
      }));
    }

    await Promise.allSettled(requests);
  }

  // синхронизирует всех текущих участников (границы раунда/карты)
  flushAll() {
    return Promise.allSettled(
      [...this._entries.keys()].map(id => this.flush(id)),
    );
  }
}
