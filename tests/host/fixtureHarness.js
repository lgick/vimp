import { vi } from 'vitest';

// Каркас движковых тестов host-фасада поверх фикстурной миниигры
// (Этап 7 плана отделения движка, PLAN.md: «Тесты движковой меты/HostGame
// переводятся на фикстуру») — доказывает, что HostGame и мета не
// завязаны на @vimp/tanks: fake-core (JS, без WASM), поэтому не требует
// собранного Rust-ядра игры и запускается всегда (engine-node, без гейта).
//
// Онбординг/тики/нажатия клавиш ниже — самостоятельная копия аналогичных
// хелперов из интеграционного харнесса игры (vimp-tanks, tests/host/harness.js,
// A3.5 плана отделения движка): они не завязаны на конкретное ядро, поэтому
// продублированы здесь, а не импортированы — этот файл больше не может
// зависеть от репозитория игры. FakeSocketManager здесь без lastShot/
// lastFrame (декодирование бинарного кадра требует реального WASM-ядра
// игры) — фикстурные тесты читают исходящие кадры через framesOf().

// Перечень всех отправителей SocketManager, которые дёргает host-фасад.
const SENDER_METHODS = [
  'sendConfig',
  'sendAuthData',
  'sendAuthResult',
  'sendPing',
  'sendClear',
  'sendTechInform',
  'sendMap',
  'sendFirstShot',
  'sendFirstVote',
  'sendShot',
  'sendPanel',
  'sendStat',
  'sendChat',
  'sendVote',
  'sendKeySet',
  'sendPlayerDefaultShot',
  'sendSpectatorDefaultShot',
  'sendGameInform',
  'sendRoundEnd',
  'sendSoundCue',
  'sendName',
];

// Фейковый SocketManager: вместо отправки в сеть пишет все исходящие кадры.
export class FakeSocketManager {
  constructor() {
    this.frames = []; // [{ method, socketId, args }]
    this._game = null;
    this._panel = null;
    this._stat = null;

    for (const method of SENDER_METHODS) {
      this[method] = (socketId, ...args) => {
        this.frames.push({ method, socketId, args });
      };
    }
  }

  injectServices(game, panel, stat) {
    this._game = game;
    this._panel = panel;
    this._stat = stat;
  }

  addUser() {}
  removeUser() {}

  close(socketId, code, key, arr) {
    this.frames.push({ method: 'close', socketId, args: [code, key, arr] });
  }

  // все кадры указанного метода
  framesOf(method) {
    return this.frames.filter(f => f.method === method);
  }

  clear() {
    this.frames.length = 0;
  }
}

// Ждёт микрозадачу (HostGame.createUser отвечает через queueMicrotask;
// fake timers её не подделывают).
export const flushMicro = () =>
  new Promise(resolve => queueMicrotask(resolve));

// Полный онбординг игрока до isReady=true. Возвращает gameId.
export const connectPlayer = async (
  host,
  { name = 'P1', model = 'm1', socketId = 's1' } = {},
) => {
  let gameId;

  host.createUser({ name, model }, socketId, id => {
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

// Загружает конфиг фикстуры в свежий синглтон config (зеркало loadConfig
// из ./harness.js, но с миниигрой вместо @vimp/tanks).
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
  const socket = new FakeSocketManager();
  const gameConfig = { ...config.get('game'), ...game };
  const host = new HostGame(gameConfig, socket, core, hostPlugin, opts);

  return { host, socket, core, config, hostPlugin };
};
