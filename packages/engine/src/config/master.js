import path from 'path';
import { fileURLToPath } from 'url';

// корень репозитория — якорь от расположения файла, не от cwd
const rootDir = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
  '..',
);

export default {
  name: 'VIMP Master Server',
  protocol: 'https:',
  domain: 'localhost',
  // 3000 — игровой сервер, 3001 — Vite HMR (vite.config.js)
  port: 3002,

  // сертификаты для локальной разработки — в .certs корня репозитория
  // (в продакшене обычный HTTP за Nginx)
  httpsOptions: {
    key: path.join(rootDir, '.certs', 'key.pem'),
    cert: path.join(rootDir, '.certs', 'cert.pem'),
  },

  // Статический каталог игр-плагинов. ПУСТ по умолчанию
  // (master-game-registry, этап 3): штатный источник каталога — реестр игр
  // auth-сервиса, откуда мастер скачивает одобренные пакеты сам
  // (master/GameSync.js). Движок игр не знает и зависимостями их не тянет.
  //
  // Массив остаётся двум потребителям, и env-переопределения у него нет:
  // локальной разработке (каталог наполняют собранные пакеты @vimp-games/*
  // из node_modules, master/localGames.js — прилинкованная игра важнее
  // реестра) и dedicated-серверу, который берёт отсюда игру, названную
  // VIMP_DEDICATED_GAME. `package` — имя npm-пакета игры, резолвится через
  // node_modules; версию задаёт сама установленная зависимость.
  // maxGameScore (snakes-v3 этап 3.3, необязательное поле рядом с
  // id/package) — потолок результата ОДНОЙ игры для этой игры; мастер
  // клампит им `best`/`points` PUT /auth/rank. Для игр реестра его задаёт
  // админ при модерации, здесь — только запасной путь. Не задан — дефолт
  // master:playerData:maxGameScore
  games: [],

  // Хранилище игровых пакетов (направление master-game-registry): мастер
  // качает одобренные игры из npm registry и раздаёт их с диска, вместо того
  // чтобы получать их npm-зависимостью на этапе сборки образа.
  gameStore: {
    // корень хранилища; null → <repoRoot>/.games (локальная разработка).
    // В проде задаётся VIMP_GAMES_DIR и монтируется томом
    dir: null,
    registryUrl: 'https://registry.npmjs.org',
    // период опроса реестра auth за изменениями каталога
    refreshInterval: 60000,
    // потолки распаковки недоверенного архива
    maxTarballBytes: 64 * 1024 * 1024,
    maxFiles: 5000,
    // сколько версий одной игры держать на диске: активная + стейджевая
    keepVersions: 2,
    // потолок ожидания ответа реестра
    timeout: 30000,
  },

  // список серверов (GET /servers)
  servers: {
    // если всего комнат <= порога — региональный фильтр
    // и пагинация отключаются, отдаётся весь список
    regionThreshold: 15,
    defaultLimit: 10, // размер страницы по умолчанию
    maxLimit: 50, // максимальный размер страницы
  },

  // ограничения регистрируемых комнат
  host: {
    // санитарная рамка вместимости комнаты для случая, когда игра комнаты
    // неизвестна мастеру (gameId: null у старых хостов или id не из
    // каталога). Потолок известной игры задаёт её манифест
    // (roomDefaults.maxPlayers) — движок его не ограничивает
    maxPlayersLimit: 8,
    heartbeatTimeout: 30000, // нет heartbeat дольше — хост потерян
    sweepInterval: 10000, // период уборки реестра комнат
  },

  // жизнь комнаты (host-migration, этап 2): комната живёт, пока в ней есть
  // участник
  room: {
    // отсоединённый участник ещё считается в комнате (реконнект сигналинга)
    memberGraceMs: 15000,
    // обрыв WS хоста запускает миграцию сразу (reclaim_host до регистрации
    // преемника её отменяет, этап 7.0); если повысить некого — комната
    // ждёт reclaim_host столько, потом уборка мигрирует или закрывает её
    hostReclaimGraceMs: 10000,
    // потолок строки карточки комнаты в лобби (gameConfig.lobbyInfo игры)
    maxInfoLength: 48,
    // RTT участников (host-migration этап 6): ws.ping() каждой сессии с
    // этим периодом; EMA RTT и джиттера — единая линейка связности для
    // хоста и кандидатов
    rttProbeIntervalMs: 5000,
    // сессия без pong дольше — terminate(): «тихо умерший» хост находится
    // быстрее, чем по heartbeatTimeout
    wsDeadAfterMs: 12000,
    // преемник (бета): кандидат должен пробыть в комнате не меньше этого
    minMemberAgeMs: 10000,
    // плановый пересчёт преемника (помимо join/leave/member_update)
    successorReviewMs: 15000,
    // гистерезис смены беты: лучший кандидат держит score не хуже
    // successorSwitchRatio × score текущего дольше successorSwitchSustainMs
    successorSwitchSustainMs: 30000,
    successorSwitchRatio: 0.65,
    // аварийная миграция (этап 7): бета — преемник с точкой, если она
    // получила её не раньше checkpointMaxAgeMs назад (по standby_status.ageMs;
    // статус идёт раз в 5 с — окно больше двух периодов), иначе cold-промоушен любого
    // способного; преемник не занял комнату за promotionTimeoutMs
    // (coldPromotionTimeoutMs — он перезагружает страницу) — следующий
    checkpointMaxAgeMs: 12000,
    promotionTimeoutMs: 10000,
    coldPromotionTimeoutMs: 25000,
    // отчёты host_unreachable: хост не ответил на probe за probeTimeoutMs —
    // потерян; ответил, но за reportWindowMs отчиталась половина гостей —
    // принудительная миграция, не чаще forcedMigrationCooldownMs на комнату.
    // Гости и отчёты считаются по аккаунтам; кворум — не меньше
    // minUnreachableReporters разных пользователей (в паре с плохим P2P один
    // гость не снимает хоста — иначе роль «пинг-понгом» ходит по кругу)
    probeTimeoutMs: 2000,
    reportWindowMs: 5000,
    forcedMigrationCooldownMs: 30000,
    minUnreachableReporters: 2,
    // плановая передача (этап 8): преемник не занял комнату за
    // handoffTimeoutMs — передача отменяется, хост размораживает матч
    handoffTimeoutMs: 8000,
    // host_migrating.waitMs — дедлайн текущей попытки промоушена (передачи)
    // плюс migrationNoticeMarginMs: столько гость ждёт host_changed
    migrationNoticeMarginMs: 5000,
    // автотриггеры (этап 9c). Сетевой лаг хоста: медиана его RTT до гостей
    // (host_health) выше lagRttThresholdMs непрерывно lagSustainMs, а score
    // беты лучше score хоста хотя бы на lagImprovementRatio — хосту
    // request_handoff. Не раньше autoMigrationCooldownMs с прошлой
    // авто-смены хоста в комнате (overload/hidden/network — кулдаун общий)
    // и с получения роли текущим хостом
    lagRttThresholdMs: 250,
    lagSustainMs: 10000,
    lagImprovementRatio: 0.35,
    autoMigrationCooldownMs: 90000,
    // бета — не ниже этого FPS рендера (caps.fps гостя; неизвестный FPS не
    // отсеивает). Аварийный промоушен порог не применяет
    minSuccessorFps: 30,
    // голосование «Change host» (этап 10, /changehost; только лобби-режим):
    // голоса считает мастер. Длительность голосования; повторный старт в
    // комнате и тем же пользователем — не раньше кулдаунов; прошедшее
    // голосование просит хоста отдать роль, не начал за voteForceAfterMs —
    // принудительная миграция; снятый хост не бета и не хост комнаты
    // demotedCooldownMs (кроме случая, когда больше принять некому).
    // Один голос на аккаунт; голосует и начинает участник, пробывший в
    // комнате не меньше minVoterAgeMs (свежие вкладки не накручивают голоса)
    vote: {
      hostVoteDurationMs: 15000,
      roomVoteCooldownMs: 120000,
      userStartCooldownMs: 60000,
      voteForceAfterMs: 5000,
      demotedCooldownMs: 600000,
      minVoterAgeMs: 30000,
    },
    // GET /rooms/:roomId (прямая ссылка, этап 3) на IP: открытие ссылки —
    // один запрос, лимит только против перебора roomId
    lookupRateLimit: {
      limit: 20,
      windowMs: 1000,
    },
  },

  // GET /auth/leaderboard (code review L2): TTL кэша на мастере (мс) и
  // верхняя граница ?limit= — публичный анонимный эндпоинт, самый частый
  // запрос лобби, выборка меняется медленно
  leaderboard: {
    cacheTtl: 15000,
    maxLimit: 100,
  },

  // GET /auth/placement + агрегирующий GET /auth/placements (snakes-v3
  // этап 3.3): место меняется медленно, а каждый вход участника стоит трёх
  // срезов. Кэш здесь про round-trip до auth; стоимость самого запроса
  // снята на стороне auth (RankDistribution)
  placement: {
    cacheTtl: 30000,
  },

  // пределы записи профилей в БД (snakes-v3 этап 3, решение пользователя 9):
  // «игр сотни, серверов сотни» — минимальный интервал держит движок на
  // стороне хоста, а мастер держит потолок для сломанного или злонамеренного
  // сервера, который этот интервал обошёл
  playerData: {
    // PUT /auth/rank + /auth/state на комнату (проверенный roomId) в минуту.
    // Честная комната на 32 при lobbyConfig.playerData.minFlushInterval в
    // 5 минут пишет 64 запроса за эти 5 минут, то есть ~13/мин; остальное —
    // запас на срочные границы (уход участника обходит интервал), и его
    // хватает даже комнате, полностью сменившей состав дважды за минуту.
    // Потолок держит не честную комнату, а сломанную или злонамеренную,
    // поэтому запас считается от честной, а не «пусть будет побольше»
    writesPerMinute: 120,
    // потолок результата ОДНОЙ игры, если игра не объявила свой
    // (master:games[].maxGameScore): обоснование — plan/snakes-v3/stage_2.md
    maxGameScore: 10000,
  },

  // заголовки безопасности (гигиена среды, Этап 5.4). CSP на статику/.wasm в
  // проде ставит Nginx (см. docs/deployment.md) — здесь single source of truth
  // политики; мастер применяет её к своим ответам только в проде (в dev CSP
  // сломала бы Vite HMR). WASM требует 'wasm-unsafe-eval', Worker — 'blob:';
  // connect-src data: — PixiJS фетчит тестовый data:-URL для проверки ImageBitmap.
  // authServiceUrl (Этап B2) — домен central auth-сервиса (packages/auth):
  // лобби делает туда прямой fetch (POST /nick), поэтому connect-src должен
  // его разрешать; сам OAuth-редирект (location.href на auth-сервис/провайдера)
  // CSP не ограничивает — это навигация верхнего уровня, не fetch/XHR.
  // script-src несёт sha256-хэш инлайнового importmap из index.html (для
  // pixi.js — src="..." на <script type="importmap"> браузеры не
  // поддерживают, инлайн обязателен). Хэш посчитан по факту собранного
  // packages/engine/dist/index.html скриптом
  // scripts/check-importmap-csp-hash.mjs (запускается postbuild) — vite
  // build минифицирует HTML и может изменить байты скрипта, поэтому хэш
  // нельзя брать из исходника/консоли браузера; при правке importmap или
  // апгрейде Vite смотреть на вывод postbuild-проверки.
  security: {
    authServiceUrl: 'http://localhost:3010',
    csp: authServiceUrl =>
      [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval' 'sha256-XJmzkFBLHYpcM8KgGRFztTJTwfMb5xIFKAmqlgTpobo='",
        "worker-src 'self' blob:",
        `connect-src 'self' wss: data:${authServiceUrl ? ` ${authServiceUrl}` : ''}`,
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    referrerPolicy: 'no-referrer',
  },

  // журнал клиентских ошибок (plan/client-reports): приём POST
  // /client-reports на боксе и пересылка пачками в auth-сервис. Пустой
  // token — пересылка выключена, остаётся строка в журнале процесса
  clientReports: {
    token: '',
    flushIntervalMs: 30000,
    forwardBatch: 50,
    forwardTimeoutMs: 5000,
    maxPending: 500, // потолок разных отпечатков в буфере
    logSeenMax: 5000, // сколько отпечатков процесс помнит «уже печатал»
    // бюджет НОВЫХ отпечатков на бокс (решение 9 плана): распределённый спам
    // обходит лимит по IP, а новая строка в auth — главный ресурс. Повторы
    // известных отпечатков бюджет не тратят
    newFingerprintsPerMinute: 60,
    // ключ — адрес, для IPv6 — подсеть /64 (lib/clientIp.js → rateLimitKey)
    // клиент шлёт не чаще раза в 10 с — запас на несколько вкладок за одним
    // адресом (NAT); главная защита — бюджет новых отпечатков
    rateLimit: { limit: 30, windowMs: 60000 },
    bodyLimit: '16kb',
    maxItemsPerRequest: 10,
  },

  // заголовок с регионом хоста от Nginx/CDN (например, CF-IPCountry);
  // выбран вместо geoip-lite — бесплатнее по памяти
  regionHeader: 'x-region',

  // лимит сигнальных ping-запросов с одного IP (защита от DDOS)
  pingRateLimit: {
    limit: 10,
    windowMs: 1000,
  },

  // ICE-конфигурация для установки P2P-соединений:
  // STUN обязателен; TURN — опциональный релей по итогам Этапа 0
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
