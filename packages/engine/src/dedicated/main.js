import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import ViteExpress from 'vite-express';
import { WebSocketServer } from 'ws';
import { applyMasterEnv, readDedicatedRoom } from '../config/env.js';
import closeCodes from '../config/closeCodes.js';
import wsports from '../config/wsports.js';
import { clientIp } from '../lib/clientIp.js';
import config from '../lib/config.js';
import { createHostRuntime } from '../lib/createHostRuntime.js';
import { loadGamePackage } from '../lib/loadGamePackage.js';
import { offlinePlayerData } from '../lib/offlinePlayerData.js';
import RateLimiter from '../lib/rateLimiter.js';
import security from '../lib/security.js';
import PortMachine from '../host/PortMachine.js';
import { createGuestIdentity } from '../host/identity.js';
import GameCatalog from '../master/GameCatalog.js';
import GameRegistryProxy from '../master/GameRegistryProxy.js';
import GameStore from '../master/GameStore.js';
import { PACKAGE_NAME_PATTERN } from '../master/gameRefs.js';
import {
  applyLocalGames,
  readGameId,
  readPackageVersion,
} from '../master/localGames.js';
import { securityHeaders } from '../master/httpSecurity.js';

// Dedicated-сервер одной игры (Этап 4 плана standalone-sdk): авторитетный
// матч крутится прямо в этом Node-процессе, браузеры подключаются прямым
// WebSocket. Ни лобби, ни сигналинга, ни WebRTC, ни вкладки хостера здесь
// нет; личность гостевая (identity.js), профиль — offline-заглушка.
//
// Ограничения (docs/en/dedicated.md): одна комната на процесс (мета-модули
// хоста — модульные синглтоны), эстафеты Worker'ов нет — деплой означает
// перезапуск процесса и разрыв матча, рейтинга серверов и GET /servers нет.

config.set('master', (await import('../config/master.js')).default);

// пути якорятся от расположения файла, а не от cwd — процесс можно запускать
// из любой директории
const engineDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const nodeModulesDir = path.resolve(engineDir, '..', '..', 'node_modules');

// корень хранилища скачанных игровых пакетов — тот же, что у лобби-мастера:
// в проде задаётся VIMP_GAMES_DIR и монтируется томом, локально это
// <repoRoot>/.games
function resolveGamesDir() {
  return (
    config.get('master:gameStore:dir') ??
    path.resolve(engineDir, '..', '..', '.games')
  );
}

// путь игрового WebSocket: тот же, что умолчание клиента (client/boot.js)
const WS_PATH = '/game';

// бэкпрешер медленному клиенту — тот же порог, что у WebRTC-хоста
// (client/network/HostConnectionManager.js): позиционные кадры дропаются,
// надёжные не дропаются никогда
const BACKPRESSURE_THRESHOLD = 262144;

// WebSocket.OPEN — константа класса; в проверке читаемее именованный литерал
const WS_OPEN = 1;

const PS_TECH_INFORM_DATA = wsports.server.TECH_INFORM_DATA;

// Публичный 24/7-процесс без лобби-гейта и OAuth — политику флуда держим
// здесь, в адаптере: PortMachine обязан остаться изоморфным и без политики.

// кадр клиента — чат-строка, клавиши, голос: килобайты. Дефолт ws (100 МиБ)
// на публичном сервере — просто пик памяти по запросу
const MAX_PAYLOAD = 64 * 1024;

// клиент шлёт до ~60 кадров/с на пике (клавиши + pong); 300/с ловит флуд,
// не задевая игру
const MESSAGE_LIMIT = { limit: 300, windowMs: 1000 };

// соединение, не дошедшее до участника, слота в комнате не занимает
// (isFull считает getHumans()), но держит сокет и память — slowloris.
// Порог щедрый намеренно: участник появляется только после AUTH_RESPONSE, то
// есть в это время укладываются инициализация WebGL и запекание ассетов у
// клиента (CONFIG_READY уходит после Promise.all(initPromises)) плюс ввод ника
// человеком. Закрытие тут заканчивается перезагрузкой страницы у клиента
// (handleDisconnect в dedicated), так что коротким таймаутом медленный игрок
// попадал бы в петлю
const HANDSHAKE_TIMEOUT = 120000;

// подключений с одного адреса за минуту: игровой сокет открывается один раз
// на вкладку (плюс перезагрузки), а до аутентификации каждое соединение уже
// стоит серверу CONFIG_DATA — без лимита это усилитель. Ключ даёт clientIp:
// адрес сокета, за прод-Nginx — перезаписанный им X-Real-IP (X-Forwarded-For
// не годится, там первый адрес пишет сам клиент — см. lib/clientIp.js)
const CONNECTION_LIMIT = { limit: 30, windowMs: 60000 };

/**
 * Разбирает VIMP_DEDICATED_GAME: `<ref>` — раздаваемая реестром версия,
 * `<ref>@<version>` — пин на точную версию пакета. Ссылкой служит id игры
 * (`tanks`) либо имя npm-пакета (`@vimp-games/tanks`) — см. resolveLocalRef.
 * @param {string} [ref] - Значение переменной окружения.
 * @returns {{id: string|null, version: string|null}} Ссылка и пин.
 */
export function parseGameRef(ref) {
  if (typeof ref !== 'string' || !ref) {
    return { id: null, version: null };
  }

  // lastIndexOf, а не split: у скоупнутого имени '@' встречается и в начале
  const at = ref.lastIndexOf('@');

  if (at <= 0) {
    return { id: ref, version: null };
  }

  return { id: ref.slice(0, at), version: ref.slice(at + 1) || null };
}

/**
 * Ссылка на игру → запись каталога `{id, package}`.
 *
 * Ссылкой служит id игры (`tanks`) или имя npm-пакета
 * (`@vimp-games/tanks`): поле `dedicatedGame` в SERVERS_MATRIX называет игру
 * пакетом, потому что до ответа реестра это единственное имя, известное
 * деплою. Разрешать её обязательно ДО каталога: id игры — сегмент URL
 * раздачи, и имя пакета на его месте дало бы `/games/@scope/name/…`.
 *
 * @param {string} ref - id игры либо имя пакета (пин версии уже отрезан).
 * @param {Object} sources - Источники разрешения.
 * @param {{id: string, package: string}[]} sources.games - `master:games`.
 * @param {string} sources.nodeModulesDir - Директория node_modules.
 * @returns {{id: string, package: string}|null} Запись каталога либо null.
 */
export function resolveLocalRef(ref, { games = [], nodeModulesDir: dir } = {}) {
  if (!ref) {
    return null;
  }

  // id первым: `tanks` обязан остаться игрой tanks, даже если рядом лежит
  // безскоупный пакет с тем же именем
  const byId = games.find(game => game.id === ref);

  if (byId) {
    return byId;
  }

  const byPackage = games.find(game => game.package === ref);

  if (byPackage) {
    return byPackage;
  }

  // пакета нет в master:games — в проде его там и не будет: автообнаружение
  // туда не ходит. Читаем манифест напрямую: он и объявляет id игры.
  // Проверка формы, а не скоупа: безскоупное имя пакета (`vimp-tanks`)
  // неотличимо от id по виду, и отсекать его значило бы объявить
  // установленный и собранный пакет ненайденным
  if (!dir || !PACKAGE_NAME_PATTERN.test(ref)) {
    return null;
  }

  const id = readGameId(dir, ref);

  return id ? { id, package: ref } : null;
}

// Игра из реестра auth-сервиса (master-game-registry, этап 5): лобби-мастера
// рядом нет, поэтому dedicated повторяет его путь сам — спрашивает каталог
// реестра и качает пакет в собственное хранилище (VIMP_GAMES_DIR, в проде
// это смонтированный том). Скачивание проверяется структурно тем же
// gamePackageCheck, код игры при этом не исполняется.
async function fetchRegistryGame(ref, version, env = process.env) {
  if (!env.VIMP_AUTH_SERVICE_URL) {
    return null;
  }

  const registry = new GameRegistryProxy(
    config.get('master:security:authServiceUrl'),
  );
  const { status, json } = await registry.list();

  if (status !== 200 || !Array.isArray(json?.games)) {
    throw new Error(
      `dedicated: game registry answered ${status} — game "${ref}" is not resolved`,
    );
  }

  // ссылкой может быть и имя пакета: реестр знает оба имени, и id игры
  // берётся из НАЙДЕННОЙ строки, а не из того, как её назвали
  const game = json.games.find(
    item => item.id === ref || item.packageName === ref,
  );

  if (!game) {
    throw new Error(`dedicated: game "${ref}" is not in the registry catalog`);
  }

  const store = new GameStore({
    dir: resolveGamesDir(),
    registryUrl: config.get('master:gameStore:registryUrl'),
    limits: {
      maxTarballBytes: config.get('master:gameStore:maxTarballBytes'),
      maxFiles: config.get('master:gameStore:maxFiles'),
      timeout: config.get('master:gameStore:timeout'),
    },
  });
  // пин из VIMP_DEDICATED_GAME важнее раздаваемой версии: так админ поднимает
  // сервер на конкретной сборке, не трогая реестр
  const result = await store.ensure(game.id, game.packageName, version ?? game.version);

  if (!result.ok) {
    throw new Error(
      `dedicated: game "${game.id}"@${version ?? game.version} is not usable — ` +
        result.errors.join('; '),
    );
  }

  return {
    // id игры, а не ссылка: он едет в каталог и становится сегментом URL
    id: game.id,
    version: result.version,
    distDir: result.distDir,
    manifest: result.manifest,
    packageUrl: game.repoUrl ?? null,
    maxGameScore: game.maxGameScore,
  };
}

/**
 * Поднимает dedicated-сервер: пакет игры, симуляцию, HTTP и игровой WS.
 * @param {Object} [options]
 * @param {string} [options.gameId] - Игра: id (`tanks`) либо имя npm-пакета
 *   (`@vimp-games/tanks`), любое из них с пином `@<version>`
 *   (VIMP_DEDICATED_GAME).
 * @param {number} [options.port] - Порт HTTP+WS (0 — свободный, для тестов).
 * @param {string} [options.host] - Интерфейс прослушивания ('0.0.0.0' в проде).
 * @param {Object} [options.room] - Переопределения комнаты (map, maxPlayers,
 *   roundTime, mapTime, friendlyFire, seed).
 * @param {Function} [options.loadGame] - Загрузчик пакета игры (инъекция тестов).
 * @param {Function} [options.fetchGame] - Загрузчик игры из реестра (инъекция тестов).
 * @param {boolean} [options.serveClient] - Раздавать ли клиент движка
 *   (ViteExpress); тестам не нужен.
 * @returns {Promise<Object>} { id, port, app, server, runtime, portMachine, close }.
 */
export async function startDedicatedServer({
  gameId,
  port = config.get('master:port'),
  host,
  room = {},
  loadGame = loadGamePackage,
  fetchGame = fetchRegistryGame,
  serveClient = true,
} = {}) {
  const isProduction = process.env.NODE_ENV === 'production';

  // каталог мастера переиспользуется ради манифеста, карт и dist/ игры:
  // клиент движка читает их теми же URL-ами, что у лобби-мастера
  const ref = parseGameRef(gameId);
  const games = config.get('master:games') ?? [];
  const local = resolveLocalRef(ref.id, { games, nodeModulesDir });
  // Пин версии на локальном пути подменить нечем: раздаётся то, что
  // установлено. Молча отдать другую сборку нельзя — оператор написал в
  // SERVERS_MATRIX точную версию, — поэтому расхождение уводит игру в
  // реестр, который пин умеет (а без реестра старт падает именованно)
  const localVersion = local ? readPackageVersion(nodeModulesDir, local.package) : null;
  const pinMissed = Boolean(local && ref.version && ref.version !== localVersion);
  const entry = pinMissed ? null : local;

  const catalog = new GameCatalog(entry ? [entry] : [], nodeModulesDir, {
    dev: !isProduction,
  });

  // Порядок разрешения игры (master-game-registry, этап 5): прилинкованный
  // пакет важнее реестра (это dev-путь и HMR разработки самой игры), а если
  // его нет — игра приезжает из реестра тем же способом, что у лобби-мастера
  let registryEntry = null;
  let packageDir = entry
    ? path.join(nodeModulesDir, entry.package, 'dist')
    : null;

  // Инъекция loadGame означает, что пакет игры тесту уже известен и
  // директория ему не нужна; инъекция fetchGame — что тест проверяет как раз
  // разрешение через реестр
  const needsPackageDir =
    loadGame === loadGamePackage || fetchGame !== fetchRegistryGame;

  if (!entry && needsPackageDir) {
    registryEntry = await fetchGame(ref.id, ref.version);

    if (!registryEntry) {
      throw new Error(
        pinMissed
          ? `dedicated: game "${ref.id}" is pinned to ${ref.version}, but ` +
            `node_modules has ${localVersion ?? 'an unknown version'} and ` +
            'there is no registry to fetch the pinned one from — install that ' +
            'version, drop the pin, or set VIMP_AUTH_SERVICE_URL'
          : `dedicated: game "${ref.id}" is not available — link its package ` +
            'into node_modules, name it by package (@scope/name), or set ' +
            'VIMP_AUTH_SERVICE_URL so the server can fetch it from the registry',
      );
    }

    // та же запись каталога, что у лобби-мастера: манифест ребейзится на
    // /games/<id>/<version>/, и версионные адреса работают одинаково.
    // id — из ответа реестра, а не из ссылки: ссылкой могло быть имя пакета,
    // и оно уехало бы в URL раздачи вместе со своим слешем
    catalog.upsert({
      id: registryEntry.id ?? ref.id,
      version: registryEntry.version,
      distDir: registryEntry.distDir,
      manifest: registryEntry.manifest,
      packageVersion: registryEntry.version,
      packageUrl: registryEntry.packageUrl,
      maxGameScore: registryEntry.maxGameScore,
      active: true,
    });

    packageDir = registryEntry.distDir;
  }

  const pkg = await loadGame(packageDir);

  // id игры объявляет её сборка; ref.id — последний запасной путь, и он же
  // единственный, которым могло оказаться имя пакета, поэтому разрешённая
  // запись стоит раньше него
  const id = pkg.id ?? entry?.id ?? registryEntry?.id ?? ref.id;
  const packageVersion = registryEntry?.version ?? null;
  const manifest = catalog.getManifest(id) ?? pkg.manifest ?? null;
  const mapCatalog = catalog.getMapCatalog(id) ?? null;
  const distDir = catalog.getDistDir(id) ?? pkg.distDir ?? null;
  // пустой каталог карт равнозначен его отсутствию: карты тогда берёт сам
  // пакет игры из своего gameConfig (так работает фикстурный и dev-путь)
  const catalogMaps = mapCatalog ? readMaps(mapCatalog) : null;
  const maps =
    catalogMaps && Object.keys(catalogMaps).length > 0 ? catalogMaps : null;

  // ***** симуляция ***** //

  const runtime = await createHostRuntime(
    {
      name: `dedicated:${id}`,
      ...room,
      // плагин уже живой объект: hostEntryUrl не нужен, wasmUrl — file:-URL
      // node-сборки ядра игры
      game: {
        id,
        version: manifest?.version ?? null,
        wasmUrl: pkg.wasmUrl,
      },
      ...(maps ? { maps } : {}),
    },
    {
      loadHostPlugin: async () => pkg.hostPlugin,
      hostOptions: {
        // центрального auth-сервиса в этом контуре нет: rank/state не
        // персистятся, профиль отвечает дефолтами
        playerDataFetch: offlinePlayerData(),
        onMapChange: mapName => console.info(`[dedicated] map: ${mapName}`),
      },
    },
  );

  // socketId → ws живых соединений (нужен и сокет-адаптеру, и shutdown'у)
  const sockets = new Map();

  const portMachine = new PortMachine({
    host: runtime.host,
    socketManager: runtime.socketManager,
    clientCfg: runtime.clientCfg,
    authSchema: runtime.hostPlugin.authSchema,
    makeSocket: socketId => makeWsSocket(sockets, socketId),
    // мастера нет — ник берётся из формы и валидируется движком
    identity: createGuestIdentity(),
  });

  // ***** HTTP ***** //

  const app = express();

  app.use(securityHeaders({ isProduction }));

  // режим сервера: клиент движка пробингует /config и по нему выбирает
  // контур загрузки (dedicated вместо лобби)
  app.get('/config', (req, res) => {
    res.json({
      mode: 'dedicated',
      gameId: id,
      gameVersion: manifest?.version ?? null,
      wsPath: WS_PATH,
    });
  });

  // каталог игр как у мастера, но ровно из одной игры
  app.get('/games/manifest.json', (req, res) => {
    res.json(manifest ? [manifest] : []);
  });

  app.get('/games/:id/manifest.json', (req, res) => {
    if (!manifest || req.params.id !== id) {
      res.status(404).json({ error: 'unknownGame' });
      return;
    }

    res.json(manifest);
  });

  app.get('/games/:id/maps/manifest.json', (req, res) => {
    if (!mapCatalog || req.params.id !== id) {
      res.status(404).json({ error: 'unknownGame' });
      return;
    }

    res.type('application/json').send(mapCatalog.manifest);
  });

  app.get('/games/:id/maps/:name', (req, res) => {
    const json =
      req.params.id === id ? mapCatalog?.get(req.params.name) : undefined;

    if (!json) {
      res.status(404).json({ error: 'unknownMap' });
      return;
    }

    res.type('application/json').send(json);
  });

  // Версионные адреса той же игры (master-game-registry, этап 5): пакет,
  // приехавший из реестра, раздаётся по `/games/<id>/<version>/…` — ровно по
  // тем адресам, что стоят в его манифесте после ребейза. Неверсионные
  // алиасы выше остаются для node_modules-пути и старых вкладок
  if (packageVersion) {
    const prefix = `/games/${id}/${packageVersion}`;

    app.get(`${prefix}/manifest.json`, (req, res) => {
      res.json(manifest);
    });

    app.get(`${prefix}/maps/manifest.json`, (req, res) => {
      if (!mapCatalog) {
        res.status(404).json({ error: 'unknownGame' });
        return;
      }

      res.type('application/json').send(mapCatalog.manifest);
    });

    app.get(`${prefix}/maps/:name`, (req, res) => {
      const json = mapCatalog?.get(req.params.name);

      if (!json) {
        res.status(404).json({ error: 'unknownMap' });
        return;
      }

      res.type('application/json').send(json);
    });
  }

  // статика игры (хешированные бандлы/wasm/звуки из GameManifest.assetsBase)
  if (distDir) {
    if (packageVersion) {
      app.use(`/games/${id}/${packageVersion}`, express.static(distDir));
    }

    app.use(`/games/${id}`, express.static(distDir));
  }

  // в проде обычный HTTP за Nginx; в dev тот же HTTP — сертификаты нужны
  // только лобби-мастеру (OAuth-редиректы), у dedicated их нет
  const server = http.createServer(app);

  await new Promise(resolve => server.listen(port, host, resolve));

  const actualPort = server.address().port;

  // ***** игровой WebSocket ***** //

  const checkOrigin = security.createOriginValidator({
    protocol: 'http:',
    domain: config.get('master:domain'),
    port: actualPort,
  });

  const wss = new WebSocketServer({
    server,
    path: WS_PATH,
    maxPayload: MAX_PAYLOAD,
  });

  const messageLimiter = new RateLimiter(MESSAGE_LIMIT);
  const connectionLimiter = new RateLimiter(CONNECTION_LIMIT);
  const limiterSweep = setInterval(() => {
    messageLimiter.sweep();
    connectionLimiter.sweep();
  }, 60000);

  limiterSweep.unref();

  wss.on('connection', (ws, req) => {
    // ws эмитит 'error' на самом сокете (ECONNRESET, битый фрейм). Без
    // слушателя это uncaughtException, то есть один сорванный клиент убивает
    // матч всех остальных — тот же слушатель стоит в сигналинге. Ставится до
    // проверки origin: иначе ошибка на отбитом соединении не перехвачена
    ws.on('error', err =>
      console.error('[dedicated] socket error:', err.message),
    );

    const requestOrigin = req.headers.origin;

    // origin не пришёл вовсе — это скорее всего бот (как у сигналинга)
    if (!requestOrigin) {
      ws.terminate();
      return;
    }

    // частота подключений с адреса
    const ip = clientIp(req, { trustProxy: isProduction });

    // адреса нет только у уже разорванного сокета: общий бакет '' для таких
    // соединений был бы дырой в лимите
    if (!ip) {
      ws.terminate();
      return;
    }

    if (!connectionLimiter.consume(ip)) {
      console.warn(`[dedicated] connection rate limit for ${ip}`);
      ws.close(closeCodes.tooManyConnections, 'tooManyConnections');
      return;
    }

    checkOrigin(requestOrigin, err => {
      if (err) {
        console.warn(err);
        // причина close ограничена 123 байтами (ws бросает RangeError, а он
        // здесь никем не перехватывается): полный текст уходит в лог,
        // клиенту — короткий маркер
        ws.close(closeCodes.invalidOrigin, 'invalidOrigin');
        return;
      }

      const socketId = crypto.randomUUID();

      sockets.set(socketId, ws);

      // соединение, застрявшее в хендшейке, закрываем сами: участника оно не
      // создало, а сокет и память держит
      const guard = setTimeout(() => {
        if (!portMachine.hasParticipant(socketId)) {
          ws.close(closeCodes.handshakeTimeout, 'handshakeTimeout');
        }
      }, HANDSHAKE_TIMEOUT);

      guard.unref();

      ws.on('message', data => {
        // молча отбрасываем: кик за неактивность и потерянные ping — забота
        // HostGame, здесь только защита от флуда
        if (messageLimiter.consume(socketId)) {
          portMachine.message(socketId, data.toString());
        }
      });

      ws.on('close', () => {
        clearTimeout(guard);
        sockets.delete(socketId);
        portMachine.disconnect(socketId);
      });

      // лимит участников — забота порт-машины (roomFull, config/closeCodes.js)
      portMachine.connect(socketId);
    });
  });

  wss.on('error', err =>
    console.error('[dedicated] ws server error:', err.message),
  );

  // раздача клиента движка: dev — через Vite, прод — статика из
  // packages/engine/dist
  if (serveClient) {
    ViteExpress.bind(app, server);
  }

  // ***** graceful shutdown ***** //

  // порядок важен: сначала уходят клиенты, затем матч (destroy дожидается
  // финальной синхронизации профилей и снимает таймеры, иначе они держали бы
  // процесс живым), и только потом закрывается HTTP
  const close = async () => {
    clearInterval(limiterSweep);

    for (const ws of sockets.values()) {
      ws.close(1001);
    }

    sockets.clear();

    await runtime.host.destroy();

    wss.close();
    server.closeAllConnections();

    await new Promise(resolve => server.close(resolve));
  };

  return { id, port: actualPort, app, server, runtime, portMachine, close };
}

// wire-сокет пользователя: тот же фрейминг, что у makeWorkerSocket
// (host.worker.js) — иначе клиент движка не разобрал бы кадры
function makeWsSocket(sockets, socketId) {
  const send = (payload, reliable = true) => {
    const ws = sockets.get(socketId);

    if (!ws || ws.readyState !== WS_OPEN) {
      return;
    }

    // бэкпрешер: позиционные кадры медленному клиенту дропаем (следующий
    // кадр компенсирует потерю), надёжные не дропаем никогда
    if (reliable === false && ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
      return;
    }

    ws.send(payload);
  };

  return {
    send: (port, data, reliable = true) =>
      send(JSON.stringify([port, data]), reliable),

    sendBinary: (buffer, reliable) => send(buffer, reliable),

    // причина закрытия доставляется отдельным TECH_INFORM до close: код
    // закрытия WebSocket клиент видит, но текст причины ему нужен раньше
    close: (code, data) => {
      if (data !== undefined) {
        send(JSON.stringify([PS_TECH_INFORM_DATA, data]));
      }

      sockets.get(socketId)?.close(code);
    },
  };
}

// карты каталога мастера уезжают в комнату разобранными: MapCatalog хранит
// готовые JSON-строки для раздачи по HTTP, хосту же нужны объекты
function readMaps(mapCatalog) {
  const maps = {};

  for (const name of JSON.parse(mapCatalog.manifest).maps) {
    maps[name] = JSON.parse(mapCatalog.get(name));
  }

  return maps;
}

// запуск из окружения: сюда приходит `node src/master/main.js` при заданной
// VIMP_DEDICATED_GAME (см. master/main.js). При импорте модуля тестами
// переменной нет — сервер не поднимается
if (process.env.VIMP_DEDICATED_GAME) {
  applyMasterEnv(config);

  // локальный запуск: игры ищем в node_modules, иначе VIMP_DEDICATED_GAME
  // указывает на id, которого нет в пустом master:games, и старт падает на
  // несобранном каталоге, а не на отсутствующей игре. В проде каталог пуст —
  // там игра резолвится по имени пакета или приезжает из реестра
  applyLocalGames(config, nodeModulesDir);

  const isProduction = process.env.NODE_ENV === 'production';
  const gameId = process.env.VIMP_DEDICATED_GAME;
  const dedicated = await startDedicatedServer({
    gameId,
    host: isProduction ? '0.0.0.0' : undefined,
    room: readDedicatedRoom(),
  });

  console.info(`
    Dedicated server is running for ${process.env.NODE_ENV || 'development'} mode.
    Game: ${dedicated.id}, map: ${dedicated.runtime.host.currentMap}
    Listening on http://${isProduction ? '0.0.0.0' : 'localhost'}:${dedicated.port} (game WS: ${WS_PATH})
  `);

  let stopping = false;

  const shutdown = () => {
    if (stopping) {
      return;
    }

    stopping = true;
    console.info('[dedicated] shutting down…');

    dedicated
      .close()
      .catch(err => console.error('[dedicated] shutdown failed:', err.message))
      .finally(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
