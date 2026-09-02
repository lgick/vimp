import { describe, it, expect } from 'vitest';
import { rebaseManifest } from '../../packages/engine/src/master/rebaseManifest.js';

// Ребейз манифеста под версионную базу мастера (master-game-registry, этап 3):
// пакет собран под /games/<id>/, а раздаётся из /games/<id>/<version>/.

const manifest = () => ({
  id: 'tanks',
  version: 'abc123',
  entries: {
    client: '/games/tanks/client-Xyz.js',
    host: '/games/tanks/host-Xyz.js',
    wasm: '/games/tanks/assets/core_bg-Xyz.wasm',
    wasmNode: 'core/pkg-node/core_bg.wasm',
  },
  assetsBase: '/games/tanks/',
});

describe('rebaseManifest', () => {
  it('переносит assetsBase и три entries под новую базу', () => {
    const result = rebaseManifest(manifest(), '/games/tanks/0.16.1/');

    expect(result.assetsBase).toBe('/games/tanks/0.16.1/');
    expect(result.entries.client).toBe('/games/tanks/0.16.1/client-Xyz.js');
    expect(result.entries.host).toBe('/games/tanks/0.16.1/host-Xyz.js');
    expect(result.entries.wasm).toBe('/games/tanks/0.16.1/assets/core_bg-Xyz.wasm');
  });

  it('не трогает entries.wasmNode — это путь файловой системы, не URL', () => {
    const result = rebaseManifest(manifest(), '/games/tanks/0.16.1/');

    expect(result.entries.wasmNode).toBe('core/pkg-node/core_bg.wasm');
  });

  it('добавляет mapsBase', () => {
    const result = rebaseManifest(manifest(), '/games/tanks/0.16.1/');

    expect(result.mapsBase).toBe('/games/tanks/0.16.1/maps');
  });

  it('оставляет как есть entry не под assetsBase', () => {
    const source = manifest();

    source.entries.client = 'https://cdn.example/tanks/client.js';

    const result = rebaseManifest(source, '/games/tanks/0.16.1/');

    expect(result.entries.client).toBe('https://cdn.example/tanks/client.js');
    expect(result.entries.host).toBe('/games/tanks/0.16.1/host-Xyz.js');
  });

  it('не мутирует исходный манифест', () => {
    const source = manifest();
    const before = JSON.stringify(source);

    rebaseManifest(source, '/games/tanks/0.16.1/');

    expect(JSON.stringify(source)).toBe(before);
  });
});
