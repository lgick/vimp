// Web Worker браузерного хоста. Крутит авторитетную часть матча:
// WASM-ядро симуляции (core/pkg-web из пакета игры, например @vimp-games/tanks,
// репозиторий vimp-tanks) + JS-мету (HostGame поверх
// мета-модулей ./meta/) + игровой цикл ~120 Гц (таймеры Worker'а не
// троттлятся в фоновой вкладке). RTCPeerConnection живут в главном потоке —
// сюда приходят уже разобранные пакеты клиентов, обратно уходят wire-кадры
// (JSON-строки и бинарные ArrayBuffer'ы через Transferable).
//
// Сам хендшейк клиента (порты 0–8) живёт в изоморфной ./PortMachine.js —
// этот файл только адаптер: postMessage-транспорт, лобби-стратегия
// идентичности и свитч сообщений главного потока.

import authClientConfig from '../config/authClient.js';
import lobbyConfig from '../config/lobby.js';
import wsports from '../config/wsports.js';
import { createHostRuntime } from '../lib/createHostRuntime.js';
import PortMachine from './PortMachine.js';
import { createTokenIdentity } from './identity.js';

// PS (server ports): порты отправки данных клиенту
const PS_TECH_INFORM_DATA = wsports.server.TECH_INFORM_DATA;

let host = null;
let portMachine = null;

// эстафета Worker'ов (Этап 5.2): socketId → gameId участников, восстановленных
// из handoff-меты — их порт-машины поднимаются минуя хендшейк
let handoffClients = null;

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
  // общая с headless-runner'ом сборка (lib/createHostRuntime.js) — чтобы
  // отладочный прогон крутил ровно тот код, что и прод
  const runtime = await createHostRuntime(room, {
    hostOptions: {
      onMapChange: mapName => self.postMessage({ type: 'map_changed', mapName }),
      handoff,
    },
  });

  host = runtime.host;

  // в лобби личность игрока — claim identity-токена, проверенного по JWKS
  // мастера (Этап B3); свободного ввода имени в форме игры нет
  portMachine = new PortMachine({
    host,
    socketManager: runtime.socketManager,
    clientCfg: runtime.clientCfg,
    authSchema: runtime.hostPlugin.authSchema,
    makeSocket: makeWorkerSocket,
    identity: createTokenIdentity({
      jwksUrl: lobbyConfig.auth.jwksUrl,
      issuer: authClientConfig.issuer,
    }),
  });

  const seed = runtime.seed;

  if (handoff) {
    handoffClients = new Map(handoff.humans.map(h => [h.socketId, h.gameId]));
  }

  // мастеру нужна фактическая карта комнаты (после эстафеты — восстановленная)
  self.postMessage({ type: 'ready', mapName: host.currentMap, seed });
}

// новое подключение клиента: участник из handoff-меты уже восстановлен в
// HostGame — его порт-машина поднимается сразу в игровом состоянии
function onConnect(socketId) {
  if (!portMachine) {
    return;
  }

  const restoredGameId = handoffClients?.get(socketId);

  if (restoredGameId !== undefined) {
    handoffClients.delete(socketId);
    portMachine.restore(socketId, restoredGameId);
    return;
  }

  portMachine.connect(socketId);
}

// отладочные действия хоста (этап 6): запись живого матча в формат сценария
// и дамп мира. Сбой не должен ронять Worker — уезжает в ответ строкой
function onDebug({ requestId, action }) {
  let result = null;
  let error = null;

  try {
    if (!host) {
      error = 'host is not ready';
    } else if (action === 'startRecording') {
      result = host.startRecording();
    } else if (action === 'stopRecording') {
      result = host.stopRecording();
    } else if (action === 'dump') {
      result = host.debugSnapshot();
    } else {
      error = `unknown debug action '${action}'`;
    }
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }

  self.postMessage({ type: 'debug_result', requestId, result, error });
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
      portMachine?.message(msg.socketId, msg.data);
      break;

    case 'disconnect':
      portMachine?.disconnect(msg.socketId);
      break;

    case 'update_maps':
      host?.updateMaps(msg.maps);
      break;

    // мастер подтвердил регистрацию комнаты (кодревью №1) — hostId+секрет
    // нужны PlayerDataSync для атрибуции последующих rank/state-flush
    case 'set_host_id':
      host?.setHostId(msg.hostId, msg.hostSecret);
      break;

    // отладочный контур (этап 6 плана plan/done/ai-debug): единственный вход в
    // авторитетную половину из главного потока — запрос/ответ по requestId
    case 'debug':
      onDebug(msg);
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
      host?.completeHandoff(new Set(portMachine ? portMachine.socketIds : []));
      break;
  }
};
