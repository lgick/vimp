import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import ViteExpress from 'vite-express';
import { WebSocketServer } from 'ws';
import authClientConfig from '../config/authClient.js';
import config from '../lib/config.js';
import RateLimiter from '../lib/rateLimiter.js';
import security from '../lib/security.js';
import GameCatalog from './GameCatalog.js';
import HostRatingProxy from './HostRatingProxy.js';
import HostRegistry from './HostRegistry.js';
import JwksProxy from './JwksProxy.js';
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

  config.set('master:domain', env.VIMP_DOMAIN);

  // порт для мастер-сервера
  if (env.VIMP_MASTER_PORT) {
    config.set('master:port', Number(env.VIMP_MASTER_PORT));
  }

  // домен central auth-сервиса (Этап B2) — попадает в CSP connect-src, т.к.
  // лобби делает туда прямой fetch (POST /nick)
  if (env.VIMP_AUTH_SERVICE_URL) {
    config.set('master:security:authServiceUrl', env.VIMP_AUTH_SERVICE_URL);
  }

  // список игр-плагинов мастера (Этап A2), по образцу остальных *_MATRIX
  // env-переопределений — JSON-массив {id, package, version}
  if (env.GAMES_MATRIX) {
    config.set('master:games', JSON.parse(env.GAMES_MATRIX));
  }
}

// проксирует JWKS central auth-сервиса под собственным origin (Этап B3) —
// Worker хоста верифицирует identity-токен по этому кэшу
const jwksProxy = new JwksProxy(config.get('master:security:authServiceUrl'));

// проксирует GET/PUT /rank и /state central auth-сервиса под мастером
// (Этап B4) — хост запрашивает/синхронизирует rank+state своим Bearer
// identity-токеном, не завися от CORS/прямой доступности auth-сервиса
const playerDataProxy = new PlayerDataProxy(
  config.get('master:security:authServiceUrl'),
);

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
console.info(`-> Max players per host: ${config.get('master:host:maxPlayersLimit')}`);
console.info(
  `-> Host rating range: [${config.get('master:rating:min')}..${config.get('master:rating:max')}], blockAt: ${config.get('master:rating:blockAt')}`,
);

if (gameCatalog.ids.length > 0) {
  console.info(`-> Games loaded: ${gameCatalog.ids.join(', ')}`);
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

// нужен для тела PUT /auth/rank и /auth/state (Этап B4)
app.use(express.json());

const port = config.get('master:port');

// гигиена среды (Этап 5.4): базовые security-заголовки на всех ответах.
// CSP — только в проде (в dev сломала бы Vite HMR; прод-статику/.wasm с CSP
// отдаёт Nginx, здесь — для API-ответов мастера и как исполняемая документация)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', config.get('master:security:referrerPolicy'));
  res.setHeader('X-Frame-Options', 'DENY');

  if (isProduction) {
    const csp = config.get('master:security:csp')(config.get('master:security:authServiceUrl'));

    res.setHeader('Content-Security-Policy', csp);
  }

  next();
});

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
    .then(({ status, json }) => res.status(status).json(json))
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

app.get('/auth/placement', (req, res) =>
  forwardPlayerData(req, res, (token, game) => playerDataProxy.getPlacement(token, game)),
);

// клампит limit в [1, 100] — тот же приём, что и на самом auth-сервисе
// (защита от произвольного query-значения ещё на прокси-слое)
function clampLimit(value, fallback, max) {
  const num = Number(value);

  return Number.isInteger(num) ? Math.min(Math.max(num, 1), max) : fallback;
}

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

  const limit = clampLimit(req.query.limit, 10, 100);

  playerDataProxy
    .getLeaderboard(game, limit)
    .then(({ status, json }) => res.status(status).json(json))
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
