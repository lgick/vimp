// Роуты реестра игр (master-game-registry, этап 4): заявка разработчика,
// панель модерации и «Тест» новой версии. Модуль отдаёт голые обработчики,
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
 * @returns {Object} Обработчики express.
 */
export function createGameRoutes({ registry, store, catalog, sync, isAdmin = () => false }) {
  // застейдженные версии по id — панель модерации и «Тест» показывают, что
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

  return {
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
      const { id, packageName, version, title = null, repoUrl = null } = req.body || {};

      // форма ссылок проверяется ДО сети и диска: id доезжает до имени
      // каталога в GameStore, а packageName — до пути в npm registry
      if (
        !GAME_ID_PATTERN.test(id ?? '') ||
        RESERVED_GAME_IDS.has(id) ||
        !PACKAGE_NAME_PATTERN.test(packageName ?? '') ||
        (version !== undefined &&
          version !== null &&
          version !== 'latest' &&
          !GAME_VERSION_PATTERN.test(version))
      ) {
        res.status(400).json({ error: 'badRequest' });
        return;
      }

      const verdict = await store.inspect(id, packageName, version);

      if (!verdict.ok) {
        res.status(400).json({ errors: verdict.errors });
        return;
      }

      try {
        const { status, json } = await registry.submit(req.authToken, {
          id,
          packageName,
          version: verdict.version,
          title,
          repoUrl,
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
