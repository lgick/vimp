# Этап 3. Динамический каталог, версионные URL, синхронизация ✅ выполнен

**Область:** `packages/engine/src/master/`, `packages/engine/src/config/`,
`packages/engine/src/client/`, `tests/master/`, `tests/client/`,
`tests/config/`.

**Цель:** каталог мастера перестаёт быть неизменяемым снимком стартового
конфига. Он собирается из реестра auth, обновляется по таймеру, умеет держать
две версии одной игры одновременно и раздаёт их по версионным URL. Админского
интерфейса ещё нет — он на Этапе 4.

## Что нужно знать перед началом

- `GameCatalog` сейчас строится **в конструкторе** и больше не меняется:
  `_games: Map<id, {manifest, mapCatalog}>`, `_distDirs: Map<id, dir>`,
  `_manifestList` — заранее сериализованная JSON-строка
  (`GameCatalog.js:31-51, 178-198`).
- Статика монтируется циклом на старте:
  `for (const id of gameCatalog.ids) app.use('/games/'+id, express.static(...))`
  (`lobby.js:505-507`). Для динамического каталога это не годится.
- Манифест уже переписывается в dev (`_toDevManifest`, `GameCatalog.js:150-164`)
  — версионный ребейз делается **тем же приёмом**, это не новая идея в коде.
- `entries.client/host/wasm` — абсолютные URL под `assetsBase`;
  `entries.wasmNode` — **путь файловой системы**, не URL
  (`docs/ai/02-packaging.md:157`). Ребейз его не касается.
- Карты клиент берёт **не** из `assetsBase`, а по отдельному URL из конфига
  лобби (`src/config/lobby.js:16-18`, вызовы — `client/main.js:1722, 1732`).
  Поэтому версионность обязана дойти и туда.
- `register_host` **уже** передаёт `gameVersion` (`SignalingServer.js:164`,
  `client/main.js:1544`, хранится `HostRegistry.js:69`) — протокол менять не
  придётся.
- Каталог гейтит не только лобби: `lobby.js:274-277` и `:414-417`
  (`gameCatalog.ids.includes(game)` → `404 unknownGame`),
  `HostRegistry` берёт `roomDefaults.maxPlayers` (`lobby.js:154`),
  `SignalingServer` — `compat` и `mapsVersion`/`codeVersion`
  (`SignalingServer.js:177-178, 243-251`). Все эти места обязаны продолжать
  работать при смене каталога на лету.

## 3.1 `rebaseManifest.js` (новый, `packages/engine/src/master/`)

Отдельный модуль ради юнит-теста и ради будущего перехода на CDN (там
поменяется только `base`).

```js
/**
 * Переносит URL-ы манифеста под новую базу.
 * @param {Object} manifest - манифест как его написала сборка игры
 * @param {string} base - новая база, оканчивается '/' (напр. '/games/tanks/0.16.1/')
 * @returns {Object} копия с переписанными assetsBase/entries и добавленным mapsBase
 */
export function rebaseManifest(manifest, base)
```

Правила:

- `assetsBase` → `base`;
- каждый из `entries.client|host|wasm`, начинающийся со **старого**
  `assetsBase`, → `base + остаток`; не начинающийся — оставить как есть
  (мусор в манифесте не наша забота, его отловил `gamePackageCheck`);
- `entries.wasmNode` — **не трогать** (путь ФС);
- добавить `mapsBase: base + 'maps'`;
- исходный объект не мутировать.

## 3.2 `GameCatalog` становится изменяемым и версионным

`packages/engine/src/master/GameCatalog.js`:

- Внутренний ключ записи — `` `${id}@${version}` `` (где `version` — **npm-версия
  пакета**, а не `manifest.version`, который является хешем бандла). Плюс
  индекс `_active: Map<gameId, version>`.
- Конструктор оставить как есть — по нему живут dev-путь из `node_modules` и
  dedicated-сервер; он просто вызывает новый `upsert` с `active: true`.
- Новые методы:

  ```js
  upsert({ id, version, distDir, manifest, packageVersion, packageUrl,
           maxGameScore, active })
  setActive(id, version)
  remove(id, version)
  isStaged(id, manifestVersion)   // см. 3.5 — сверка по manifest.version
  getManifest(id, version)        // version не задан → активная
  getMapCatalog(id, version)
  getDistDir(id, version)
  getMaxGameScore(id)             // см. 3.6
  stagedManifests()               // все неактивные — для админского роута Этапа 4
  ```

- `manifestList` пересчитывается при каждом изменении и содержит **только
  активные** манифесты, в детерминированном порядке (по `id`) — первая игра
  каталога становится активной в лобби (`client/main.js:155`).
- В `upsert` манифест прогоняется через `rebaseManifest` с
  `base = /games/<id>/<version>/`, если `version` задан; для dev-пути
  (`node_modules`) поведение прежнее — `_toDevManifest`, без ребейза.
- `packageVersion`/`packageUrl` для скачанных игр приходят **аргументами** из
  реестра (npm-версия и `repo_url`), а не из `package.json` пакета: в тарболл
  мы берём только `dist/`. Существующий `_readPackageMeta` остаётся для
  `node_modules`-пути.

## 3.3 `GameRegistryProxy.js` (новый)

По образцу `PlayerDataProxy.js` — конструктор `(authServiceUrl, {fetchImpl})`,
приватный `_request`, ответ отдаётся как `{status, json}`, ничего не кэшируется
внутри:

```js
list()                                  // GET /games                (публично)
listAll(token)                          // GET /admin/games
mine(token)                             // GET /games/mine
submit(token, body)                     // POST /games
requestVersion(token, id, version)      // POST /games/:id/version
moderate(token, id, patch)              // PATCH /admin/games/:id
```

## 3.4 `GameSync.js` (новый)

Периодическая синхронизация каталога с реестром. Приём тот же, что у
`SignalingServer.refreshRatings()` (`SignalingServer.js:450-473`): таймер +
`unref()`, отказ логируется и не роняет процесс.

```js
export default class GameSync {
  constructor({ registry, store, catalog, localGameIds, intervalMs, keepVersions })
  async run()      // один проход; вызывается на старте, по таймеру и после действий админа
  start() / stop()
}
```

Один проход:

1. `registry.list()` → одобренные игры. Отказ → `console.warn` и **выход без
   изменений каталога** (протухший каталог лучше пустого).
2. Для каждой игры `store.ensure(id, packageName, version)`.
   `ok: false` → `console.warn` с текстом ошибок, игра в каталог не попадает
   (тот же инвариант «битая игра не уносит каталог»).
3. `catalog.upsert({ …, active: true })`, включая `maxGameScore` из реестра.
4. Игры, исчезнувшие из ответа реестра (сняты с публикации), — `catalog.remove`.
5. `store.prune(keep)`, где `keep` = активные версии + застейдженные (Этап 4) +
   `keepVersions` последних.

### Приоритет локальной разработки (обязательно)

**Локально прилинкованная игра всегда важнее реестра.** `localGames.js`
находит собранные `@vimp-games/*` в `node_modules` и мастер подменяет их
`entries` на Vite `/@fs/` — это единственный способ вести HMR-разработку игры.
Если синхронизация перезапишет такую запись скачанной из npm версией,
разработчик молча начнёт править исходники, которые никуда не едут.

Поэтому `GameSync` получает `localGameIds` (набор id, пришедших из
`applyLocalGames`) и **пропускает** такие игры на шагах 2–4, логируя один раз:

```
GameSync: "tanks" is linked locally — the registry entry is ignored (dev)
```

В проде `applyLocalGames` возвращает пустой список (`localGames.js:94`), так
что набор пуст и правило не действует.

## 3.5 Скрытые тестовые комнаты

`register_host` уже несёт `gameVersion` — это `manifest.version` (хеш бандла),
уникальный для каждой сборки игры. Значит мастер может отличить комнату на
застейдженной версии от комнаты на одобренной без изменения протокола:

- `GameCatalog.isStaged(gameId, manifestVersion)` → `true`, если в каталоге
  есть запись этой игры с таким `manifest.version`, но она не активная.
- `SignalingServer._onRegisterHost` (`:164`) вычисляет
  `hidden = gameCatalog.isStaged(gameId, gameVersion)` и передаёт флаг в
  `HostRegistry.add` (`HostRegistry.js:43`), где он ложится в запись комнаты
  рядом с `gameId`/`gameVersion` (`:69`).
- `HostRegistry.getList(query)` по умолчанию скрытые комнаты не отдаёт.
  Опция `{ includeHidden: true }` включается только для запроса с админским
  токеном — чтобы двое админов могли играть в тест-комнате вдвоём. Проверка
  токена — мягкий вариант `adminAuth` из Этапа 4; до его появления
  `GET /servers` просто фильтрует скрытые.
- Существующая проверка `compat.ok` при регистрации
  (`SignalingServer.js:177-178`) сохраняется как есть.

## 3.6 `maxGameScore` переезжает из конфига в каталог

Сейчас потолок результата одного матча читается из статического конфига:

```js
// lobby.js:311-317
function maxGameScoreOf(game) {
  const declared = config.get('master:games').find(({ id }) => id === game)?.maxGameScore;
  …
}
```

С динамическим каталогом `master:games` пуст, и клампа не станет — все игры
получат общий дефолт `master:playerData:maxGameScore`. Это **потеря защиты**:
`maxGameScore` — параметр доверия, который выставляет админ, и брать его из
манифеста игры нельзя (игра завысила бы себе потолок сама).

Поэтому:

- `GameSync` кладёт `maxGameScore` из реестра в `catalog.upsert`;
- `GameCatalog.getMaxGameScore(id)` возвращает его или `null`;
- `maxGameScoreOf` в `lobby.js` читает каталог, а конфиг остаётся только
  запасным вариантом для dev/self-hosted:

  ```js
  function maxGameScoreOf(game) {
    const declared =
      gameCatalog.getMaxGameScore(game) ??
      config.get('master:games').find(({ id }) => id === game)?.maxGameScore;

    return Number.isInteger(declared) && declared > 0
      ? declared
      : config.get('master:playerData:maxGameScore');
  }
  ```

Комментарий над функцией обновить: источник — реестр, а не манифест игры, и
почему.

## 3.7 Роуты мастера (`packages/engine/src/master/lobby.js`)

```
GET /games/manifest.json                  → активные одобренные (путь не меняется)
GET /games/:id/manifest.json              → активная версия (алиас)
GET /games/:id/maps/manifest.json         → активная версия (алиас)
GET /games/:id/maps/:name                 → активная версия (алиас)
GET /games/:id/:version/manifest.json
GET /games/:id/:version/maps/manifest.json
GET /games/:id/:version/maps/:name
        (всё выше — до статики)
app.use('/games', …)                      → статика: /games/:id/:version/* и /games/:id/*
```

**Порядок объявления критичен.** `/games/:id/:version/manifest.json` и
`/games/:id/maps/manifest.json` имеют одинаковое число сегментов: если
версионный роут объявить первым, `:version` съест сегмент `maps`. Поэтому
фиксированные `maps`-алиасы объявляются **раньше** версионных, и вдобавок
`:version` охраняется проверкой формы версии (та же регулярка, что в
`config/auth.js:games.versionPattern`; при несовпадении — `next()`).

**Статика** вместо цикла `:505-507` — один обработчик под `/games`, который:

1. разбирает из `req.url` первый сегмент как `id`, второй — как возможную
   версию (по той же регулярке);
2. берёт `distDir` из каталога (`getDistDir(id, version)`), при промахе —
   `next()` (уйдёт в 404);
3. делегирует закэшированному в `Map<dir, middleware>` инстансу
   `express.static(dir)`, переписав `req.url` на остаток пути.

Кэш инстансов обязателен: создавать `express.static` на каждый запрос — это
лишний `serve-static` на каждый файл игры.

Алиасы без версии нужны трём потребителям: вкладкам, открытым до смены версии;
dev/standalone/dedicated, где `mapsBase` может отсутствовать; и старым хостам.

## 3.8 Клиент

### 3.8.1 Карты берутся из манифеста

`packages/engine/src/config/lobby.js:15-18` — функции принимают **манифест**,
а не `gameId`:

```js
  maps: {
    // mapsBase проставляет мастер при ребейзе версионного каталога; его
    // отсутствие (dev, standalone, dedicated, старый мастер) — законный
    // случай, тогда работает прежний путь по id
    manifestUrl: manifest =>
      `${manifest.mapsBase ?? `/games/${manifest.id}/maps`}/manifest.json`,
    baseUrl: manifest => manifest.mapsBase ?? `/games/${manifest.id}/maps`,
  },
```

Два места вызова — `packages/engine/src/client/main.js:1722` и `:1732`; в
обоих `activeGameManifest` уже доступен.

### 3.8.2 Кэш плагинов в `gameActivator` ключуется версией (обязательно)

`packages/engine/src/client/lib/gameActivator.js:13,22-33` кэширует промис
загрузки по `gameId`. Как только в каталоге появятся две версии одной игры
(Этап 4: админ стейджит `tanks@0.17.0` и тут же заходит в обычную комнату на
`0.16.1`), кэш вернёт **не тот модуль**: `import()` уже выполнен, промис лежит
под ключом `tanks`.

Ключ должен включать версию манифеста:

```js
const key = `${gameId}@${manifest.version}`;
```

(`manifest.version` — хеш бандла, он и есть идентификатор кода.) Удаление
отказавшего промиса из кэша (`:28`) — по тому же ключу. Комментарий у `Map`
дополнить причиной.

## 3.9 Порядок сборки каталога в `lobby.js`

```js
applyMasterEnv(config, env);
const localGames = applyLocalGames(config, nodeModulesDir, env);   // как сейчас
const gameCatalog = new GameCatalog(config.get('master:games'), nodeModulesDir, { dev: !isProduction });

// новое:
const gameStore = new GameStore({ dir: resolveGamesDir(config), … });
const gameRegistry = new GameRegistryProxy(config.get('master:security:authServiceUrl'));
const gameSync = new GameSync({
  registry: gameRegistry,
  store: gameStore,
  catalog: gameCatalog,
  localGameIds: new Set(localGames.map(g => g.id)),
  intervalMs: config.get('master:gameStore:refreshInterval'),
  keepVersions: config.get('master:gameStore:keepVersions'),
});
```

- Первый `gameSync.run()` запускается **до** `server.listen`, но его отказ не
  должен мешать старту: `await gameSync.run().catch(…)`.
- `gameSync.start()` — после `listen`.
- Стартовый лог (`lobby.js:127-142`) переписать: печатать источник каталога
  (`registry` / `node_modules` / `GAMES_MATRIX`) и список игр с версиями;
  пустой каталог — предупреждение с указанием, что игры добавляются в панели
  модерации, а не в конфиге.
- `resolveGamesDir(config)`: `master:gameStore:dir` или `<repoRoot>/.games`.
  Путь якорить от расположения файла (как `engineDir` в `lobby.js:33`), не от
  `cwd`.

## 3.10 Конфиг движка без игр

`packages/engine/src/config/master.js:36` → `games: []`. Комментарий над
ключом переписать: каталог приезжает из реестра auth-сервиса; массив и
`GAMES_MATRIX` остаются как переопределение для локальной разработки и
self-hosted мастера без реестра. `localGames.js` **не трогать**.

## 3.11 Тесты

- `tests/master/rebaseManifest.test.js` — ребейз `assetsBase` и трёх entries,
  `wasmNode` не тронут, `mapsBase` добавлен, исходник не мутирован, entry не
  под `assetsBase` оставлен как есть.
- `tests/master/GameCatalog.test.js` — дописать: `upsert`/`setActive`/`remove`,
  пересчёт `manifestList` (только активные, порядок по `id`), сосуществование
  двух версий одной игры, `isStaged`, `getMaxGameScore`, ребейз применён к
  скачанной игре и не применён к dev-пути.
- `tests/master/GameRegistryProxy.test.js` — по образцу
  `PlayerDataProxy.test.js` с инъекцией `fetchImpl`: прокидывание Bearer,
  отсутствие токена у публичного `list()`, отказ апстрима.
- `tests/master/GameSync.test.js` (стабы стора, реестра, каталога) — новая
  игра попадает в каталог; смена версии переносит активную; отказ реестра
  оставляет каталог прежним; битый пакет не ломает остальные игры;
  **локально прилинкованная игра не перезаписывается**; `prune` получает
  корректный `keep`.
- `tests/master/SignalingServer.test.js` и `tests/master/HostRegistry.test.js`
  — скрытые комнаты: регистрация на застейдженной версии даёт `hidden`,
  `getList` их не отдаёт, `{includeHidden:true}` отдаёт.
- `tests/client/gameActivator.test.js` — две версии одной игры дают два разных
  плагина; повторный вызов с той же версией не грузит второй раз; отказ
  вычищается по версионному ключу.
- `tests/config/lobby.test.js` — `maps.manifestUrl`/`baseUrl` от манифеста с
  `mapsBase` и без него.

## Критерии готовности

1. `npx eslint . && npm test -- --silent` — зелено.
2. С поднятым auth (Этап 1) и **пустым** `node_modules` от игр:
   `npm run dev` скачивает `tanks` и `snakes` из реестра, лобби показывает обе,
   матч поднимается, карты грузятся с `/games/<id>/<version>/maps/…`,
   `assetsBase` в `/games/manifest.json` — версионный.
3. С прилинкованными играми (`npm link`) в dev каталог берёт их из
   `node_modules`, в логе строка про игнор реестра, `entries` указывают на
   `/@fs/` — HMR работает.
4. `curl -s https://localhost:3002/games/tanks/manifest.json | jq .assetsBase`
   → `/games/tanks/<version>/`; `curl` того же файла по старому пути
   `/games/tanks/<hash>.js` продолжает отдавать 200 (алиас).
5. Остановить auth-сервис → мастер продолжает раздавать уже скачанный каталог,
   в логе предупреждение.
