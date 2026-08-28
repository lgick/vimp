import path from 'path';
import { fileURLToPath } from 'url';

// корень репозитория — якорь от расположения файла, не от cwd
const rootDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

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

  // список игр-плагинов, подключаемых к мастеру (Этап A2 плана разделения):
  // `package` — имя npm-пакета игры, резолвится через node_modules; пакет
  // объявлен зависимостью в корневом package.json репозитория (деплой-уровень),
  // не в packages/engine — vimp-engine остаётся game-agnostic и не тянет
  // конкретную игру за собой (кодревью Этапов A, находка F1). Версию задаёт
  // именно эта зависимость, каталог берёт её из dist/manifest.json пакета.
  // Список переопределяется переменной окружения GAMES_MATRIX (JSON) — её
  // задаёт деплой; вне прода каталог вдобавок дополняется собранными
  // пакетами @vimp-games/* из node_modules (master/localGames.js), чтобы
  // прилинкованная игра попадала в лобби без правки этого массива: он
  // публикуется вместе с пакетом vimp-engine
  // maxGameScore (snakes-v3 этап 3.3, необязательное поле рядом с
  // id/package) — потолок результата ОДНОЙ игры для этой игры; мастер
  // клампит им `best`/`points` PUT /auth/rank. Не задан — дефолт
  // master:playerData:maxGameScore
  games: [{ id: 'tanks', package: '@vimp-games/tanks' }],

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
    maxNameLength: 30, // длина имени комнаты
    // санитарная рамка вместимости комнаты для случая, когда игра комнаты
    // неизвестна мастеру (gameId: null у старых хостов или id не из
    // каталога). Потолок известной игры задаёт её манифест
    // (roomDefaults.maxPlayers) — движок его не ограничивает
    maxPlayersLimit: 8,
    heartbeatTimeout: 30000, // нет heartbeat дольше — комната удаляется
    sweepInterval: 10000, // период проверки протухших комнат
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
    // PUT /auth/rank + /auth/state на комнату (проверенный hostId) в минуту.
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

  // рейтинг хостера комнаты (server-rating этап 2, plan/server-rating/
  // stage_2.md): /like·/unlike гостей комнаты вместо соц-модерации /ban.
  // Дефолт движка для всех игр; auth-сервис хранит и клампит рейтинг
  // персистентно и глобально (нужно и для аннулирования rank/skills, этап 4) —
  // это значение зеркалируется в packages/auth/src/config/auth.js:rating,
  // фактический кламп/blocked считает auth, не мастер
  rating: {
    min: -10,
    max: 10,
    blockAt: -10,
    // период опроса auth за актуальным рейтингом активных хостеров (этап 3,
    // stage_3.md) — держит кэш GET /servers свежим (счёт мог измениться на
    // другом мастере), голос/регистрация на этом мастере обновляют кэш сразу
    refreshInterval: 30000,
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
