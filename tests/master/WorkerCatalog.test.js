import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WorkerCatalog from '../../packages/engine/src/master/WorkerCatalog.js';

// Каталог worker-бандла (Этап 5.2): версия-хеш содержимого бандла + url —
// по нему вкладка хоста создаёт Worker и обнаруживает новую версию кода
// (host_registered → codeVersion).

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-catalog-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WorkerCatalog', () => {
  it('манифест содержит версию-хеш и url бандла', () => {
    fs.writeFileSync(path.join(dir, 'host.worker-Abc123.js'), 'bundle-v1');

    const catalog = new WorkerCatalog(dir);
    const manifest = JSON.parse(catalog.manifest);

    expect(manifest.version).toBe(catalog.version);
    expect(catalog.version).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest.url).toBe('/assets/host.worker-Abc123.js');
  });

  it('версия стабильна для того же содержимого и меняется при изменении', () => {
    fs.writeFileSync(path.join(dir, 'host.worker-Abc123.js'), 'bundle-v1');

    const first = new WorkerCatalog(dir);
    const same = new WorkerCatalog(dir);

    fs.writeFileSync(path.join(dir, 'host.worker-Abc123.js'), 'bundle-v2');

    const changed = new WorkerCatalog(dir);

    expect(same.version).toBe(first.version);
    expect(changed.version).not.toBe(first.version);
  });

  it('пустой каталог: нет бандла, нет директории или null — версия null', () => {
    const noBundle = new WorkerCatalog(dir);
    const noDir = new WorkerCatalog(path.join(dir, 'missing'));
    const dev = new WorkerCatalog(null);

    for (const catalog of [noBundle, noDir, dev]) {
      expect(catalog.version).toBeNull();
      expect(JSON.parse(catalog.manifest)).toEqual({
        version: null,
        url: null,
      });
    }
  });

  it('игнорирует посторонние ассеты', () => {
    fs.writeFileSync(path.join(dir, 'index-Xyz.js'), 'app');
    fs.writeFileSync(path.join(dir, 'vimp_core_bg-Xyz.wasm'), 'wasm');

    expect(new WorkerCatalog(dir).version).toBeNull();
  });

  it('несколько бандлов (грязный dist) — берёт новейший и предупреждает', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oldFile = path.join(dir, 'host.worker-Old111.js');
    const newFile = path.join(dir, 'host.worker-New222.js');

    fs.writeFileSync(oldFile, 'bundle-old');
    fs.writeFileSync(newFile, 'bundle-new');

    const past = new Date(Date.now() - 60000);

    fs.utimesSync(oldFile, past, past);

    const manifest = JSON.parse(new WorkerCatalog(dir).manifest);

    expect(manifest.url).toBe('/assets/host.worker-New222.js');
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });
});
