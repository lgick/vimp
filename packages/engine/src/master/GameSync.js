import { existsSync } from 'node:fs';

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
   * @param {Function} [options.onPruned] - Колбэк со списком удалённых путей.
   */
  constructor({
    registry,
    store,
    catalog,
    localGameIds = new Set(),
    intervalMs = 60000,
    keepVersions = 2,
    onPruned = null,
  }) {
    this._registry = registry;
    this._store = store;
    this._catalog = catalog;
    this._localGameIds = localGameIds;
    this._intervalMs = intervalMs;
    this._keepVersions = keepVersions;
    // удалённые с диска пути: вызывающий снимает по ним свои кэши, привязанные
    // к директории версии (статик-маунты лобби)
    this._onPruned = onPruned;
    this._timer = null;
    // идущий проход: см. run()
    this._running = null;
    // id -> отпечаток полей, взятых из СТРОКИ РЕЕСТРА (а не из пакета):
    // версия может не меняться, а потолок счёта или адрес проекта админ
    // правит отдельным PATCH — см. stampOf
    this._stamps = new Map();
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
  run() {
    // проход не пересекается сам с собой: PATCH модерации зовёт run() поверх
    // таймерного прохода, а медленный npm легко переживает intervalMs.
    // Возвращается ТОТ ЖЕ промис, а не немедленный выход: админ обязан
    // дождаться завершения синхронизации, а не получить ответ раньше, чем
    // каталог обновился
    if (this._running) {
      return this._running;
    }

    this._running = this._run().finally(() => {
      this._running = null;
    });

    return this._running;
  }

  async _run() {
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

        // черновик, чья сборка совпала с раздаваемой, свою работу отработал.
        // Снять его больше некому: локальная игра выходит из цикла здесь,
        // до _owned не доходит, а активной у неё остаётся запись из
        // node_modules — оставленный черновик держал бы свою версию на диске
        // и висел бы лишним пунктом «(test)» до перезапуска мастера
        this._dropStaged(game.id);

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

      // каталог уже описывает ровно это состояние: пересобирать запись
      // (перечитывание всех карт игры + JSON.stringify каталога) незачем.
      // Одной версии для этого мало: maxGameScore и repoUrl приходят из
      // строки реестра, и админ правит их PATCH'ем, не трогая версию
      const stamp = stampOf(game, result.version);

      if (
        this._catalog.hasActive(game.id, result.version) &&
        this._stamps.get(game.id) === stamp
      ) {
        this._owned.add(game.id);
        this._errors.delete(game.id);
        continue;
      }

      this._stamps.set(game.id, stamp);
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
        this._stamps.delete(id);
      }
    }

    this._dropMissing();

    await this._prune(games);
  }

  // Черновик снимается, только когда раздаваемая запись — ТОТ ЖЕ АРТЕФАКТ:
  // сверка по manifest.version (хеш сборки), а не по номеру npm-версии.
  // У локально прилинкованной игры раздаётся сборка из node_modules, и
  // совпадение номеров о ней не говорит ничего — сравнение этих двух сборок
  // и есть весь смысл «Теста» в dev. По той же причине сверяет хеш и
  // GameCatalog.isStaged: одна сборка бывает опубликована под двумя
  // npm-версиями.
  //
  // rebaseManifest поле version не трогает, а _toDevManifest подменяет только
  // entries — хеш сравним между записью из node_modules и скачанной из npm
  _dropStaged(id) {
    const activeHash = this._catalog.getManifest(id)?.version;

    if (!activeHash) {
      return;
    }

    for (const staged of this._catalog.stagedManifests()) {
      if (staged.id === id && staged.manifest.version === activeHash) {
        this._catalog.remove(id, staged.version);
      }
    }
  }

  // каталог и диск не расходятся ни в одну сторону: запись, чьей директории
  // на диске уже нет (ручная чистка тома, прошлый prune), снимается — иначе
  // /games/<id>/<version>/* отдаёт 404 посреди матча
  _dropMissing() {
    for (const { id, version, distDir } of this._catalog.entries()) {
      if (version && !existsSync(distDir)) {
        console.warn(`GameSync: drop "${id}"@${version} — ${distDir} is gone`);
        this._catalog.remove(id, version);
      }
    }
  }

  // диск чистится по тому же списку, по которому собран каталог: активная
  // версия каждой игры плюс застейдженные (админский «Test», этап 4), не
  // больше keepVersions на игру
  async _prune(games) {
    const keep = new Map();
    // черновик админа живёт ТОЛЬКО на диске, даже когда сама игра
    // прилинкована в node_modules. Запрет на локальные id относится к
    // раздаваемой версии из реестра (её на диске держать незачем), а не к
    // «Test» — иначе первый же тик таймера сносит его посреди прогона
    const add = (id, version, { staged = false } = {}) => {
      if (!version || (!staged && this._localGameIds.has(id))) {
        return;
      }

      if (!keep.has(id)) {
        keep.set(id, new Set());
      }

      // потолок keepVersions — про раздаваемые версии: любую из них всегда
      // можно перекачать из npm. Черновик «Test» существует ТОЛЬКО на диске,
      // и вытеснить его посреди тестового матча значит вернуть тот самый
      // отказ import(), ради которого черновик и выведен из-под запрета.
      //
      // Верхней границы у черновиков здесь нет намеренно, и держит её не этот
      // модуль: роут `POST /admin/games/:id/stage` (gameRoutes.js) снимает
      // прошлый черновик игры перед тем, как положить новый, — «один черновик
      // на игру» это его инвариант. Правка роута, снявшая это ограничение,
      // молча снимет потолок и с диска
      if (staged || keep.get(id).size < this._keepVersions) {
        keep.get(id).add(version);
      }
    };

    // раздаваемая версия каждой игры реестра — первой: потолок keepVersions
    // тратится на них, черновики идут сверх него
    for (const game of games) {
      add(game.id, game.version);
    }

    // застейдженные версии — включая игры, которых в одобренном каталоге нет
    // вовсе (заявка на новую игру, которую админ прямо сейчас тестирует).
    // Раньше здесь стояло условие keep.has(id), и «Test» новой игры сносило
    // с диска первым же тиком таймера прямо посреди тестового матча
    for (const { id, version } of this._catalog.stagedManifests()) {
      add(id, version, { staged: true });
    }

    try {
      const removed = await this._store.prune(keep);

      if (removed.length > 0) {
        this._onPruned?.(removed);
      }
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

// Отпечаток полей игры, источник которых — строка реестра, а не пакет:
// совпадение версии не означает, что запись каталога актуальна
function stampOf(game, version) {
  return `${version}|${game.maxGameScore ?? ''}|${game.repoUrl ?? ''}`;
}
