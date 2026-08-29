import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadGamePackage } from '../../packages/engine/src/lib/loadGamePackage.js';
import { ENGINE_API_VERSION } from '../../packages/engine/src/config/opcodes.js';

// Загрузка пакета игры в Node (Этап 4 плана standalone-sdk): общий код
// headless-прогона и dedicated-сервера. Проверки перенесены из
// tests/devtools/pluginLoader.test.js — там остались только те, что
// специфичны для самого раннера (--core, контракт gameConfig).
//
// entries манифеста — URL-ы, какими их видит браузер (assetsBase + путь
// внутри пакета). На диске этой базе соответствует каталог манифеста:
// абсолютный URL нельзя резолвить как путь, иначе загрузчик уходит в корень
// файловой системы.

let dir;
let dist;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vimp-package-'));
  dist = path.join(dir, 'dist');

  await mkdir(dist, { recursive: true });
  await mkdir(path.join(dir, 'core', 'pkg-node'), { recursive: true });

  await writeFile(
    path.join(dist, 'host-abc.js'),
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
  // половины, объявившие `requires` — поле читает standalone SDK, у
  // которого манифеста нет вовсе
  await writeFile(
    path.join(dist, 'host-requires.js'),
    `export default { id: "demo", kind: "host", engineApi: ${ENGINE_API_VERSION}, requires: ["accolades"] };\n`,
  );
  await writeFile(
    path.join(dist, 'host-requires-bad.js'),
    `export default { id: "demo", kind: "host", engineApi: ${ENGINE_API_VERSION}, requires: "accolades" };\n`,
  );
  await writeFile(path.join(dir, 'core', 'pkg-node', 'demo.js'), 'export {};\n');

  await writeFile(
    path.join(dist, 'manifest.json'),
    JSON.stringify(manifestWith({ wasmNode: '../core/pkg-node/demo.js' })),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const manifestWith = ({ host = '/games/demo/host-abc.js', wasmNode, requires }) => ({
  id: 'demo',
  engineApi: ENGINE_API_VERSION,
  ...(requires ? { requires } : {}),
  assetsBase: '/games/demo/',
  entries: {
    host,
    client: '/games/demo/client-abc.js',
    wasm: '/games/demo/assets/demo_bg.wasm',
    ...(wasmNode ? { wasmNode } : {}),
  },
});

// вариант манифеста под собственным именем в том же каталоге
const variant = async (name, manifest) => {
  const file = path.join(dist, name);

  await writeFile(file, JSON.stringify(manifest));

  return file;
};

describe('loadGamePackage', () => {
  it('резолвит entries относительно assetsBase, а не корня ФС', async () => {
    const pkg = await loadGamePackage(dist);

    expect(pkg.id).toBe('demo');
    expect(pkg.hostPlugin.kind).toBe('host');
    expect(pkg.clientPlugin.kind).toBe('client');
    expect(pkg.wasmUrl).toMatch(/core\/pkg-node\/demo\.js$/);
    expect(pkg.distDir).toBe(dist);
  });

  it('без node-сборки ядра говорит об этом, а не гадает', async () => {
    const file = await variant('bare.json', manifestWith({}));

    await expect(loadGamePackage(file)).rejects.toThrow(/entries\.wasmNode/);
  });

  it('объявленный, но не доехавший в пакете wasmNode — именованный отказ', async () => {
    const file = await variant(
      'broken.json',
      manifestWith({ wasmNode: '../core/pkg-node/missing.js' }),
    );

    await expect(loadGamePackage(file)).rejects.toThrow(
      /does not exist — the game package was published without/,
    );
  });

  it('плагин, отставший от манифеста по engineApi, не грузится', async () => {
    const file = await variant(
      'stale.json',
      manifestWith({
        host: '/games/demo/host-stale.js',
        wasmNode: '../core/pkg-node/demo.js',
      }),
    );

    await expect(loadGamePackage(file)).rejects.toThrow(/host plugin engineApi/);
  });

  // `requires` пишут три места одного пакета: скрипт сборки манифеста и обе
  // половины плагина. Разъехавшись, они дают игру, которую лобби отвергает,
  // а solo-режим принимает и тихо недоигрывает
  describe('requires манифеста и половин плагина', () => {
    it('половина просит возможность, которой нет в манифесте — stale dist/', async () => {
      const file = await variant(
        'half-extra.json',
        manifestWith({
          host: '/games/demo/host-requires.js',
          wasmNode: '../core/pkg-node/demo.js',
        }),
      );

      await expect(loadGamePackage(file)).rejects.toThrow(
        /host plugin requires accolades, which manifest\.requires does not list/,
      );
    });

    it('манифест просит возможность, которой не объявила ни одна половина', async () => {
      const file = await variant(
        'manifest-extra.json',
        manifestWith({
          requires: ['accolades'],
          wasmNode: '../core/pkg-node/demo.js',
        }),
      );

      // половины поля не объявляют вовсе — старый пакет, собранный до его
      // появления: сверять не с чем, отказа нет
      await expect(loadGamePackage(file)).resolves.toMatchObject({ id: 'demo' });
    });

    it('половина объявила поле, а манифест просит больше — отказ', async () => {
      const file = await variant(
        'manifest-more.json',
        manifestWith({
          host: '/games/demo/host-requires.js',
          requires: ['accolades', 'stat.leaderboard'],
          wasmNode: '../core/pkg-node/demo.js',
        }),
      );

      await expect(loadGamePackage(file)).rejects.toThrow(
        /manifest\.requires names stat\.leaderboard, which neither plugin half declares/,
      );
    });

    it('согласованные списки грузятся', async () => {
      const file = await variant(
        'half-match.json',
        manifestWith({
          host: '/games/demo/host-requires.js',
          requires: ['accolades'],
          wasmNode: '../core/pkg-node/demo.js',
        }),
      );

      await expect(loadGamePackage(file)).resolves.toMatchObject({ id: 'demo' });
    });

    it('не-массив в половине назван дефектом, а не проитерирован', async () => {
      const file = await variant(
        'half-bad.json',
        manifestWith({
          host: '/games/demo/host-requires-bad.js',
          requires: ['accolades'],
          wasmNode: '../core/pkg-node/demo.js',
        }),
      );

      await expect(loadGamePackage(file)).rejects.toThrow(
        /host plugin requires must be an array/,
      );
    });
  });
});
