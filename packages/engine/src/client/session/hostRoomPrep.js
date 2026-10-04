// Подготовка комнаты к Worker'у хоста: room.game по манифесту игры, карты
// мастера, URL worker-бандла. Общая для создания комнаты, прогрева
// преемника (host-migration этап 6, HostPrewarm) и эстафеты Worker'ов.
//
// Без DOM: активную игру, конфиг и сеть инъектирует сборщик
// (client/main.js).

/**
 * @param {Object} deps
 * @param {Function} deps.getActiveGame - () → манифест активной игры.
 * @param {Object} deps.config - lobby-конфиг (maps, worker, game).
 * @param {boolean} deps.isDevBuild
 * @param {Function} deps.fetchGamePluginManifest - lib/gamePlugin.js.
 * @param {Function} [deps.fetch]
 */
export function createHostRoomPrep({
  getActiveGame,
  config,
  isDevBuild,
  fetchGamePluginManifest,
  fetch = (...args) => globalThis.fetch(...args),
}) {
  // Этап 5.1/6.4: скачивает каталог карт мастера активной игры (манифест +
  // все карты)
  async function fetchMasterMaps(gameManifest = getActiveGame()) {
    const manifestRes = await fetch(config.maps.manifestUrl(gameManifest));

    if (!manifestRes.ok) {
      throw new Error(`maps manifest: HTTP ${manifestRes.status}`);
    }

    const manifest = await manifestRes.json();

    const entries = await Promise.all(
      manifest.maps.map(async name => {
        const url = `${config.maps.baseUrl(gameManifest)}/${encodeURIComponent(name)}`;
        const res = await fetch(url);

        if (!res.ok) {
          throw new Error(`map ${name}: HTTP ${res.status}`);
        }

        return [name, await res.json()];
      }),
    );

    return { version: manifest.version, maps: Object.fromEntries(entries) };
  }

  // Этап 5.2: скачивает манифест worker-бандла мастера ({ version, url })
  async function fetchWorkerManifest() {
    const res = await fetch(config.worker.manifestUrl);

    if (!res.ok) {
      throw new Error(`worker manifest: HTTP ${res.status}`);
    }

    return res.json();
  }

  // Этап 6.5: перечитывает манифест активной игры мастера — своп не должен
  // нести новому Worker'у закэшированный с момента создания комнаты
  // hostEntryUrl/wasmUrl (деплой игры мог обновиться независимо от движка)
  async function fetchGameManifest(gameId) {
    return fetchGamePluginManifest(config.game.manifestUrl(gameId));
  }

  // манифест игры по ссылке на неё: уже загруженный активный — как есть,
  // другая версия — версионный манифест мастера
  async function resolveGameManifest(gameRef) {
    if (gameRef?.entries) {
      return gameRef;
    }

    const active = getActiveGame();

    if (
      active &&
      gameRef.id === active.id &&
      gameRef.version === active.version
    ) {
      return active;
    }

    return fetchGamePluginManifest(
      config.game.versionManifestUrl(gameRef.id, gameRef.version),
    );
  }

  // gameRef — манифест игры или { id, version } из контрольной точки: бета
  // обязана поднять ту версию игры, что крутится в комнате (версионные URL
  // мастера)
  async function prepareHostRoom(room, gameRef = getActiveGame()) {
    const gameManifest = await resolveGameManifest(gameRef);

    // отладочный контур (этап 6): рекордер живого матча и хостовый
    // CONSOLE-лог поднимаются только в dev-сборке
    room.isDevMode = isDevBuild;

    // Этап 6.4: Worker грузит HostPlugin динамически по
    // entries.host/entries.wasm активной игры — движок не знает игру
    // статически
    room.game = {
      id: gameManifest.id,
      version: gameManifest.version,
      hostEntryUrl: gameManifest.entries.host,
      wasmUrl: gameManifest.entries.wasm,
    };

    // Этап 5.1: комната стартует на актуальных картах мастера;
    // недоступность каталога некритична — Worker возьмёт карты из бандла
    let mapsVersion = null;

    try {
      const catalog = await fetchMasterMaps(gameManifest);

      room.maps = catalog.maps;
      mapsVersion = catalog.version;
    } catch (e) {
      console.warn('[maps] master catalog unavailable, using bundled maps:', e);
    }

    // Этап 5.2: Worker создаётся по манифесту мастера — бандл страницы после
    // деплоя исчезает из раздачи; без манифеста (dev) — бандловый URL,
    // обновления кода отключены
    let workerUrl = null;
    let codeVersion = null;

    try {
      const manifest = await fetchWorkerManifest();

      // составной codeVersion (Этап 6.5): движок (worker-бандл) + игра
      // (id/version манифеста, с которым комната стартует)
      codeVersion = {
        engine: manifest.version,
        game: { id: gameManifest.id, version: gameManifest.version },
      };
      workerUrl = manifest.url;
    } catch (e) {
      console.warn('[worker] master manifest unavailable, using bundled:', e);
    }

    return { room, workerUrl, mapsVersion, codeVersion };
  }

  return {
    prepareHostRoom,
    fetchMasterMaps,
    fetchWorkerManifest,
    fetchGameManifest,
  };
}
