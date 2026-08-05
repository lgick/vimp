import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadGameForSim } from '../../packages/engine/src/devtools/pluginLoader.js';
import { ENGINE_API_VERSION } from '../../packages/engine/src/config/opcodes.js';

// entries манифеста — URL-ы, какими их видит браузер (assetsBase + путь
// внутри пакета). На диске этой базе соответствует каталог манифеста:
// абсолютный URL нельзя резолвить как путь, иначе загрузчик уходит в корень
// файловой системы.

let dir;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vimp-plugin-'));

  const dist = path.join(dir, 'dist');

  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await mkdir(path.join(dir, 'core', 'pkg-node'), { recursive: true });

  // минимальный gameConfig, проходящий контракт: загрузчик проверяет его сам,
  // потому что встроенный сценарий собирается из него до старта прогона
  const gameConfig = JSON.stringify({
    roomDefaults: { maxPlayers: 8 },
    snapshot: {},
    parts: { models: { m1: {} }, weapons: {}, friendlyFire: false },
    panel: { fields: {} },
    playerKeys: { forward: { key: 1 } },
    teams: { team1: 1, spectators: 2 },
    spectatorTeam: 'spectators',
  });

  await writeFile(
    path.join(dist, 'host-abc.js'),
    `export default { id: "demo", kind: "host", engineApi: ${ENGINE_API_VERSION}, ` +
      `gameConfig: ${gameConfig} };\n`,
  );
  // плагин, не довёзший gameConfig: до проверки в createHostRuntime дело не
  // доходит — сценарий собирается раньше
  await writeFile(
    path.join(dist, 'host-noconfig.js'),
    `export default { id: "demo", kind: "host", engineApi: ${ENGINE_API_VERSION} };\n`,
  );
  await writeFile(
    path.join(dist, 'client-abc.js'),
    `export default { id: "demo", kind: "client", engineApi: ${ENGINE_API_VERSION} };\n`,
  );
  // dist/, отставший от манифеста: плагин собран под другую версию контракта
  await writeFile(
    path.join(dist, 'host-stale.js'),
    `export default { id: "demo", kind: "host", engineApi: ${ENGINE_API_VERSION - 1} };\n`,
  );
  await writeFile(path.join(dir, 'core', 'pkg-node', 'demo.js'), 'export {};\n');
  await writeFile(
    path.join(dist, 'manifest.json'),
    JSON.stringify({
      id: 'demo',
      engineApi: ENGINE_API_VERSION,
      assetsBase: '/games/demo/',
      entries: {
        host: '/games/demo/host-abc.js',
        client: '/games/demo/client-abc.js',
        wasm: '/games/demo/assets/demo_bg.wasm',
        wasmNode: '../core/pkg-node/demo.js',
      },
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadGameForSim', () => {
  it('резолвит entries относительно assetsBase, а не корня ФС', async () => {
    const plugin = await loadGameForSim({ game: dir });

    expect(plugin.hostPlugin.kind).toBe('host');
    expect(plugin.clientPlugin.kind).toBe('client');
    expect(plugin.wasmUrl).toMatch(/core\/pkg-node\/demo\.js$/);
  });

  it('--core перекрывает entries.wasmNode', async () => {
    const plugin = await loadGameForSim({
      game: path.join(dir, 'dist', 'manifest.json'),
      core: path.join(dir, 'core', 'pkg-node', 'demo.js'),
    });

    expect(plugin.wasmUrl).toMatch(/demo\.js$/);
  });

  it('без node-сборки ядра говорит об этом, а не гадает', async () => {
    const bare = path.join(dir, 'bare.json');

    await writeFile(
      bare,
      JSON.stringify({
        id: 'demo',
        engineApi: ENGINE_API_VERSION,
        assetsBase: '/games/demo/',
        entries: {
          host: '/games/demo/dist/host-abc.js',
          client: '/games/demo/dist/client-abc.js',
          wasm: '/games/demo/dist/assets/demo_bg.wasm',
        },
      }),
    );

    await expect(loadGameForSim({ game: bare })).rejects.toThrow(
      /entries\.wasmNode/,
    );
  });

  it('объявленный, но не доехавший в пакете wasmNode — именованный отказ', async () => {
    const broken = path.join(dir, 'broken.json');

    await writeFile(
      broken,
      JSON.stringify({
        id: 'demo',
        engineApi: ENGINE_API_VERSION,
        assetsBase: '/games/demo/',
        entries: {
          host: '/games/demo/dist/host-abc.js',
          client: '/games/demo/dist/client-abc.js',
          wasmNode: './core/pkg-node/missing.js',
        },
      }),
    );

    await expect(loadGameForSim({ game: broken })).rejects.toThrow(
      /does not exist — the game package was published without/,
    );
  });

  it('плагин без gameConfig отвечает контрактом, а не TypeError', async () => {
    const noconfig = path.join(dir, 'noconfig.json');

    await writeFile(
      noconfig,
      JSON.stringify({
        id: 'demo',
        engineApi: ENGINE_API_VERSION,
        assetsBase: '/games/demo/',
        entries: {
          host: '/games/demo/dist/host-noconfig.js',
          client: '/games/demo/dist/client-abc.js',
          wasmNode: './core/pkg-node/demo.js',
        },
      }),
    );

    await expect(loadGameForSim({ game: noconfig })).rejects.toThrow(
      /missing required field/,
    );
  });

  it('плагин, отставший от манифеста по engineApi, не грузится', async () => {
    const stale = path.join(dir, 'stale.json');

    await writeFile(
      stale,
      JSON.stringify({
        id: 'demo',
        engineApi: ENGINE_API_VERSION,
        assetsBase: '/games/demo/',
        entries: {
          host: '/games/demo/dist/host-stale.js',
          client: '/games/demo/dist/client-abc.js',
          wasmNode: './core/pkg-node/demo.js',
        },
      }),
    );

    await expect(loadGameForSim({ game: stale })).rejects.toThrow(
      /host plugin engineApi/,
    );
  });
});
