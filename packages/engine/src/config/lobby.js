// Конфиг лобби (список серверов + умный пинг). Клиент проходит лобби ДО
// подключения к хосту, поэтому эти параметры бандлятся в сборку, а не приходят
// от хоста в CONFIG_DATA (как остальной клиентский конфиг).
export default {
  // REST-эндпоинт мастера со списком серверов (GET /servers)
  serversUrl: '/servers',

  // комната по прямому id (GET /rooms/:roomId, host-migration этап 3):
  // прямая ссылка #/<gameId>/<roomId> проверяется до входа
  roomUrl: roomId => `/rooms/${encodeURIComponent(roomId)}`,

  // быстрая игра (GET /quickplay/:gameId, ревью F16): лучшая комната игры
  // от мастера вместо всего списка; недоступен — GET /servers?search
  quickPlayUrl: gameId => `/quickplay/${encodeURIComponent(gameId)}`,

  // быстрая игра по ссылке #/<gameId>: подходящей комнаты нет — создать
  // свою с настройками формы по умолчанию (false — показать лобби этой игры);
  // createDelayMinMs…createDelayMaxMs — случайная пауза перед созданием и
  // повторный GET /servers (host-migration этап 7): гости закрытой комнаты
  // уходят в быструю игру разом, и без паузы каждый создал бы свою
  quickPlay: {
    autoCreate: true,
    createDelayMinMs: 500,
    createDelayMaxMs: 2000,
  },

  // меню комнаты внутри матча (только лобби-режим, roomMenu.pug)
  roomMenu: {
    elems: {
      // кнопка меню живёт в панели, справа от таблицы
      panelId: 'panel',
      menuId: 'room-menu',
      toggleId: 'room-menu-toggle',
      listId: 'room-menu-list',
      leaveId: 'room-menu-leave',
      handoverId: 'room-menu-handover',
      statusId: 'room-menu-status',
    },
  },

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
    // манифест конкретной версии: прогрев преемника (host-migration этап 6)
    // поднимает ту версию игры, что крутится в комнате
    versionManifestUrl: (gameId, version) =>
      `/games/${gameId}/${encodeURIComponent(version)}/manifest.json`,
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

  // установка P2P-соединения с хостом (host-migration этап 4): каналы не
  // открылись за connectTimeoutMs — попытка считается провалившейся;
  // offerRetryMs — пауза перед повтором оффера, отклонённого мастером на
  // время плановой передачи хоста (error migrating, этап 8)
  webrtc: {
    connectTimeoutMs: 10000,
    offerRetryMs: 1000,
  },

  // миграция хоста (host-migration этап 6; значения — замеры этапа 0):
  // checkpointIntervalMs — период контрольных точек хоста для беты (поток
  // ≤ ~150 КБ/с, serialize ≤ 25 % бюджета тика); standbyChunkBytes — кусок
  // точки в канале standby (≤ минимального maxMessageSize с запасом);
  // standbyHighWaterBytes — bufferedAmount, выше которого периодическая
  // точка пропускается; standbyStatusIntervalMs — как часто бета сообщает
  // мастеру свою последнюю точку (с её возрастом); maxRestoreAgeMs — точку,
  // полученную раньше, преемник не поднимает (promote_failed → холодный
  // старт; больше master:room:checkpointMaxAgeMs на дорогу статуса);
  // standbyReopenDelayMs…standbyReopenMaxDelayMs — экспоненциальная пауза
  // перед повторным открытием канала standby, закрывшегося при живом пире
  // беты; finalWaitMs — сколько бета при плановой
  // передаче (этап 8) ждёт финальную точку замороженного хоста, прежде чем
  // взять последнюю периодическую; handoffSlowMs — нет handoff_go за это
  // время — «медленная связь» (передача продолжается); handoffDeadlineMs —
  // общий дедлайн плановой передачи от handoff_begin (master:room:
  // handoffTimeoutMs + запас на дорогу ответа мастера); deferMaxMs — потолок
  // ожидания границы раунда передачей в игре без migration.midRound (этап 8d);
  // peersReportIntervalMs — период повтора room_peers хоста мастеру (кто
  // подключён по WebRTC; при смене состава отчёт уходит сразу, с дебаунсом);
  // minTokenLifetimeMs — вкладка, чей вход истечёт раньше, не объявляет
  // canHost и отказывается от промоушена (токен предъявляется мастеру
  // посреди матча, продления нет); tokenHandoffLeadMs — за столько до
  // истечения входа хост с бетой сам передаёт роль (плановая передача на
  // границе раунда); tokenHandoffRetryMs — через сколько повторить её, если
  // беты ещё нет, идёт эстафета Worker'ов или передача сорвалась (повторы —
  // до истечения входа); leaveFlushTimeoutMs — сколько «Leave
  // server» хоста без людей ждёт записи очков участников перед закрытием
  // комнаты (HostController.shutdown)
  migration: {
    checkpointIntervalMs: 500,
    standbyChunkBytes: 65536,
    standbyHighWaterBytes: 1024 * 1024,
    standbyStatusIntervalMs: 5000,
    maxRestoreAgeMs: 15000,
    standbyReopenDelayMs: 1000,
    standbyReopenMaxDelayMs: 10000,
    finalWaitMs: 3000,
    handoffSlowMs: 3000,
    handoffDeadlineMs: 10000,
    deferMaxMs: 30000,
    peersReportIntervalMs: 15000,
    minTokenLifetimeMs: 600000,
    tokenHandoffLeadMs: 300000,
    tokenHandoffRetryMs: 5000,
    leaveFlushTimeoutMs: 3000,

    // автотриггеры передачи (этап 9b, HostHealthPolicy; сэмпл — сообщение
    // health Worker'а раз в ~1 с): мягкая перегрузка — среднее tickRate за
    // overloadWindowMs ниже overloadTickRate (передача ждёт границы раунда);
    // жёсткая — среднее за criticalWindowMs ниже criticalTickRate или
    // lostMs > 0 у lostWindows сэмплов подряд (сразу); отложенная
    // отменяется, когда все сэмплы за recoverWindowMs выше recoverTickRate
    // (гистерезис); hiddenHandoffMs — скрытая вкладка хоста (этап 0:
    // троттлинг Worker'а за 1–3 с); autoHandoffCooldownMs — между
    // авто-передачами вкладки; minHostTenureMs — не отдавать роль, только
    // что её получив; enabled — общий выключатель
    auto: {
      enabled: true,
      overloadTickRate: 100,
      overloadWindowMs: 5000,
      criticalTickRate: 60,
      criticalWindowMs: 3000,
      lostWindows: 3,
      recoverTickRate: 110,
      recoverWindowMs: 5000,
      hiddenHandoffMs: 1500,
      autoHandoffCooldownMs: 90000,
      minHostTenureMs: 30000,
      // этап 9c: host_health мастеру (правило сетевого лага) не чаще
      // hostHealthIntervalMs; гость шлёт свой FPS рендера (caps.fps) раз в
      // fpsReportIntervalMs. Просьбу мастера request_handoff хост
      // выполняет, только если enabled
      hostHealthIntervalMs: 2000,
      fpsReportIntervalMs: 10000,
    },
  },

  // супервизор сессии гостя (host-migration этап 4, SessionSupervisor):
  // reconnectWindowMs — сколько после обрыва транспорта пытаться вернуться в
  // матч (повторы с бэкоффом reconnectBaseDelayMs…reconnectMaxDelayMs);
  // hostSilenceMs — молчание хоста в игре, после которого транспорт
  // считается мёртвым (кадры идут ~30/с, PING — раз в 3 с);
  // migrationWaitMs — сколько после host_migrating ждать host_changed, затем
  // комната считается закрытой (быструю игру); migrationPollMs — период
  // повторного GET /rooms/:roomId, пока комната по ссылке в 'migrating';
  // host_migrating.waitMs мастера (сколько он ещё ищет преемника) ожидание
  // продлевает, но не укорачивает; linkWaitMaxMs — крайний срок ожидания
  // комнаты по ссылке, пока она меняет хоста; resumeSilenceGraceMs — фора
  // сторожку тишины после возобновления до первого кадра: восстановленный
  // матч стоит до hostDefaults.resumeWaitMs, ожидая остальных. Связки с
  // таймингами мастера и Worker'а — tests/config/migrationTimings.test.js;
  // joinRetryWindowMs — сколько гость повторяет join_room на unknownRoom
  // после рестарта мастера, пока хост не вернёт комнату reclaim_host (больше
  // master.room.hostReclaimGraceMs с запасом на бэкофф сигналинга хоста)
  session: {
    reconnectWindowMs: 15000,
    reconnectBaseDelayMs: 500,
    reconnectMaxDelayMs: 4000,
    hostSilenceMs: 3000,
    migrationWaitMs: 40000,
    migrationPollMs: 1000,
    linkWaitMaxMs: 90000,
    resumeSilenceGraceMs: 3000,
    joinRetryWindowMs: 30000,
  },

  // приёмник выгрузок отладочного контура (этап 6 плана plan/done/ai-debug):
  // маршрут поднимается мастером только в dev, в проде вернёт 404
  debugReportUrl: '/debug/report',

  // журнал клиентских ошибок (plan/client-reports): приём на том же боксе,
  // что раздал страницу, — лобби-мастер или dedicated
  clientReportUrl: '/client-reports',

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
      // удаление игры: и «My games» (автор), и «Moderation» (админ) ходят
      // одним URL — право решает auth
      remove: id => `/games/mine/${encodeURIComponent(id)}`,
      // очередь модерации целиком плюс локальное состояние на этом мастере
      admin: '/admin/games',
      // манифесты застейдженных версий — по ним админ поднимает тестовую
      // комнату, не трогая каталог игроков
      staged: '/admin/games/manifest.json',
      // «Test»: скачать версию и положить её в каталог не раздаваемой
      stage: id => `/admin/games/${encodeURIComponent(id)}/stage`,
      // возврат мягко удалённой игры из графы Deleted (только админ)
      restore: id => `/admin/games/${encodeURIComponent(id)}/restore`,
      // решение модератора
      moderate: id => `/admin/games/${encodeURIComponent(id)}`,
      // что опубликовано в npm — индикатор «есть версия новее»
      versions: id => `/admin/games/${encodeURIComponent(id)}/versions`,
    },

    // фильтры («графы») очереди модерации: id -> подпись кнопки. Первые
    // четыре — статусы реестра, и значения обязаны совпадать со статусами
    // auth-сервиса. Пятая графа стоит особняком: 'deleted' статусом НЕ
    // является (мягко удалённая игра сохраняет свой прежний статус, иначе
    // восстанавливать было бы не во что) — под неё попадает всё с
    // непустым deletedAt, см. GamesModel._bucketOf
    statuses: [
      { id: 'pending', title: 'Pending' },
      { id: 'approved', title: 'Published' },
      { id: 'rejected', title: 'Rejected' },
      { id: 'disabled', title: 'Disabled' },
      { id: 'deleted', title: 'Deleted' },
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

      // карточки панели показываются по одной; заголовок общий, как и
      // переключатель страниц (виден только админу)
      mineId: 'games-mine',
      titleId: 'games-title',
      switchBtnId: 'games-switch',

      // модерация
      moderationId: 'games-moderation',
      adminListId: 'games-admin-list',
      adminErrorId: 'games-admin-error',
      filtersId: 'games-filters',
    },
  },

  // журнал клиентских ошибок (plan/client-reports, этап 5): только админ.
  // URL и id элементов — здесь, как у панели реестра игр (reports.pug)
  clientReports: {
    urls: {
      // страница журнала: ?status&gameId&limit&offset
      list: '/admin/client-reports',
      // статус и заметка админа по строке
      setStatus: id => `/admin/client-reports/${encodeURIComponent(id)}`,
    },
    pageSize: 50,
    // графы: значения совпадают со статусами auth-сервиса, 'all' — без фильтра
    statuses: [
      { id: 'open', title: 'Open' },
      { id: 'fixed', title: 'Fixed' },
      { id: 'ignored', title: 'Ignored' },
      { id: 'all', title: 'All' },
    ],
    defaultStatus: 'open',

    // DOM-элементы панели (из reports.pug)
    elems: {
      panelId: 'reports-panel',
      // панель и лобби делят место, как у панели реестра игр
      lobbyId: 'lobby',
      // кнопка в бейдже пользователя (lobby.pug), видна только админу
      openBtnId: 'reports-open',
      closeBtnId: 'reports-close',
      filtersId: 'reports-filters',
      gameSelectId: 'reports-game',
      listId: 'reports-list',
      moreBtnId: 'reports-more',
      errorId: 'reports-error',
    },
  },

  // создание комнаты (хост в этой же вкладке); лимит игроков/время
  // раунда-карты/огонь по своим/карта по умолчанию — из roomDefaults
  // манифеста активной игры (Этап 6.3), не бандлятся здесь
  create: {
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
