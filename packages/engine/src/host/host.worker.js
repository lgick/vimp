// Web Worker браузерного хоста. Крутит авторитетную часть матча:
// WASM-ядро симуляции (core/pkg-web из пакета игры, например @vimp/tanks,
// репозиторий vimp-tanks) + JS-мету (HostGame поверх
// мета-модулей ./meta/) + игровой цикл ~120 Гц (таймеры Worker'а не
// троттлятся в фоновой вкладке). RTCPeerConnection живут в главном потоке —
// сюда приходят уже разобранные пакеты клиентов, обратно уходят wire-кадры
// (JSON-строки и бинарные ArrayBuffer'ы через Transferable).

import authClientConfig from '../config/authClient.js';
import clientDefaults from '../config/clientDefaults.js';
import lobbyConfig from '../config/lobby.js';
import wsports from '../config/wsports.js';
import { applyRoomOverrides } from '../lib/applyRoomOverrides.js';
import { buildClientConfig } from '../lib/buildClientConfig.js';
import { buildCoreConfig } from '../lib/coreConfig.js';
import { validateAuth } from '../lib/validators.js';
import { verifyIdentityToken } from '../lib/jwt.js';
import { assertGameConfigShape } from '../lib/gamePlugin.js';
import SocketManager from './meta/SocketManager.js';
import HostGame from './HostGame.js';

// PC (client ports): порты получения данных от клиента
const PC_CONFIG_READY = wsports.client.CONFIG_READY;
const PC_AUTH_RESPONSE = wsports.client.AUTH_RESPONSE;
const PC_MODULES_READY = wsports.client.MODULES_READY;
const PC_MAP_READY = wsports.client.MAP_READY;
const PC_FIRST_SHOT_READY = wsports.client.FIRST_SHOT_READY;
const PC_KEYS_DATA = wsports.client.KEYS_DATA;
const PC_CHAT_DATA = wsports.client.CHAT_DATA;
const PC_VOTE_DATA = wsports.client.VOTE_DATA;
const PC_PONG = wsports.client.PONG;

// PS (server ports): порты отправки данных клиенту
const PS_TECH_INFORM_DATA = wsports.server.TECH_INFORM_DATA;

let host = null;
let socketManager = null;
let clientCfg = null;

// HostPlugin игры (Этап 6.4): грузится динамически по entries.host из
// GameManifest (room.game) — до onInit движок игру не знает вовсе
let hostPlugin = null;

// состояние подключений: socketId → { gameId, methods, enabled }
const clients = new Map();

// эстафета Worker'ов (Этап 5.2): socketId → gameId участников, восстановленных
// из handoff-меты — их порт-машины поднимаются минуя хендшейк
let handoffClients = null;

// JWKS central auth-сервиса, проксированный мастером (Этап B3), закэширован
// на время жизни Worker'а — ключ меняется только при ротации
let jwksPromise = null;

function getJwks() {
  if (!jwksPromise) {
    jwksPromise = fetch(lobbyConfig.auth.jwksUrl).then(res => {
      if (!res.ok) {
        throw new Error(`jwks: HTTP ${res.status}`);
      }

      return res.json();
    });

    // сбой не должен закэшироваться навсегда — следующий вход попробует снова
    jwksPromise.catch(() => {
      jwksPromise = null;
    });
  }

  return jwksPromise;
}

// проверяет identity-токен клиента (Этап B3): подпись RS256 по JWKS мастера,
// issuer, срок годности — возвращает проверенный ник или бросает исключение.
// Свободный ввод имени в игре больше не источник ника: он берётся из claim
async function verifyClientToken(token) {
  const jwks = await getJwks();
  const payload = await verifyIdentityToken(token, {
    jwks,
    issuer: authClientConfig.issuer,
  });

  return payload.nick;
}

// wire-сокет пользователя: пишет кадры в главный поток (роутер WebRTC/loopback)
function makeWorkerSocket(socketId) {
  return {
    // JSON-сообщение [port, payload] — строкой (как ws.send); reliable
    // решает канал WebRTC (meta/state) — ненадёжен только ping
    send: (port, data, reliable = true) => {
      self.postMessage({
        type: 'to_client',
        socketId,
        payload: JSON.stringify([port, data]),
        reliable,
      });
    },

    // бинарный кадр — Transferable ArrayBuffer (без копии); reliable решает
    // канал WebRTC (meta/state) в главном потоке
    sendBinary: (buffer, reliable) => {
      self.postMessage(
        { type: 'to_client', socketId, payload: buffer, reliable },
        [buffer],
      );
    },

    // закрытие соединения. В отличие от ws, закрытие data channel не несёт
    // код/причину — причина (кик и т.п.) доставляется отдельным TECH_INFORM
    // по meta до закрытия (reliable-ordered гарантирует порядок)
    close: (code, data) => {
      if (data !== undefined) {
        self.postMessage({
          type: 'to_client',
          socketId,
          payload: JSON.stringify([PS_TECH_INFORM_DATA, data]),
          reliable: true,
        });
      }

      self.postMessage({ type: 'close_client', socketId, code, data });
    },
  };
}

// инициализация хоста: HostPlugin игры (динамический import по
// GameManifest, Этап 6.4), ядро, мета, игровой цикл. handoff — состояние
// эстафеты Worker'ов (Этап 5.2): комната восстанавливается вместо
// холодного старта, порт-машины клиентов поднимутся минуя хендшейк
async function onInit(room, handoff = null) {
  const pluginModule = await import(/* @vite-ignore */ room.game.hostEntryUrl);

  hostPlugin = pluginModule.default;
  assertGameConfigShape(hostPlugin);

  const game = applyRoomOverrides(room, hostPlugin);
  const seed = (Math.random() * 2 ** 32) >>> 0;

  const core = await hostPlugin.createCore(
    JSON.stringify(
      buildCoreConfig(hostPlugin.gameConfig, {
        friendlyFire: game.parts.friendlyFire,
        seed,
      }),
    ),
    { wasmUrl: room.game.wasmUrl },
  );

  clientCfg = buildClientConfig(
    game,
    clientDefaults,
    hostPlugin.buildClientGameConfig(),
  );
  socketManager = new SocketManager(wsports.server, {
    soundCues: game.soundCues,
    initialVote: game.initialVote,
  });
  host = new HostGame(game, socketManager, core, hostPlugin, {
    hostSocketId: room?.hostSocketId ?? null,
    onMapChange: mapName => self.postMessage({ type: 'map_changed', mapName }),
    handoff,
    gameVersion: room.game.version,
  });

  // эстафета Worker'ов (Этап 5.2) несёт уже известный hostId в room — новый
  // Worker не должен ждать повторного register_host, чтобы возобновить
  // атрибуцию rank/state-flush (кодревью №1); при холодном старте hostId
  // ещё не назначен мастером, придёт позже через 'set_host_id'
  if (room?.hostId) {
    host.setHostId(room.hostId);
  }

  if (handoff) {
    handoffClients = new Map(handoff.humans.map(h => [h.socketId, h.gameId]));
  }

  // мастеру нужна фактическая карта комнаты (после эстафеты — восстановленная)
  self.postMessage({ type: 'ready', mapName: host.currentMap });
}

// порт-обработчики клиента (замыкание над gameId через state)
function buildPortMethods(socketId, state) {
  return [
    // 0: config ready
    () => {
      state.enabled[PC_AUTH_RESPONSE] = true;

      // validators — код, по проводу не передаётся (форма клиента берёт
      // игровые валидаторы из своего бандла); texts — заголовок и
      // help-секции игры для нейтрального каркаса auth.pug
      socketManager.sendAuthData(socketId, {
        elems: hostPlugin.authSchema.elems,
        params: hostPlugin.authSchema.params,
        texts: hostPlugin.authSchema.texts,
      });
      state.enabled[PC_CONFIG_READY] = false;
    },

    // 1: auth response. Ник — не свободный ввод игровой формы, а claim
    // проверенного identity-токена (Этап B3); authSchema.params больше не
    // содержит 'name', только игро-специфичные поля (например 'model')
    data => {
      if (!data || typeof data !== 'object') {
        return;
      }

      const err = validateAuth(
        data,
        hostPlugin.authSchema.params,
        hostPlugin.authSchema.validators,
      );

      if (err) {
        socketManager.sendAuthResult(socketId, err);
        return;
      }

      verifyClientToken(data.token)
        .then(name => {
          // клиент мог отключиться, пока токен проверялся
          if (!clients.has(socketId)) {
            return;
          }

          state.enabled[PC_AUTH_RESPONSE] = false;
          state.enabled[PC_MODULES_READY] = true;

          host.createUser({ ...data, name }, socketId, createdId => {
            state.gameId = createdId;
          });

          socketManager.sendTechInform(socketId, 'loading');
          socketManager.sendAuthResult(socketId, undefined);
        })
        .catch(() => {
          socketManager.sendAuthResult(socketId, [
            { name: 'token', error: 'invalid' },
          ]);
        });
    },

    // 2: modules ready
    () => {
      state.enabled[PC_MODULES_READY] = false;
      state.enabled[PC_MAP_READY] = true;
      state.enabled[PC_FIRST_SHOT_READY] = true;
      state.enabled[PC_KEYS_DATA] = true;
      state.enabled[PC_CHAT_DATA] = true;
      state.enabled[PC_VOTE_DATA] = true;
      state.enabled[PC_PONG] = true;

      host.sendMap(state.gameId);
    },

    // 3: map ready
    () => host.mapReady(state.gameId),

    // 4: first shot ready
    () => host.firstShotReady(state.gameId),

    // 5: keys data ('seq:action:name')
    keyEventString => {
      if (typeof keyEventString === 'string') {
        host.updateKeys(state.gameId, keyEventString);
      }
    },

    // 6: chat data
    message => host.pushMessage(state.gameId, message),

    // 7: vote data
    data => {
      if (data) {
        host.parseVote(state.gameId, data);
      }
    },

    // 8: pong
    pingId => host.updateRTT(state.gameId, pingId),
  ];
}

// новое подключение клиента: порт-машина как в socket/index.js
function onConnect(socketId) {
  if (!host || clients.has(socketId)) {
    return;
  }

  const socket = makeWorkerSocket(socketId);

  socketManager.addUser(socketId, socket);

  // эстафета (Этап 5.2): участник уже восстановлен в HostGame — порт-машина
  // поднимается сразу в игровом состоянии, хендшейк не повторяется
  const restoredGameId = handoffClients?.get(socketId);

  if (restoredGameId !== undefined) {
    handoffClients.delete(socketId);

    const state = {
      gameId: restoredGameId,
      enabled: new Array(9).fill(false),
    };

    state.methods = buildPortMethods(socketId, state);
    state.enabled[PC_MAP_READY] = true;
    state.enabled[PC_FIRST_SHOT_READY] = true;
    state.enabled[PC_KEYS_DATA] = true;
    state.enabled[PC_CHAT_DATA] = true;
    state.enabled[PC_VOTE_DATA] = true;
    state.enabled[PC_PONG] = true;

    clients.set(socketId, state);
    return;
  }

  // комната заполнена (люди + боты) — отказ без порт-машины
  // (очереди ожидания легаси-сервера в P2P-комнате нет)
  if (host.isFull) {
    // причину доставит close (TECH_INFORM перед close_client)
    socketManager.close(socketId, 4006, 'roomFull', [host.maxPlayers]);
    socketManager.removeUser(socketId);
    return;
  }

  const state = {
    gameId: undefined,
    enabled: new Array(9).fill(false),
  };

  clients.set(socketId, state);
  state.methods = buildPortMethods(socketId, state);

  state.enabled[PC_CONFIG_READY] = true;
  socketManager.sendConfig(socketId, clientCfg);
}

// входящее сообщение клиента (wire-строка [port, payload])
function onClientMessage(socketId, data) {
  const state = clients.get(socketId);

  if (!state) {
    return;
  }

  let msg;

  try {
    msg = JSON.parse(data);
  } catch (e) {
    return;
  }

  if (msg && state.enabled[msg[0]]) {
    state.methods[msg[0]](msg[1]);
  }
}

// отключение клиента
function onDisconnect(socketId) {
  const state = clients.get(socketId);

  if (!state) {
    return;
  }

  socketManager.removeUser(socketId);

  if (state.gameId !== undefined) {
    host.removeUser(state.gameId);
  }

  clients.delete(socketId);
}

self.onmessage = async event => {
  const msg = event.data;

  switch (msg.type) {
    case 'init':
      try {
        await onInit(msg.room, msg.handoff);
      } catch (e) {
        // сбой загрузки WASM/конфига/handoff-меты — сообщить главному
        // потоку, не виснуть (при эстафете тот возобновит старый Worker)
        self.postMessage({
          type: 'error',
          message: e && e.message ? e.message : String(e),
        });
      }
      break;

    case 'connect':
      onConnect(msg.socketId);
      break;

    case 'message':
      onClientMessage(msg.socketId, msg.data);
      break;

    case 'disconnect':
      onDisconnect(msg.socketId);
      break;

    case 'update_maps':
      host?.updateMaps(msg.maps);
      break;

    // мастер подтвердил регистрацию комнаты (кодревью №1) — hostId нужен
    // PlayerDataSync для атрибуции последующих rank/state-flush
    case 'set_host_id':
      host?.setHostId(msg.hostId);
      break;

    // эстафета Worker'ов (Этап 5.2)

    // запрос переноса: на ближайшей границе раунда игра остановится и
    // handoff-состояние уедет главному потоку
    case 'prepare_handoff':
      host?.requestHandoff(state =>
        self.postMessage({ type: 'handoff_state', state }),
      );
      break;

    // новый Worker не поднялся — продолжаем жить на этой версии
    case 'resume':
      host?.resumeAfterHandoff();
      break;

    // клиенты переподключены главным потоком — завершить перенос
    case 'handoff_complete':
      handoffClients = null;
      host?.completeHandoff(new Set(clients.keys()));
      break;
  }
};
