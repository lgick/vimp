import { vi } from 'vitest';
import RecordingSocketManager from '../../packages/engine/src/devtools/RecordingSocketManager.js';
import { offlinePlayerData } from '../../packages/engine/src/lib/offlinePlayerData.js';

// Каркас движковых тестов host-фасада поверх фикстурной миниигры
// (Этап 7 плана отделения движка, PLAN.md: «Тесты движковой меты/HostGame
// переводятся на фикстуру») — доказывает, что HostGame и мета не
// завязаны на @vimp-games/tanks: fake-core (JS, без WASM), поэтому не требует
// собранного Rust-ядра игры и запускается всегда (engine-node, без гейта).
//
// Онбординг/тики/нажатия клавиш ниже — самостоятельная копия аналогичных
// хелперов из интеграционного харнесса игры (vimp-tanks, tests/host/harness.js,
// A3.5 плана отделения движка): они не завязаны на конкретное ядро, поэтому
// продублированы здесь, а не импортированы — этот файл больше не может
// зависеть от репозитория игры. Запись исходящих кадров переехала в
// devtools/RecordingSocketManager.js (её же использует headless-runner) —
// фикстурные тесты читают кадры через framesOf().

export { RecordingSocketManager as FakeSocketManager };

// Ждёт микрозадачу (HostGame.createUser отвечает через queueMicrotask;
// fake timers её не подделывают).
export const flushMicro = () =>
  new Promise(resolve => queueMicrotask(resolve));

// Полный онбординг игрока до isReady=true. Возвращает gameId.
export const connectPlayer = async (
  host,
  { name = 'P1', model = 'm1', socketId = 's1', token = 'tok' } = {},
) => {
  let gameId;

  // токен доезжает до участника так же, как в проде: PortMachine передаёт в
  // createUser всё тело авторизации плюс проверенный ник. Он не декорация —
  // по нему PlayerDataSync ходит на мастер, а Accolades отличает игрока с
  // проверенной личностью от гостя
  host.createUser({ name, model, token }, socketId, id => {
    gameId = id;
  });

  await flushMicro();

  host.sendMap(gameId);
  host.mapReady(gameId);
  host.firstShotReady(gameId);

  return gameId;
};

// Игрок выбирает команду (становится активным).
export const joinTeam = (host, gameId, team = 'team1') => {
  host.parseVote(gameId, ['teamChange', team]);
};

// Прогоняет n тиков игрового цикла с фиксированным dt.
export const tick = (host, n = 1, dt = 1 / 120) => {
  for (let i = 0; i < n; i += 1) {
    host._onShotTick(dt);
  }
};

// Нажатие/отпускание клавиши игрока (формат wire: 'seq:down:forward').
let inputSeq = 0;

export const pressKey = (host, gameId, name, action = 'down') => {
  inputSeq += 1;
  host.updateKeys(gameId, `${inputSeq}:${action}:${name}`);
};

// Ввод указателем (формат wire: 'seq:aim:x:y:flags').
export const sendAim = (host, gameId, x, y, flags = 1) => {
  inputSeq += 1;
  host.updateKeys(gameId, `${inputSeq}:aim:${x}:${y}:${flags}`);
};

// Загружает конфиг фикстуры в свежий синглтон config (зеркало loadConfig
// из ./harness.js, но с миниигрой вместо @vimp-games/tanks).
export const loadFixtureConfig = async () => {
  const config = (await import('../../packages/engine/src/lib/config.js'))
    .default;

  config.set(
    'auth',
    (await import('../../packages/engine/tests/fixtures/miniGame/config/auth.js'))
      .default,
  );
  config.set(
    'wsports',
    (await import('../../packages/engine/src/config/wsports.js')).default,
  );

  const hostDefaults = (
    await import('../../packages/engine/src/config/hostDefaults.js')
  ).default;
  const miniGameConfig = (
    await import('../../packages/engine/tests/fixtures/miniGame/config/game.js')
  ).default;

  config.set('game', { ...hostDefaults, ...miniGameConfig });
  config.set('game:isDevMode', true);
  config.set('game:timers:networkSendRate', 1);

  return config;
};

// Создаёт свежий HostGame поверх fake-core миниигры-фикстуры и реальных
// (движковых) мета-модулей.
export const createFixtureHost = async ({ seed = 42, game = {}, opts = {} } = {}) => {
  vi.useFakeTimers();

  const config = await loadFixtureConfig();
  const HostGame = (await import('../../packages/engine/src/host/HostGame.js'))
    .default;
  const hostPlugin = (
    await import('../../packages/engine/tests/fixtures/miniGame/host/index.js')
  ).default;
  const core = await hostPlugin.createCore(JSON.stringify({ seed }));
  const socket = new RecordingSocketManager();
  const gameConfig = { ...config.get('game'), ...game };
  // мастера в тестах нет: без заглушки PlayerDataSync и Accolades уходят в
  // настоящий fetch по относительному URL и логируют отказ уже ПОСЛЕ конца
  // файла — vitest ловит это как unhandled EnvironmentTeardownError
  const host = new HostGame(gameConfig, socket, core, hostPlugin, {
    playerDataFetch: offlinePlayerData(),
    ...opts,
  });

  return { host, socket, core, config, hostPlugin };
};
