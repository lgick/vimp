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

  await writeFile(
    path.join(dist, 'host-abc.js'),
    'export default { id: "demo", kind: "host" };\n',
  );
  await writeFile(
    path.join(dist, 'client-abc.js'),
    'export default { id: "demo", kind: "client" };\n',
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
});
