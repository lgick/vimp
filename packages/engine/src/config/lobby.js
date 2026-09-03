// Конфиг лобби (список серверов + умный пинг). Клиент проходит лобби ДО
// подключения к хосту, поэтому эти параметры бандлятся в сборку, а не приходят
// от хоста в CONFIG_DATA (как остальной клиентский конфиг).
export default {
  // REST-эндпоинт мастера со списком серверов (GET /servers)
  serversUrl: '/servers',

  // каталог игр мастера (Этап 6.3, GameCatalog): roomDefaults формы создания
  // комнаты и ClientPlugin берутся отсюда вместо статической композиции
  gamesManifestUrl: '/games/manifest.json',

  // каталог карт мастера, per-game (Этап 6.4): комната хоста стартует на
  // актуальных картах активной игры, недоступность каталога — fallback на
  // карты из бандла.
  //
  // Аргумент — МАНИФЕСТ, а не gameId (master-game-registry, этап 3): карты
  // клиент берёт не из assetsBase, а по отдельному URL, и версионность
  // каталога обязана доехать и сюда, иначе комната на застейдженной версии
  // играла бы на картах одобренной. `mapsBase` проставляет мастер при
  // ребейзе версионного каталога; его отсутствие (dev, standalone,
  // dedicated, старый мастер) — законный случай, тогда работает прежний
  // путь по id
  maps: {
    manifestUrl: manifest =>
      `${manifest.mapsBase ?? `/games/${manifest.id}/maps`}/manifest.json`,
    baseUrl: manifest => manifest.mapsBase ?? `/games/${manifest.id}/maps`,
  },

  // манифест конкретной игры (Этап 6.5): эстафета Worker'ов перечитывает его
  // перед свопом — новый Worker должен получить свежий entries.host/wasm
  // (деплой игры мог обновиться независимо от деплоя движка)
  game: {
    manifestUrl: gameId => `/games/${gameId}/manifest.json`,
  },

  // манифест worker-бандла мастера (Этап 5.2): Worker комнаты создаётся по
  // url из манифеста, расхождение codeVersion при re-register — эстафета
  // Worker'ов; недоступность манифеста — бандловый URL без обновлений кода
  worker: {
    manifestUrl: '/worker/manifest.json',
  },

  // JWKS central auth-сервиса, проксируемый мастером (Этап B3): Worker хоста
  // фетчит его сам (тот же origin, что и сам Worker) и проверяет подпись
  // identity-токена, не доверяя auth-сервису напрямую из недоверенного хоста
  auth: {
    jwksUrl: '/auth/jwks',

    // rank/state central auth-сервиса, проксируемые мастером (Этап B4):
    // хост запрашивает их на join своим identity-токеном и синхронизирует
    // обратно по границам раунда/карты (RoundManager)
    rankUrl: '/auth/rank',
    stateUrl: '/auth/state',
  },

  // синхронизация профилей участников с мастером (snakes-v3 этап 3):
  // пределами записи в БД владеет движок, а не игра — «игр сотни, серверов
  // сотни», и одна игра, зовущая flushPlayerData() каждую секунду, не должна
  // мочь положить auth-сервис. Игра может попросить синхронизацию, но не
  // может участить её сверх minFlushInterval (кроме срочных границ:
  // уход участника и destroy() комнаты)
  playerData: {
    // результат игры (PUT { points, best }); GET рангов больше не ходит
    // сюда — три среза приезжают одним запросом на placementsUrl
    rankUrl: '/auth/rank',
    stateUrl: '/auth/state',
    // агрегирующий роут мастера: { day, month, all } за один поход хоста
    placementsUrl: '/auth/placements',
    // точечный перезапрос одного среза (refreshPlacement)
    placementUrl: '/auth/placement',
    // ***** ОТКУДА ЭТО ЧИСЛО *****
    //
    // Целевой масштаб — 100 игр × 100 серверов × 8 игроков = 80 000 игроков
    // одновременно. Участник со свежим результатом стоит двух запросов
    // (PUT rank + PUT state) за интервал, поэтому весь мир пишет
    //
    //   80 000 × 2 / интервал.
    //
    //   60 с  → 2700 запросов/с — на каждый пишущая транзакция, и это без
    //           единого всплеска: столько auth-сервис держать не обязан;
    //   300 с → 530 запросов/с — с запасом, и запас этот нужен на всплески
    //           (конец раунда синхронизирует комнату целиком).
    //
    // Платится за это СВЕЖЕСТЬЮ ГЛОБАЛЬНЫХ рейтингов, и только их: очки
    // склеиваются в памяти комнаты (сумма складывается, максимум берётся
    // максимумом — finishGame), поэтому не теряется ничего, а свои значения
    // игрок видит сразу, локально. Срочные границы (уход участника, destroy
    // комнаты) интервал обходят, так что «ушёл и потерял» тоже не про это.
    minFlushInterval: 300000, // мс на участника
    flushJitter: 0.2, // ±20 % на комнату: сотни серверов по круглому таймеру
    // потолок очереди запросов комнаты. Держится СТРОГО НИЖЕ потолка
    // мастера (master:playerData:writesPerMinute / 60 = 2/с): очередь должна
    // тормозить сама, а не через 429 — отказ стоит round-trip'а и уводит в
    // бэкофф всю комнату, то есть задерживает и тех, кто ни при чём.
    // Комната на 32 при интервале в 5 минут выпускает 64 запроса — при 1/с
    // это чуть больше минуты, вчетверо быстрее следующего интервала
    maxRequestsPerSecond: 1,
    // Пауза комнаты после 5xx/429/сетевого сбоя, экспоненциальная. Обе
    // границы соразмерны minFlushInterval, и это не украшение: потолок НИЖЕ
    // интервала не значил бы ничего — обычный flush и так ждёт интервал,
    // пауза короче него не отложила бы ни одного запроса, и бэкофф оказался
    // бы мёртвым кодом. Поэтому 30 с (заметно, но не наказание за одну
    // осечку) → 15 минут (втрое дольше интервала: лежащий сервис комната
    // перестаёт трогать почти совсем)
    backoff: { baseMs: 30000, maxMs: 900000 },
    placementTtl: 30000, // троттлинг refreshPlacement, мс
  },

  // рейтинг игры (lobby-page-plan): публичный топ-N и позиция вызывающего,
  // проксируемые мастером под тем же origin — правки CSP не нужны
  leaderboardUrl: '/auth/leaderboard',
  placementUrl: '/auth/placement',
  leaderboardLimit: 10,

  // награды за место в глобальном топе (snakes-v3 этап 4): хост комнаты
  // периодически спрашивает тот же публичный топ, что рисует лобби, и
  // рассылает участникам их места. Награда про игрока, а не про комнату,
  // поэтому источник глобальный, а сопоставление — по нику. Запрос идёт с
  // If-None-Match: неизменившийся топ стоит 304 и ни одного обращения к БД
  accolades: {
    refreshInterval: 45000, // мс между опросами топа
    // срезы, за которыми ходит хост: ключ ответа -> ?period=
    periods: { daily: 'day', monthly: 'month' },
  },

  // rank-periods: срезы рейтинга и тот, что открыт по умолчанию. Порядок
  // здесь — порядок кнопок; `id` едет в auth как ?period=, `title` идёт в
  // заголовок списка. Значения должны совпадать с RANK_PERIODS auth-сервиса:
  // на всё прочее он отвечает 400
  leaderboardPeriods: [
    { id: 'day', title: 'TODAY' },
    { id: 'month', title: 'THIS MONTH' },
    { id: 'all', title: 'ALL-TIME' },
  ],
  defaultLeaderboardPeriod: 'all',

  // переподключение сигнального WS хоста (комната без него выпадает из
  // выдачи мастера): экспоненциальный бэкофф от baseDelay до maxDelay (мс)
  reconnect: {
    baseDelay: 1000,
    maxDelay: 30000,
  },

  // приёмник выгрузок отладочного контура (этап 6 плана plan/done/ai-debug):
  // маршрут поднимается мастером только в dev, в проде вернёт 404
  debugReportUrl: '/debug/report',

  // размер страницы для «Загрузить ещё» (offset/limit к мастеру)
  pageSize: 10,

  // минимальный интервал повторного пинга одного сервера (мс):
  // защита от спама ping_host при перерисовке/скролле списка
  pingInterval: 5000,

  // DOM-элементы лобби (из lobby.pug)
  elems: {
    lobbyId: 'lobby',
    listId: 'lobby-list',
    searchId: 'lobby-search',
    moreId: 'lobby-more',
    emptyId: 'lobby-empty',
    nameId: 'lobby-name',
    hostBtnId: 'lobby-host',
    // строка отказа под кнопкой: загрузка ClientPlugin выбранной игры может
    // не удаться, и лобби обязано остаться рабочим
    errorId: 'lobby-error',
    // селектор игры: заполняется всем каталогом мастера, выбор задаёт и
    // форму/leaderboard, и игру, которая поднимется по «Create server»
    gameId: 'lobby-game',
    // контейнер полей комнаты: генерируются по ключам roomDefaults
    // манифеста активной игры (Д7) — движок не знает игровых полей
    fieldsId: 'lobby-fields',

    // вкладки правой панели (lobby-page-plan)
    tabServersBtnId: 'btn-show-servers',
    tabLeaderboardBtnId: 'btn-show-leaderboard',
    serversContentId: 'lobby-servers-content',
    leaderboardContentId: 'lobby-leaderboard-content',
    leaderboardListId: 'lobby-leaderboard-list',
    // кнопки срезов (rank-periods): id периода -> id элемента
    periodBtnIds: {
      day: 'btn-period-day',
      month: 'btn-period-month',
      all: 'btn-period-all',
    },
    leaderboardTitleId: 'leaderboard-title',
    leaderboardTotalId: 'leaderboard-total',
    myPlacementId: 'lobby-my-placement',

    // футер: версия npm-пакета движка, запечённая в бандл при сборке
    // (client/lib/engineVersion.js), и ссылка на его страницу
    versionId: 'lobby-version',
    linkId: 'lobby-link',
  },

  // реестр игр (master-game-registry, этап 4): заявка разработчика и панель
  // модерации живут в том же лобби, без правки конфигов и рестартов.
  // Все URL и id элементов — здесь: правило репозитория, модули их не
  // хардкодят (games.pug)
  games: {
    urls: {
      // заявки вызывающего со статусами и замечаниями модератора
      mine: '/games/mine',
      // разбор npm-пакета для формы заявки: id, title, версии и репозиторий
      // мастер читает сам — человек вводит только пакет и версию
      lookup: '/games/lookup',
      // заявка на новую игру платформы (валидируется мастером до записи)
      submit: '/games/submit',
      // заявка на новую версию уже заведённой игры
      version: id => `/games/mine/${encodeURIComponent(id)}/version`,
      // очередь модерации целиком плюс локальное состояние на этом мастере
      admin: '/admin/games',
      // манифесты застейдженных версий — по ним админ поднимает тестовую
      // комнату, не трогая каталог игроков
      staged: '/admin/games/manifest.json',
      // «Test»: скачать версию и положить её в каталог не раздаваемой
      stage: id => `/admin/games/${encodeURIComponent(id)}/stage`,
      // решение модератора
      moderate: id => `/admin/games/${encodeURIComponent(id)}`,
      // что опубликовано в npm — индикатор «есть версия новее»
      versions: id => `/admin/games/${encodeURIComponent(id)}/versions`,
    },

    // фильтры очереди модерации: id статуса реестра -> подпись кнопки.
    // Значения обязаны совпадать со статусами auth-сервиса
    statuses: [
      { id: 'pending', title: 'Pending' },
      { id: 'approved', title: 'Published' },
      { id: 'rejected', title: 'Rejected' },
      { id: 'disabled', title: 'Disabled' },
    ],
    defaultStatus: 'pending',

    // суффикс игры, поднятой из застейдженной версии: в селекторе она
    // стоит рядом с одобренной, и различать их обязано быть видно
    stagedSuffix: ' (test)',

    // DOM-элементы панели (из games.pug)
    elems: {
      panelId: 'games-panel',
      // панель и лобби делят место: открытая панель прячет #lobby целиком
      lobbyId: 'lobby',
      // кнопки в бейдже пользователя (lobby.pug)
      openMineBtnId: 'games-open-mine',
      openModerationBtnId: 'games-open-moderation',
      closeBtnId: 'games-close',

      // «My games»
      mineListId: 'games-mine-list',
      submitFormId: 'games-submit-form',
      submitErrorId: 'games-submit-error',
      submitBtnId: 'games-submit',
      // форма спрашивает ровно две вещи; id, title и репозиторий приезжают
      // предпросмотром из разобранного пакета
      fieldIds: {
        packageName: 'games-field-package',
        version: 'games-field-version',
      },
      lookupBtnId: 'games-lookup',
      previewId: 'games-preview',
      versionListId: 'games-version-list',

      // модерация
      moderationId: 'games-moderation',
      adminListId: 'games-admin-list',
      adminErrorId: 'games-admin-error',
      filtersId: 'games-filters',
    },
  },

  // создание комнаты (хост в этой же вкладке); лимит игроков/время
  // раунда-карты/огонь по своим/карта по умолчанию — из roomDefaults
  // манифеста активной игры (Этап 6.3), не бандлятся здесь
  create: {
    defaultName: 'My Server',

    // каталог платформы пуст: реестр ещё ничего не одобрил либо модератор
    // снял с раздачи последнюю игру. Комнату создавать не на чем, но лобби
    // живо — и текст называет то единственное, что выводит его из этого
    // состояния
    emptyCatalogText: 'No games are published yet — see “My games”',

    // период heartbeat/актуализации комнаты у мастера (мс); должен быть
    // меньше master.host.heartbeatTimeout (30 c), иначе комнату выметет
    heartbeatInterval: 10000,

    // socketId loopback-соединения хоста-игрока: по нему Worker исключает
    // хоста из kick-политик (его отключение = смерть комнаты для всех)
    hostSocketId: 'local',
  },
};
