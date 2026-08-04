import { describe, it, expect } from 'vitest';
import VirtualClient from '../../packages/engine/src/devtools/VirtualClient.js';
import { HOT_FLAGS } from '../../packages/engine/src/config/opcodes.js';

// Ядро-заглушка: отдаёт заранее заданные hot-буферы, чтобы проверить именно
// конвейер VirtualClient (hot → сцена), а не чужую физику.
class StubCore {
  constructor(buffers = []) {
    this._buffers = buffers;
    this._index = 0;
    this._hot = new Float32Array(0);
    this.pushed = [];
    this.frames = '[]';
  }

  push_frame(data, localNow) {
    this.pushed.push({ data, localNow });

    return true;
  }

  sample() {
    this._hot = this._buffers[this._index] ?? new Float32Array(0);
    this._index += 1;

    return this._hot.length;
  }

  hot_values() {
    return this._hot;
  }

  take_frames() {
    return this.frames;
  }

  apply_input() {}
}

const clientConfig = {
  snapshot: {
    a1: { id: 1, kind: 'indexed8', fields: [{ name: 'x' }, { name: 'y' }] },
  },
  parts: {
    gameSets: { a1: ['Actor'] },
    entitiesOnCanvas: { Actor: 'vimp' },
  },
};

const makeClient = (core, config = clientConfig) =>
  new VirtualClient({ core, clientConfig: config, socketId: 's1', gameId: 0 });

const actorFrame = (id, x, y, flags = HOT_FLAGS.GAME | HOT_FLAGS.CAMERA) =>
  new Float32Array([flags, x, y, 1, 1, id, x, y, 0]);

describe('VirtualClient', () => {
  it('раскладывает hot-буфер в сцену и камеру', () => {
    const client = makeClient(new StubCore([actorFrame(10, 5, 7)]));

    client.render(0);

    expect(client.scene).toEqual({ a1: { 10: [5, 7] } });
    expect(client.camera).toEqual([5, 7]);
  });

  it('пустая выборка не трогает сцену', () => {
    const client = makeClient(new StubCore([actorFrame(10, 5, 7), null]));

    client.render(0);
    client.render(1);

    expect(client.scene).toEqual({ a1: { 10: [5, 7] } });
  });

  it('снимок сцены — копия, а не ссылка на живой объект', () => {
    const client = makeClient(
      new StubCore([actorFrame(10, 5, 7), actorFrame(10, 50, 70)]),
    );

    client.render(0);

    const first = client.snapshot();

    client.render(1);

    expect(first.entities.a1[10]).toEqual([5, 7]);
    expect(first.camera).toEqual([5, 7]);
    expect(client.snapshot().entities.a1[10]).toEqual([50, 70]);
  });

  it('ключ снапшота без записи в gameSets — это «чёрный холст», и он назван', () => {
    const client = makeClient(new StubCore([actorFrame(10, 5, 7)]), {
      ...clientConfig,
      parts: { ...clientConfig.parts, gameSets: {} },
    });

    client.render(0);

    expect(client.decodeErrors).toHaveLength(1);
    expect(client.decodeErrors[0].message).toMatch(
      /snapshot key 'a1' is missing from parts.gameSets/,
    );
  });

  it('part без записи в entitiesOnCanvas тоже называется', () => {
    const client = makeClient(new StubCore([actorFrame(10, 5, 7)]), {
      ...clientConfig,
      parts: { ...clientConfig.parts, entitiesOnCanvas: {} },
    });

    client.render(0);

    expect(client.decodeErrors[0].message).toMatch(
      /part 'Actor' is missing from parts.entitiesOnCanvas/,
    );
  });

  it('JSON-очередь кадров (FRAMES) применяется тем же конвейером', () => {
    const core = new StubCore([
      new Float32Array([HOT_FLAGS.FRAMES, 0, 0, 0, 0]),
    ]);

    core.frames = JSON.stringify([
      { game: { a1: { 11: [1, 2] } }, camera: [3, 4] },
    ]);

    const client = makeClient(core);

    client.render(0);

    expect(client.scene).toEqual({ a1: { 11: [1, 2] } });
    expect(client.camera).toEqual([3, 4]);
  });

  it('null-запись удаляет сущность со сцены', () => {
    const core = new StubCore([
      new Float32Array([HOT_FLAGS.FRAMES, 0, 0, 0, 0]),
      new Float32Array([HOT_FLAGS.FRAMES, 0, 0, 0, 0]),
    ]);

    core.frames = JSON.stringify([{ game: { a1: { 11: [1, 2] } } }]);

    const client = makeClient(core);

    client.render(0);

    core.frames = JSON.stringify([{ game: { a1: { 11: null } } }]);

    client.render(1);

    expect(client.scene.a1).toEqual({});
  });

  it('кадр уходит в ядро как есть — и ArrayBuffer, и Uint8Array', () => {
    const core = new StubCore();
    const client = makeClient(core);

    client.pushFrame(new Uint8Array([1, 2, 3]), 10);
    client.pushFrame(new Uint8Array([4, 5]).buffer, 20);

    expect(core.pushed.map(p => [...p.data])).toEqual([[1, 2, 3], [4, 5]]);
    expect(client.frameCount).toBe(2);
  });

  it('сбой ядра на кадре фиксируется, а не роняет прогон', () => {
    const core = new StubCore();

    core.push_frame = () => {
      throw new Error('bad frame');
    };

    const client = makeClient(core);

    client.pushFrame(new Uint8Array([1]), 5);

    expect(client.frameCount).toBe(0);
    expect(client.decodeErrors[0].message).toMatch(/bad frame/);
  });

  it('не-кадровые порты копятся для проверок инвариантов', () => {
    const client = makeClient(new StubCore());

    client.record('panel', { h: 90 });
    client.record('stat', ['x']);
    client.record('unknownPort', 1);

    expect(client.received.panel).toEqual([{ h: 90 }]);
    expect(client.received.stat).toHaveLength(1);
    expect(client.received.unknownPort).toBeUndefined();
  });

  it('записи дрейфа предикта вычерпываются из ядра каждый тик', () => {
    const core = new StubCore([null, null]);
    const record = {
      source: 'state',
      serverTime: 1200,
      delta: [12.5, 0],
      exceeded: [0],
    };

    core.take_divergence = () =>
      JSON.stringify({
        samples: 2,
        violations: 1,
        dropped: 0,
        maxDelta: [12.5, 0],
        records: [record],
      });

    const client = makeClient(core);

    // тик с пустым hot-буфером записи не теряет: они копятся на push_frame
    client.render(0);
    client.render(1);

    expect(client.divergence).toEqual([record, record]);
    expect(client.divergenceStats).toEqual({
      samples: 2,
      violations: 1,
      dropped: 0,
      maxDelta: [12.5, 0],
    });
    expect(client.snapshot().divergence.samples).toBe(2);
  });

  it("детектор выключен ('null' из ядра) — записей нет", () => {
    const core = new StubCore([null]);

    core.take_divergence = () => 'null';

    const client = makeClient(core);

    client.render(0);

    expect(client.divergenceStats).toBeNull();
    expect(client.divergence).toEqual([]);
  });

  it('debug(): дамп ядра парсится, а без метода в ядре — null', () => {
    const core = new StubCore();
    const client = makeClient(core);

    expect(client.debug()).toBeNull();
    expect(client.snapshot().debug).toBeNull();

    core.debug_json = () =>
      JSON.stringify({ myGameId: 0, interpolator: { buffered: 2 } });

    expect(client.debug()).toEqual({ myGameId: 0, interpolator: { buffered: 2 } });
    expect(client.snapshot().debug.interpolator.buffered).toBe(2);
  });

  // проводка ядра из client/main.js: без неё headless гоняет ядро в режиме,
  // которого в игре не бывает (модель не задана, предикт не включён)
  describe('проводка портов в ядро', () => {
    const wired = () => {
      const core = new StubCore();
      const calls = { auth: [], panel: [], active: [], map: [] };

      core.set_active = value => calls.active.push(value);
      core.set_map = json => calls.map.push(json);

      const clientPlugin = {
        createClientCore: async () => ({ core }),
        hooks: {
          onAuth: (c, data) => calls.auth.push(data),
          onPanel: (c, data) => calls.panel.push(data),
        },
      };

      return { core, calls, clientPlugin };
    };

    it('авторизация доходит до ядра при создании клиента', async () => {
      const { calls, clientPlugin } = wired();

      await VirtualClient.create({
        clientPlugin,
        clientConfig: { ...clientConfig, prediction: {}, interpolation: {} },
        socketId: 's1',
        gameId: 0,
        auth: { name: 'P1', model: 'm1' },
      });

      expect(calls.auth).toEqual([{ name: 'P1', model: 'm1' }]);
    });

    it('keySet переключает предикт, панель уходит в игровой хук', () => {
      const { core, calls, clientPlugin } = wired();
      const client = new VirtualClient({
        core,
        clientConfig,
        socketId: 's1',
        gameId: 0,
        clientPlugin,
      });

      client.record('keySet', 1);
      client.record('keySet', 0);
      client.record('panel', ['h:100']);

      expect(calls.active).toEqual([true, false]);
      expect(calls.panel).toEqual([['h:100']]);
    });

    it('MAP_DATA доходит до ядра, ошибка ядра не теряется', () => {
      const { core, calls, clientPlugin } = wired();
      const client = new VirtualClient({
        core,
        clientConfig,
        socketId: 's1',
        gameId: 0,
        clientPlugin,
      });

      client.setMap({ map: [[1]], step: 8, scale: 1, physicsStatic: [] });

      expect(JSON.parse(calls.map[0]).step).toBe(8);

      core.set_map = () => {
        throw new Error('bad map');
      };

      client.setMap({});
      expect(client.decodeErrors[0].message).toMatch(/set_map: .*bad map/);
    });
  });
});
