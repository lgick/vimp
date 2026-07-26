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

  // переподключение сигнального WS хоста (комната без него выпадает из
  // выдачи мастера): экспоненциальный бэкофф от baseDelay до maxDelay (мс)
  reconnect: {
    baseDelay: 1000,
    maxDelay: 30000,
  },

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
    // селектор игры: скрыт, пока в каталоге мастера одна игра (§6, PLAN.md)
    gameId: 'lobby-game',
    // контейнер полей комнаты: генерируются по ключам roomDefaults
    // манифеста активной игры (Д7) — движок не знает игровых полей
    fieldsId: 'lobby-fields',
  },

  // движковые подсказки генератору формы комнаты (только движковые ключи
  // roomDefaults; игровые поля выводятся из типа значения)
  form: {
    // тайм-ключи движка: в roomDefaults хранятся в мс, в форме — секунды
    secondsKeys: ['roundTime', 'mapTime'],
    // атрибуты числовых полей (в единицах формы)
    attrs: {
      maxPlayers: { min: 1 },
      roundTime: { min: 10, max: 3600 },
      mapTime: { min: 10, max: 3600 },
    },
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
