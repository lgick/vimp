import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { c as tarCreate } from 'tar';

// Фикстуры игровых пакетов для тестов хранилища мастера (направление
// master-game-registry): тарболл собирается в памяти на каждый прогон,
// бинарник в репозиторий не коммитится.

const MANIFEST = {
  id: 'tanks',
  engineApi: 4,
  version: '1.2.3',
  title: 'Tanks',
  entries: {
    client: '/games/tanks/client.js',
    host: '/games/tanks/host.js',
    wasm: '/games/tanks/assets/core_bg.wasm',
    wasmNode: './core-node/core.js',
  },
  assetsBase: '/games/tanks/',
  maps: { version: 'abc', list: ['arena'] },
  roomDefaults: { maxPlayers: 8, map: 'arena' },
  roomForm: [
    { name: 'maxPlayers', control: 'text' },
    { name: 'map', control: 'select', source: 'maps' },
  ],
};

// содержимое package/ валидного пакета: dist/ + то, что обязано быть
// отброшено при распаковке
const baseFiles = manifest => ({
  'package/package.json': JSON.stringify({ name: '@vimp-games/tanks' }),
  'package/dist/manifest.json': JSON.stringify(manifest, null, 2),
  'package/dist/client.js': 'export default {};\n',
  'package/dist/host.js': 'export default {};\n',
  'package/dist/assets/core_bg.wasm': '\0asm',
  'package/dist/core-node/core.js': 'export default {};\n',
  'package/dist/maps/arena.json': JSON.stringify({ name: 'arena' }),
});

const withManifest = patch => {
  const manifest = { ...MANIFEST, ...patch };

  return baseFiles(manifest);
};

/** Варианты пакета: имя → {files, symlinks?}. */
export const variants = {
  valid: { files: baseFiles(MANIFEST) },

  wrongId: { files: withManifest({ id: 'snakes' }) },

  brokenManifest: {
    files: { ...baseFiles(MANIFEST), 'package/dist/manifest.json': '{ oops' },
  },

  escapingEntry: {
    files: withManifest({
      entries: { ...MANIFEST.entries, client: '../../etc/passwd' },
    }),
  },

  missingMap: {
    files: withManifest({ maps: { list: ['arena', 'nowhere'] } }),
  },

  tooManyFiles: {
    files: {
      ...baseFiles(MANIFEST),
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `package/dist/chunk-${i}.js`,
          'export default 0;\n',
        ]),
      ),
    },
  },

  withSymlink: {
    files: baseFiles(MANIFEST),
    symlinks: { 'package/dist/escape.json': '../../../../etc/passwd' },
  },

  extraFiles: {
    files: {
      ...baseFiles(MANIFEST),
      'package/README.md': '# tanks\n',
      'package/src/index.js': 'export default {};\n',
    },
  },
};

/** Манифест валидного пакета — эталон для точечных проверок. */
export const validManifest = () => structuredClone(MANIFEST);

/**
 * Собирает тарболл варианта в память (tar.c поверх временного каталога).
 * @param {string} name - Имя варианта из `variants`.
 * @returns {Promise<Buffer>} Тело .tgz.
 */
export async function tarballOf(name) {
  const { files, symlinks = {} } = variants[name];

  return makeTarball(files, symlinks);
}

/**
 * Собирает произвольный тарболл.
 * @param {Object<string, string>} files - Путь внутри архива → содержимое.
 * @param {Object<string, string>} [symlinks] - Путь → цель символьной ссылки.
 * @returns {Promise<Buffer>} Тело .tgz.
 */
export async function makeTarball(files, symlinks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vimp-pkg-'));

  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }

    for (const [rel, target] of Object.entries(symlinks)) {
      const link = path.join(root, rel);

      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link);
    }

    const chunks = [];
    const stream = tarCreate(
      { gzip: true, cwd: root, portable: true, follow: false },
      ['package'],
    );

    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Раскладывает dist/ варианта прямо на диск — для тестов checkGamePackage,
 * которым тарболл не нужен.
 * @param {string} destDir - Каталог назначения (создаётся).
 * @param {Object<string, string>} files - Содержимое package/ варианта.
 * @returns {string} destDir.
 */
export function writeDist(destDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    if (!rel.startsWith('package/dist/')) {
      continue;
    }

    const file = path.join(destDir, rel.slice('package/dist/'.length));

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  return destDir;
}
