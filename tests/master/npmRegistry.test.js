import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  downloadTarball,
  extractDist,
  fetchPackageMeta,
  fetchPackument,
  listVersions,
  normalizeRepoUrl,
  resolveVersion,
} from '../../packages/engine/src/master/npmRegistry.js';
import { tarballOf } from '../fixtures/gamePackages.js';

const registryUrl = 'https://registry.example';

const packument = {
  'dist-tags': { latest: '1.2.3' },
  versions: {
    '1.0.0': { dist: { tarball: 'https://cdn/tanks-1.0.0.tgz', shasum: 'a1' } },
    '1.2.3': {
      dist: {
        tarball: 'https://cdn/tanks-1.2.3.tgz',
        integrity: 'sha512-xxx',
        shasum: 'b2',
      },
    },
  },
};

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const tarballResponse = buffer => ({
  ok: true,
  status: 200,
  body: Readable.from([buffer]),
  arrayBuffer: async () => buffer,
});

const integrityOf = buffer =>
  `sha512-${createHash('sha512').update(buffer).digest('base64')}`;

const tempDirs = [];

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vimp-extract-'));

  tempDirs.push(dir);

  return dir;
};

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('fetchPackument', () => {
  it('кодирует имя scoped-пакета целиком и просит тощий пакумент', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(packument));

    await fetchPackument('@vimp-games/tanks', { registryUrl, fetchImpl });

    const [url, options] = fetchImpl.mock.calls[0];

    expect(url).toBe(`${registryUrl}/@vimp-games%2Ftanks`);
    expect(options.headers.accept).toBe('application/vnd.npm.install-v1+json');
  });

  it('404 — это «пакета нет», а не отказ', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, 404));

    await expect(
      fetchPackument('@vimp-games/nope', { registryUrl, fetchImpl }),
    ).resolves.toBeNull();
  });

  it('не-404 статус — именованный отказ', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, 500));

    await expect(
      fetchPackument('@vimp-games/tanks', { registryUrl, fetchImpl }),
    ).rejects.toThrow(/did not answer.*500/);
  });

  it('сетевой отказ отличается от «версии не существует»', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      fetchPackument('@vimp-games/tanks', { registryUrl, fetchImpl }),
    ).rejects.toThrow(/did not answer.*ECONNREFUSED/);
  });
});

describe('resolveVersion', () => {
  it('резолвит точную версию', () => {
    expect(resolveVersion(packument, '1.0.0')).toEqual({
      version: '1.0.0',
      tarball: 'https://cdn/tanks-1.0.0.tgz',
      integrity: null,
      shasum: 'a1',
    });
  });

  it('без спецификатора и по «latest» берёт dist-tags.latest', () => {
    expect(resolveVersion(packument, 'latest').version).toBe('1.2.3');
    expect(resolveVersion(packument).version).toBe('1.2.3');
  });

  it('несуществующая версия — null', () => {
    expect(resolveVersion(packument, '9.9.9')).toBeNull();
  });
});

describe('listVersions', () => {
  it('отдаёт версии по возрастанию, новые в конце', () => {
    expect(listVersions(packument)).toEqual(['1.0.0', '1.2.3']);
  });

  it('build-метаданные не участвуют в сравнении, пререлиз сравнивается целиком', () => {
    // '+build' раньше уезжал в Number() и давал NaN — сравнение возвращало
    // недопустимое значение, и порядок sort становился неопределённым
    const versions = {
      '1.0.0+b': {},
      '1.0.0': {},
      '1.0.0-alpha-2': {},
      '1.0.0-alpha-1': {},
      '1.10.0': {},
      '1.9.0': {},
    };

    expect(listVersions({ versions })).toEqual([
      '1.0.0-alpha-1',
      '1.0.0-alpha-2',
      // '1.0.0+b' и '1.0.0' равны (semver §10), поэтому стабильная
      // сортировка сохраняет их исходный порядок
      '1.0.0+b',
      '1.0.0',
      '1.9.0',
      '1.10.0',
    ]);
  });
});

describe('downloadTarball', () => {
  it('отдаёт тело при совпавшем integrity', async () => {
    const buffer = Buffer.from('tarball');
    const fetchImpl = vi.fn(async () => tarballResponse(buffer));

    const result = await downloadTarball('https://cdn/x.tgz', {
      integrity: integrityOf(buffer),
      fetchImpl,
    });

    expect(result.equals(buffer)).toBe(true);
  });

  it('отказывает при несовпавшем integrity', async () => {
    const fetchImpl = vi.fn(async () =>
      tarballResponse(Buffer.from('подмена')),
    );

    await expect(
      downloadTarball('https://cdn/x.tgz', {
        integrity: integrityOf(Buffer.from('tarball')),
        fetchImpl,
      }),
    ).rejects.toThrow(/integrity mismatch/);
  });

  it('проверяет shasum, когда integrity нет', async () => {
    const buffer = Buffer.from('tarball');
    const shasum = createHash('sha1').update(buffer).digest('hex');
    const fetchImpl = vi.fn(async () => tarballResponse(buffer));

    await expect(
      downloadTarball('https://cdn/x.tgz', { shasum, fetchImpl }),
    ).resolves.toBeInstanceOf(Buffer);

    await expect(
      downloadTarball('https://cdn/x.tgz', { shasum: 'deadbeef', fetchImpl }),
    ).rejects.toThrow(/integrity mismatch/);
  });

  it('обрывает чтение на превышении maxBytes', async () => {
    const buffer = Buffer.alloc(1024);
    const fetchImpl = vi.fn(async () => tarballResponse(buffer));

    await expect(
      downloadTarball('https://cdn/x.tgz', {
        integrity: integrityOf(buffer),
        maxBytes: 16,
        fetchImpl,
      }),
    ).rejects.toThrow(/exceeds 16 bytes/);
  });

  it('не-200 — именованный отказ', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));

    await expect(
      downloadTarball('https://cdn/x.tgz', { fetchImpl }),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe('extractDist', () => {
  it('распаковывает только package/dist и отбрасывает остальное', async () => {
    const dir = tempDir();

    await extractDist(await tarballOf('extraFiles'), dir);

    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'maps', 'arena.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'src'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(false);
  });

  it('не создаёт символьных ссылок из архива', async () => {
    const dir = tempDir();

    await extractDist(await tarballOf('withSymlink'), dir);

    expect(fs.existsSync(path.join(dir, 'escape.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
  });

  it('отказывает при превышении maxFiles', async () => {
    const dir = tempDir();

    await expect(
      extractDist(await tarballOf('tooManyFiles'), dir, { maxFiles: 10 }),
    ).rejects.toThrow(/more than 10 files/);
  });

  it('отказывает при превышении maxBytes', async () => {
    const dir = tempDir();

    await expect(
      extractDist(await tarballOf('valid'), dir, { maxBytes: 4 }),
    ).rejects.toThrow(/exceed 4 bytes/);
  });
});

// Описательные поля пакета: в тарболл едет только package/dist/, а
// repository живёт в package.json пакета — на диск он не попадает вовсе, и
// «тощий» пакумент его тоже не отдаёт
describe('fetchPackageMeta', () => {
  const full = {
    'dist-tags': { latest: '1.2.3' },
    repository: 'lgick/vimp-root',
    versions: {
      '1.0.0': { repository: 'lgick/vimp-tanks' },
      '1.2.3': {
        repository: { type: 'git', url: 'git+ssh://git@github.com/lgick/vimp-tanks.git' },
      },
    },
  };

  it('просит ПОЛНЫЙ пакумент: тощая форма repository не отдаёт', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(full));

    await fetchPackageMeta('@vimp-games/tanks', '1.2.3', { registryUrl, fetchImpl });

    const [url, options] = fetchImpl.mock.calls[0];

    expect(url).toBe(`${registryUrl}/@vimp-games%2Ftanks`);
    expect(options.headers.accept).toBe('application/json');
  });

  it('берёт поля запрошенной версии, недостающие — из корня пакумента', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(full));

    await expect(
      fetchPackageMeta('@vimp-games/tanks', '1.2.3', { registryUrl, fetchImpl }),
    ).resolves.toEqual({ repoUrl: 'https://github.com/lgick/vimp-tanks' });
  });

  it('без версии и на latest читается dist-tags.latest', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(full));

    await expect(
      fetchPackageMeta('@vimp-games/tanks', undefined, { registryUrl, fetchImpl }),
    ).resolves.toEqual({ repoUrl: 'https://github.com/lgick/vimp-tanks' });
    await expect(
      fetchPackageMeta('@vimp-games/tanks', 'latest', { registryUrl, fetchImpl }),
    ).resolves.toEqual({ repoUrl: 'https://github.com/lgick/vimp-tanks' });
  });

  // подмена на latest соврала бы: карточка заявки показывала бы репозиторий
  // чужой версии вместо корневого — последнего опубликованного значения
  it('запрошенной версии нет — поля из корня, а не из latest', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(full));

    await expect(
      fetchPackageMeta('@vimp-games/tanks', '9.9.9', { registryUrl, fetchImpl }),
    ).resolves.toEqual({ repoUrl: 'https://github.com/lgick/vimp-root' });
  });

  it('404 — пакета нет: все поля пустые', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null, 404));

    await expect(
      fetchPackageMeta('@vimp-games/nope', '1.0.0', { registryUrl, fetchImpl }),
    ).resolves.toEqual({ repoUrl: null });
  });

  it.each([
    ['недоступный реестр', async () => { throw new Error('ECONNRESET'); }],
    ['не-200', async () => jsonResponse(null, 500)],
  ])('%s — отказ, а не «репозитория нет»', async (_name, fetchImpl) => {
    await expect(
      fetchPackageMeta('@vimp-games/tanks', '1.0.0', { registryUrl, fetchImpl }),
    ).rejects.toThrow(/npm registry did not answer/);
  });
});

describe('normalizeRepoUrl', () => {
  it.each([
    ['шорткат', 'lgick/vimp-tanks', 'https://github.com/lgick/vimp-tanks'],
    ['github:', 'github:lgick/vimp-tanks', 'https://github.com/lgick/vimp-tanks'],
    ['gitlab:', 'gitlab:lgick/vimp-tanks', 'https://gitlab.com/lgick/vimp-tanks'],
    [
      'git+https',
      { type: 'git', url: 'git+https://github.com/lgick/vimp-tanks.git' },
      'https://github.com/lgick/vimp-tanks',
    ],
    [
      'git+ssh',
      { type: 'git', url: 'git+ssh://git@github.com/lgick/vimp-tanks.git' },
      'https://github.com/lgick/vimp-tanks',
    ],
    [
      'scp-подобная форма',
      { url: 'git@github.com:lgick/vimp-tanks.git' },
      'https://github.com/lgick/vimp-tanks',
    ],
    ['git://', 'git://github.com/lgick/vimp-tanks.git', 'https://github.com/lgick/vimp-tanks'],
    ['уже http(s)', 'https://example.com/repo', 'https://example.com/repo'],
  ])('%s приводится к http(s)', (_name, input, expected) => {
    expect(normalizeRepoUrl(input)).toBe(expected);
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['мусор', 'not a url at all'],
    ['пусто', ''],
    ['null', null],
    ['объект без url', { type: 'git' }],
  ])('%s ссылкой не становится', (_name, input) => {
    // href — исполняемое место представления, и значение уезжает ещё и в БД
    expect(normalizeRepoUrl(input)).toBeNull();
  });
});
