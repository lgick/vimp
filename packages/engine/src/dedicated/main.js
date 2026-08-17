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

  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on('connection', (ws, req) => {
    const requestOrigin = req.headers.origin;

    // origin не пришёл вовсе — это скорее всего бот (как у сигналинга)
    if (!requestOrigin) {
      ws.terminate();
      return;
    }

    checkOrigin(requestOrigin, err => {
      if (err) {
        console.warn(err);
        ws.close(4001, JSON.stringify(err));
        return;
      }

      const socketId = crypto.randomUUID();

      sockets.set(socketId, ws);

      ws.on('message', data => portMachine.message(socketId, data.toString()));

      ws.on('close', () => {
        sockets.delete(socketId);
        portMachine.disconnect(socketId);
      });

      // лимит участников — забота порт-машины (roomFull, код 4006)
      portMachine.connect(socketId);
    });
  });

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
