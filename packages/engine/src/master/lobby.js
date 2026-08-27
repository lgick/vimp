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
import { clampLimit } from '../lib/validators.js';
import DebugReportStore from './DebugReportStore.js';
import GameCatalog from './GameCatalog.js';
import { applyLocalGames } from './localGames.js';
import { securityHeaders } from './httpSecurity.js';
import HostRatingProxy from './HostRatingProxy.js';
import HostRegistry from './HostRegistry.js';
import JwksProxy from './JwksProxy.js';
import LeaderboardCache from './LeaderboardCache.js';
import PlayerDataProxy from './PlayerDataProxy.js';
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

if (gameCatalog.ids.length > 0) {
  console.info(`-> Games loaded: ${gameCatalog.ids.join(', ')}`);

  if (localGames.length > 0) {
    console.info(
      `-> Games discovered in node_modules: ${localGames
        .map(game => game.id)
        .join(', ')} (set GAMES_MATRIX to pin the catalog and its order)`,
    );
  }
} else {
  console.warn(
    '-> Games loaded: none (install/link the game package(s) listed in ' +
      'master:games and build them in their own repository before starting the master)',
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

// REST API: список серверов (пагинация, регионы, поиск)
app.get('/servers', (req, res) => {
  res.json(registry.getList(req.query));
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
app.put('/auth/rank', (req, res) =>
  forwardPlayerData(req, res, (token, game) =>
    playerDataProxy.putRank(
      token,
      game,
      req.body?.delta,
      registry.verifiedAttribution(req.body?.hostId, req.body?.hostSecret),
    ),
  ),
);

app.get('/auth/state', (req, res) =>
  forwardPlayerData(req, res, (token, game) => playerDataProxy.getState(token, game)),
);

app.put('/auth/state', (req, res) =>
  forwardPlayerData(req, res, (token, game) =>
    playerDataProxy.putState(
      token,
      game,
      req.body?.state,
      registry.verifiedAttribution(req.body?.hostId, req.body?.hostSecret),
    ),
  ),
);

app.get('/auth/placement', (req, res) => {
  const period = readPeriod(req.query.period);

  if (!period) {
    res.status(400).json({ error: 'badPeriod' });
    return;
  }

  forwardPlayerData(req, res, (token, game) =>
    playerDataProxy.getPlacement(token, game, period),
  );
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

// статика игры (хешированные бандлы/wasm/звуки из GameManifest.assetsBase);
// в dev entries манифеста указывают на Vite-исходники напрямую, но
// assetsBase-содержимое (карты/звуки) всё равно раздаётся отсюда из dist
for (const id of gameCatalog.ids) {
  app.use(`/games/${id}`, express.static(gameCatalog.getDistDir(id)));
}

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

// сигнальный WebSocket
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => signaling.handleConnection(ws, req));

// периодическая уборка комнат без heartbeat
setInterval(
  () => signaling.sweepStaleHosts(),
  config.get('master:host:sweepInterval'),
);

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
