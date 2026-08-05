import { createHostRuntime } from '../lib/createHostRuntime.js';
import VirtualClock, { flushMicrotasks } from './VirtualClock.js';
import RecordingSocketManager from './RecordingSocketManager.js';
import VirtualClient from './VirtualClient.js';
import { loadGameForSim } from './pluginLoader.js';
import { resetHostSingletons } from './resetHostSingletons.js';
import { checkInvariants, summarize } from './invariants.js';
import { inspectCore, inspectHost } from './inspectHost.js';

// Прогон сценария целиком в одном Node-процессе: авторитетный хост
// (боевая инициализация из lib/createHostRuntime.js) + по настоящему
// клиентскому ядру на каждого участника, связанные записывающим транспортом.
// Время — виртуальное, поэтому десятиминутный матч занимает секунды, а два
// прогона одного сценария обязаны совпасть.

// Не-кадровые порты, которые VirtualClient складывает в received —
// имя метода SocketManager → имя корзины.
const RECORDED_PORTS = {
  sendPanel: 'panel',
  sendStat: 'stat',
  sendChat: 'chat',
  sendVote: 'vote',
  sendKeySet: 'keySet',
  sendGameInform: 'gameInform',
  sendSoundCue: 'soundCue',
  sendRoundEnd: 'roundEnd',
  sendTechInform: 'techInform',
};

// В headless-контуре нет ни мастера, ни auth-сервиса — участник стартует с
// пустым профилем. Это не заглушка ради тишины: пустой профиль и есть
// корректное состояние прогона, а настоящий fetch по относительному URL в
// Node просто не разрешается.
const emptyProfileFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ rank: 0, state: null }),
});

/**
 * Приводит сценарий к полной форме и проверяет обязательные поля.
 * @param {Object} raw - Разобранный JSON сценария.
 * @returns {Object} Нормализованный сценарий.
 */
export function parseScenario(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('scenario: expected an object');
  }

  if (raw.version !== 1) {
    throw new Error(`scenario: unsupported version ${raw.version} (expected 1)`);
  }

  if (!Array.isArray(raw.participants) || !raw.participants.length) {
    throw new Error('scenario: participants must be a non-empty array');
  }

  const timeline = [...(raw.timeline ?? [])].sort(
    (a, b) => (a.tick ?? 0) - (b.tick ?? 0),
  );

  return {
    version: 1,
    seed: raw.seed ?? 1,
    game: raw.game ?? null,
    map: raw.map ?? null,
    config: raw.config ?? {},
    participants: raw.participants,
    timeline,
    // ключи схемы, которых в этом сценарии заведомо не будет (инвариант 2):
    // «сущность не спавнится» отличается от «сценарий её не трогает» только
    // этим объявлением
    unusedSnapshotKeys: raw.unusedSnapshotKeys ?? [],
    // пороги детектора рассинхрона предикта (инвариант 9); {} — дефолты
    // ядра, null — детектор выключен
    divergence: raw.divergence === null ? null : (raw.divergence ?? {}),
    ticks: raw.ticks ?? 600,
    dumpTicks: raw.dumpTicks ?? null,
    room: raw.room ?? {},
  };
}

/**
 * Прогоняет сценарий и возвращает отчёт.
 * @param {Object} rawScenario
 * @param {Object} [options]
 * @param {Object} [options.plugin] - Результат loadGameForSim (если игра уже
 *   загружена — например, при двух прогонах подряд для самопроверки
 *   детерминизма).
 * @param {string} [options.gamePath] - Путь к пакету игры/манифесту.
 * @param {string} [options.corePath] - Путь к node-сборке ядра.
 * @param {boolean} [options.captureFrames] - Считать хеши потока кадров
 *   (нужны только самопроверке детерминизма — на длинном матче это лишние
 *   мегабайты в отчёте).
 * @returns {Promise<Object>} Отчёт прогона.
 */
export async function runScenario(rawScenario, options = {}) {
  const scenario = parseScenario(rawScenario);
  const plugin =
    options.plugin ??
    (await loadGameForSim({ game: options.gamePath, core: options.corePath }));

  // каждый прогон — свой матч: мета-модули хоста синглтонны, и без сброса
  // второй прогон унаследовал бы таймеры первого
  resetHostSingletons();

  const virtualClock = new VirtualClock({ seed: scenario.seed });
  const restoreClock = virtualClock.install();

  try {
    return await execute(scenario, plugin, virtualClock, {
      captureFrames: options.captureFrames === true,
    });
  } finally {
    restoreClock();
  }
}

async function execute(scenario, plugin, virtualClock, { captureFrames }) {
  const clients = new Map(); // socketId → VirtualClient
  const byParticipant = new Map(); // id сценария → { socketId, gameId }
  const participantLog = []; // [{ who, socketId, gameId, joinTick, leaveTick }]
  const mapChanges = [];
  const inputSeq = new Map();

  let currentTick = 0;

  // ping/pong: без ответа хост честно кикает участника по таймауту RTT, и
  // длинный сценарий тихо теряет игроков посреди прогона. Объявлено до
  // транспорта — замыкание onFrame читает эту переменную.
  let host = null;
  let socketManager = null;

  const room = {
    ...scenario.room,
    seed: scenario.seed,
    map: scenario.map ?? undefined,
    // wasmUrl — node-сборка ядра: createHostRuntime отдаёт его плагину
    // тем же полем, что и Worker в браузере (у фикстуры его нет — её
    // ядра обычный JS)
    game: {
      version: scenario.game?.version ?? null,
      wasmUrl: plugin.wasmUrl,
    },
  };

  const runtime = await createHostRuntime(room, {
    loadHostPlugin: () => plugin.hostPlugin,
    // транспорт собирается той же фабрикой, что и боевой: наследник обязан
    // получить те же порты и ту же игровую параметризацию
    createSocketManager: (ports, gameOpts) => {
      socketManager = new RecordingSocketManager(ports, gameOpts, {
        onFrame: frame => routeFrame(frame, clients, virtualClock, host),
      });

      return socketManager;
    },
    overrideGameConfig: game => mergeConfig(game, scenario.config),
    hostOptions: {
      onMapChange: mapName =>
        mapChanges.push({ tick: currentTick, map: mapName }),
      playerDataFetch: emptyProfileFetch,
    },
  });

  const { clientCfg, game, seed } = runtime;
  const stepMs = game.timers.timeStep;

  host = runtime.host;

  // очередь операций сценария, разложенная по номеру тика: ввод хост
  // применяет синхронно при приходе сообщения (HostGame.updateKeys), очереди
  // у него нет — значит сценарий обязан задавать именно границу тика
  const opsByTick = new Map();

  for (const op of scenario.timeline) {
    const tick = op.tick ?? 0;

    if (!opsByTick.has(tick)) {
      opsByTick.set(tick, []);
    }

    opsByTick.get(tick).push(op);
  }

  const dumpTicks = new Set(scenario.dumpTicks ?? [scenario.ticks]);
  const scenes = [];

  for (let tick = 0; tick <= scenario.ticks; tick += 1) {
    currentTick = tick;
    socketManager.tick = tick;

    for (const op of opsByTick.get(tick) ?? []) {
      await applyOp(op, {
        host,
        clientCfg,
        plugin,
        clients,
        byParticipant,
        participantLog,
        inputSeq,
        scenario,
        virtualClock,
        tick,
      });
    }

    if (tick > 0) {
      await virtualClock.advance(stepMs);
    }

    for (const client of clients.values()) {
      client.render(virtualClock.monotonic());
    }

    if (dumpTicks.has(tick)) {
      scenes.push({
        tick,
        // дамп мира ядра рядом со сценой клиентов: расхождение «в ядре тело
        // есть, на холсте пусто» видно только при обеих половинах в одном
        // файле (этап 4)
        core: inspectCore(host),
        clients: [...clients.values()].map(client => client.snapshot()),
      });
    }
  }

  return buildReport({
    scenario,
    plugin,
    seed,
    stepMs,
    host,
    core: runtime.core,
    game,
    clientCfg,
    clients,
    socketManager,
    scenes,
    mapChanges,
    byParticipant,
    participantLog,
    captureFrames,
  });
}

// исходящий кадр хоста → клиент-получатель. sendShot несёт байты, которые в
// проде ушли бы в data channel — их и скармливаем клиентскому ядру
function routeFrame(frame, clients, virtualClock, host) {
  const client = clients.get(frame.socketId);

  if (!client) {
    return;
  }

  // pong отвечается мгновенно: латентность headless-прогона равна нулю, и
  // это единственная честная её модель
  if (frame.method === 'sendPing') {
    host?.updateRTT(client.gameId, frame.args[0]);
    return;
  }

  if (frame.method === 'sendShot') {
    client.pushFrame(frame.args[0], virtualClock.monotonic());
    return;
  }

  // первый снапшот мира: в браузере он применяется сразу (applyShot), а не
  // едет через буфер интерполяции — сущность, доехавшая только им, иначе не
  // попадёт ни в сцену, ни в проверки
  if (frame.method === 'sendFirstShot') {
    client.applyFirstShot(frame.sent[0]?.data);
    return;
  }

  // CLEAR приходит на каждый рестарт раунда и на смену карты; без него
  // headless живёт через границу раунда в состоянии, которого в игре нет
  if (frame.method === 'sendClear') {
    client.clear(frame.args[0]);
    return;
  }

  if (frame.method === 'sendMap') {
    client.setMap(frame.args[0]);
    return;
  }

  const bucket = RECORDED_PORTS[frame.method];

  if (bucket) {
    client.record(bucket, frame.args[0]);
  }
}

async function applyOp(op, ctx) {
  const {
    host,
    clients,
    byParticipant,
    participantLog,
    inputSeq,
    virtualClock,
    tick,
  } = ctx;

  switch (op.op) {
    case 'join':
      await joinParticipant(op, ctx);
      break;

    case 'leave': {
      const entry = byParticipant.get(op.who);

      if (entry) {
        host.removeUser(entry.gameId);

        // ядро клиента живёт в WASM-памяти: без free многочасовой реплей с
        // текучкой участников растит процесс
        clients.get(entry.socketId)?.destroy();
        clients.delete(entry.socketId);
        byParticipant.delete(op.who);

        const logged = participantLog.find(
          item => item.who === op.who && item.leaveTick === null,
        );

        if (logged) {
          logged.leaveTick = tick;
        }
      }

      break;
    }

    case 'key': {
      const entry = requireEntry(byParticipant, op.who);
      const seq = (inputSeq.get(op.who) ?? 0) + 1;

      inputSeq.set(op.who, seq);
      host.updateKeys(entry.gameId, `${seq}:${op.action}:${op.name}`);

      // клиент предсказывает тот же ввод — иначе дрейф предикта не с чем
      // сравнивать (этап 5)
      clients
        .get(entry.socketId)
        ?.core.apply_input(op.action, op.name, virtualClock.monotonic());

      break;
    }

    case 'chat':
      host.pushMessage(requireEntry(byParticipant, op.who).gameId, op.text);
      break;

    case 'vote':
      host.parseVote(requireEntry(byParticipant, op.who).gameId, op.data);
      break;

    default:
      throw new Error(`scenario: unknown op '${op.op}'`);
  }

  await flushMicrotasks();
}

async function joinParticipant(op, ctx) {
  const {
    host,
    clientCfg,
    plugin,
    clients,
    byParticipant,
    participantLog,
    scenario,
    tick,
  } = ctx;
  const participant = scenario.participants.find(p => p.id === op.who);

  if (!participant) {
    throw new Error(`scenario: join references unknown participant '${op.who}'`);
  }

  const socketId = participant.socketId ?? `sock-${participant.id}`;
  let gameId;

  host.createUser(
    { name: participant.name, model: participant.model },
    socketId,
    id => {
      gameId = id;
    },
  );

  await flushMicrotasks();

  if (gameId === undefined) {
    throw new Error(`scenario: host refused participant '${op.who}'`);
  }

  // клиент создаётся ДО онбординга: в браузере вкладка существует раньше
  // карты, и MAP_DATA/keySet/панель должны дойти до ядра
  const client = await VirtualClient.create({
    clientPlugin: plugin.clientPlugin,
    clientConfig: clientCfg,
    wasmUrl: plugin.wasmUrl,
    socketId,
    gameId,
    auth: { name: participant.name, model: participant.model },
    divergence: scenario.divergence ?? undefined,
  });

  clients.set(socketId, client);

  // онбординг клиента: карта → готовность → первый кадр (порт-машина
  // Worker'а в headless-контуре не участвует)
  host.sendMap(gameId);
  host.mapReady(gameId);
  host.firstShotReady(gameId);
  byParticipant.set(op.who, { socketId, gameId });
  participantLog.push({
    who: op.who,
    socketId,
    gameId,
    joinTick: tick,
    leaveTick: null,
  });

  if (op.team) {
    host.parseVote(gameId, ['teamChange', op.team]);
  }
}

function requireEntry(byParticipant, who) {
  const entry = byParticipant.get(who);

  if (!entry) {
    throw new Error(`scenario: participant '${who}' has not joined yet`);
  }

  return entry;
}

// точечное переопределение конфига игры сценарием. Таймеры — только через
// config.timers: неявный роутинг одноимённого ключа верхнего уровня в
// game.timers молча правил не то, что просил сценарий.
function mergeConfig(game, overrides) {
  const { timers = {}, ...rest } = overrides;

  Object.assign(game.timers, timers);

  for (const [key, value] of Object.entries(rest)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      game[key] = { ...game[key], ...value };
    } else {
      game[key] = value;
    }
  }
}

function buildReport(ctx) {
  const {
    scenario,
    plugin,
    seed,
    stepMs,
    host,
    core,
    game,
    clientCfg,
    clients,
    socketManager,
    scenes,
    mapChanges,
    byParticipant,
    participantLog,
    captureFrames,
  } = ctx;

  const frameCounts = {};

  for (const frame of socketManager.frames) {
    frameCounts[frame.method] = (frameCounts[frame.method] ?? 0) + 1;
  }

  const clientList = [...clients.values()];

  // проверки идут по живым объектам прогона (сцена, реестр хоста, ядро), а
  // не по сериализованному отчёту: половина инвариантов смотрит туда, чего
  // в JSON нет вовсе
  const invariants = checkInvariants({
    scenario,
    game,
    clientConfig: clientCfg,
    clients: clientList,
    socketManager,
    core,
    hostState: inspectHost(host),
    participantLog,
    stepMs,
  });

  return {
    scenario: {
      seed: scenario.seed,
      ticks: scenario.ticks,
      map: scenario.map,
      participants: scenario.participants.length,
      timeline: scenario.timeline.length,
    },
    game: { id: plugin.id, source: plugin.source },
    seed,
    stepMs,
    durationMs: stepMs * scenario.ticks,
    currentMap: host.currentMap,
    mapChanges,
    participants: [...byParticipant.entries()].map(([id, entry]) => ({
      id,
      ...entry,
    })),
    participantLog,
    invariants,
    invariantSummary: summarize(invariants),
    frameCounts,
    clients: clientList.map(client => ({
      ...client.snapshot(),
      received: Object.fromEntries(
        Object.entries(client.received).map(([kind, list]) => [
          kind,
          list.length,
        ]),
      ),
      decodeErrors: client.decodeErrors,
      // дрейф предикта: агрегаты за прогон + сами записи (этап 5)
      divergence: client.divergenceStats && {
        ...client.divergenceStats,
        records: client.divergence,
        truncated: client.truncated.divergence,
      },
      // сколько строк на ключ схемы доехало за весь прогон, а не к финалу:
      // сущность могла появиться и исчезнуть между дампами
      observedRows: Object.fromEntries(
        Object.entries(client.observed).map(([key, stats]) => [
          key,
          stats.rows,
        ]),
      ),
    })),
    scenes,
    // поток кадров нужен ровно одному потребителю — самопроверке
    // детерминизма (этап 3). Хеша на кадр для сравнения потоков достаточно,
    // а сами байты линейно от длины матча раздували report.json
    shotHashes: captureFrames
      ? socketManager
          .framesOf('sendShot')
          .map(frame => hash32(toBytes(frame.args[0])))
      : null,
    snapshotSchema: game.snapshot,
  };
}

function toBytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  return new Uint8Array(value);
}

// FNV-1a: сравниваются потоки одного и того же прогона, криптостойкость не
// нужна — нужна дешевизна и отсутствие зависимостей
function hash32(bytes) {
  let hash = 0x811c9dc5;

  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}
