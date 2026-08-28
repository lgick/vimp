import lobbyConfig from '../../../config/lobby.js';

// Профиль участника (Этап B4 + snakes-v3 этап 3). Игрок приходит в игру с
// ником из JWT — рейтинги (три среза: day/month/all) и state (непрозрачный
// для движка JSON, "скиллы") подгружаются с мастера (прокси central
// auth-сервиса) при входе и синхронизируются обратно по естественным
// границам жизненного цикла (RoundManager: смена карты, конец раунда).
// Схему/дефолты state объявляет игра — здесь это чёрный ящик.
//
// snakes-v3 этап 3: движок знает общее для всех игр понятие «результат
// игры» — жизнь, раунд, матч, что бы игра ни называла игрой. Очки текущей
// игры копятся в `currentGamePoints`, `finishGame` переводит их в сумму
// (`pendingPoints`, месячный рейтинг) и максимум (`pendingBest`, дневной).
// Пределы записи в БД держит движок, а не игра: грязные флаги, один запрос
// в полёте на участника, минимальный интервал с джиттером, очередь с
// потолком запросов в секунду и бэкофф комнаты (см. lobbyConfig.playerData).

const PERIODS = ['day', 'month', 'all'];

export default class PlayerDataSync {
  // дефолт fetchImpl обёрнут стрелкой, а не взят как голый `fetch`: из поля
  // объекта он вызывался бы с `this` экземпляра, а в браузере/воркере у
  // fetch brand-check на глобальный scope — это синхронный TypeError ещё до
  // обращения к сети (тесты подставляют обычную функцию и мимо этого ходят)
  constructor(
    gameId,
    {
      fetchImpl = (...args) => fetch(...args),
      defaultState = {},
      // now/sleep/random — впрыск для тестов: интервал, очередь и бэкофф
      // это время, и проверять их реальными таймерами значит проверять их
      // секундами ожидания
      now = () => Date.now(),
      sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
      random = () => Math.random(),
    } = {},
  ) {
    this._gameId = gameId;
    this._fetch = fetchImpl;
    this._defaultState = defaultState;
    this._now = now;
    this._sleep = sleep;
    this._entries = new Map(); // participantId -> запись профиля (_makeEntry)
    // hostId + per-room секрет комнаты (кодревью №1, plan/server-rating/
    // review.md): неизвестны при создании (назначаются мастером на
    // register_host, после запуска Worker'а) — проставляются позже через
    // setHostId(). Едут в теле PUT rank/state; мастер сверяет секрет с
    // реестром и по нему подставляет проверенную атрибуцию, не доверяя
    // hostId из тела напрямую (иначе можно было бы подставить чужую комнату)
    this._hostId = null;
    this._hostSecret = null;

    const settings = lobbyConfig.playerData;

    // джиттер считается один раз на комнату: сотни серверов, синхронно
    // проснувшихся по круглому минутному таймеру, дают мастеру пик
    this._flushInterval = Math.round(
      settings.minFlushInterval * (1 + (random() * 2 - 1) * settings.flushJitter),
    );
    // вверх, а не как получится: слот, округлённый вниз, выпускал бы чуть
    // больше запросов в секунду, чем объявленный потолок
    this._slotMs = Math.ceil(1000 / settings.maxRequestsPerSecond);
    // очередь комнаты: запросы уходят последовательно, не чаще одного за
    // _slotMs — flush комнаты на 32 участника растягивается на секунды
    // вместо залпа
    this._queue = Promise.resolve();
    this._nextSlotAt = 0;
    // бэкофф комнаты: 5xx/429/сеть — экспоненциальная пауза, первый успех
    // сбрасывает её. Без этого сотня серверов синхронно молотит лежащий
    // сервис следующим же flush'ем
    this._backoffMs = 0;
    this._backoffUntil = 0;
  }

  // вызывается HostGame, когда мастер подтвердил регистрацию комнаты
  // (host_registered) — до этого flush уходит без атрибуции
  setHostId(hostId, hostSecret = null) {
    this._hostId = hostId;
    this._hostSecret = hostSecret;
  }

  _makeEntry(token) {
    return {
      token,
      state: structuredClone(this._defaultState),
      stateLoaded: false,
      // сериализованный слепок последнего успешно отправленного state:
      // «не изменилось — не отправляем» (решение пользователя 9)
      lastSyncedState: null,
      // значения на момент входа + локальные правки finishGame
      ratings: Object.fromEntries(
        PERIODS.map(period => [period, { value: 0, placement: null, total: 0 }]),
      ),
      // ПО СРЕЗАМ, а не общим флагом: агрегирующий /auth/placements отдаёт
      // 200, если приехал хоть один срез, и кладёт провалившийся как null.
      // Общий флаг помечал бы такой срез загруженным нулём НАВСЕГДА — а
      // ноль дневного среза игра читает как «рекорд побит» (см.
      // isRatingLoaded)
      ratingsLoaded: Object.fromEntries(PERIODS.map(period => [period, false])),
      currentGamePoints: 0, // очки незавершённой игры
      pendingPoints: 0, // сумма завершённых игр, ещё не отправленная
      pendingBest: 0, // лучшая завершённая игра, ещё не отправленная
      placementRefreshedAt: Object.fromEntries(PERIODS.map(period => [period, 0])),
      inFlight: false,
      // промис текущей серии flush: его отдают повторные вызовы, чтобы
      // граница, которая ждёт записи (destroy, уход участника), ждала её
      // по-настоящему
      inFlightPromise: null,
      flushAgain: false,
      lastFlushAt: 0,
    };
  }

  _authedFetch(url, token, { method = 'GET', body, params } = {}) {
    const query = new URLSearchParams({ game: this._gameId, ...params });

    return this._fetch(`${url}?${query}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // очередь комнаты с потолком запросов в секунду (правило 5)
  _enqueue(task) {
    const run = this._queue.then(async () => {
      const wait = this._nextSlotAt - this._now();

      if (wait > 0) {
        await this._sleep(wait);
      }

      this._nextSlotAt = this._now() + this._slotMs;

      return task();
    });

    // хвост очереди не должен обрываться на отказе задачи
    this._queue = run.then(
      () => {},
      () => {},
    );

    return run;
  }

  // 5xx/429/сетевой сбой — пауза комнаты (правило 6)
  _noteFailure() {
    const { baseMs, maxMs } = lobbyConfig.playerData.backoff;

    this._backoffMs = Math.min(this._backoffMs ? this._backoffMs * 2 : baseMs, maxMs);
    this._backoffUntil = this._now() + this._backoffMs;
  }

  _noteSuccess() {
    this._backoffMs = 0;
    this._backoffUntil = 0;
  }

  // отказ отказу рознь: 4xx (кроме 429) — это «так и будет», повтор
  // ничего не изменит и паузы комнаты не заслуживает
  _noteStatus(status) {
    if (status === 429 || status >= 500) {
      this._noteFailure();
    }
  }

  // подгружает рейтинги+state с мастера при входе игрока. Сбой auth-сервиса
  // не должен блокировать вход — участник стартует с дефолтами (нули, пустой
  // state) и попробует синхронизироваться на следующем flush.
  // ratingsLoaded (ПО СРЕЗАМ) и stateLoaded (F4 кодревью) отражают, был ли
  // реально получен серверный ответ: flush не должен PUT'ить дефолтный state
  // поверх настоящего сохранённого, если загрузка не удалась. Результат игры
  // отправляется независимо от них — он строка в леджер, а не замещение
  // (см. _sync)
  async load(participantId, token) {
    const entry = this._entries.get(participantId) ?? this._makeEntry(token);

    entry.token = token;
    this._entries.set(participantId, entry);

    try {
      // ***** ЗАГРУЗКА ИДЁТ МИМО ОЧЕРЕДИ, И ЭТО НАМЕРЕННО *****
      //
      // Очередь комнаты держит потолок ЗАПИСЕЙ: он и объявлен на записи
      // (master:playerData:writesPerMinute считает только PUT rank/state), и
      // растягивать по ней чтение значило бы платить за это входом — профиль
      // участника приезжал бы через слот очереди после его появления, а в
      // комнате на 32 последний ждал бы секунды. Чтение защищено там, где
      // оно дорого: TTL-кэшем мастера (master/PlacementCache.js) и, с
      // миграции 008, агрегатом вместо свёртки леджера.
      //
      // Что этот путь обязан делать — замечать отказ (см. ниже): срочный
      // flush бэкофф обходит, а тянет за собой именно повторный load()
      const [ratingsRes, stateRes] = await Promise.all([
        this._authedFetch(lobbyConfig.playerData.placementsUrl, token),
        this._authedFetch(lobbyConfig.playerData.stateUrl, token),
      ]);

      // неуспешный ответ логируется и ставит паузу комнаты: stateLoaded
      // гейтит синхронизацию state, поэтому молчаливый 401/404 здесь
      // навсегда выключает её и выглядит снаружи как «данных просто нет»
      if (!ratingsRes.ok) {
        this._noteStatus(ratingsRes.status);
        console.warn(`[playerData] GET placements ${ratingsRes.status} for ${participantId}`);
      } else {
        const json = (await ratingsRes.json()) ?? {};
        const at = this._now();

        this._noteSuccess();

        for (const period of PERIODS) {
          const slice = json[period];
          const rating = entry.ratings[period];

          // срез уже загружен — второй load() (повтор после сбоя другого
          // среза) не должен применять его снова: месяц СКЛАДЫВАЕТСЯ, и
          // повторное применение удвоило бы его
          if (entry.ratingsLoaded[period]) {
            continue;
          }

          // null — этот срез не приехал (роут отдаёт 200, если приехал хоть
          // один). Загруженным его помечать нельзя: следующий _sync
          // повторит load() и доберёт именно его
          if (!slice) {
            continue;
          }

          const server = Number(slice.rank) || 0;

          // F9: во время await мог накопиться finishGame поверх стартового
          // нуля — перетирать его серверным значением нельзя. Но и складывать
          // с ним можно не всегда: СРЕЗЫ АГРЕГИРУЮТСЯ ПО-РАЗНОМУ, ровно как в
          // finishGame — день это МАКСИМУМ одной игры, месяц сумма, all-time
          // локально не двигается вовсе (суточный снимок).
          //
          // Путь этот не только про гонку на входе: _sync повторяет load()
          // после неудачной первой загрузки, и к тому моменту игрок успел
          // доиграть несколько жизней — сложение дало бы дневному срезу
          // сумму вместо максимума, и refreshPlacement её бы не исправил
          // (при непустом pending он берёт Math.max с показанным)
          rating.value =
            period === 'month' ? rating.value + server : Math.max(rating.value, server);
          rating.placement = slice.placement ?? null;
          rating.total = Number(slice.total) || 0;
          entry.placementRefreshedAt[period] = at;
          entry.ratingsLoaded[period] = true;
        }
      }

      if (!stateRes.ok) {
        this._noteStatus(stateRes.status);
        console.warn(`[playerData] GET state ${stateRes.status} for ${participantId}`);
      } else if (!entry.stateLoaded) {
        this._noteSuccess();

        const { state } = await stateRes.json();

        entry.state =
          state && Object.keys(state).length ? state : structuredClone(this._defaultState);
        entry.stateLoaded = true;
        // то, что только что приехало, отправлять обратно незачем
        entry.lastSyncedState = JSON.stringify(entry.state);
      }
    } catch (err) {
      // недоступность auth-сервиса — остаёмся на дефолтах, следующий
      // flush повторит load() перед синхронизацией (см. flush).
      //
      // Пауза комнаты ставится и здесь: без неё лежащий сервис получал бы с
      // этого пути полную нагрузку — срочный flush (уход участника, рекорд
      // в игре) бэкофф обходит, а именно он и тянет за собой повторный
      // load(), пока рейтинги не загружены
      this._noteFailure();
      console.warn(`[playerData] load failed for ${participantId}:`, err.message);
    }

    return entry;
  }

  // ***** рейтинги ***** //

  // значения для показа: { value, placement, total } среза или null для
  // незнакомого участника (и незнакомого периода)
  getRating(participantId, period = 'all') {
    const entry = this._entries.get(participantId);

    if (!entry || !PERIODS.includes(period)) {
      return null;
    }

    const { value, placement, total } = entry.ratings[period];

    return { value, placement, total };
  }

  // приехал ли СРЕЗ с мастера. getRating отдаёт нули и знакомому участнику,
  // чей load() ещё не вернулся, — а игре разницу знать надо: ноль дневного
  // среза значит «сегодня ещё не играл», и игра, сравнивающая с ним счёт
  // законченной игры, прочитает «данных нет» как «побит рекорд» и потратит
  // срочную запись на каждую смерть (src/host/StatBridge.js в snakes)
  isRatingLoaded(participantId, period = 'all') {
    return this._entries.get(participantId)?.ratingsLoaded[period] === true;
  }

  // все ли три среза приехали — внутренний вопрос _sync, не игры
  _ratingsComplete(entry) {
    return PERIODS.every(period => entry.ratingsLoaded[period]);
  }

  // точечный перезапрос одного среза (чат-команда /rank): место меняется от
  // чужих игр, поэтому локальными значениями его не пересчитать. Троттлинг
  // placementTtl — команду можно звать в чате сколько угодно часто
  async refreshPlacement(participantId, period = 'all') {
    const entry = this._entries.get(participantId);

    if (!entry || !PERIODS.includes(period)) {
      return null;
    }

    const now = this._now();

    if (now - entry.placementRefreshedAt[period] < lobbyConfig.playerData.placementTtl) {
      return this.getRating(participantId, period);
    }

    // метка ставится ДО запроса и на сбое не сбрасывается: это анти-флуд, а
    // не кэш. `/rank` в чате может звать кто угодно и сколько угодно, и
    // лежащий мастер не должен превращать это в отправку запроса на каждое
    // сообщение — цена в том, что после сбоя игрок ждёт TTL
    entry.placementRefreshedAt[period] = now;

    try {
      const res = await this._enqueue(() =>
        this._authedFetch(lobbyConfig.playerData.placementUrl, entry.token, {
          params: { period },
        }),
      );

      if (!res.ok) {
        this._noteStatus(res.status);
        console.warn(`[playerData] GET placement ${res.status} for ${participantId}`);
      } else {
        const { placement, total, rank } = (await res.json()) ?? {};
        const rating = entry.ratings[period];
        const server = Number(rank) || 0;

        this._noteSuccess();
        // всё отправленное — серверное значение и есть правда (в том числе
        // ноль после смены суток); есть неотправленное — оно ещё не учтено
        // сервером, и показывать меньше уже показанного нельзя
        rating.value =
          entry.pendingPoints > 0 || entry.pendingBest > 0
            ? Math.max(rating.value, server)
            : server;
        rating.placement = placement ?? null;
        rating.total = Number(total) || 0;
      }
    } catch (err) {
      this._noteFailure();
      console.warn(`[playerData] placement failed for ${participantId}:`, err.message);
    }

    return this.getRating(participantId, period);
  }

  // очки ТЕКУЩЕЙ игры участника (жизнь, раунд, матч — что игра называет
  // игрой). В сумму и в максимум они попадают только на finishGame
  addPoints(participantId, delta) {
    const entry = this._entries.get(participantId);

    if (entry) {
      entry.currentGamePoints += delta;
    }
  }

  // @deprecated snakes-v3 этап 3: алиас addPoints. Зовётся
  // RoundManager.reportKill (килл = 1 очко текущей игры) и старыми играми
  // через HostGame.addPlayerRank
  addRank(participantId, delta) {
    this.addPoints(participantId, delta);
  }

  // игра участника закончилась: накопленное уходит в сумму (месяц) и в
  // максимум (день)
  finishGame(participantId) {
    const entry = this._entries.get(participantId);

    if (!entry || entry.currentGamePoints <= 0) {
      // пустых записей в леджере не бывает: отрицательный счёт (огонь по
      // своим) — это не результат, а ноль
      if (entry) {
        entry.currentGamePoints = 0;
      }

      return;
    }

    const points = entry.currentGamePoints;

    entry.currentGamePoints = 0;
    entry.pendingPoints += points;
    entry.pendingBest = Math.max(entry.pendingBest, points);

    // локальные значения — чтобы игрок видел правду до синхронизации
    entry.ratings.day.value = Math.max(entry.ratings.day.value, points);
    entry.ratings.month.value += points;
    // all-time НЕ двигаем: он суточный снимок (решение пользователя 5)
  }

  // «игра закончилась у всех» — границы раунда/карты (RoundManager) и
  // закрытие комнаты
  finishAllGames() {
    for (const participantId of this._entries.keys()) {
      this.finishGame(participantId);
    }
  }

  // ***** совместимость со старыми играми (all-срез) ***** //

  getRank(participantId) {
    return this._entries.get(participantId)?.ratings.all.value ?? 0;
  }

  isRankLoaded(participantId) {
    return this.isRatingLoaded(participantId);
  }

  getState(participantId) {
    return this._entries.get(participantId)?.state ?? this._defaultState;
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

  // синхронизирует накопленный результат+state участника на мастер. Сбой не
  // бросается дальше — следующий flush попробует снова с уже накопленными
  // (не потерянными) данными.
  //
  // urgent — срочная граница (уход участника, destroy комнаты): такой вызов
  // обходит и минимальный интервал, и паузу бэкоффа, потому что второго
  // шанса записать эти очки не будет
  async flush(participantId, { urgent = false } = {}) {
    const entry = this._entries.get(participantId);

    if (!entry) {
      return;
    }

    if (!urgent) {
      const now = this._now();

      // предел владеет движком: просьба игры синхронизироваться чаще
      // minFlushInterval — это просьба, а не команда (решение пользователя 9)
      if (now - entry.lastFlushAt < this._flushInterval || now < this._backoffUntil) {
        return;
      }
    }

    // один запрос в полёте на участника: повторный вызов ставит флаг, а не
    // стартует второй запрос — по завершении делается один повтор, и
    // добавленное во время await уходит им.
    //
    // Наружу при этом отдаётся промис ТЕКУЩЕЙ серии, а не resolved: destroy()
    // комнаты ждёт именно flushAll, и «нечего ждать, запрос уже летит» было
    // бы враньём — Worker сняли бы раньше, чем ушёл повтор с последними
    // очками
    if (entry.inFlight) {
      entry.flushAgain = true;

      return entry.inFlightPromise;
    }

    entry.inFlightPromise = (async () => {
      entry.inFlight = true;

      try {
        do {
          entry.flushAgain = false;
          await this._sync(participantId, entry);
        } while (entry.flushAgain);
      } finally {
        entry.inFlight = false;
        entry.inFlightPromise = null;
      }
    })();

    return entry.inFlightPromise;
  }

  // F4: если исходная load() не удалась, PUT дефолтом затёр бы реальные
  // сохранённые рейтинг/state — вместо этого повторяем load() и шлём PUT
  // только для того, что реально загрузилось
  async _sync(participantId, stale) {
    let entry = stale;

    entry.lastFlushAt = this._now();

    if (!this._ratingsComplete(entry) || !entry.stateLoaded) {
      entry = await this.load(participantId, entry.token);
    }

    const { token } = entry;
    const requests = [];
    // отправляем именно накопленное на этот момент и вычитаем его же после
    // успеха — finishGame во время await не теряется (тот же паттерн, что
    // F9 в load())
    const points = entry.pendingPoints;
    const best = entry.pendingBest;

    // РЕЗУЛЬТАТ ИГРЫ ОТПРАВЛЯЕТСЯ БЕЗУСЛОВНО. Гейт по загруженности здесь
    // был бы вреден: это не абсолютное значение, а строка в леджер (auth
    // складывает её сам), затереть ею нечего — а недоступный на входе
    // /auth/placements держал бы очки в pending до конца жизни комнаты и
    // терял бы их вместе с ней. Гейт нужен ровно state ниже: тот PUT
    // ЗАМЕЩАЕТ сохранённый JSON, и дефолтом поверх настоящего нельзя (F4)
    if (points > 0 || best > 0) {
      requests.push(
        this._enqueue(() =>
          this._authedFetch(lobbyConfig.playerData.rankUrl, token, {
            method: 'PUT',
            body: { points, best, hostId: this._hostId, hostSecret: this._hostSecret },
          }),
        ).then(res => {
          // pendingBest только растёт: если он тот же — отправленное учтено
          // целиком; если больше — во время запроса закончилась игра лучше,
          // и её максимум ещё не отправлен
          const drop = () => {
            entry.pendingPoints -= points;

            if (entry.pendingBest === best) {
              entry.pendingBest = 0;
            }
          };

          if (res.ok) {
            this._noteSuccess();
            drop();
          } else {
            this._noteStatus(res.status);
            console.warn(`[playerData] PUT rank ${res.status} for ${participantId}`);

            // 4xx (кроме 429) — отказ ПО СОДЕРЖАНИЮ: повтор того же тела
            // получит тот же ответ. Оставить его в pending значит слать
            // заведомый мусор на каждом flush до конца жизни комнаты, а
            // накопленное сверху — сверх него. Очки теряются, и это честнее
            // вечного цикла (сам отказ уже в логе выше)
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
              drop();
            }
          }
        }),
      );
    }

    const state = JSON.stringify(entry.state);

    if (entry.stateLoaded && state !== entry.lastSyncedState) {
      requests.push(
        this._enqueue(() =>
          this._authedFetch(lobbyConfig.playerData.stateUrl, token, {
            method: 'PUT',
            body: { state: entry.state, hostId: this._hostId, hostSecret: this._hostSecret },
          }),
        ).then(res => {
          if (res.ok) {
            this._noteSuccess();
            entry.lastSyncedState = state;
          } else {
            this._noteStatus(res.status);
            console.warn(`[playerData] PUT state ${res.status} for ${participantId}`);
          }
        }),
      );
    }

    // allSettled глушит отказы по замыслу (сбой не должен ронять раунд), но
    // не должен глушить их след — иначе потеря синхронизации не диагностируема
    for (const result of await Promise.allSettled(requests)) {
      if (result.status === 'rejected') {
        this._noteFailure();
        console.warn(`[playerData] flush failed for ${participantId}:`, result.reason?.message);
      }
    }
  }

  // синхронизирует всех текущих участников (границы раунда/карты). Просьба,
  // а не команда: участник, у которого с прошлой синхронизации прошло
  // меньше минимального интервала, пропускается — кроме urgent
  flushAll({ urgent = false } = {}) {
    return Promise.allSettled(
      [...this._entries.keys()].map(id => this.flush(id, { urgent })),
    );
  }
}
