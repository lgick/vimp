// Web Worker браузерного хоста. Крутит авторитетную часть матча:
// WASM-ядро симуляции (core/pkg-web из пакета игры, например @vimp-games/tanks,
// репозиторий vimp-tanks) + JS-мету (HostGame поверх
// мета-модулей ./meta/) + игровой цикл ~120 Гц (таймеры Worker'а не
// троттлятся в фоновой вкладке). RTCPeerConnection живут в главном потоке —
// сюда приходят уже разобранные пакеты клиентов, обратно уходят wire-кадры
// (JSON-строки и бинарные ArrayBuffer'ы через Transferable).
//
// Сам хендшейк клиента (порты 0–10) живёт в изоморфной ./PortMachine.js —
// этот файл только адаптер: postMessage-транспорт, лобби-стратегия
// идентичности и свитч сообщений главного потока.

import authClientConfig from '../config/authClient.js';
import lobbyConfig from '../config/lobby.js';
import wsports from '../config/wsports.js';
import { encodeCheckpoint, decodeCheckpoint } from '../lib/checkpointCodec.js';
import {
  createHostRuntime,
  preloadHostRuntime,
} from '../lib/createHostRuntime.js';
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

// участники эстафеты внутри вкладки: v3 — плоский humans, v4 — формат
// контрольной точки (participants.humans)
function handoffHumans(handoff) {
  return handoff.participants?.humans ?? handoff.humans ?? [];
}

// готовая контрольная точка уходит главному потоку списком переноса — без
// копии: 2 точки в секунду не должны стоить сборщику мусора лишних буферов.
// Буфер кодека принадлежит результату целиком (не view на память wasm)
function postCheckpoint({ meta, core, final }) {
  encodeCheckpoint(meta, core)
    .then(bytes => {
      const owned =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes
          : bytes.slice();

      self.postMessage(
        {
          type: 'checkpoint',
          checkpointId: meta.checkpointId,
          seq: meta.seq,
          createdAt: meta.createdAt,
          final,
          mode: meta.mode,
          bytes: owned,
        },
        [owned.buffer],
      );
    })
    .catch(e => {
      self.postMessage({
        type: 'diagnostic',
        kind: 'checkpoint',
        message: e && e.message ? e.message : String(e),
        stack: e && typeof e.stack === 'string' ? e.stack : null,
      });
    });
}

// инициализация хоста: HostPlugin игры (динамический import по
// GameManifest, Этап 6.4), ядро, мета, игровой цикл. handoff — состояние
// эстафеты Worker'ов (Этап 5.2): комната восстанавливается вместо
// холодного старта, порт-машины клиентов поднимутся минуя хендшейк.
// checkpoint — сжатая контрольная точка (host-migration этап 5): матч
// поднимается на паузе, люди ждут RESUME, старт — start_after_restore
async function onInit(room, handoff = null, checkpointBytes = null, seqFloor) {
  const checkpoint = checkpointBytes
    ? await decodeCheckpoint(checkpointBytes)
    : null;

  // общая с headless-runner'ом сборка (lib/createHostRuntime.js) — чтобы
  // отладочный прогон крутил ровно тот код, что и прод
  const runtime = await createHostRuntime(room, {
    hostOptions: {
      // map_changed остаётся для главного потока до host-migration этапа 2
      onMapChange: mapName =>
        self.postMessage({ type: 'map_changed', mapName }),
      onLobbyInfoChange: info => self.postMessage({ type: 'lobby_info', info }),
      handoff: checkpoint ? null : handoff,
      checkpoint,
      seqFloor: Number(seqFloor) || 0,
    },
  });

  host = runtime.host;
  host.setCheckpointSink(postCheckpoint);
  // здоровье хоста (host-migration этап 9a): главный поток решает, не пора
  // ли отдать роль
  host.setHealthSink(health => self.postMessage({ type: 'health', health }));

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
    // возобновление сессии (host-migration этап 4) — только в лобби:
    // оборвавшийся гость держит место resumeGraceMs и возвращается в него
    resumeGraceMs: runtime.game.resumeGraceMs,
    resumeRequestTimeoutMs: runtime.game.resumeRequestTimeoutMs,
  });

  const seed = runtime.seed;

  if (handoff && !checkpoint) {
    handoffClients = new Map(
      handoffHumans(handoff).map(h => [h.socketId, h.gameId]),
    );
  }

  // мастеру нужна фактическая карта комнаты (после эстафеты — восстановленная)
  self.postMessage({
    type: 'ready',
    mapName: host.currentMap,
    lobbyInfo: host.lobbyInfo,
    seed,
  });
}

// новое подключение клиента: участник из handoff-меты уже восстановлен в
// HostGame — его порт-машина поднимается сразу в игровом состоянии
// resume — переподключение гостя (host-migration этап 4): порт-машина ждёт
// RESUME_REQUEST вместо хендшейка
function onConnect(socketId, resume = false) {
  if (!portMachine) {
    return;
  }

  const restoredGameId = handoffClients?.get(socketId);

  if (restoredGameId !== undefined) {
    handoffClients.delete(socketId);
    portMachine.restore(socketId, restoredGameId);
    return;
  }

  portMachine.connect(socketId, { resume });
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

// журнал клиентских ошибок (plan/client-reports): необработанный reject в
// Worker не всплывает в worker.onerror главного потока — пересылаем сами.
// Отдельный тип сообщения: 'error' занят сбоем init и запускает откат эстафеты
self.addEventListener('unhandledrejection', event => {
  const reason = event.reason;

  self.postMessage({
    type: 'diagnostic',
    kind: 'rejection',
    message: reason && reason.message ? reason.message : String(reason),
    stack: reason && typeof reason.stack === 'string' ? reason.stack : null,
  });
});

self.onmessage = async event => {
  const msg = event.data;

  switch (msg.type) {
    case 'init':
      try {
        await onInit(msg.room, msg.handoff, msg.checkpoint, msg.seqFloor);
      } catch (e) {
        // сбой загрузки WASM/конфига/handoff-меты — сообщить главному
        // потоку, не виснуть (при эстафете тот возобновит старый Worker)
        self.postMessage({
          type: 'error',
          message: e && e.message ? e.message : String(e),
          // стек Worker'а — для журнала клиентских ошибок: в главном потоке его
          // уже не восстановить
          stack: e && typeof e.stack === 'string' ? e.stack : null,
        });
      }
      break;

    // прогрев Worker'а преемника (host-migration этап 6): плагин и wasm
    // готовы, матча нет — его поднимет init с контрольной точкой (этап 7)
    case 'preload':
      try {
        const { wasmCompiled } = await preloadHostRuntime(msg.room);

        self.postMessage({
          type: 'preloaded',
          gameId: msg.room?.game?.id ?? null,
          gameVersion: msg.room?.game?.version ?? null,
          wasmCompiled,
        });
      } catch (e) {
        self.postMessage({
          type: 'error',
          message: e && e.message ? e.message : String(e),
          stack: e && typeof e.stack === 'string' ? e.stack : null,
        });
      }
      break;

    case 'connect':
      onConnect(msg.socketId, msg.resume === true);
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

    // мастер подтвердил регистрацию комнаты — roomId+секрет эпохи нужны
    // PlayerDataSync для атрибуции последующих rank/state-flush
    case 'set_room':
      host?.setRoom({
        roomId: msg.roomId,
        roomSecret: msg.roomSecret,
        epoch: msg.epoch,
      });
      break;

    // имя того же сообщения у главного потока до host-migration этапа 2:
    // страница, загруженная до деплоя, поднимает Worker по свежему манифесту
    case 'set_host_id':
      host?.setRoom({ roomId: msg.hostId, roomSecret: msg.hostSecret });
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

    // контрольные точки (host-migration этап 5)

    // периодические точки: снимаются на границе кадра не чаще intervalMs
    case 'checkpoint_start':
      host?.startCheckpoints(msg.intervalMs);
      break;

    case 'checkpoint_stop':
      host?.stopCheckpoints();
      break;

    // одна точка на ближайшей границе кадра (final — финальная перед
    // плановой передачей)
    case 'checkpoint_request':
      host?.requestCheckpoint({ final: msg.final === true });
      break;

    // матч поднят из точки: запустить цикл и таймеры. waitForResume —
    // промоушен преемника (этап 7.4): старт, когда вернулись все люди точки
    // или истёк resumeWaitMs; не вернувшимся — ожидание resumeGraceMs.
    // reason (этап 9) — причина передачи для сообщения игрокам; старый
    // главный поток её не шлёт
    case 'start_after_restore':
      if (msg.waitForResume === true) {
        host?.startAfterResume(ids => portMachine?.startGraceFor(ids), {
          reason: typeof msg.reason === 'string' ? msg.reason : null,
        });
      } else {
        host?.startAfterRestore();
      }
      break;

    // плановая передача хоста (этап 8d): дождаться границы раунда (у игры
    // с migration.midRound — ответ сразу)
    case 'round_boundary_wait':
      host?.awaitRoundBoundary(() =>
        self.postMessage({ type: 'round_boundary' }),
      );
      break;

    case 'round_boundary_cancel':
      host?.cancelRoundBoundary();
      break;

    case 'freeze':
      host?.freeze();
      break;

    case 'unfreeze':
      host?.unfreeze();
      break;
  }
};
