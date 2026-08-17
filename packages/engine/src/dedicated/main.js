import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import ViteExpress from 'vite-express';
import { WebSocketServer } from 'ws';
import { applyMasterEnv, readDedicatedRoom } from '../config/env.js';
import wsports from '../config/wsports.js';
import config from '../lib/config.js';
import { createHostRuntime } from '../lib/createHostRuntime.js';
import { loadGamePackage } from '../lib/loadGamePackage.js';
import { offlinePlayerData } from '../lib/offlinePlayerData.js';
import RateLimiter from '../lib/rateLimiter.js';
import security from '../lib/security.js';
import PortMachine from '../host/PortMachine.js';
import { createGuestIdentity } from '../host/identity.js';
import GameCatalog from '../master/GameCatalog.js';
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
// стоит серверу CONFIG_DATA — без лимита это усилитель. Ключ — тот же, что у
// сигналинга: X-Forwarded-For (первый адрес) за Nginx, иначе адрес сокета
const CONNECTION_LIMIT = { limit: 30, windowMs: 60000 };

/**
 * Поднимает dedicated-сервер: пакет игры, симуляцию, HTTP и игровой WS.
 * @param {Object} [options]
 * @param {string} [options.gameId] - Игра из `master:games` (VIMP_DEDICATED_GAME).
 * @param {number} [options.port] - Порт HTTP+WS (0 — свободный, для тестов).
 * @param {string} [options.host] - Интерфейс прослушивания ('0.0.0.0' в проде).
 * @param {Object} [options.room] - Переопределения комнаты (map, maxPlayers,
 *   roundTime, mapTime, friendlyFire, seed).
 * @param {Function} [options.loadGame] - Загрузчик пакета игры (инъекция тестов).
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
  serveClient = true,
} = {}) {
  const isProduction = process.env.NODE_ENV === 'production';

  // каталог мастера переиспользуется ради манифеста, карт и dist/ игры:
  // клиент движка читает их теми же URL-ами, что у лобби-мастера
  const games = config.get('master:games') ?? [];
  const entry = games.find(game => game.id === gameId);

  if (!entry && loadGame === loadGamePackage) {
    throw new Error(
      `dedicated: game "${gameId}" is not listed in master:games — set ` +
        'VIMP_DEDICATED_GAME to a configured id (see GAMES_MATRIX)',
    );
  }

  const catalog = new GameCatalog(entry ? [entry] : [], nodeModulesDir, {
    dev: !isProduction,
  });
  const pkg = await loadGame(
    entry ? path.join(nodeModulesDir, entry.package, 'dist') : null,
  );

  const id = pkg.id ?? gameId;
  const manifest = catalog.getManifest(id) ?? pkg.manifest ?? null;
  const mapCatalog = catalog.getMapCatalog(id) ?? null;
  const distDir = catalog.getDistDir(id) ?? pkg.distDir ?? null;
  const maps = mapCatalog ? readMaps(mapCatalog) : null;

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

  // статика игры (хешированные бандлы/wasm/звуки из GameManifest.assetsBase)
  if (distDir) {
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

    // частота подключений с адреса: за Nginx реальный адрес приходит в
    // X-Forwarded-For (тот же разбор, что в SignalingServer)
    const ipHeader = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ip = String(ipHeader ?? '').split(',')[0].trim();

    if (!connectionLimiter.consume(ip)) {
      console.warn(`[dedicated] connection rate limit for ${ip}`);
      ws.close(4009, 'tooManyConnections');
      return;
    }

    checkOrigin(requestOrigin, err => {
      if (err) {
        console.warn(err);
        // причина close ограничена 123 байтами (ws бросает RangeError, а он
        // здесь никем не перехватывается): полный текст уходит в лог,
        // клиенту — короткий маркер
        ws.close(4001, 'invalidOrigin');
        return;
      }

      const socketId = crypto.randomUUID();

      sockets.set(socketId, ws);

      // соединение, застрявшее в хендшейке, закрываем сами: участника оно не
      // создало, а сокет и память держит
      const guard = setTimeout(() => {
        if (!portMachine.hasParticipant(socketId)) {
          ws.close(4008, 'handshakeTimeout');
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

      // лимит участников — забота порт-машины (roomFull, код 4006)
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
