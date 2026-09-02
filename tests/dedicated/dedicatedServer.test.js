import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import {
  parseGameRef,
  resolveLocalRef,
  startDedicatedServer,
} from '../../packages/engine/src/dedicated/main.js';
import engineConfig from '../../packages/engine/src/lib/config.js';
import { resetHostSingletons } from '../../packages/engine/src/devtools/resetHostSingletons.js';
import { ENGINE_API_VERSION } from '../../packages/engine/src/config/opcodes.js';
import wsports from '../../packages/engine/src/config/wsports.js';

// Dedicated-сервер (Этап 4 плана standalone-sdk): express + ws + матч в этом
// же процессе. Прогон идёт на фикстурной миниигре — её ядро обычный JS,
// поэтому node-сборка ядра (entries.wasmNode) не нужна и тест не зависит от
// собранного пакета игры.

const PS = wsports.server;
const PC = wsports.client;

const loadFixtureGame = async () => {
  const [hostPlugin, clientPlugin] = await Promise.all([
    import('../../packages/engine/tests/fixtures/miniGame/host/index.js').then(
      m => m.default,
    ),
    import('../../packages/engine/tests/fixtures/miniGame/client/index.js').then(
      m => m.default,
    ),
  ]);

  return {
    id: hostPlugin.id,
    manifest: {
      id: hostPlugin.id,
      engineApi: ENGINE_API_VERSION,
      version: '0.0.0-fixture',
      assetsBase: '/games/miniGame/',
      entries: {},
    },
    hostPlugin,
    clientPlugin,
    wasmUrl: undefined,
    distDir: null,
  };
};

// клиент хендшейка поверх настоящего WebSocket: проходит порты 0–4 и
// складывает всё принятое (кадры JSON отдельно от бинарных)
class TestClient {
  constructor(port, { name = 'Guest', model = 'm1' } = {}) {
    this.frames = [];
    this.binary = [];
    this.auth = { name, model };
    this.ws = new WebSocket(`ws://localhost:${port}/game`, {
      origin: `http://localhost:${port}`,
    });

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.binary.push(data);
        return;
      }

      const [port_, payload] = JSON.parse(data.toString());

      this.frames.push([port_, payload]);
      this._onFrame(port_, payload);
    });
  }

  _send(port, data = null) {
    this.ws.send(JSON.stringify([port, data]));
  }

  _onFrame(port, payload) {
    if (port === PS.CONFIG_DATA) {
      this._send(PC.CONFIG_READY);
    } else if (port === PS.AUTH_DATA) {
      this._send(PC.AUTH_RESPONSE, this.auth);
    } else if (port === PS.AUTH_RESULT && !payload) {
      this._send(PC.MODULES_READY);
    } else if (port === PS.MAP_DATA) {
      this._send(PC.MAP_READY);
    } else if (port === PS.FIRST_SHOT_DATA) {
      this._send(PC.FIRST_SHOT_READY);
    }
  }

  received(port) {
    return this.frames.find(frame => frame[0] === port);
  }

  close() {
    return new Promise(resolve => {
      this.ws.on('close', resolve);
      this.ws.close();
    });
  }
}

// опрос вместо фиксированной паузы: матч крутится реальными таймерами
const waitFor = async (check, timeout = 3000) => {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const value = check();

    if (value) {
      return value;
    }

    await new Promise(resolve => setTimeout(resolve, 10));
  }

  throw new Error('waitFor: timed out');
};

describe('parseGameRef', () => {
  it('разбирает id и пин версии', () => {
    expect(parseGameRef('tanks')).toEqual({ id: 'tanks', version: null });
    expect(parseGameRef('tanks@1.2.3')).toEqual({
      id: 'tanks',
      version: '1.2.3',
    });
    expect(parseGameRef('tanks@')).toEqual({ id: 'tanks', version: null });
    expect(parseGameRef('')).toEqual({ id: null, version: null });
    expect(parseGameRef(undefined)).toEqual({ id: null, version: null });
  });

  it('имя пакета не путается с пином: @ в начале — часть скоупа', () => {
    // SERVERS_MATRIX называет игру пакетом, и разбор обязан отличать скоуп
    // от версии — иначе '@vimp-games/tanks' распалось бы на пустой id
    expect(parseGameRef('@vimp-games/tanks')).toEqual({
      id: '@vimp-games/tanks',
      version: null,
    });
    expect(parseGameRef('@vimp-games/tanks@0.16.1')).toEqual({
      id: '@vimp-games/tanks',
      version: '0.16.1',
    });
  });
});

describe('resolveLocalRef', () => {
  const games = [
    { id: 'tanks', package: '@vimp-games/tanks' },
    { id: 'snakes', package: '@vimp-games/snakes' },
  ];

  let nodeModulesDir;

  beforeEach(() => {
    nodeModulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-ref-'));
  });

  afterEach(() => {
    fs.rmSync(nodeModulesDir, { recursive: true, force: true });
  });

  const installGame = (pkg, manifest) => {
    const distDir = path.join(nodeModulesDir, pkg, 'dist');

    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, 'manifest.json'),
      JSON.stringify(manifest),
    );
  };

  it('разрешает и id игры, и имя пакета из master:games', () => {
    expect(resolveLocalRef('tanks', { games, nodeModulesDir })).toEqual(games[0]);
    expect(
      resolveLocalRef('@vimp-games/snakes', { games, nodeModulesDir }),
    ).toEqual(games[1]);
  });

  it('id важнее пакета: `tanks` остаётся игрой tanks', () => {
    // безскоупный пакет с именем чужой игры не должен перехватывать ссылку
    const shadowed = [
      { id: 'snakes', package: 'tanks' },
      { id: 'tanks', package: '@vimp-games/tanks' },
    ];

    expect(resolveLocalRef('tanks', { games: shadowed, nodeModulesDir })).toEqual(
      shadowed[1],
    );
  });

  it('пакета нет в master:games — id читается из его манифеста', () => {
    // путь прода: обнаружение туда не ходит, master:games пуст, а пакет в
    // node_modules лежит. Работает и со сторонним скоупом
    installGame('@acme/arena-game', { id: 'arena' });

    expect(resolveLocalRef('@acme/arena-game', { games: [], nodeModulesDir })).toEqual(
      { id: 'arena', package: '@acme/arena-game' },
    );
  });

  it('безскоупное имя пакета тоже читается с диска', () => {
    // 'vimp-tanks' по виду неотличим от id игры, и отсекать его по форме
    // значило бы объявить установленный и собранный пакет ненайденным
    installGame('vimp-tanks', { id: 'tanks' });

    expect(resolveLocalRef('vimp-tanks', { games: [], nodeModulesDir })).toEqual({
      id: 'tanks',
      package: 'vimp-tanks',
    });
  });

  it('неизвестная ссылка и несобранный пакет — null', () => {
    expect(resolveLocalRef('@acme/missing', { games, nodeModulesDir })).toBeNull();
    expect(resolveLocalRef('pong', { games, nodeModulesDir })).toBeNull();
    expect(resolveLocalRef('', { games, nodeModulesDir })).toBeNull();
    expect(resolveLocalRef(null, { games, nodeModulesDir })).toBeNull();
  });

  it('без nodeModulesDir отдаёт null, а не бросает', () => {
    // функция экспортирована, и её контракт — «запись либо null»: путь до
    // node_modules нужен только последнему шагу, и его отсутствие не должно
    // превращаться в TypeError из path.join
    expect(resolveLocalRef('@acme/game')).toBeNull();
    expect(resolveLocalRef('tanks', { games })).toEqual(games[0]);
  });
});

describe('dedicated-сервер', () => {
  let server;

  beforeEach(() => {
    // мета-модули хоста — синглтоны на модуль: без сброса второй матч в том
    // же процессе получил бы таймеры первого
    resetHostSingletons();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  const start = async () => {
    server = await startDedicatedServer({
      port: 0,
      loadGame: loadFixtureGame,
      serveClient: false,
    });

    return server;
  };

  it('GET /config объявляет режим и игру', async () => {
    const { port } = await start();
    const res = await fetch(`http://localhost:${port}/config`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      mode: 'dedicated',
      gameId: 'miniGame',
      gameVersion: '0.0.0-fixture',
      wsPath: '/game',
    });
  });

  it('манифест игры отдаётся теми же URL-ами, что у мастера', async () => {
    const { port } = await start();
    const list = await (
      await fetch(`http://localhost:${port}/games/manifest.json`)
    ).json();

    expect(list.map(manifest => manifest.id)).toEqual(['miniGame']);

    const single = await (
      await fetch(`http://localhost:${port}/games/miniGame/manifest.json`)
    ).json();

    expect(single.version).toBe('0.0.0-fixture');

    const unknown = await fetch(
      `http://localhost:${port}/games/other/manifest.json`,
    );

    expect(unknown.status).toBe(404);
  });

  it('клиент проходит хендшейк по прямому WebSocket и получает кадры', async () => {
    const { port } = await start();
    const client = new TestClient(port);

    await waitFor(() => client.received(PS.FIRST_SHOT_DATA));

    // порядок хендшейка: конфиг → форма → результат → карта → первый кадр
    expect(client.frames.slice(0, 3).map(frame => frame[0])).toEqual([
      PS.CONFIG_DATA,
      PS.AUTH_DATA,
      PS.TECH_INFORM_DATA,
    ]);
    // ошибок формы нет: undefined уезжает по проводу как null
    expect(client.received(PS.AUTH_RESULT)[1]).toBeNull();
    expect(client.received(PS.MAP_DATA)).toBeDefined();

    // бинарный SHOT_DATA — доказательство, что симуляция реально тикает
    await waitFor(() => client.binary.length > 0);

    await client.close();
  });

  it('отключение клиента не останавливает симуляцию', async () => {
    const { port } = await start();
    const first = new TestClient(port, { name: 'First' });

    await waitFor(() => first.binary.length > 0);
    await first.close();

    // участник снят с матча, но комната жива: второй клиент входит и
    // получает кадры (в P2P-контуре уход хостера убил бы комнату)
    const second = new TestClient(port, { name: 'Second' });

    await waitFor(() => second.received(PS.FIRST_SHOT_DATA));
    await waitFor(() => second.binary.length > 0);

    expect(server.runtime.host.currentMap).toBeTruthy();

    await second.close();
  });

  it('грубый обрыв соединения не роняет сервер', async () => {
    const { port } = await start();
    const first = new TestClient(port, { name: 'First' });

    await waitFor(() => first.received(PS.FIRST_SHOT_DATA));

    // битый кадр в сыром сокете: ws эмитит 'error' на серверном соединении, и
    // без слушателя это uncaughtException — один сорванный клиент убил бы
    // матч всех остальных
    first.ws._socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    await new Promise(resolve => setTimeout(resolve, 50));

    const res = await fetch(`http://localhost:${port}/config`);

    expect(res.status).toBe(200);

    // сервер продолжает обслуживать: второй клиент проходит хендшейк
    const second = new TestClient(port, { name: 'Second' });

    await waitFor(() => second.received(PS.FIRST_SHOT_DATA));
    await second.close();
  });

  it('длинный Origin закрывает только своё соединение, сервер жив', async () => {
    const { port } = await start();
    // причина close ограничена 123 байтами: полный текст ошибки с origin
    // бросил бы RangeError внутри ws и убил процесс
    const ws = new WebSocket(`ws://localhost:${port}/game`, {
      origin: `http://${'a'.repeat(200)}.test`,
    });

    await new Promise(resolve => {
      ws.on('close', resolve);
      ws.on('error', resolve);
    });

    const res = await fetch(`http://localhost:${port}/config`);

    expect(res.status).toBe(200);

    const client = new TestClient(port);

    await waitFor(() => client.received(PS.FIRST_SHOT_DATA));
    await client.close();
  });

  it('кадр сверх maxPayload закрывает только своё соединение', async () => {
    const { port } = await start();
    const first = new TestClient(port, { name: 'First' });

    await waitFor(() => first.received(PS.FIRST_SHOT_DATA));

    // дефолт ws — 100 МиБ: такой кадр прошёл бы через JSON.parse целиком
    first.ws.send(JSON.stringify([0, 'x'.repeat(128 * 1024)]));

    await new Promise(resolve => first.ws.on('close', resolve));

    const res = await fetch(`http://localhost:${port}/config`);

    expect(res.status).toBe(200);

    const second = new TestClient(port, { name: 'Second' });

    await waitFor(() => second.received(PS.FIRST_SHOT_DATA));
    await second.close();
  });

  it('частота подключений с адреса ограничена', async () => {
    const { port } = await start();
    const url = `ws://localhost:${port}/game`;
    const opts = { origin: `http://localhost:${port}` };
    const held = [];

    // лимит стоит до порт-машины, поэтому хендшейк проходить не нужно: до
    // аутентификации каждое соединение уже стоит серверу CONFIG_DATA
    for (let i = 0; i < 30; i += 1) {
      const ws = new WebSocket(url, opts);

      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      held.push(ws);
    }

    const extra = new WebSocket(url, opts);
    const code = await new Promise(resolve => extra.on('close', resolve));

    expect(code).toBe(4009);

    for (const ws of held) {
      ws.close();
    }

    // отказ касается только лишнего соединения
    const res = await fetch(`http://localhost:${port}/config`);

    expect(res.status).toBe(200);
  });

  // review-3.md (R3-1): Nginx деплоя дописывает реальный адрес к клиентскому
  // X-Forwarded-For, поэтому ключом лимита он быть не может — иначе свой
  // заголовок на каждое соединение снимает лимит целиком
  it('подделанные заголовки адреса не дают нового бакета', async () => {
    const { port } = await start();
    const url = `ws://localhost:${port}/game`;
    const held = [];
    const spoofed = i => ({
      origin: `http://localhost:${port}`,
      headers: {
        'x-forwarded-for': `10.0.0.${i}`,
        // вне прода (NODE_ENV=test) не считается и X-Real-IP
        'x-real-ip': `10.1.0.${i}`,
      },
    });

    for (let i = 0; i < 30; i += 1) {
      const ws = new WebSocket(url, spoofed(i));

      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      held.push(ws);
    }

    const extra = new WebSocket(url, spoofed(99));
    const code = await new Promise(resolve => extra.on('close', resolve));

    expect(code).toBe(4009);

    for (const ws of held) {
      ws.close();
    }
  });

  it('соединение без Origin закрывается', async () => {
    const { port } = await start();
    const ws = new WebSocket(`ws://localhost:${port}/game`);

    await new Promise(resolve => {
      ws.on('close', resolve);
      ws.on('error', resolve);
    });

    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  // ***** разрешение игры (master-game-registry, этап 5) ***** //

  it('игра не найдена ни локально, ни в реестре — именованная ошибка', async () => {
    await expect(
      startDedicatedServer({
        gameId: 'tanks',
        port: 0,
        loadGame: loadFixtureGame,
        fetchGame: async () => null,
        serveClient: false,
      }),
    ).rejects.toThrow(/game "tanks" is not available/);
  });

  // ответ реестра: id игры приходит из НАЙДЕННОЙ строки, а не из того, как
  // игру назвали в VIMP_DEDICATED_GAME
  const registryAnswer = () => ({
    id: 'miniGame',
    version: '9.9.9',
    distDir: '/nonexistent/miniGame/9.9.9',
    manifest: {
      id: 'miniGame',
      engineApi: ENGINE_API_VERSION,
      version: '0.0.0-fixture',
      assetsBase: '/games/miniGame/',
      entries: {},
    },
    packageUrl: null,
    maxGameScore: null,
  });

  it('игра приезжает из реестра и раздаётся по версионным адресам', async () => {
    const fetched = [];

    server = await startDedicatedServer({
      gameId: 'miniGame@9.9.9',
      port: 0,
      loadGame: loadFixtureGame,
      fetchGame: async (ref, version) => {
        fetched.push([ref, version]);

        return registryAnswer();
      },
      serveClient: false,
    });

    // пин `<ref>@<version>` доехал до загрузчика разобранным
    expect(fetched).toEqual([['miniGame', '9.9.9']]);

    const versioned = await (
      await fetch(
        `http://localhost:${server.port}/games/miniGame/9.9.9/manifest.json`,
      )
    ).json();

    // манифест отдаётся ребейзнутым на версионный префикс — как у мастера
    expect(versioned.assetsBase).toBe('/games/miniGame/9.9.9/');

    const list = await (
      await fetch(`http://localhost:${server.port}/games/manifest.json`)
    ).json();

    expect(list.map(manifest => manifest.id)).toEqual(['miniGame']);
  });

  it('пин, разошедшийся с установленной версией, уводит игру в реестр', async () => {
    // раздаётся то, что установлено, и подменить его нечем: оператор написал
    // в SERVERS_MATRIX точную версию, и молча отдать другую сборку нельзя
    const games = engineConfig.get('master:games');
    const fetched = [];

    engineConfig.set('master:games', [
      { id: 'miniGame', package: '@vimp-games/not-installed' },
    ]);

    try {
      server = await startDedicatedServer({
        gameId: 'miniGame@9.9.9',
        port: 0,
        loadGame: loadFixtureGame,
        fetchGame: async (ref, version) => {
          fetched.push([ref, version]);

          return registryAnswer();
        },
        serveClient: false,
      });
    } finally {
      engineConfig.set('master:games', games);
    }

    // локальная запись есть, но её версии не видно — значит пин не выполнен,
    // и разрешение обязано уйти туда, где пин умеют
    expect(fetched).toEqual([['miniGame', '9.9.9']]);
  });

  it('ссылкой на игру может быть имя пакета — в URL едет id из ответа', async () => {
    // dedicatedGame в SERVERS_MATRIX называет игру пакетом. Имя пакета несёт
    // слеш, и попади оно в каталог сегментом URL — раздача была бы битой
    const fetched = [];

    server = await startDedicatedServer({
      gameId: '@vimp-games/mini@9.9.9',
      port: 0,
      loadGame: loadFixtureGame,
      fetchGame: async (ref, version) => {
        fetched.push([ref, version]);

        return registryAnswer();
      },
      serveClient: false,
    });

    // в реестр уехала строка пакета целиком, скоуп не принят за пин версии
    expect(fetched).toEqual([['@vimp-games/mini', '9.9.9']]);
    expect(server.id).toBe('miniGame');

    const versioned = await (
      await fetch(
        `http://localhost:${server.port}/games/miniGame/9.9.9/manifest.json`,
      )
    ).json();

    expect(versioned.assetsBase).toBe('/games/miniGame/9.9.9/');
  });
});
