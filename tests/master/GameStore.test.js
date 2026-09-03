import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it, expect, vi, afterEach } from 'vitest';
import GameStore from '../../packages/engine/src/master/GameStore.js';
import { makeTarball, tarballOf, validManifest } from '../fixtures/gamePackages.js';

const registryUrl = 'https://registry.example';
const limits = { maxTarballBytes: 64 * 1024 * 1024, maxFiles: 5000 };

const dirs = [];

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vimp-store-'));

  dirs.push(dir);

  return dir;
};

// реестр в памяти: versions — версия → тарболл; integrity считается честно,
// чтобы путь проверки целостности проходился в тестах целиком
const makeRegistry = (versions, packageName = '@vimp-games/tanks') => {
  const entries = Object.entries(versions);

  return vi.fn(async url => {
    if (url === `${registryUrl}/${packageName.replace('/', '%2F')}`) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          'dist-tags': { latest: entries.at(-1)[0] },
          versions: Object.fromEntries(
            entries.map(([version, buffer]) => [
              version,
              {
                dist: {
                  tarball: `https://cdn/tanks-${version}.tgz`,
                  integrity: `sha512-${createHash('sha512').update(buffer).digest('base64')}`,
                },
              },
            ]),
          ),
        }),
      };
    }

    const version = url.match(/tanks-(.+)\.tgz$/)?.[1];

    if (version && versions[version]) {
      return {
        ok: true,
        status: 200,
        body: Readable.from([versions[version]]),
      };
    }

    return { ok: false, status: 404 };
  });
};

// пакет с произвольным id в манифесте: id заявки читается из него, и
// проверять его надо ровно там, где он приезжает
const tarballWithId = id => {
  const manifest = { ...validManifest(), id };

  return makeTarball({
    'package/package.json': JSON.stringify({ name: '@vimp-games/tanks' }),
    'package/dist/manifest.json': JSON.stringify(manifest),
    'package/dist/client.js': 'export default {};\n',
    'package/dist/host.js': 'export default {};\n',
    'package/dist/assets/core_bg.wasm': '\0asm',
    'package/dist/core-node/core.js': 'export default {};\n',
    'package/dist/maps/arena.json': JSON.stringify({ name: 'arena' }),
  });
};

const stagingEntries = (dir, gameId) => {
  try {
    return fs.readdirSync(path.join(dir, gameId, '.staging'));
  } catch {
    return [];
  }
};

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop(), { recursive: true, force: true });
  }
});

describe('GameStore', () => {
  it('именованно отказывает, если корень недоступен на запись', () => {
    const parent = tempDir();

    fs.chmodSync(parent, 0o500);

    try {
      expect(
        () =>
          new GameStore({
            dir: path.join(parent, 'games'),
            registryUrl,
            limits,
          }),
      ).toThrow(/VIMP_GAMES_DIR/);
    } finally {
      fs.chmodSync(parent, 0o700);
    }
  });

  it('ensure качает версию один раз и кладёт dist на диск', async () => {
    const dir = tempDir();
    const fetchImpl = makeRegistry({ '1.2.3': await tarballOf('valid') });
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    const result = await store.ensure('tanks', '@vimp-games/tanks', '1.2.3');

    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.2.3');
    expect(result.manifest.id).toBe('tanks');
    expect(fs.existsSync(path.join(dir, 'tanks', '1.2.3', 'manifest.json'))).toBe(
      true,
    );
    // в раздачу попадает только dist/ пакета
    expect(fs.existsSync(path.join(dir, 'tanks', '1.2.3', 'package.json'))).toBe(
      false,
    );
    expect(store.has('tanks', '1.2.3')).toBe(true);

    const calls = fetchImpl.mock.calls.length;

    const again = await store.ensure('tanks', '@vimp-games/tanks', '1.2.3');

    expect(again.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('две версии одной игры сосуществуют', async () => {
    const dir = tempDir();
    const tarball = await tarballOf('valid');
    const fetchImpl = makeRegistry({ '1.2.3': tarball, '1.3.0': tarball });
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    await store.ensure('tanks', '@vimp-games/tanks', '1.2.3');
    await store.ensure('tanks', '@vimp-games/tanks', '1.3.0');

    expect(store.listLocalVersions('tanks').sort()).toEqual(['1.2.3', '1.3.0']);
  });

  it('непрошедшая проверку версия не попадает в раздачу', async () => {
    const dir = tempDir();
    const fetchImpl = makeRegistry({ '1.2.3': await tarballOf('wrongId') });
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    const result = await store.ensure('tanks', '@vimp-games/tanks', '1.2.3');

    expect(result.ok).toBe(false);
    expect(result.distDir).toBeNull();
    expect(result.errors.join('\n')).toMatch(/does not match/);
    expect(store.has('tanks', '1.2.3')).toBe(false);
    expect(stagingEntries(dir, 'tanks')).toEqual([]);
  });

  it('несуществующая версия — вердикт, а не исключение', async () => {
    const dir = tempDir();
    const fetchImpl = makeRegistry({ '1.2.3': await tarballOf('valid') });
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    const result = await store.ensure('tanks', '@vimp-games/tanks', '9.9.9');

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/no version "9\.9\.9"/);
    expect(stagingEntries(dir, 'tanks')).toEqual([]);
  });

  it('отказ реестра не роняет вызов', async () => {
    const dir = tempDir();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    const result = await store.ensure('tanks', '@vimp-games/tanks', '1.2.3');

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/ECONNREFUSED/);
  });

  it('inspect проверяет версию, не делая её видимой', async () => {
    const dir = tempDir();
    const fetchImpl = makeRegistry({ '1.2.3': await tarballOf('valid') });
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    const result = await store.inspect('tanks', '@vimp-games/tanks', 'latest');

    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.2.3');
    expect(store.has('tanks', '1.2.3')).toBe(false);
    expect(stagingEntries(dir, 'tanks')).toEqual([]);
  });

  it('prune удаляет всё, чего нет в keep', async () => {
    const dir = tempDir();
    const tarball = await tarballOf('valid');
    const fetchImpl = makeRegistry({ '1.2.3': tarball, '1.3.0': tarball });
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    await store.ensure('tanks', '@vimp-games/tanks', '1.2.3');
    await store.ensure('tanks', '@vimp-games/tanks', '1.3.0');
    fs.mkdirSync(path.join(dir, 'snakes', '0.9.1'), { recursive: true });

    await store.prune(new Map([['tanks', new Set(['1.3.0'])]]));

    expect(store.listLocalVersions('tanks')).toEqual(['1.3.0']);
    expect(fs.existsSync(path.join(dir, 'snakes'))).toBe(false);
  });

  it.each([
    '../../../../tmp/pwn',
    'a/../../b',
    'a/b',
    '..',
    '',
  ])('ensure/inspect с id "%s" не создают ничего вне корня', async id => {
    const dir = tempDir();
    const outside = path.join(dir, '..', 'pwn');
    const fetchImpl = vi.fn();
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    const ensured = await store.ensure(id, '@vimp-games/tanks', '1.2.3');
    const inspected = await store.inspect(id, '@vimp-games/tanks', '1.2.3');

    // отказ вердиктом, а не броском: контракт ensure/inspect не меняется
    expect(ensured.ok).toBe(false);
    expect(inspected.ok).toBe(false);
    expect(ensured.errors[0]).toMatch(/invalid game id/);
    // до сети и диска дело не дошло вовсе
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('версия с разделителем отвергается вердиктом', async () => {
    const dir = tempDir();
    const fetchImpl = vi.fn();
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    const result = await store.ensure('tanks', '@vimp-games/tanks', '../../etc');

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/invalid version/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('кривая версия из пакумента — вердикт, а не бросок из ensure', async () => {
    // ключ versions приходит из недоверенного реестра и становится именем
    // каталога: проверка обязана срабатывать ДО distDir, иначе бросок уедет
    // из ensure наружу — а её зовут await'ом на верхнем уровне lobby.js
    const dir = tempDir();
    const fetchImpl = vi.fn(async url => {
      if (url.endsWith('%2Ftanks')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            'dist-tags': { latest: '1.0.0/../../pwn' },
            versions: { '1.0.0/../../pwn': { dist: { tarball: 'https://cdn/x.tgz' } } },
          }),
        };
      }

      return { ok: false, status: 404 };
    });
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    const result = await store.ensure('tanks', '@vimp-games/tanks', 'latest');

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/invalid version|invalid game id/i);
    expect(fs.existsSync(path.join(dir, '..', 'pwn'))).toBe(false);
  });

  it('distDir бросает на сегменте с разделителем — прямой вызов тоже защищён', () => {
    const store = new GameStore({ dir: tempDir(), registryUrl, limits });

    expect(() => store.distDir('../evil', '1.0.0')).toThrow(/invalid/);
    expect(() => store.distDir('tanks', '../evil')).toThrow(/invalid/);
    expect(() => store.listLocalVersions('../evil')).toThrow(/invalid/);
  });

  // ***** заявка без заранее известного id (форма спрашивает только пакет) *****

  it('inspectPackage читает id из манифеста и убирает за собой', async () => {
    const dir = tempDir();
    const fetchImpl = makeRegistry({ '1.2.3': await tarballOf('valid') });
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    const verdict = await store.inspectPackage('@vimp-games/tanks', '1.2.3');

    expect(verdict).toMatchObject({ ok: true, id: 'tanks', version: '1.2.3' });
    expect(verdict.manifest.title).toBe('Tanks');
    // версия доступной не стала, а корневой .staging пуст
    expect(fs.existsSync(path.join(dir, 'tanks'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, '.staging'))).toEqual([]);
  });

  it.each([
    ['негодный по формату', 'A/../pwn'],
    ['зарезервированный роутами мастера', 'submit'],
  ])('id из манифеста %s — отказ вердиктом', async (_name, id) => {
    const dir = tempDir();
    const fetchImpl = makeRegistry({ '1.2.3': await tarballWithId(id) });
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    const verdict = await store.inspectPackage('@vimp-games/tanks', '1.2.3');

    // манифест недоверенный: id становится сегментом URL и именем каталога
    expect(verdict.ok).toBe(false);
    expect(verdict.id).toBeNull();
    expect(verdict.errors[0]).toMatch(/game id/);
    expect(fs.readdirSync(dir)).toEqual(['.staging']);
  });

  it('ensurePackage кладёт версию под прочитанным id', async () => {
    const dir = tempDir();
    const fetchImpl = makeRegistry({ '1.2.3': await tarballOf('valid') });
    const store = new GameStore({ dir, registryUrl, limits, fetchImpl });

    const verdict = await store.ensurePackage('@vimp-games/tanks', 'latest');

    expect(verdict).toMatchObject({ ok: true, id: 'tanks', version: '1.2.3' });
    expect(verdict.distDir).toBe(path.join(dir, 'tanks', '1.2.3'));
    expect(store.has('tanks', '1.2.3')).toBe(true);
    expect(stagingEntries(dir, '.')).toEqual([]);

    // dedicated зовёт ensurePackage на каждом старте процесса: повтор обязан
    // отдать ту же версию и не оставить мусора в .staging
    const again = await store.ensurePackage('@vimp-games/tanks', 'latest');

    expect(again).toMatchObject({ ok: true, id: 'tanks', version: '1.2.3' });
    expect(again.distDir).toBe(verdict.distDir);
    expect(stagingEntries(dir, 'tanks')).toEqual([]);
    expect(stagingEntries(dir, '.')).toEqual([]);
  });

  it('корневой .staging — не игра: prune чистит его по TTL, а не как каталог игры', async () => {
    const dir = tempDir();
    const store = new GameStore({ dir, registryUrl, limits });
    const fresh = path.join(dir, '.staging', 'fresh');
    const stale = path.join(dir, '.staging', 'stale');

    fs.mkdirSync(fresh, { recursive: true });
    fs.mkdirSync(stale, { recursive: true });
    fs.utimesSync(stale, new Date(0), new Date(0));

    // keep пуст: не отфильтруй prune корневой .staging — он снёс бы чужую
    // идущую прямо сейчас распаковку как «игру, которой нет в keep»
    await store.prune(new Map());

    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(dir, '.staging'))).toBe(true);
  });

  it('prune не трогает свежий .staging', async () => {
    const dir = tempDir();
    const store = new GameStore({ dir, registryUrl, limits });
    const staging = path.join(dir, 'tanks', '.staging', 'fresh');
    const stale = path.join(dir, 'tanks', '.staging', 'stale');

    fs.mkdirSync(staging, { recursive: true });
    fs.mkdirSync(stale, { recursive: true });
    fs.utimesSync(stale, new Date(0), new Date(0));

    await store.prune(new Map([['tanks', new Set()]]));

    expect(fs.existsSync(staging)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });
});
