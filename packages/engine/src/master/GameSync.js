// Синхронизация каталога мастера с реестром игр auth-сервиса
// (master-game-registry, этап 3).
//
// Один проход: спросить реестр, докачать недостающие версии на диск
// (GameStore), обновить каталог и подмести с диска то, что больше не нужно.
// Приём периодического опроса тот же, что у SignalingServer.refreshRatings():
// таймер с unref(), отказ логируется и не роняет процесс.
//
// Главный инвариант — «протухший каталог лучше пустого»: отказ реестра,
// сетевая ошибка npm и битый пакет одной игры НЕ снимают с раздачи то, что
// уже работает. Мастер, потерявший связь с auth, продолжает раздавать
// скачанные игры.
export default class GameSync {
  /**
   * @param {Object} options - Источники, каталог и расписание.
   * @param {Object} options.registry - GameRegistryProxy.
   * @param {Object} options.store - GameStore.
   * @param {Object} options.catalog - GameCatalog.
   * @param {Set<string>} [options.localGameIds] - id игр, взятых из node_modules.
   * @param {number} [options.intervalMs] - Период опроса реестра.
   * @param {number} [options.keepVersions] - Сколько версий игры держать на диске.
   */
  constructor({
    registry,
    store,
    catalog,
    localGameIds = new Set(),
    intervalMs = 60000,
    keepVersions = 2,
  }) {
    this._registry = registry;
    this._store = store;
    this._catalog = catalog;
    this._localGameIds = localGameIds;
    this._intervalMs = intervalMs;
    this._keepVersions = keepVersions;
    this._timer = null;
    // id игр, поставленных в каталог именно этой синхронизацией: снимать с
    // раздачи мы вправе только их, но не игры из node_modules и не игры
    // из статического конфига self-hosted мастера
    this._owned = new Set();
    // «прилинкована локально» логируется один раз на игру, а не каждый проход
    this._loggedLocal = new Set();
    // последний отказ по игре (id -> текст): панель модерации показывает
    // им, почему игра не раздаётся ИМЕННО ЭТИМ мастером — в логе процесса
    // админ этого не увидит
    this._errors = new Map();
  }

  /**
   * Один проход синхронизации. Никогда не бросает.
   * @returns {Promise<void>} Завершение прохода.
   */
  async run() {
    let games;

    try {
      const { status, json } = await this._registry.list();

      if (status !== 200 || !Array.isArray(json?.games)) {
        console.warn(`GameSync: registry answered ${status} — catalog left as is`);
        return;
      }

      games = json.games;
    } catch (err) {
      console.warn(`GameSync: registry unreachable (${err.message}) — catalog left as is`);
      return;
    }

    const seen = new Set();

    for (const game of games) {
      // Локально прилинкованная игра всегда важнее реестра: dev-путь
      // подменяет её entries на Vite '/@fs/' исходники, и это единственный
      // способ вести HMR-разработку игры. Перезаписать её скачанным из npm
      // пакетом значит молча увести разработчика править файлы, которые
      // никуда не едут
      if (this._localGameIds.has(game.id)) {
        if (!this._loggedLocal.has(game.id)) {
          this._loggedLocal.add(game.id);
          console.info(
            `GameSync: "${game.id}" is linked locally — the registry entry is ignored (dev)`,
          );
        }

        continue;
      }

      seen.add(game.id);

      const result = await this._store.ensure(game.id, game.packageName, game.version);

      if (!result.ok) {
        // битая игра не уносит каталог: она просто не попадает в раздачу,
        // а уже раздаваемая её версия остаётся на месте
        console.warn(
          `GameSync: skip "${game.id}"@${game.version} — ${result.errors.join('; ')}`,
        );
        this._errors.set(game.id, result.errors.join('; '));
        continue;
      }

      this._catalog.upsert({
        id: game.id,
        version: result.version,
        distDir: result.distDir,
        manifest: result.manifest,
        // версия и адрес проекта приходят из реестра, а не из пакета: в
        // тарболле лежит только dist/, package.json игры там нет
        packageVersion: result.version,
        packageUrl: game.repoUrl ?? null,
        // потолок счёта — параметр доверия, его выставляет админ в реестре;
        // из манифеста игра завысила бы его себе сама
        maxGameScore: game.maxGameScore,
        active: true,
      });

      this._owned.add(game.id);
      this._errors.delete(game.id);
    }

    for (const id of this._owned) {
      if (!seen.has(id)) {
        this._catalog.remove(id);
        this._owned.delete(id);
      }
    }

    await this._prune(games);
  }

  // диск чистится по тому же списку, по которому собран каталог: активная
  // версия каждой игры плюс застейдженные (админский «Тест», этап 4), не
  // больше keepVersions на игру
  async _prune(games) {
    const keep = new Map();

    for (const game of games) {
      if (!this._localGameIds.has(game.id)) {
        keep.set(game.id, new Set([game.version]));
      }
    }

    for (const { id, version } of this._catalog.stagedManifests()) {
      if (version && keep.has(id) && keep.get(id).size < this._keepVersions) {
        keep.get(id).add(version);
      }
    }

    try {
      await this._store.prune(keep);
    } catch (err) {
      console.warn(`GameSync: prune failed (${err.message})`);
    }
  }

  /**
   * Последний отказ скачивания/проверки игры на этом мастере.
   * @param {string} id - Идентификатор игры.
   * @returns {string|null} Текст отказа либо null.
   */
  lastError(id) {
    return this._errors.get(id) ?? null;
  }

  /**
   * Запускает периодический опрос реестра.
   * @returns {void}
   */
  start() {
    if (this._timer) {
      return;
    }

    // unref: опрос каталога не повод держать процесс живым
    this._timer = setInterval(() => {
      this.run().catch(err => console.warn(`GameSync: cycle failed (${err.message})`));
    }, this._intervalMs);
    this._timer.unref?.();
  }

  /**
   * Останавливает периодический опрос.
   * @returns {void}
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
