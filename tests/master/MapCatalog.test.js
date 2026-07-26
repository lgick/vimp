import { describe, it, expect } from 'vitest';
import MapCatalog from '../../packages/engine/src/master/MapCatalog.js';

// Каталог карт мастера (Этап 5.1): JSON карт в памяти + версия-хеш
// содержимого для сверки хостами (host_registered → mapsVersion).

const mapsFixture = {
  canopy: { setId: 'c1', step: 32, layers: {} },
  'pool mini': { setId: 'c1', step: 16, layers: {} },
};

describe('MapCatalog', () => {
  it('манифест содержит версию и имена карт', () => {
    const catalog = new MapCatalog(mapsFixture);
    const manifest = JSON.parse(catalog.manifest);

    expect(manifest.version).toBe(catalog.version);
    expect(manifest.maps).toEqual(['canopy', 'pool mini']);
  });

  it('get отдаёт JSON карты, неизвестное имя — undefined', () => {
    const catalog = new MapCatalog(mapsFixture);

    expect(JSON.parse(catalog.get('canopy'))).toEqual(mapsFixture.canopy);
    expect(catalog.get('nope')).toBeUndefined();
  });

  it('версия стабильна для одинаковых данных и меняется при изменении', () => {
    const same = new MapCatalog(mapsFixture);
    const changed = new MapCatalog({
      ...mapsFixture,
      canopy: { ...mapsFixture.canopy, step: 64 },
    });

    expect(new MapCatalog(mapsFixture).version).toBe(same.version);
    expect(changed.version).not.toBe(same.version);
  });
});
