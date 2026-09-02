import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { checkGamePackage } from '../../packages/engine/src/master/gamePackageCheck.js';
import {
  validManifest,
  variants,
  writeDist,
} from '../fixtures/gamePackages.js';

const dirs = [];

// распакованный dist/ валидного пакета с точечной правкой манифеста
const distWith = (patch, { raw } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vimp-check-'));

  dirs.push(dir);
  writeDist(dir, variants.valid.files);

  const manifestPath = path.join(dir, 'manifest.json');

  if (raw !== undefined) {
    fs.writeFileSync(manifestPath, raw);
  } else if (patch) {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ ...validManifest(), ...patch }),
    );
  }

  return dir;
};

const errorsOf = (patch, options) =>
  checkGamePackage(distWith(patch, options), { id: 'tanks' }).errors.join('\n');

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop(), { recursive: true, force: true });
  }
});

describe('checkGamePackage', () => {
  it('валидный пакет проходит без ошибок', () => {
    const result = checkGamePackage(distWith(), { id: 'tanks' });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest.id).toBe('tanks');
    expect(result.compat.ok).toBe(true);
  });

  it('битый manifest.json — вердикт, а не исключение', () => {
    const result = checkGamePackage(distWith(null, { raw: '{ oops' }), {
      id: 'tanks',
    });

    expect(result.ok).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.errors[0]).toMatch(/manifest\.json/);
  });

  it('отсутствующий dist/ — вердикт, а не исключение', () => {
    const result = checkGamePackage('/nope/nowhere', { id: 'tanks' });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('ловит расхождение manifest.id с запрошенным', () => {
    expect(errorsOf({ id: 'snakes' })).toMatch(/не совпадает/);
  });

  it('ловит нецелый engineApi и пустые title/version', () => {
    const errors = errorsOf({ engineApi: '4', title: '', version: null });

    expect(errors).toMatch(/engineApi/);
    expect(errors).toMatch(/title/);
    expect(errors).toMatch(/version/);
  });

  it('требует assetsBase со слэшем на конце', () => {
    expect(errorsOf({ assetsBase: '/games/tanks' })).toMatch(/assetsBase/);
  });

  it('требует все три entries', () => {
    const errors = errorsOf({
      entries: { client: '/games/tanks/client.js' },
    });

    expect(errors).toMatch(/entries\.host/);
    expect(errors).toMatch(/entries\.wasm/);
  });

  it('ловит entry, уводящий за пределы dist/', () => {
    const manifest = validManifest();

    manifest.entries.client = '../../etc/passwd';

    expect(errorsOf(manifest)).toMatch(/наружу dist/);
  });

  it('ловит entry, которого нет на диске', () => {
    const manifest = validManifest();

    manifest.entries.wasm = '/games/tanks/assets/missing.wasm';

    expect(errorsOf(manifest)).toMatch(/отсутствует в dist/);
  });

  it('требует от wasmNode относительный путь, а не URL', () => {
    const manifest = validManifest();

    manifest.entries.wasmNode = 'https://cdn/core.js';

    expect(errorsOf(manifest)).toMatch(/wasmNode/);
  });

  it('ловит карту из maps.list без файла в dist/maps', () => {
    expect(errorsOf({ maps: { list: ['arena', 'nowhere'] } })).toMatch(
      /dist\/maps\/nowhere\.json/,
    );
  });

  it('требует непустой maps.list', () => {
    expect(errorsOf({ maps: { list: [] } })).toMatch(/maps\.list/);
  });

  it('ловит roomForm-поле без значения в roomDefaults', () => {
    expect(errorsOf({ roomDefaults: { map: 'arena' } })).toMatch(
      /maxPlayers.*roomDefaults/,
    );
  });

  it('не требует roomDefaults для поля с source: maps', () => {
    const result = checkGamePackage(
      distWith({ roomDefaults: { maxPlayers: 8 } }),
      { id: 'tanks' },
    );

    expect(result.errors).toEqual([]);
  });

  it('несовместимость по requires едет в compat, а не в errors', () => {
    const result = checkGamePackage(
      distWith({ requires: ['no-such-capability'] }),
      { id: 'tanks' },
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.compat.ok).toBe(false);
    expect(result.compat.missing).toEqual(['no-such-capability']);
  });

  it('битая форма requires тоже даёт compat, а не исключение', () => {
    const result = checkGamePackage(distWith({ requires: 'accolades' }), {
      id: 'tanks',
    });

    expect(result.compat.ok).toBe(false);
    expect(result.compat.reason).toBe('bad-manifest');
  });
});
