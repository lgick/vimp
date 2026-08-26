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

  // рейтинг игры (lobby-page-plan): публичный топ-N и позиция вызывающего,
  // проксируемые мастером под тем же origin — правки CSP не нужны
  leaderboardUrl: '/auth/leaderboard',
  placementUrl: '/auth/placement',
  leaderboardLimit: 10,

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
