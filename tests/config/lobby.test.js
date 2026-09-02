import { describe, it, expect } from 'vitest';
import lobbyConfig from '../../packages/engine/src/config/lobby.js';

// URL каталога карт строится по МАНИФЕСТУ (master-game-registry, этап 3):
// версионный каталог мастера кладёт в манифест mapsBase, а его отсутствие
// (dev, standalone, dedicated, старый мастер) — законный случай.

describe('lobbyConfig.maps', () => {
  it('версионный манифест — карты берутся из его mapsBase', () => {
    const manifest = { id: 'tanks', mapsBase: '/games/tanks/0.16.1/maps' };

    expect(lobbyConfig.maps.manifestUrl(manifest)).toBe(
      '/games/tanks/0.16.1/maps/manifest.json',
    );
    expect(lobbyConfig.maps.baseUrl(manifest)).toBe('/games/tanks/0.16.1/maps');
  });

  it('манифест без mapsBase — прежний путь по id', () => {
    const manifest = { id: 'tanks' };

    expect(lobbyConfig.maps.manifestUrl(manifest)).toBe('/games/tanks/maps/manifest.json');
    expect(lobbyConfig.maps.baseUrl(manifest)).toBe('/games/tanks/maps');
  });
});
