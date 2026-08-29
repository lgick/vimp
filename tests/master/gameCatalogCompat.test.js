import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import GameCatalog from '../../packages/engine/src/master/GameCatalog.js';
import { ENGINE_API_VERSION } from '../../packages/engine/src/config/opcodes.js';

// Мягкая деградация каталога (этап 5 плана plugin-forward-compat): игра,
// которая просит возможность, отсутствующую в этой сборке движка, больше не
// исчезает из manifestList молча — она остаётся в каталоге с полем `compat`,
// по которому лобби показывает её недоступной с причиной. Раньше такая игра
// выглядела у игрока как пустое лобби без единой строки о том, что случилось.

let nodeModulesDir;

const games = [{ id: 'tanks', package: 'tanks' }];

const manifestOf = extra => ({
  id: 'tanks',
  engineApi: ENGINE_API_VERSION,
  title: 'VIMP Tanks',
  entries: {
    client: '/games/tanks/client.js',
    host: '/games/tanks/host.js',
    wasm: '/games/tanks/core_bg.wasm',
  },
  assetsBase: '/games/tanks/',
  maps: { version: 'maps123', list: ['arena'] },
  roomDefaults: { maxPlayers: 8 },
  ...extra,
});

const writeManifest = manifest => {
  const distDir = path.join(nodeModulesDir, 'tanks', 'dist');

  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'manifest.json'),
    JSON.stringify(manifest),
  );
};

beforeEach(() => {
  nodeModulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vimp-compat-'));
});

afterEach(() => {
  fs.rmSync(nodeModulesDir, { recursive: true, force: true });
});

describe('GameCatalog: поле compat', () => {
  it('игра без requires попадает в каталог без пометки', () => {
    writeManifest(manifestOf());

    const catalog = new GameCatalog(games, nodeModulesDir);

    expect(catalog.ids).toEqual(['tanks']);
    expect(catalog.getManifest('tanks').compat).toBeUndefined();
  });

  it('игра с известными возможностями тоже без пометки', () => {
    writeManifest(manifestOf({ requires: ['accolades'] }));

    expect(
      new GameCatalog(games, nodeModulesDir).getManifest('tanks').compat,
    ).toBeUndefined();
  });

  it('игра новее движка остаётся в каталоге, но помечена недоступной', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeManifest(manifestOf({ requires: ['телепортация'] }));

    const catalog = new GameCatalog(games, nodeModulesDir);
    const { compat } = catalog.getManifest('tanks');

    expect(catalog.ids).toEqual(['tanks']);
    expect(compat.ok).toBe(false);
    expect(compat.missing).toEqual(['телепортация']);
    expect(compat.text).toContain('update the engine');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'));

    warn.mockRestore();
  });

  it('пометка доезжает клиентам в manifestList', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeManifest(manifestOf({ requires: ['телепортация'] }));

    const [manifest] = JSON.parse(
      new GameCatalog(games, nodeModulesDir).manifestList,
    );

    expect(manifest.id).toBe('tanks');
    expect(manifest.compat.ok).toBe(false);

    vi.restoreAllMocks();
  });
});
