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
  // карты из бандла
  maps: {
    manifestUrl: gameId => `/games/${gameId}/maps/manifest.json`,
    baseUrl: gameId => `/games/${gameId}/maps`,
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
    minFlushInterval: 60000, // мс на участника
    flushJitter: 0.2, // ±20 % на комнату: сотни серверов по круглому таймеру
    maxRequestsPerSecond: 5, // потолок очереди запросов комнаты
    backoff: { baseMs: 2000, maxMs: 120000 },
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

  // создание комнаты (хост в этой же вкладке); лимит игроков/время
  // раунда-карты/огонь по своим/карта по умолчанию — из roomDefaults
  // манифеста активной игры (Этап 6.3), не бандлятся здесь
  create: {
    defaultName: 'My Server',

    // период heartbeat/актуализации комнаты у мастера (мс); должен быть
    // меньше master.host.heartbeatTimeout (30 c), иначе комнату выметет
    heartbeatInterval: 10000,

    // socketId loopback-соединения хоста-игрока: по нему Worker исключает
    // хоста из kick-политик (его отключение = смерть комнаты для всех)
    hostSocketId: 'local',
  },
};
