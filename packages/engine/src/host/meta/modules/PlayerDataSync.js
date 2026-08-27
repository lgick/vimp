import lobbyConfig from '../../../config/lobby.js';

// Rank/state участника (Этап B4). Игрок приходит в игру с ником из JWT —
// rank (числовой рейтинг) и state (непрозрачный для движка JSON, "скиллы")
// подгружаются с мастера (прокси central auth-сервиса) при входе и
// синхронизируются обратно по естественным границам жизненного цикла
// (RoundManager: смена карты, конец раунда). Схему/дефолты state объявляет
// игра — здесь это чёрный ящик.
export default class PlayerDataSync {
  // дефолт fetchImpl обёрнут стрелкой, а не взят как голый `fetch`: из поля
  // объекта он вызывался бы с `this` экземпляра, а в браузере/воркере у
  // fetch brand-check на глобальный scope — это синхронный TypeError ещё до
  // обращения к сети (тесты подставляют обычную функцию и мимо этого ходят)
  constructor(gameId, { fetchImpl = (...args) => fetch(...args), defaultState = {} } = {}) {
    this._gameId = gameId;
    this._fetch = fetchImpl;
    this._defaultState = defaultState;
    this._entries = new Map(); // participantId -> { token, rank, state }
    // hostId + per-room секрет комнаты (кодревью №1, plan/server-rating/
    // review.md): неизвестны при создании (назначаются мастером на
    // register_host, после запуска Worker'а) — проставляются позже через
    // setHostId(). Едут в теле PUT rank/state; мастер сверяет секрет с
    // реестром и по нему подставляет проверенную атрибуцию, не доверяя
    // hostId из тела напрямую (иначе можно было бы подставить чужую комнату)
    this._hostId = null;
    this._hostSecret = null;
  }

  // вызывается HostGame, когда мастер подтвердил регистрацию комнаты
  // (host_registered) — до этого flush уходит без атрибуции
  setHostId(hostId, hostSecret = null) {
    this._hostId = hostId;
    this._hostSecret = hostSecret;
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

      // неуспешный ответ логируется: rankLoaded/stateLoaded гейтят весь
      // последующий flush, поэтому молчаливый 401/404 здесь навсегда
      // выключает синхронизацию и выглядит снаружи как «данных просто нет»
      if (!rankRes.ok) {
        console.warn(`[playerData] GET rank ${rankRes.status} for ${participantId}`);
      } else if (!entry.rankLoaded) {
        // F9: во время await мог накопиться addRank-дельта поверх
        // стартового 0 — прибавляем, а не перетираем серверным значением
        entry.rank += (await rankRes.json()).rank ?? 0;
        entry.rankLoaded = true;
      }

      if (!stateRes.ok) {
        console.warn(`[playerData] GET state ${stateRes.status} for ${participantId}`);
      } else if (!entry.stateLoaded) {
        const { state } = await stateRes.json();

        entry.state =
          state && Object.keys(state).length ? state : structuredClone(this._defaultState);
        entry.stateLoaded = true;
      }
    } catch (err) {
      // недоступность auth-сервиса — остаёмся на дефолтах, следующий
      // flush повторит load() перед синхронизацией (см. flush)
      console.warn(`[playerData] load failed for ${participantId}:`, err.message);
    }

    return entry;
  }

  getRank(participantId) {
    return this._entries.get(participantId)?.rank ?? 0;
  }

  getState(participantId) {
    return this._entries.get(participantId)?.state ?? this._defaultState;
  }

  // прибавляет к рангу игрока. Два вызывающих: RoundManager.reportKill (тот
  // же чокпоинт, что и Stat score) и HostGame.addPlayerRank — прямой путь для
  // игр, которые не эмитят CoreEvent::Death и до reportKill не доходят
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
          body: { delta, hostId: this._hostId, hostSecret: this._hostSecret },
        }).then(res => {
          if (res.ok) {
            entry.pendingRankDelta -= delta;
          } else {
            console.warn(`[playerData] PUT rank ${res.status} for ${participantId}`);
          }
        }),
      );
    }

    if (stateLoaded) {
      requests.push(this._authedFetch(lobbyConfig.auth.stateUrl, token, {
        method: 'PUT',
        body: { state, hostId: this._hostId, hostSecret: this._hostSecret },
      }).then(res => {
        if (!res.ok) {
          console.warn(`[playerData] PUT state ${res.status} for ${participantId}`);
        }
      }));
    }

    // allSettled глушит отказы по замыслу (сбой не должен ронять раунд), но
    // не должен глушить их след — иначе потеря синхронизации не диагностируема
    for (const result of await Promise.allSettled(requests)) {
      if (result.status === 'rejected') {
        console.warn(`[playerData] flush failed for ${participantId}:`, result.reason?.message);
      }
    }
  }

  // синхронизирует всех текущих участников (границы раунда/карты)
  flushAll() {
    return Promise.allSettled(
      [...this._entries.keys()].map(id => this.flush(id)),
    );
  }
}
