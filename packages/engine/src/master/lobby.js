import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import ViteExpress from 'vite-express';
import { WebSocketServer } from 'ws';
import authClientConfig from '../config/authClient.js';
import { applyMasterEnv } from '../config/env.js';
import config from '../lib/config.js';
import RateLimiter from '../lib/rateLimiter.js';
import security from '../lib/security.js';
import { clampGameResult, clampLimit } from '../lib/validators.js';
import { createAdminAuth } from './adminAuth.js';
import DebugReportStore from './DebugReportStore.js';
import GameCatalog from './GameCatalog.js';
import GameRegistryProxy from './GameRegistryProxy.js';
import GameStore from './GameStore.js';
import GameSync from './GameSync.js';
import { GAME_VERSION_PATTERN } from './gameRefs.js';
import { createGameRoutes } from './gameRoutes.js';
import { applyLocalGames } from './localGames.js';
import { securityHeaders } from './httpSecurity.js';
import HostRatingProxy from './HostRatingProxy.js';
import HostRegistry from './HostRegistry.js';
import JwksProxy from './JwksProxy.js';
import LeaderboardCache from './LeaderboardCache.js';
import PlacementCache from './PlacementCache.js';
import PlayerDataProxy from './PlayerDataProxy.js';
import { etagFor, isNotModified } from './etag.js';
import WorkerCatalog from './WorkerCatalog.js';
import SignalingServer from './SignalingServer.js';

config.set('master', (await import('../config/master.js')).default);

// пути мастера якорятся от расположения этого файла, а не от cwd —
// сервер можно запускать из любой директории
const engineDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
// node_modules, где резолвятся пакеты игр (Этап A2): до разъезда репозиториев
// (Этап A3) это npm workspace-симлинк на games/<id>, после — обычная
// зависимость, установленная деплоем
const nodeModulesDir = path.resolve(engineDir, '..', '..', 'node_modules');

// корень хранилища скачанных игровых пакетов (master-game-registry, этап 2):
// в проде задаётся VIMP_GAMES_DIR и монтируется томом, локально — <repoRoot>/
// .games. Путь якорится от расположения файла, как engineDir: мастер можно
// запускать из любой директории
function resolveGamesDir() {
  return (
    config.get('master:gameStore:dir') ??
    path.resolve(engineDir, '..', '..', '.games')
  );
}

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

// если продакшн
if (isProduction) {
  // если не указан домен
  if (!env.VIMP_DOMAIN) {
    console.error(`
      ERROR: VIMP_DOMAIN must be set in the .env file for production.
    `);
    process.exit(1);
  }
}

// env читается всегда: в проде каталог игр задаёт деплой (GAMES_MATRIX),
// локально той же переменной можно переопределить порядок игр — первая
// становится активной в лобби (client/main.js). Остальные переопределения
// защищены собственными проверками и в dev просто не заданы.
applyMasterEnv(config, env);

// локально каталога от деплоя нет: игры берутся из node_modules — обычной
// зависимостью или симлинком `npm link`, — вместо правки master:games в
// опубликованном конфиге движка
const localGames = applyLocalGames(config, nodeModulesDir, env);

// проксирует JWKS central auth-сервиса под собственным origin (Этап B3) —
// Worker хоста верифицирует identity-токен по этому кэшу
const jwksProxy = new JwksProxy(config.get('master:security:authServiceUrl'));

// проксирует GET/PUT /rank и /state central auth-сервиса под мастером
// (Этап B4) — хост запрашивает/синхронизирует rank+state своим Bearer
// identity-токеном, не завися от CORS/прямой доступности auth-сервиса
const playerDataProxy = new PlayerDataProxy(
  config.get('master:security:authServiceUrl'),
);

// TTL-кэш публичного топ-N рейтинга (code review L2) — GET /auth/leaderboard
// самый частый анонимный запрос лобби, выборка меняется медленно; placement
// (per-user) через этот кэш не идёт, см. LeaderboardCache.js
const leaderboardCache = new LeaderboardCache(playerDataProxy, {
  ttlMs: config.get('master:leaderboard:cacheTtl'),
});

// TTL-кэш места игрока (snakes-v3 этап 3.3): вход участника стоит трёх
// срезов (агрегирующий GET /auth/placements), а место меняется медленно.
// Экономит round-trip до auth; тяжесть самого запроса снята там же
// (auth/src/db/RankDistribution.js)
const placementCache = new PlacementCache(playerDataProxy, {
  ttlMs: config.get('master:placement:cacheTtl'),
});

// потолок записи профилей на комнату (snakes-v3 этап 3.3, решение
// пользователя 9): минимальный интервал синхронизации держит движок на
// стороне хоста, но хост недоверенный — мастер держит собственный потолок
// на проверенный hostId. Превышение — 429, движок уходит в бэкофф
const playerDataLimiter = new RateLimiter({
  limit: config.get('master:playerData:writesPerMinute'),
  windowMs: 60000,
});

// заявка стоит мастеру похода в npm и распаковки архива, поэтому лимит
// стоит ДО скачивания, а не в auth-сервисе за ним (там он тоже есть, но
// туда запрос доходит только с успешным вердиктом). Ключ — пользователь, а
// не IP: заявка уже требует авторизации
const gameSubmitLimiter = new RateLimiter({ limit: 5, windowMs: 60000 });

function limitSubmits(req, res, next) {
  if (!gameSubmitLimiter.consume(`u${req.user.id}`)) {
    res.status(429).json({ error: 'tooManyRequests' });
    return;
  }

  next();
}

// проксирует GET/PUT /host-rating central auth-сервиса (server-rating этап 2,
// plan/server-rating/stage_2.md) — рейтинг хостера/голоса гостей персистентны
// и глобальны, поэтому живут в БД auth, не в памяти мастера
const hostRatingProxy = new HostRatingProxy(
  config.get('master:security:authServiceUrl'),
);

// каталог игр-плагинов (Этап A2): по конфигу `master:games` резолвит пакеты
// в node_modules и читает <package>/dist/manifest.json (продукт `npm run
// build` в репозитории игры, например vimp-tanks); в dev entries указывают
// на Vite-исходники (HMR), maps/assetsBase — из уже собранного dist (как и
// WorkerCatalog, требует установки/сборки игры один раз перед первым запуском)
const gameCatalog = new GameCatalog(config.get('master:games'), nodeModulesDir, {
  dev: !isProduction,
});

// хранилище игровых пакетов (master-game-registry, этап 2): одобренные игры
// приезжают из npm registry на диск мастера, а не npm-зависимостью образа
const gameStore = new GameStore({
  dir: resolveGamesDir(),
  registryUrl: config.get('master:gameStore:registryUrl'),
  limits: {
    maxTarballBytes: config.get('master:gameStore:maxTarballBytes'),
    maxFiles: config.get('master:gameStore:maxFiles'),
    timeout: config.get('master:gameStore:timeout'),
  },
});

// реестр игр живёт в БД auth-сервиса; мастер ходит туда REST'ом, как за
// rank/state/jwks
const gameRegistry = new GameRegistryProxy(
  config.get('master:security:authServiceUrl'),
);

// статик-маунты игр по директории версии: наполняет staticFor() ниже, а
// чистит onPruned — объявление стоит здесь, потому что первый проход
// синхронизации идёт до конца модуля
const staticByDir = new Map();

// каталог перестал быть снимком стартового конфига: GameSync обновляет его
// по реестру на лету — без пересборки образа и без рестарта мастера
const gameSync = new GameSync({
  registry: gameRegistry,
  store: gameStore,
  catalog: gameCatalog,
  // локально прилинкованная игра важнее реестра: только так работает HMR
  // разработки самой игры (localGames.js)
  localGameIds: new Set(localGames.map(game => game.id)),
  intervalMs: config.get('master:gameStore:refreshInterval'),
  keepVersions: config.get('master:gameStore:keepVersions'),
  // снятая с диска версия уносит и свой статик-маунт: иначе Map растёт на
  // каждую скачанную за время жизни процесса версию и никогда не убывает
  onPruned: paths => paths.forEach(dir => staticByDir.delete(dir)),
});

// авторизация REST-роутов мастера (master-game-registry, этап 4): та же
// проверка подписи по JWKS и та же политика issuer, что на сигнальном пути
const adminAuth = createAdminAuth(jwksProxy, authClientConfig.issuer);

// заявка разработчика, панель модерации и «Тест» новой версии
const gameRoutes = createGameRoutes({
  registry: gameRegistry,
  store: gameStore,
  catalog: gameCatalog,
  sync: gameSync,
  isAdmin: adminAuth.isAdmin,
});

// первый проход до listen: мастер стартует уже с каталогом. Его отказ старту
// не мешает — каталог тогда пуст (или остаётся локальным), а следующий цикл
// таймера подхватит реестр, когда тот вернётся.
//
// Дедлайн обязателен: медленный (а не отказавший) npm держал бы проход
// минутами — по 30 с таймаута на игру, — и всё это время процесс не слушал
// бы порт. Каталог пополнится следующим тиком таймера, а мастер обязан
// начать отвечать в предсказуемое время
const FIRST_SYNC_DEADLINE = 15000;

await Promise.race([
  gameSync.run(),
  new Promise(resolve => {
    setTimeout(resolve, FIRST_SYNC_DEADLINE).unref?.();
  }),
]);

console.info('------------------------------------------');
console.info('Master Server Settings:');
console.info(`-> Domain: ${config.get('master:domain')}`);
console.info(`-> Port: ${config.get('master:port')}`);
console.info(`-> Region threshold: ${config.get('master:servers:regionThreshold')}`);
console.info(
  `-> Max players per host: declared by the game (roomDefaults.maxPlayers); ${config.get('master:host:maxPlayersLimit')} for an unknown game`,
);
console.info(
  `-> Host rating range: [${config.get('master:rating:min')}..${config.get('master:rating:max')}], blockAt: ${config.get('master:rating:blockAt')}`,
);

// источник каталога виден в логе: реестр auth (штатный прод), node_modules
// (локальная разработка с `npm link`) или GAMES_MATRIX (self-hosted мастер
// без реестра). Расхождение «правлю игру, а едет другая» ловится именно здесь
const catalogSources = [
  localGames.length > 0 ? 'node_modules' : null,
  env.GAMES_MATRIX ? 'GAMES_MATRIX' : null,
  'registry',
].filter(Boolean);

if (gameCatalog.ids.length > 0) {
  console.info(`-> Games catalog source: ${catalogSources.join(' + ')}`);
  console.info(
    `-> Games loaded: ${gameCatalog.ids
      .map(id => {
        const version = gameCatalog.getManifest(id)?.packageVersion;

        return version ? `${id}@${version}` : id;
      })
      .join(', ')}`,
  );

  if (localGames.length > 0) {
    console.info(
      `-> Games linked locally (registry entries ignored): ${localGames
        .map(game => game.id)
        .join(', ')}`,
    );
  }
} else {
  console.warn(
    '-> Games loaded: none. Games are added in the moderation panel of the ' +
      'lobby, not in the engine config; locally, link a built @vimp-games/* ' +
      'package into node_modules',
  );
}

console.info('------------------------------------------');

const registry = new HostRegistry({
  regionThreshold: config.get('master:servers:regionThreshold'),
  defaultLimit: config.get('master:servers:defaultLimit'),
  maxLimit: config.get('master:servers:maxLimit'),
  maxNameLength: config.get('master:host:maxNameLength'),
  maxPlayersLimit: config.get('master:host:maxPlayersLimit'),
  // потолок комнаты объявляет игра — тот же манифест каталога, из которого
  // лобби берёт roomDefaults формы комнаты
  gameMaxPlayers: id => gameCatalog.getManifest(id)?.roomDefaults?.maxPlayers,
});

// каталог worker-бандла (Этап 5.2): версия кода комнаты для эстафеты
// Worker'ов; в dev Worker раздаёт Vite из исходников — каталог пуст
const workerCatalog = new WorkerCatalog(
  isProduction ? path.join(engineDir, 'dist', 'assets') : null,
);

const signaling = new SignalingServer(registry, {
  iceServers: config.get('master:iceServers'),
  regionHeader: config.get('master:regionHeader'),
  heartbeatTimeout: config.get('master:host:heartbeatTimeout'),
  pingLimiter: new RateLimiter(config.get('master:pingRateLimit')),
  // в проде мастер стоит за Nginx деплоя, который перезаписывает X-Real-IP;
  // в dev процесс смотрит в браузер напрямую и заголовкам верить нельзя
  trustProxy: isProduction,
  codeVersion: workerCatalog.version,
  gameCatalog,
  // server-rating этап 2: идентичность хостера/голосующего — Bearer
  // identity-токен, проверенный по тому же JWKS-прокси, каким его проверяет
  // Worker хоста, и той же политике issuer (packages/engine/src/config/authClient.js)
  jwksProxy,
  hostRatingProxy,
  issuer: authClientConfig.issuer,
  checkOrigin: security.createOriginValidator({
    protocol: config.get('master:protocol'),
    domain: config.get('master:domain'),
    port: config.get('master:port'),
  }),
});

// EXPRESS
const app = express();
let server;

const port = config.get('master:port');

// гигиена среды (Этап 5.4): базовые security-заголовки на всех ответах
app.use(securityHeaders({ isProduction }));

// режим сервера (Этап 4 плана standalone-sdk): клиент движка пробингует
// /config на старте и по нему выбирает контур загрузки. Здесь — лобби;
// dedicated-сервер отдаёт по тому же URL свой режим и игру
app.get('/config', (req, res) => {
  res.json({ mode: 'lobby' });
});

// Выгрузка браузерной половины отладочного контура (этап 6 плана
// plan/done/ai-debug): записанный вкладкой хоста сценарий и дампы ложатся в тот же
// `.debug/`, куда пишет headless-runner. Только dev: в проде это запись на
// диск по запросу произвольного клиента. Свой парсер тела — сценарий матча
// заведомо не влезает в дефолтные 100 kb express.json
if (!isProduction) {
  const debugReports = new DebugReportStore(
    path.resolve(engineDir, '..', '..', '.debug'),
  );

  app.post('/debug/report', express.json({ limit: '8mb' }), (req, res) => {
    debugReports
      .save(req.body)
      .then(({ file, bytes }) => {
        console.info(`[vimp:debug] report saved: .debug/${file} (${bytes} B)`);
        res.json({ file, bytes });
      })
      .catch(err => {
        res.status(err.status || 500).json({ error: err.message });
      });
  });
}

// нужен для тела PUT /auth/rank и /auth/state (Этап B4)
app.use(express.json());

// REST API: список серверов (пагинация, регионы, поиск). Тестовые комнаты
// застейдженных версий (master-game-registry, этап 3.5) скрыты от всех,
// кроме админов, — поэтому токен здесь читается, но не требуется
app.get('/servers', adminAuth.optional, (req, res) => {
  res.json(
    registry.getList({ ...req.query, includeHidden: adminAuth.isAdmin(req.user) }),
  );
});

// REST API: JWKS central auth-сервиса, проксированный под origin мастера
// (Этап B3) — Worker хоста проверяет по нему подпись identity-токена
app.get('/auth/jwks', (req, res) => {
  jwksProxy
    .get()
    .then(jwks => res.json(jwks))
    .catch(err => {
      console.error('[auth] jwks proxy failed:', err.message);
      res.status(502).json({ error: 'authServiceUnavailable' });
    });
});

// REST API: rank/state central auth-сервиса, проксированные под origin
// мастера (Этап B4) — хост запрашивает их на join и синхронизирует обратно
// по границам раунда/карты, авторизуясь тем же Bearer identity-токеном
// игрока, каким проверяется вход. game проверяется против каталога
// (кодревью №4) — иначе любой валидный identity-токен мог бы писать
// rank/state в произвольный, в т.ч. некаталожный, game_id-namespace
// rank-periods: срез рейтинга, ?period=day|month|all. Отсутствие — 'all',
// то есть в точности прежнее поведение для старых клиентов; мусор
// отклоняется здесь же, чтобы не ходить за 400 в auth-сервис.
const RANK_PERIODS = ['day', 'month', 'all'];

function readPeriod(raw) {
  if (raw === undefined) {
    return 'all';
  }

  return RANK_PERIODS.includes(raw) ? raw : null;
}

function forwardPlayerData(req, res, call) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const game = req.query.game;

  if (!token || !game) {
    res.status(400).json({ error: 'badRequest' });
    return;
  }

  if (!gameCatalog.ids.includes(game)) {
    res.status(404).json({ error: 'unknownGame' });
    return;
  }

  call(token, game)
    .then(({ status, json }) => {
      // per-user данные (Bearer-токен) — не кэшируются нигде между запросами
      res.set('Cache-Control', 'no-store');
      res.status(status).json(json);
    })
    .catch(err => {
      console.error('[auth] player-data proxy failed:', err.message);
      res.status(502).json({ error: 'authServiceUnavailable' });
    });
}

app.get('/auth/rank', (req, res) =>
  forwardPlayerData(req, res, (token, game) => playerDataProxy.getRank(token, game)),
);

// атрибуция rank_events/state_snapshots (server-rating кодревью №1) идёт от
// мастера, из hosterUserId, проверенного при register_host — не из тела хоста.
// hostId+hostSecret из тела проверяются реестром (verifiedAttribution): секрет
// доказывает владение комнатой, поэтому подставить чужой публичный hostId
// нельзя (иначе можно было бы обойти void или подставить хостера-жертву)
// потолок записи профилей на комнату (snakes-v3 этап 3.3): ключ — проверенная
// комната (sessionId), а не hostId из тела; неатрибутированной записи ключом
// служит IP, иначе потолок обходился бы пустым hostId
function writeAllowed(req, attribution) {
  const key = attribution.sessionId ?? `ip:${req.ip}`;

  return playerDataLimiter.consume(key);
}

// Потолок результата ОДНОЙ игры. Источник — реестр игр (его выставляет
// админ при модерации, GameCatalog.getMaxGameScore), а НЕ манифест игры:
// это параметр доверия, и из манифеста игра завысила бы его себе сама.
// master:games[].maxGameScore остаётся запасным путём для dev и
// self-hosted мастера без реестра, дефолт — master:playerData:maxGameScore
function maxGameScoreOf(game) {
  const declared =
    gameCatalog.getMaxGameScore(game) ??
    config.get('master:games').find(({ id }) => id === game)?.maxGameScore;

  return Number.isInteger(declared) && declared > 0
    ? declared
    : config.get('master:playerData:maxGameScore');
}

app.put('/auth/rank', (req, res) => {
  const attribution = registry.verifiedAttribution(req.body?.hostId, req.body?.hostSecret);

  if (!writeAllowed(req, attribution)) {
    res.status(429).json({ error: 'tooManyWrites' });
    return;
  }

  forwardPlayerData(req, res, (token, game) => {
    // snakes-v3 (stage_2.md 2.5, stage_3.md 3.3): тело — результат игры
    // { points, best }. `delta` старого хоста означает и сумму, и одну игру
    const raw = req.body ?? {};
    const { points, best, clamped } = clampGameResult(
      raw.points ?? raw.delta,
      raw.best ?? raw.points ?? raw.delta,
      maxGameScoreOf(game),
    );

    if (clamped) {
      // игра, присылающая больше своего потолка, либо взломана, либо
      // неверно настроена — режется молча для игрока, но не для логов
      console.warn(
        `[auth] game result clamped for ${game}`,
        `(points=${raw.points ?? raw.delta}, best=${raw.best}) ->`,
        `{ points: ${points}, best: ${best} }`,
      );
    }

    return playerDataProxy.putRank(token, game, { points, best }, attribution);
  });
});

app.get('/auth/state', (req, res) =>
  forwardPlayerData(req, res, (token, game) => playerDataProxy.getState(token, game)),
);

app.put('/auth/state', (req, res) => {
  const attribution = registry.verifiedAttribution(req.body?.hostId, req.body?.hostSecret);

  if (!writeAllowed(req, attribution)) {
    res.status(429).json({ error: 'tooManyWrites' });
    return;
  }

  forwardPlayerData(req, res, (token, game) =>
    playerDataProxy.putState(token, game, req.body?.state, attribution),
  );
});

app.get('/auth/placement', (req, res) => {
  const period = readPeriod(req.query.period);

  if (!period) {
    res.status(400).json({ error: 'badPeriod' });
    return;
  }

  forwardPlayerData(req, res, (token, game) => placementCache.get(token, game, period));
});

// REST API: все три среза одним походом хоста (snakes-v3 этап 3.3) —
// PlayerDataSync.load() запрашивает их на каждый вход участника, и три
// отдельных запроса на join это втрое больше работы мастера и auth.
// Неуспех отдельного среза не рушит ответ: приезжает то, что приехало
app.get('/auth/placements', (req, res) => {
  forwardPlayerData(req, res, async (token, game) => {
    const results = await Promise.all(
      RANK_PERIODS.map(period => placementCache.get(token, game, period)),
    );
    // 200 — если приехал хоть один срез; иначе статус первого отказа,
    // чтобы хост увидел настоящую причину (401/404/502), а не пустоту
    const failure = results.find(({ status }) => status !== 200);
    const json = Object.fromEntries(
      RANK_PERIODS.map((period, i) => [
        period,
        results[i].status === 200 ? results[i].json : null,
      ]),
    );

    return failure && results.every(({ status }) => status !== 200)
      ? failure
      : { status: 200, json };
  });
});

// REST API: публичный (без Bearer-токена) топ-N рейтинга игры, проксированный
// под origin мастера — лобби показывает leaderboard до логина, как GET /servers
app.get('/auth/leaderboard', (req, res) => {
  const game = req.query.game;

  if (!game) {
    res.status(400).json({ error: 'gameRequired' });
    return;
  }

  if (!gameCatalog.ids.includes(game)) {
    res.status(404).json({ error: 'unknownGame' });
    return;
  }

  const limit = clampLimit(req.query.limit, 10, config.get('master:leaderboard:maxLimit'));
  const period = readPeriod(req.query.period);

  if (!period) {
    res.status(400).json({ error: 'badPeriod' });
    return;
  }

  leaderboardCache
    .get(game, limit, period)
    .then(({ status, json }) => {
      // браузерный кэш для повторных открытий той же вкладкой (защита в
      // глубину поверх серверного TTL-кэша) — только на успешный ответ,
      // иначе браузер 15с держал бы протухшую ошибку auth-сервиса (code review)
      if (status === 200) {
        res.set('Cache-Control', 'public, max-age=15');

        // «не изменилось — не отправляем» (решение пользователя 9): топ
        // меняется медленно, а лобби перезапрашивает его на каждое
        // открытие вкладки — совпал валидатор, ушёл 304 без тела
        const etag = etagFor(json);

        res.set('ETag', etag);

        if (isNotModified(req.headers['if-none-match'], etag)) {
          res.status(304).end();
          return;
        }
      }
      res.status(status).json(json);
    })
    .catch(err => {
      console.error('[auth] leaderboard proxy failed:', err.message);
      res.status(502).json({ error: 'authServiceUnavailable' });
    });
});

// REST API: манифест worker-бандла (Этап 5.2 — эстафета Worker'ов).
// По нему вкладка хоста создаёт Worker (хешированное имя бандла страница
// старой сборки знать не может) и обнаруживает новую версию кода
app.get('/worker/manifest.json', (req, res) => {
  res.type('application/json').send(workerCatalog.manifest);
});

// REST API: GameManifest игр-плагинов (Этап 6.2 — динамическая загрузка игры)
app.get('/games/manifest.json', (req, res) => {
  res.type('application/json').send(gameCatalog.manifestList);
});

// ***** РЕЕСТР ИГР (master-game-registry, этап 4) *****
//
// Разработчик подаёт заявку и следит за её статусом, админ модерирует и
// играет в черновик — всё из лобби. Обработчики живут в gameRoutes.js,
// здесь — адресное пространство и доступ к нему.
//
// Порядок объявления: эти пути обязаны идти ДО версионных `/games/:id/...`
// и до статики `/games` — иначе `mine` и `submit` уехали бы в `:id`
app.get('/games/mine', adminAuth.authenticated, gameRoutes.mine);
app.post('/games/submit', adminAuth.authenticated, limitSubmits, gameRoutes.submit);
app.post(
  '/games/mine/:id/version',
  adminAuth.authenticated,
  limitSubmits,
  gameRoutes.requestVersion,
);

app.get('/admin/games', adminAuth.required, gameRoutes.adminList);
// раньше `/admin/games/:id/versions`: сегментов столько же, и `manifest.json`
// иначе уехал бы в `:id`
app.get('/admin/games/manifest.json', adminAuth.required, gameRoutes.stagedManifests);
app.get('/admin/games/:id/versions', adminAuth.required, gameRoutes.versions);
app.post('/admin/games/:id/stage', adminAuth.required, gameRoutes.stage);
app.patch('/admin/games/:id', adminAuth.required, gameRoutes.moderate);

// Версионное URL-пространство игр (master-game-registry, этап 3):
// /games/<id>/<version>/… адресует конкретную скачанную версию, а
// неверсионные алиасы ниже — ту, что каталог раздаёт сейчас. Именно это
// позволяет админу играть в новую версию, пока игроки играют в одобренную.
//
// ПОРЯДОК ОБЪЯВЛЕНИЯ КРИТИЧЕН: `/games/:id/maps/manifest.json` и
// `/games/:id/:version/manifest.json` имеют одинаковое число сегментов, и
// объявленный первым версионный роут съел бы сегмент `maps` в `:version`.
// Поэтому фиксированные maps-алиасы идут раньше, а `:version` вдобавок
// охраняется проверкой формы версии (GAME_VERSION_PATTERN — та же, что у
// реестра в auth).

// неверсионные алиасы нужны трём потребителям: вкладкам, открытым до смены
// версии; dev/standalone/dedicated, где mapsBase в манифесте нет вовсе; и
// хостам старых сборок
app.get('/games/:id/manifest.json', (req, res) => {
  const manifest = gameCatalog.getManifest(req.params.id);

  if (!manifest) {
    res.status(404).json({ error: 'unknownGame' });
    return;
  }

  res.json(manifest);
});

// per-game каталог карт
app.get('/games/:id/maps/manifest.json', (req, res) => {
  const catalog = gameCatalog.getMapCatalog(req.params.id);

  if (!catalog) {
    res.status(404).json({ error: 'unknownGame' });
    return;
  }

  res.type('application/json').send(catalog.manifest);
});

app.get('/games/:id/maps/:name', (req, res) => {
  const json = gameCatalog.getMapCatalog(req.params.id)?.get(req.params.name);

  if (!json) {
    res.status(404).json({ error: 'unknownMap' });
    return;
  }

  res.type('application/json').send(json);
});

// сегмент не похож на версию — это не версионный роут, пусть его разбирает
// статика (иначе `/games/tanks/assets/manifest.json` ушёл бы в 404 отсюда)
function isVersionSegment(req, next) {
  if (!GAME_VERSION_PATTERN.test(req.params.version)) {
    next();
    return false;
  }

  return true;
}

app.get('/games/:id/:version/manifest.json', (req, res, next) => {
  if (!isVersionSegment(req, next)) {
    return;
  }

  const manifest = gameCatalog.getManifest(req.params.id, req.params.version);

  if (!manifest) {
    res.status(404).json({ error: 'unknownGame' });
    return;
  }

  res.json(manifest);
});

app.get('/games/:id/:version/maps/manifest.json', (req, res, next) => {
  if (!isVersionSegment(req, next)) {
    return;
  }

  const catalog = gameCatalog.getMapCatalog(req.params.id, req.params.version);

  if (!catalog) {
    res.status(404).json({ error: 'unknownGame' });
    return;
  }

  res.type('application/json').send(catalog.manifest);
});

app.get('/games/:id/:version/maps/:name', (req, res, next) => {
  if (!isVersionSegment(req, next)) {
    return;
  }

  const json = gameCatalog
    .getMapCatalog(req.params.id, req.params.version)
    ?.get(req.params.name);

  if (!json) {
    res.status(404).json({ error: 'unknownMap' });
    return;
  }

  res.type('application/json').send(json);
});

// Статика игры (хешированные бандлы/wasm/звуки из GameManifest.assetsBase);
// в dev entries манифеста указывают на Vite-исходники напрямую, но
// assetsBase-содержимое (карты/звуки) всё равно раздаётся отсюда из dist.
//
// Один обработчик вместо цикла по каталогу: каталог теперь меняется на лету,
// и статик-маунты, расставленные на старте, устарели бы уже к первому
// gameSync.run(). Инстансы express.static кэшируются по директории —
// создавать serve-static на каждый файл игры незачем (объявление Map — выше,
// рядом с GameSync: снятая с диска версия уносит и свой маунт)
function staticFor(dir) {
  let middleware = staticByDir.get(dir);

  if (!middleware) {
    middleware = express.static(dir);
    staticByDir.set(dir, middleware);
  }

  return middleware;
}

app.use('/games', (req, res, next) => {
  const original = req.url;
  const queryAt = original.indexOf('?');
  const pathname = queryAt === -1 ? original : original.slice(0, queryAt);
  const query = queryAt === -1 ? '' : original.slice(queryAt);
  const segments = pathname.split('/');
  let id;
  let second;

  try {
    id = decodeURIComponent(segments[1] ?? '');
    second = decodeURIComponent(segments[2] ?? '');
  } catch {
    // битая процентная последовательность (`/games/%ZZ/x.js`) — это 404
    // дальше по цепочке, а не 500 из дефолтного обработчика Express
    next();
    return;
  }

  const versioned = GAME_VERSION_PATTERN.test(second);
  const dir = gameCatalog.getDistDir(id, versioned ? second : undefined);

  if (!dir) {
    next();
    return;
  }

  // остаток пути внутри dist/ игры; req.url восстанавливается, если файла
  // там нет — дальше по цепочке (ViteExpress) должен прийти исходный URL
  req.url = `/${segments.slice(versioned ? 3 : 2).join('/')}${query}`;

  staticFor(dir)(req, res, err => {
    req.url = original;
    next(err);
  });
});

// в продакшене обычный HTTP сервер, Nginx будет обрабатывать HTTPS
// для разработки HTTPS сервер с локальными сертификатами
if (isProduction) {
  server = http.createServer(app);
} else {
  try {
    const options = {
      key: fs.readFileSync(config.get('master:httpsOptions:key')),
      cert: fs.readFileSync(config.get('master:httpsOptions:cert')),
    };

    server = https.createServer(options, app);
  } catch (err) {
    console.error(`
      Error creating HTTPS server: ${err.message}.
      Ensure that the paths to the certificate and
      key files in config/master.js are correct and the files exist.

      For local development, creating certificates with mkcert:

      brew install mkcert
      brew install nss
      mkcert -install
      mkdir .certs && cd .certs
      mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
    `);

    process.exit(1);
  }
}

const host = isProduction ? '0.0.0.0' : undefined;

server.listen(port, host, () => {
  const protocol = isProduction ? 'http:' : 'https:';
  const displayHost = host || 'localhost';

  console.info(`
    Master server is running for ${env.NODE_ENV || 'development'} mode.
    Listening on ${protocol}//${displayHost}:${port}
  `);
});

// периодический опрос реестра игр — каталог обновляется без рестарта мастера
gameSync.start();

// сигнальный WebSocket
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => signaling.handleConnection(ws, req));

// периодическая уборка комнат без heartbeat
setInterval(
  () => signaling.sweepStaleHosts(),
  config.get('master:host:sweepInterval'),
);

// уборка памяти кэша мест и окон потолка записи (snakes-v3 этап 3.3):
// обе Map растут по числу увиденных участников/комнат, а комната живёт
// часами
setInterval(() => {
  placementCache.sweep();
  playerDataLimiter.sweep();
}, config.get('master:placement:cacheTtl'));

// периодический опрос auth за рейтингом активных хостеров (server-rating
// этап 3) — держит кэш GET /servers свежим между голосами/регистрациями.
// Самоперезапуск через setTimeout после завершения (кодревью, мелкая
// находка) — setInterval не ждёт разрешения промиса, и при медленном auth
// с многими хостерами циклы наслаивались бы друг на друга
(function scheduleRatingsRefresh() {
  signaling
    .refreshRatings()
    .catch(err => console.error('[rating] refresh cycle failed:', err.message))
    .finally(() => {
      setTimeout(scheduleRatingsRefresh, config.get('master:rating:refreshInterval'));
    });
})();

// раздача клиентской статики в dev; в prod её отдаёт Nginx
ViteExpress.bind(app, server);
