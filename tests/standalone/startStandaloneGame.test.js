import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startStandaloneGame } from '../../packages/engine/src/standalone/index.js';
import { resetBootConfig } from '../../packages/engine/src/client/boot.js';
import { resetHostSingletons } from '../../packages/engine/src/devtools/resetHostSingletons.js';
import wsports from '../../packages/engine/src/config/wsports.js';
import hostPlugin from '../../packages/engine/tests/fixtures/miniGame/host/index.js';
import clientPlugin from '../../packages/engine/tests/fixtures/miniGame/client/index.js';

// Standalone SDK (Этап 3 плана standalone-sdk).
//
// Настоящий src/client/main.js в happy-dom не поднять: он безусловно создаёт
// PixiJS-приложения (Application.init требует WebGL-контекста), а произошло бы
// это внутри обработчика CONFIG_DATA — то есть хендшейк встал бы на первом же
// шаге. Поэтому клиент движка заменён минимальной заглушкой, которая читает
// ровно тот boot-конфиг, который собрал SDK, и ведёт по нему хендшейк через
// InlineHostBridge. Проверяется именно связка «SDK → boot-конфиг → живой
// матч»; сам main.js покрыт тестами Этапа 2.
const MAIN_PATH = '../../packages/engine/src/client/main.js';

const PS = wsports.server;
const PC = wsports.client;

// путь задан литералом: vi.mock поднимается наверх файла, до констант
vi.mock('../../packages/engine/src/client/main.js', async () => {
  const [
    { getBootConfig },
    { default: InlineHostBridge },
    { default: LoopbackTransport },
    { default: createAutostart },
  ] = await Promise.all([
    import('../../packages/engine/src/client/boot.js'),
    import('../../packages/engine/src/client/network/InlineHostBridge.js'),
    import('../../packages/engine/src/client/network/LoopbackTransport.js'),
    import('../../packages/engine/src/client/lib/autostart.js'),
  ]);

  const boot = getBootConfig();

  const bridge = new InlineHostBridge(
    {
      name: 'solo',
      ...boot.room,
      hostSocketId: 'local',
      game: {
        id: boot.manifest.id,
        version: boot.manifest.version,
        wasmUrl: boot.manifest.entries.wasm,
      },
    },
    { hostPlugin: boot.hostPlugin },
  );

  await bridge.ready;

  const received = [];
  const transport = new LoopbackTransport(bridge, 'local');
  const send = (port, data = null) =>
    transport.send(JSON.stringify([port, data]));

  // renderTick'а у заглушки нет — автостарт исполняется немедленно; порядок
  // «голоса → команды» обеспечивает сам createAutostart
  const runAutostart = createAutostart({
    votes: boot.startupVotes,
    commands: boot.startupCommands,
    sendVote: data => send(PC.VOTE_DATA, data),
    sendCommand: message => send(PC.CHAT_DATA, message),
    schedule: fn => fn(),
  });

  transport.publisher.on('message', payload => {
    // бинарные снапшоты заглушку не интересуют
    if (typeof payload !== 'string') {
      return;
    }

    const [port, data] = JSON.parse(payload);

    received.push([port, data]);

    if (port === PS.CONFIG_DATA) {
      send(PC.CONFIG_READY);
    } else if (port === PS.AUTH_DATA) {
      send(PC.AUTH_RESPONSE, boot.autoAuth);
    } else if (port === PS.AUTH_RESULT && !data) {
      // участник досоздаётся асинхронно (playerDataFetch), поэтому
      // MODULES_READY уходит следующим микротаском — у настоящего клиента
      // между ними стоит асинхронная инициализация модулей
      queueMicrotask(() => send(PC.MODULES_READY));
    } else if (port === PS.MAP_DATA) {
      send(PC.MAP_READY);
    } else if (port === PS.FIRST_SHOT_DATA) {
      send(PC.FIRST_SHOT_READY);
      runAutostart();
    }
  });

  transport.publisher.on('close', () => {});
  transport.connect();

  return {
    stopGame: () => transport.close(),
    // наружу для проверок теста: своего API у main.js нет
    __test: { bridge, received },
  };
});

// хендшейк идёт через микротаски (playerDataFetch участника)
const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise(resolve => queueMicrotask(resolve));
  }
};

const options = container => ({
  hostPlugin,
  clientPlugin,
  wasmUrl: 'about:blank',
  container,
  playerName: 'Guest',
  playerModel: 'm1',
  startupVotes: [['teamChange', 'team1']],
  startupCommands: ['/spawn 2'],
});

describe('startStandaloneGame', () => {
  let container;

  beforeEach(() => {
    resetHostSingletons();
    resetBootConfig();
    vi.useFakeTimers();

    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('доводит матч до первого кадра и исполняет автостарт', async () => {
    const game = await startStandaloneGame(options(container));
    const { __test } = await import(MAIN_PATH);
    const { bridge, received } = __test;

    await flush();

    const ports = received.map(([port]) => port);

    // каркас интерфейса собран в переданном контейнере, а не в body
    for (const id of ['panel', 'chat', 'cmd', 'stat', 'auth', 'auth-fields']) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }

    // хендшейк дошёл до первого кадра
    expect(ports).toContain(PS.CONFIG_DATA);
    expect(ports).toContain(PS.AUTH_RESULT);
    expect(ports).toContain(PS.MAP_DATA);
    expect(ports).toContain(PS.FIRST_SHOT_DATA);

    // участник создан гостевым входом (без формы, из playerName)
    const host = bridge._runtime.host;
    const humans = host._participants.getHumans();

    expect(humans).toHaveLength(1);
    expect(humans[0].name).toBe('Guest');

    // startupVotes вывели участника из наблюдателей — иначе игровая команда
    // спавна отбилась бы (см. autostart.js)
    expect(humans[0].teamId).not.toBe(host._spectatorId);

    // startupCommands доехали до HostGame.pushMessage: игровая команда
    // фикстуры ('/spawn 2') создала scripted-участников
    // (сколько именно их появится, решает игра и вместимость комнаты)
    expect(host._participants.getScripted().length).toBeGreaterThan(0);

    // stop() гасит матч: транспорт закрыт, соединений у хоста нет
    game.stop();

    expect(bridge._clients.size).toBe(0);

    await bridge.destroy();
  });

  it('требует плагины и wasmUrl', async () => {
    await expect(
      startStandaloneGame({ clientPlugin, wasmUrl: 'about:blank' }),
    ).rejects.toThrow('hostPlugin');

    await expect(
      startStandaloneGame({ hostPlugin, wasmUrl: 'about:blank' }),
    ).rejects.toThrow('clientPlugin');

    await expect(
      startStandaloneGame({ hostPlugin, clientPlugin }),
    ).rejects.toThrow('wasmUrl');
  });

  it('отбивает плагин, собранный под другую версию API движка', async () => {
    await expect(
      startStandaloneGame({
        ...options(container),
        hostPlugin: { ...hostPlugin, engineApi: hostPlugin.engineApi + 1 },
      }),
    ).rejects.toThrow('engine API');
  });
});
