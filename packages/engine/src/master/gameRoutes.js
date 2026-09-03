// Роуты реестра игр (master-game-registry, этап 4): заявка разработчика,
// панель модерации и «Test» новой версии. Модуль отдаёт голые обработчики,
// а URL-таблицу и middleware расставляет lobby.js — так адресное
// пространство мастера видно в одном месте, а обработчики проверяются
// юнит-тестом (lobby.js поднимает сервер и импортироваться из теста не
// может).
//
// ***** ГРАНИЦА ОТВЕТСТВЕННОСТИ *****
//
// Мастер валидирует пакет и раздаёт его; ЛЮБАЯ запись в реестр уходит в
// auth-сервис, где роль перечитывается из БД. Прямой вызов auth в обход
// мастера безвреден и закрывать его незачем: такая запись получает статус
// `pending`, а мастер перепроверяет пакет при каждом скачивании
// (GameStore.ensure), поэтому неотвалидированный код в раздачу не попадает.

import {
  GAME_ID_PATTERN,
  GAME_VERSION_PATTERN,
  PACKAGE_NAME_PATTERN,
  RESERVED_GAME_IDS,
} from './gameRefs.js';
import { fetchPackageMeta } from './npmRegistry.js';

// отказ auth-сервиса выглядит для лобби одинаково на всех роутах реестра
function unavailable(res, err) {
  console.error('[games] registry proxy failed:', err.message);
  res.status(502).json({ error: 'authServiceUnavailable' });
}

/**
 * @param {Object} deps - Реестр, хранилище, каталог и синхронизация.
 * @param {Object} deps.registry - GameRegistryProxy.
 * @param {Object} deps.store - GameStore.
 * @param {Object} deps.catalog - GameCatalog.
 * @param {Object} deps.sync - GameSync.
 * @param {Function} [deps.isAdmin] - Админская ли роль у req.user.
 * @param {string} [deps.registryUrl] - Базовый адрес npm registry: за
 *   репозиторием пакета мастер ходит туда сам (в тарболл едет только
 *   package/dist/, package.json пакета до диска не доезжает).
 * @param {Function} [deps.fetchImpl] - Реализация fetch для этого похода.
 * @param {number} [deps.timeout] - Потолок ожидания ответа реестра (мс).
 * @returns {Object} Обработчики express.
 */
export function createGameRoutes({
  registry,
  store,
  catalog,
  sync,
  isAdmin = () => false,
  registryUrl = null,
  fetchImpl = fetch,
  timeout,
}) {
  // застейдженные версии по id — панель модерации и «Test» показывают, что
  // именно сейчас лежит на диске рядом с одобренной версией
  function stagedVersionOf(id) {
    return catalog.stagedManifests().find(entry => entry.id === id)?.version ?? null;
  }

  // локальное состояние игры на ЭТОМ мастере — то, чем панель отличается от
  // голого списка из БД: одна и та же строка реестра на разных мастерах
  // может быть скачана, не скачана или отвалиться с ошибкой
  function localStateOf(game) {
    return {
      downloaded: Boolean(game.version) && store.has(game.id, game.version),
      stagedVersion: stagedVersionOf(game.id),
      lastError: sync.lastError(game.id),
    };
  }

  // строка реестра по id: имя npm-пакета мастеру взять больше неоткуда, а
  // качать он вправе только то, что в реестре заведено
  async function findGame(list, id) {
    const { status, json } = await list();

    if (status !== 200 || !Array.isArray(json?.games)) {
      return { status, game: null };
    }

    return { status: 200, game: json.games.find(game => game.id === id) ?? null };
  }

  // репозиторий — единственное поле карточки, которого нет ни в манифесте,
  // ни на диске. Его отказ обнуляет ссылку, но не роняет роут: заявку это
  // не должно блокировать (тот же приём, что в store.publishedVersions)
  async function packageMeta(packageName, version) {
    if (!registryUrl) {
      return { repoUrl: null };
    }

    try {
      return await fetchPackageMeta(packageName, version, {
        registryUrl,
        fetchImpl,
        timeout,
      });
    } catch {
      return { repoUrl: null };
    }
  }

  // Вердикт разбора пакета: форма всегда делает lookup перед submit, и без
  // кэша заявка стоит платформе двух скачиваний тарболла и двух походов в
  // npm. TTL короткий намеренно: опубликованную версию подменить нельзя, но
  // пакет могли снять (unpublish), и держать вердикт дольше минуты незачем
  const INSPECT_TTL = 60000;
  const inspected = new Map(); // `${packageName}@${version}` -> {at, verdict, meta}

  async function inspectPackage(packageName, version) {
    const key = `${packageName}@${version ?? ''}`;
    const hit = inspected.get(key);

    if (hit && Date.now() - hit.at < INSPECT_TTL) {
      return hit;
    }

    const [verdict, meta] = await Promise.all([
      store.inspectPackage(packageName, version),
      packageMeta(packageName, version),
    ]);
    const entry = { at: Date.now(), verdict, meta };

    inspected.set(key, entry);

    // кэш ограничен: ключ приходит от пользователя, и расти ему нельзя
    if (inspected.size > 64) {
      for (const [oldKey, value] of inspected) {
        if (Date.now() - value.at >= INSPECT_TTL) {
          inspected.delete(oldKey);
        }
      }
    }

    return entry;
  }

  // форма ссылок проверяется ДО сети и диска: packageName доезжает до пути
  // в npm registry, version — до имени подкаталога в GameStore
  function badPackageRef(packageName, version) {
    return (
      // тип проверяется явно: RegExp.test приводит аргумент к строке, и
      // число 42 прошло бы как имя пакета "42"
      typeof packageName !== 'string' ||
      !PACKAGE_NAME_PATTERN.test(packageName) ||
      (version !== undefined &&
        version !== null &&
        version !== '' &&
        version !== 'latest' &&
        !GAME_VERSION_PATTERN.test(version))
    );
  }

  return {
    // GET /games/lookup?package=<name>&version=<v|latest> — разбор пакета
    // для формы заявки: id, title и версия живут в манифесте внутри
    // тарболла, и спрашивать их у человека, чтобы потом сверить с
    // манифестом, незачем
    async lookup(req, res) {
      const packageName = req.query?.package ?? null;
      const version = req.query?.version || null;

      if (badPackageRef(packageName, version)) {
        res.status(400).json({ error: 'badRequest' });
        return;
      }

      const [{ verdict, meta }, versions] = await Promise.all([
        inspectPackage(packageName, version),
        store.publishedVersions(packageName),
      ]);

      res.json({
        id: verdict.id,
        title: verdict.manifest?.title ?? null,
        version: verdict.version,
        versions,
        repoUrl: meta.repoUrl,
        engineApi: verdict.manifest?.engineApi ?? null,
        compat: verdict.compat,
        errors: verdict.errors,
      });
    },

    // GET /games/mine — заявки вызывающего со статусами и замечаниями
    mine(req, res) {
      registry
        .mine(req.authToken)
        .then(({ status, json }) => res.status(status).json(json))
        .catch(err => unavailable(res, err));
    },

    // POST /games/submit — заявка на новую игру платформы. Пакет
    // проверяется ДО записи: разработчик получает список проблем сразу, а
    // реестр не засоряется заведомо нерабочими заявками
    async submit(req, res) {
      const body = req.body || {};
      const { packageName, version } = body;

      if (badPackageRef(packageName, version)) {
        res.status(400).json({ error: 'badRequest' });
        return;
      }

      // id, title и репозиторий мастер берёт из пакета: манифест он и так
      // читает, а сверять прочитанное с тем, что человек напечатал в форме,
      // незачем. Присланные поля остаются запасным путём — старый клиент и
      // прямые вызовы работают как работали
      const { verdict, meta } = await inspectPackage(packageName, version);

      if (!verdict.ok) {
        res.status(400).json({ errors: verdict.errors });
        return;
      }

      const id = verdict.id ?? body.id ?? null;

      // итоговый id проверяется независимо от того, откуда он взялся: он
      // становится сегментом URL раздачи и именем каталога на диске
      if (!GAME_ID_PATTERN.test(id ?? '') || RESERVED_GAME_IDS.has(id)) {
        res.status(400).json({ error: 'badRequest' });
        return;
      }

      try {
        const { status, json } = await registry.submit(req.authToken, {
          id,
          packageName,
          version: verdict.version,
          title: verdict.manifest?.title ?? body.title ?? null,
          repoUrl: meta.repoUrl ?? body.repoUrl ?? null,
        });

        res.status(status).json(json);
      } catch (err) {
        unavailable(res, err);
      }
    },

    // POST /games/mine/:id/version — заявка на новую версию своей игры
    async requestVersion(req, res) {
      const { id } = req.params;
      const { version } = req.body || {};
      // админ вправе поднять версию ЛЮБОЙ игры (auth это разрешает —
      // requestGameVersion(…, {isAdmin})), но в своих заявках чужой игры
      // нет: списком для него служит очередь модерации целиком
      const list = isAdmin(req.user)
        ? () => registry.listAll(req.authToken)
        : () => registry.mine(req.authToken);
      const { status, game } = await findGame(list, id).catch(() => ({ status: 0, game: null }));

      if (status !== 200) {
        res.status(status || 502).json({ error: 'authServiceUnavailable' });
        return;
      }

      if (!game) {
        res.status(404).json({ error: 'unknownGame' });
        return;
      }

      const verdict = await store.inspect(id, game.packageName, version);

      if (!verdict.ok) {
        res.status(400).json({ errors: verdict.errors });
        return;
      }

      try {
        const answer = await registry.requestVersion(req.authToken, id, verdict.version);

        res.status(answer.status).json(answer.json);
      } catch (err) {
        unavailable(res, err);
      }
    },

    // DELETE /games/mine/:id — удаление игры. Право проверяет auth (админ —
    // любую, автор — свою неопубликованную), мастер лишь убирает за собой:
    // запись каталога снимается сразу, а файлы версий выметает ближайший
    // prune внутри sync.run().
    //
    // В реестре удаление МЯГКОЕ (строка и рейтинги живут ещё 30 суток), но
    // мастеру это безразлично: игра пропала из GET /games, и локально её
    // держать не на чем. Вернёт её restore — тем же sync.run()
    async remove(req, res) {
      try {
        const { status, json } = await registry.remove(req.authToken, req.params.id);

        if (status === 200) {
          // remove(id) без версии снимает ВСЕ записи игры, включая
          // застейдженные админом черновики: их не убирает больше никто
          catalog.remove(req.params.id);
          await sync.run();
        }

        res.status(status).json(json);
      } catch (err) {
        unavailable(res, err);
      }
    },

    // POST /admin/games/:id/restore — возврат мягко удалённой игры. Мастер
    // ничего не докачивает сам: восстановленная игра снова появляется в
    // GET /games, и её забирает штатная синхронизация
    async restore(req, res) {
      try {
        const { status, json } = await registry.restore(req.authToken, req.params.id);

        if (status === 200) {
          await sync.run();
        }

        res.status(status).json(json);
      } catch (err) {
        unavailable(res, err);
      }
    },

    // GET /admin/games — очередь модерации плюс локальное состояние каждой
    // игры на этом мастере
    async adminList(req, res) {
      try {
        const { status, json } = await registry.listAll(req.authToken);

        if (status !== 200 || !Array.isArray(json?.games)) {
          res.status(status).json(json);
          return;
        }

        res.json({
          games: json.games.map(game => ({ ...game, local: localStateOf(game) })),
        });
      } catch (err) {
        unavailable(res, err);
      }
    },

    // GET /admin/games/manifest.json — манифесты застейдженных версий:
    // вкладка админа кладёт их в свой каталог и поднимает по ним комнату,
    // не трогая каталог игроков
    stagedManifests(req, res) {
      res.json({ manifests: catalog.stagedManifests() });
    },

    // POST /admin/games/:id/stage — скачать версию и положить её в каталог
    // НЕ раздаваемой. Именно ensure, а не inspect: манифест без файлов на
    // диске раздать нечем, а активной версия при этом не становится
    async stage(req, res) {
      const { id } = req.params;
      const { version } = req.body || {};
      const { status, game } = await findGame(() => registry.listAll(req.authToken), id).catch(
        () => ({ status: 0, game: null }),
      );

      if (status !== 200) {
        res.status(status || 502).json({ error: 'authServiceUnavailable' });
        return;
      }

      if (!game) {
        res.status(404).json({ error: 'unknownGame' });
        return;
      }

      const wanted = version ?? game.pendingVersion ?? game.version;
      const verdict = await store.ensure(id, game.packageName, wanted);

      if (!verdict.ok) {
        res.status(400).json({ errors: verdict.errors });
        return;
      }

      // один черновик на игру. Снять прошлый обязан именно этот роут:
      // застейдженную запись не убирает больше никто (у локально
      // прилинкованной игры цикл синхронизации до неё вовсе не доходит), а
      // оставленная она навсегда держит свою версию на диске, висит лишним
      // пунктом «(test)» в селекторе админской вкладки и занимает место
      // в keepVersions
      for (const staged of catalog.stagedManifests()) {
        if (staged.id === id && staged.version !== verdict.version) {
          catalog.remove(id, staged.version);
        }
      }

      catalog.upsert({
        id,
        version: verdict.version,
        distDir: verdict.distDir,
        manifest: verdict.manifest,
        packageVersion: verdict.version,
        packageUrl: game.repoUrl ?? null,
        maxGameScore: game.maxGameScore,
        active: false,
      });

      res.json({
        version: verdict.version,
        errors: verdict.errors,
        manifest: catalog.getManifest(id, verdict.version),
      });
    },

    // PATCH /admin/games/:id — решение модератора. Одобрение завершается
    // немедленной синхронизацией: админ обязан увидеть игру в лобби сразу,
    // остальные мастера подтянут её в течение refreshInterval
    async moderate(req, res) {
      try {
        const { status, json } = await registry.moderate(
          req.authToken,
          req.params.id,
          req.body || {},
        );

        if (status === 200) {
          await sync.run();
        }

        res.status(status).json(json);
      } catch (err) {
        unavailable(res, err);
      }
    },

    // GET /admin/games/:id/versions — что вообще опубликовано в npm:
    // индикатор «есть версия новее раздаваемой»
    async versions(req, res) {
      const { status, game } = await findGame(
        () => registry.listAll(req.authToken),
        req.params.id,
      ).catch(() => ({ status: 0, game: null }));

      if (status !== 200) {
        res.status(status || 502).json({ error: 'authServiceUnavailable' });
        return;
      }

      if (!game) {
        res.status(404).json({ error: 'unknownGame' });
        return;
      }

      res.json({ versions: await store.publishedVersions(game.packageName) });
    },
  };
}
