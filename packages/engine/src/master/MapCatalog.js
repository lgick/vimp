import { createHash } from 'node:crypto';

// Каталог карт мастера (Этап 5.1): JSON-представление карт игры
// (src/data/maps в репозитории игры, например vimp-tanks) в памяти
// для раздачи хостам без пересборки клиента и без файловых артефактов.
// version — хеш содержимого: меняется только вместе с самими картами, по нему
// хост понимает, что его карты устарели (host_registered → mapsVersion).
export default class MapCatalog {
  /**
   * @param {Object} maps - карты проекта ({ имя: данные карты }).
   */
  constructor(maps) {
    this._maps = new Map();

    const hash = createHash('sha256');

    for (const [name, data] of Object.entries(maps)) {
      const json = JSON.stringify(data);

      this._maps.set(name, json);
      hash.update(name).update(json);
    }

    this._version = hash.digest('hex').slice(0, 16);
    this._manifest = JSON.stringify({
      version: this._version,
      maps: [...this._maps.keys()],
    });
  }

  get version() {
    return this._version;
  }

  // манифест каталога — готовая JSON-строка { version, maps: [имена] }
  get manifest() {
    return this._manifest;
  }

  // JSON карты по имени; undefined для неизвестной
  get(name) {
    return this._maps.get(name);
  }
}
