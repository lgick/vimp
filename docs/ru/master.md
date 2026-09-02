# Мастер-сервер (лобби и сигналинг P2P)

Мастер-сервер (`packages/engine/src/master/`) — центральный узел P2P-архитектуры: хранит реестр активных комнат (браузерных хостов), отдаёт их список по REST и маршрутизирует WebRTC-координацию (SDP-офферы/ответы, ICE-кандидаты) между клиентами и хостами. **Игровой логики в нём нет** — только координация соединений.

`packages/engine/src/master/main.js` — **точка входа проекта** (легаси авторитетный игровой сервер полностью демонтирован). Это диспетчер: при заданной `VIMP_DEDICATED_GAME` он передаёт управление `src/dedicated/main.js` ([dedicated-сервер](dedicated.md) одной игры), иначе — `src/master/lobby.js`, лобби-мастеру, которому посвящена эта страница. Развилка живёт в точке входа, чтобы `CMD ["node", "src/master/main.js"]`, `npm start`, `npm run dev` и watch-списки nodemon оставались валидными для обеих ролей. Пути к файлам (`node_modules/`, `dist/assets`) якорятся от расположения модуля через `import.meta.url`, поэтому мастер можно запускать из любой рабочей директории.

## Запуск

```bash
npm run dev       # dev: https://localhost:3002 (nodemon + ViteExpress)
npm start         # production: HTTP за Nginx, читает .env
```

- dev: HTTPS с локальными сертификатами из `.certs/`, клиентскую статику раздаёт ViteExpress. Порт `3002` (`3001` — Vite HMR).
- production: обычный HTTP за Nginx; обязательна `VIMP_DOMAIN`, порт задаёт `VIMP_MASTER_PORT`.

Конфигурация — [packages/engine/src/config/master.js](../../packages/engine/src/config/master.js), описание — в [configuration.md](configuration.md#packagesenginesrcconfigmasterjs).

## Модули

| Модуль | Ответственность |
| --- | --- |
| `packages/engine/src/master/main.js` | точка входа: развилка между лобби-мастером и [dedicated-сервером](dedicated.md) (`VIMP_DEDICATED_GAME`) |
| `packages/engine/src/master/lobby.js` | сам лобби-мастер: Express + REST, HTTPS/HTTP-сервер, сигнальный `WebSocketServer`, периодическая уборка протухших комнат |
| `packages/engine/src/master/httpSecurity.js` | базовые security-заголовки (`nosniff`, `Referrer-Policy`, `X-Frame-Options`, CSP в проде), общие с dedicated-сервером |
| `packages/engine/src/config/env.js` | env-переопределения серверного конфига (`VIMP_DOMAIN`, `VIMP_MASTER_PORT`, `VIMP_AUTH_SERVICE_URL`, `VIMP_GAMES_DIR`, `GAMES_MATRIX`) и разбор `VIMP_DEDICATED_ROOM`; применяют и лобби, и dedicated |
| `packages/engine/src/master/HostRegistry.js` | реестр комнат `Map<hostId, HostSession>`: регистрация (не более 1 комнаты с IP), heartbeat/`lastSeen`, закэшированный `rating`, выборка для `GET /servers` |
| `packages/engine/src/master/SignalingServer.js` | сигнальный WebSocket: жизненный цикл соединений, маршрутизация WebRTC-сообщений, rate limiting пингов |
| `packages/engine/src/master/MapCatalog.js` | каталог карт: JSON-представление `src/data/maps` игры-плагина (например, в `vimp-tanks`) в памяти + версия-хеш содержимого; раздача хостам без пересборки |
| `packages/engine/src/master/WorkerCatalog.js` | каталог worker-бандла: версия-хеш содержимого `dist/assets/host.worker-*.js` + его URL; по нему хосты обнаруживают новую версию кода и меняют Worker эстафетой |
| `packages/engine/src/master/GameCatalog.js` | каталог игр-плагинов, **изменяемый**: `upsert`/`setActive`/`remove` — единственный вход для обоих источников: списка `master:games` (`{id, package}[]`, резолвится в `node_modules/`) и `GameSync`. Запись адресуется парой `id` + npm-версия, поэтому две версии одной игры живут в каталоге одновременно (игроки — на одобренной, админ тестирует другую); в dev `entries.client/host/wasm` подменяются на исходники Vite `/@fs/` (HMR) — см. [plugin-api.md](plugin-api.md#gamemanifest) |
| `packages/engine/src/master/GameRegistryProxy.js` | клиент реестра игр auth-сервиса (`/games`, `/games/mine`, `/admin/games`) — как `PlayerDataProxy`, ничего не кэширует и не интерпретирует, отдаёт `{status, json}` |
| `packages/engine/src/master/GameStore.js` | хранилище игровых пакетов на диске (`VIMP_GAMES_DIR`, `<dir>/<id>/<npmVersion>/`): качает одобренную версию из npm registry, проверяет `integrity`, распаковывает `package/dist` и валидирует структурно. `ensure`/`inspect` не бросают никогда — сетевой отказ, 404, битый архив и проваленная проверка одинаково возвращают `{ok: false, errors}` |
| `packages/engine/src/master/npmRegistry.js` | npm-половина хранилища: скачивание пакумента, резолв версии, загрузка тарболла с проверкой `integrity`/`shasum`, распаковка `tar` с потолками по размеру и числу файлов |
| `packages/engine/src/master/gamePackageCheck.js` | структурная проверка скачанного пакета **без исполнения его кода** (форма манифеста, совпадение `id`, entries под `assetsBase`, карты): мастер не импортирует ни одну половину плагина — полный `vimp-contract` остаётся инструментом разработчика, см. [publishing.md](publishing.md) |
| `packages/engine/src/master/rebaseManifest.js` | переписывает `assetsBase`/`entries` отдаваемого манифеста на версионную базу `/games/<id>/<version>/` и добавляет `mapsBase`; `entries.wasmNode` намеренно не трогается (это путь в ФС, а не URL) |
| `packages/engine/src/master/GameSync.js` | держит каталог в согласии с реестром: один проход спрашивает реестр, докачивает недостающее, обновляет каталог и подметает диск; опрашивается по таймеру (`master:gameStore:refreshInterval`). Отказ реестра каталог не опустошает — протухший каталог лучше пустого |
| `packages/engine/src/master/adminAuth.js` | авторизация REST-роутов мастера: та же проверка подписи по JWKS и та же политика issuer, что на сигнальном пути, плюс клейм `role` для `/admin/*` |
| `packages/engine/src/master/gameRoutes.js` | обработчики роутов реестра: заявка разработчика и её статус, панель модерации, «Тест» версии в каталоге |
| `packages/engine/src/master/JwksProxy.js` | проксирует `GET /jwks` центрального auth-сервиса под собственным origin мастера, с кэшем (TTL) — см. [GET /auth/jwks](#get-authjwks) |
| `packages/engine/src/master/PlayerDataProxy.js` | проксирует per-user `GET`/`PUT /rank` и `/state` центрального auth-сервиса, **без кэша** (Этап B4) — см. [GET/PUT /auth/rank, GET/PUT /auth/state](#getput-authrank-getput-authstate); также публичный `GET /leaderboard` и per-user `GET /placement` (lobby-page-plan) — см. [GET /auth/leaderboard, GET /auth/placement](#get-authleaderboard-get-authplacement) |
| `packages/engine/src/master/LeaderboardCache.js` | keyed-TTL кэш (`game:limit:period`) перед `PlayerDataProxy.getLeaderboard` (кодревью L2) — см. [GET /auth/leaderboard, GET /auth/placement](#get-authleaderboard-get-authplacement) |
| `packages/engine/src/master/HostRatingProxy.js` | проксирует эндпоинты рейтинга хостера центрального auth-сервиса: `getRating` (собственный рейтинг, Bearer) для проверки блокировки в `register_host`, `vote` (Bearer) для `like_host`/`unlike_host`, `getPublic` (без токена — `GET /host-rating/:hosterUserId` не требует авторизации, значение публично) для периодического опроса в `refreshRatings` |
| `packages/engine/src/lib/rateLimiter.js` | общий rate limiter с фиксированным окном (лимит событий на ключ за интервал) |

`HostSession`: `hostId` (uuid), `name`, `maxPlayers` (clamp к `host.maxPlayersLimit`, целевой размер комнаты — 8), `currentPlayers`, `mapName`, `region`, `ip`, `gameId`/`gameVersion` (какую игру-плагин и версию манифеста объявил хост в `register_host` — каждый хост с Этапа 6.4), `hosterUserId` (идентичность хостера из его Bearer-токена в `register_host` — server-rating этап 2), `secret` (per-room возможность, генерируется при регистрации, возвращается только регистрирующей сессии, доказывает владение комнатой при атрибуции rank/state — не попадает в `GET /servers`), `rating` (закэшированный рейтинг хостера, server-rating этап 3 — см. ниже), `status` (`online`), `lastSeen`.

Регион определяется по заголовку от Nginx/CDN (`regionHeader`, по умолчанию `x-region`; например, `CF-IPCountry`) — выбран вместо `geoip-lite` как бесплатный по памяти. Без заголовка регион — `unknown`.

## REST API

### GET /config

Режим сервера — его пробингует клиент движка на старте (standalone-sdk,
этап 4):

- `GET /config` → `{ "mode": "lobby" }`.

Контракт у клиента один на обе роли сервера: ответ `dedicated` переключает
его на загрузку с прямым WebSocket, всё остальное (включая 404 от старого
мастера) означает лобби. См. [dedicated.md](dedicated.md#get-config) и
[client.md](client.md#режимы-загрузки-bootjs).

### GET /servers

Query-параметры: `offset`, `limit`, `region`, `search`. Логика (в порядке приоритета):

1. `search` — поиск по подстроке без учёта регистра; остальные параметры
   игнорируются. Обычный текст ищется в имени комнаты. Формат `gameId/name`
   (lobby-page-plan — тот же вид, что показывает карточка сервера в лобби)
   разбивается по первому `/`: игровая часть матчится против `gameId`,
   остаток — против `name`; пустая часть имени (`"tanks/"`) матчит только по игре.
2. Если всего комнат ≤ `servers.regionThreshold` (15) — возвращается весь список без фильтров и пагинации.
3. Иначе — фильтр по `region` (если передан) и срез `offset`/`limit` (`limit` по умолчанию 10, максимум 50).

Забаненные комнаты (`status !== 'online'`) в выдачу не попадают. Ответ:

```json
{
  "total": 1,
  "servers": [
    {
      "hostId": "3b86e7a7-…",
      "name": "My Room",
      "mapName": "arena",
      "currentPlayers": 3,
      "maxPlayers": 8,
      "region": "DE",
      "gameId": "tanks",
      "rating": 7
    }
  ]
}
```

IP хоста и служебные поля наружу не отдаются. `gameId` — задел под будущий
фильтр по игре в лобби; каждый хост теперь объявляет свою игру в
`register_host` (Этап 6.4), поэтому `null` бывает только у хостов на
клиентском коде до 6.4. `rating` — закэшированный рейтинг хостера
(server-rating этап 3, см. [ниже](#рейтинг-сервера-likeunlike)) — `0` для
только что зарегистрированной комнаты, пока не отработает первый цикл
`register_host`/голоса/периодического опроса; заблокированный хостер вообще
не может зарегистрировать комнату, поэтому флага `blocked` в этом ответе
нет.

### GET /games/manifest.json, GET /games/:id/…, GET /games/:id/:version/…

Каталог `GameManifest` (`GameCatalog` — см.
[plugin-api.md](plugin-api.md#gamemanifest)). У него **два источника**, и
штатный из них — реестр:

1. **Реестр игр центрального auth-сервиса** (`GameSync` + `GameStore`).
   Каждые `master:gameStore:refreshInterval` мастер спрашивает у auth-сервиса
   `GET /games` — одобренные игры и раздаваемую версию, — качает недостающее
   из npm registry в `VIMP_GAMES_DIR` (`<dir>/<id>/<npmVersion>/`), проверяет
   пакет структурно **без исполнения его кода** (`gamePackageCheck.js`) и
   кладёт в каталог. Добавление игры и подъём её версии не требуют ни
   пересборки образа, ни рестарта. Отказ реестра, битый архив или проваленная
   проверка оставляют работающее на месте: протухший каталог лучше пустого, а
   причина хранится по игре (`GameSync.lastError`) для панели модерации.
2. **`master:games`** (`{id, package, maxGameScore?}[]`, см.
   [configuration.md](configuration.md#packagesenginesrcconfigmasterjs),
   переопределяется переменной окружения `GAMES_MATRIX`, а вне прода
   дополняется собранными пакетами `@vimp-games/*` из `node_modules` —
   `src/master/localGames.js`) — резолвится в пакеты `node_modules/` и
   читается из `<package>/dist/manifest.json`. Это путь локальной разработки
   (`npm link` плюс HMR) и self-hosted мастера без реестра. **Локально
   прилинкованная игра всегда важнее**: `GameSync` пропускает запись реестра,
   чей id прилинкован, — иначе разработчика молча увели бы править файлы,
   которые никуда не едут.

Игра, у которой `manifest.id` не совпадает с id из конфига, пропускается с
предупреждением (статик-маунт строит пути по id); карта с битым JSON
пропускается с предупреждением, не роняя мастер.

За `engineApi` игра не выкидывается **никогда**: гейта по версии больше нет
(`plan/plugin-forward-compat`). Игра, чей манифест просит через
[`requires`](plugin-api.md#requires-и-возможности-движка) возможность,
которой в этой сборке движка нет, тоже остаётся в `manifestList` — но с
дополнительным полем:

```jsonc
"compat": { "ok": false, "reason": "engine-too-old",
            "missing": ["telemetry"], "text": "… — update the engine" }
```

У работающей игры поля нет (старый клиент его просто не увидит); игру с этим
полем лобби рисует недоступной, подставляя `text` в подсказку, — недоступная
игра выглядит как ошибка, а не как пустое лобби.

В каждый отдаваемый манифест каталог дополнительно кладёт два поля, которых
сборка игры не пишет: `packageVersion` и `packageUrl`. На пути `node_modules`
они вычитываются из собственного `package.json` разрезолвленного пакета
(`repository`, иначе `homepage`) и приводятся к https через
`resolveProjectUrl` (`src/lib/packageLink.js`); для игры из реестра они
приходят строкой реестра — в опубликованном тарболле лежит только `dist/`.
Клиент показывает их в футере формы входа (см.
[client.md](client.md)). Источник здесь, а не в сборке игры, потому что новое
поле манифеста доезжает до игроков только после того, как каждый репозиторий
игры поправит свой `build-game-manifest.js`, пересоберётся и перепубликуется,
тогда как `package.json` лежит рядом с уже установленным пакетом и верен по
определению. Пакет без читаемого `package.json` — или не объявивший
репозиторий — оставляет поля `null` и из каталога не выпадает: пустеет только
футер, а о недостающем поле предупреждает правило контракта `A7`.
Dedicated-сервер переиспользует тот же `GameCatalog`, поэтому его футер
`#auth` заполняется так же.

- `GET /games/manifest.json` → JSON-массив манифестов, которые каталог
  **раздаёт** (активная версия каждой игры), в порядке по id.
- `GET /games/:id/manifest.json` → манифест одной игры; неизвестный id →
  `404 { "error": "unknownGame" }`.
- `GET /games/:id/maps/manifest.json` / `GET /games/:id/maps/:name` —
  `{ "version": "<хеш содержимого>", "maps": ["canopy", …] }` и JSON карты
  соответственно, per-game (строится из `dist/maps/*.json` резолвленного
  пакета); неизвестная игра/карта — `404`. `MapCatalog` (per-game, внутри
  `GameCatalog`) держит собранные `maps/*.json` в памяти. Как хост
  потребляет каталог — см. [host.md](host.md#динамические-карты).
- `GET /games/:id/*` — собранные ассеты игры (`dist/`: хешированные
  client/host-бандлы, общий хешированный `.wasm`, звуки) раздаются статикой
  под `assetsBase` (`/games/<id>/`), маунтится из `GameCatalog.getDistDir(id)`.

#### Версионное URL-пространство

Скачанная из реестра игра адресуется парой **id + npm-версия**:
`/games/<id>/<version>/manifest.json`, `/games/<id>/<version>/maps/*` и
`/games/<id>/<version>/*` для ассетов. Именно это позволяет админу играть в
застейдженную версию, пока все остальные играют в одобренную, — один и тот же
мастер раздаёт обе сразу. Сегмент версии обязан выглядеть как версия
(`1.2.3`, при желании с суффиксом `-`/`+`), иначе путь уходит дальше в
статику, и `/games/tanks/assets/…` по-прежнему резолвится.

Мастер **переписывает отдаваемый манифест**: `rebaseManifest` переносит
`assetsBase` и `entries.client/host/wasm` на `/games/<id>/<version>/` и
добавляет `mapsBase` (`/games/<id>/<version>/maps`), откуда лобби берёт URL
карт (`src/config/lobby.js`). `entries.wasmNode` не трогается — это путь в
файловой системе для dedicated-сервера, а не URL. Тот же приём каталог уже
применяет в dev, направляя entries на исходники Vite `/@fs/`. Entry, который
не лежит под собственным `assetsBase` манифеста, остаётся как есть, а не
«чинится».

Неверсионные алиасы выше сохраняются и резолвятся в раздаваемую сейчас
версию. Они нужны трём потребителям: вкладкам, открытым до смены версии;
путям dev / standalone / dedicated, где `mapsBase` в манифесте нет вовсе; и
хостам старых сборок.

#### Роуты реестра (заявка и модерация)

Обработчики живут в `gameRoutes.js`, авторизация — в `adminAuth.js`; **любая
запись уходит в auth-сервис**, который перечитывает роль вызывающего из БД —
мастер валидирует и раздаёт пакеты, но не решает, кому публиковать.

| Роут | Доступ | Что делает |
| --- | --- | --- |
| `GET /games/mine` | любой вошедший | собственные заявки вызывающего со статусами и замечаниями модератора |
| `POST /games/submit` | любой вошедший | заявка на новую игру: пакет качается и проверяется **до** записи строки, поэтому разработчик получает список проблем сразу, а реестр не засоряется нерабочими заявками. Лимит — 5 заявок в минуту на пользователя, до похода в npm |
| `POST /games/mine/:id/version` | владелец игры (и админ — по любой игре) | новая версия уже заведённой игры, проверяется так же |
| `GET /admin/games` | `role=admin` | вся очередь модерации плюс локальное состояние каждой игры на этом мастере (`downloaded`, `stagedVersion`, `lastError`) |
| `GET /admin/games/manifest.json` | `role=admin` | манифесты застейдженных (не раздаваемых) версий — вкладка админа кладёт их в свой каталог и поднимает по ним комнату |
| `POST /admin/games/:id/stage` | `role=admin` | «Тест»: скачать версию и положить её в каталог **неактивной** |
| `PATCH /admin/games/:id` | `role=admin` | решение модератора (статус, раздаваемая версия, замечание, `maxGameScore`); при успехе мастер тут же гоняет проход синхронизации, поэтому админ видит результат немедленно, а остальные мастера подхватывают его в течение `refreshInterval` |
| `GET /admin/games/:id/versions` | `role=admin` | что опубликовано в npm для пакета — индикатор «есть версия новее» |

Отказ auth-сервиса на любом из них — `502 { "error": "authServiceUnavailable" }`.

Комната, поднятая на застейдженной версии, **скрыта**: `register_host`
помечает сессию `hidden`, когда срабатывает `GameCatalog.isStaged(gameId,
gameVersion)`, и `GET /servers` её не показывает — в тестовую комнату можно
попасть только по ссылке, чтобы игроки не заходили в неодобренную сборку.
Проверка идёт по `manifest.version` (хеш бандла, который присылает хост): про
npm-версии хост ничего не знает. Комната на одобренной версии скрытой не
становится, даже если её хеш бандла совпал с застейдженным (публикация с
правкой одного `package.json` кода не меняет).

Потолок счёта одной игры (`maxGameScore`, применяется клампом к
`PUT /auth/rank`) берётся из **строки реестра, заполненной админом**, а не из
манифеста — иначе игра завысила бы себе потолок сама. В `master:games` он
остаётся запасным путём для self-hosted.

В dev `entries.client`/`entries.host`/`entries.wasm` подменяются на
абсолютные пути исходников через Vite `/@fs/` (`src/client/index.js`
резолвленного пакета и т.п., `.wasm` — из его `core/pkg-web/`), чтобы импорт
шёл через dev-трансформацию и HMR Vite, а не собранный бандл; остальное
содержимое манифеста (`maps`,
`assetsBase`, `roomDefaults`, `version`) по-прежнему берётся из собранного
`dist/manifest.json` — игру нужно собрать один раз (`npm run build` в репозитории игры)
перед первым запуском в dev, как и `npm run core:build` для WASM-ядра.

### GET /worker/manifest.json

Манифест worker-бандла хоста для эстафеты Worker'ов:

- `GET /worker/manifest.json` → `{ "version": "<хеш содержимого>", "url": "/assets/host.worker-<hash>.js" }`.

`WorkerCatalog` при старте мастера находит бандл в `dist/assets/` и хеширует
его содержимое (SHA-256, 16 символов — по образцу `MapCatalog`). Vite хеширует
имена ассетов, поэтому страница старой сборки не может знать имя нового
бандла — вкладка хоста создаёт Worker по `url` из манифеста и сверяет
`version` с движковой половиной составного `codeVersion` из `host_registered`
(Этап 6.5 — см. ниже). В dev каталог пуст (`{ "version": null, "url": null }`)
— Worker раздаёт Vite из исходников, обновления кода отключены. Как хост
потребляет манифест — см. [host.md](host.md#эстафета-workerов).

### GET /auth/jwks

Проксирует `GET /jwks` центрального auth-сервиса (`packages/auth`, см.
[auth.md](auth.md)) под собственным origin мастера (Этап B3): `JwksProxy`
(`packages/engine/src/master/JwksProxy.js`) фетчит
`{security.authServiceUrl}/jwks` и кэширует в памяти (TTL по умолчанию 10
минут — ключ меняется только при ротации). Worker браузерного хоста
(`packages/engine/src/host/host.worker.js`) фетчит этот эндпоинт (тот же
origin, что и сам Worker), чтобы проверить подпись identity-JWT клиента
перед тем как доверять claim `nick`, вместо зависимости от CORS/прямой
доступности auth-сервиса из недоверенного хоста. `502
authServiceUnavailable` при сбое запроса к апстриму.

### GET/PUT /auth/rank, GET/PUT /auth/state

Проксирует per-user `GET`/`PUT /rank` и `GET`/`PUT /state` центрального
auth-сервиса (`packages/auth`, см. [auth.md](auth.md)) под собственным
origin мастера (Этап B4): `PlayerDataProxy`
(`packages/engine/src/master/PlayerDataProxy.js`) пересылает каждый вызов на
`{security.authServiceUrl}{/rank|/state}?game=<gameId>` с собственным
заголовком вызывающего `Authorization: Bearer <token>` — в отличие от
`JwksProxy`, ответ **не кэшируется** (это per-user данные, а не общий
публичный ключ). Общий хелпер `forwardPlayerData(req, res, call)` в
`main.js` достаёт Bearer-токен и `?game=` из входящего запроса и
пробрасывает статус/JSON апстрима как есть:

- `400 badRequest`, если токен или параметр `game` отсутствуют.
- `404 unknownGame`, если `game` не входит в `gameCatalog.ids` (фикс
  кодревью — иначе любой валидный identity-токен мог бы писать rank/state в
  произвольный, некаталожный `game_id`-namespace, ломая модель доверия
  «пишут только каталожные игры»).
- `502 authServiceUnavailable` при сбое запроса к апстриму.

**Атрибуцию проставляет мастер, а не тело запроса хоста** (фикс кодревью):
недоверенный браузер хоста иначе мог бы приписать собственные rank/state
записи себе же (уходя от аннулирования этапа 4) или чужому
хостеру-жертве (подставляя его под будущий откат при бане). Тела `PUT`
несут `hostId` **и его per-room `hostSecret`** (оба хост узнаёт после
подтверждения `register_host`, см. ниже); `registry.verifiedAttribution(hostId,
hostSecret)` в `main.js` ищет комнату в `HostRegistry` и возвращает уже
проверенный по JWT `hosterUserId` плюс `sessionId: hostId`, **только если
секрет совпал** — иначе `{}`. Секрет доказывает владение комнатой: `hostId`
публичны (видны в `GET /servers`), поэтому без секрета читер-хост мог бы
приписать записи любой чужой активной комнате; секрет это закрывает. Он
генерируется на комнату в `HostRegistry.add`, возвращается **только
регистрирующей сессии** в `host_registered`, не попадает в `GET /servers`
(`_toPublic` перечисляет поля явным whitelist'ом) и не пробрасывается в auth
(мастер его срезает — до `PlayerDataProxy.putRank`/`putState` доходит только
`{ hosterUserId, sessionId }`). Неизвестный `hostId` либо отсутствующий/неверный
секрет (комната ещё не зарегистрирована, Worker подменён эстафетой или это
попытка подделки) дают запись без атрибуции — не ошибку.

Браузерный хост в лице `PlayerDataSync`
(`packages/engine/src/host/meta/modules/PlayerDataSync.js`) вызывает эти
роуты, чтобы загрузить rank/state участника на join и слить их обратно на
границах конец-раунда/смены-карты/выхода — см.
[host.md](host.md#синхронизация-rank-и-state-игрока-этап-b4). Свои `hostId`/
`hostSecret` он узнаёт из `host_registered` (`HostController.setHostId`,
передаётся в Worker сообщением `set_host_id` и переживает эстафету Worker'ов
через `room.hostId`/`room.hostSecret`) и с этого момента несёт их в каждом
теле `PUT`. `express.json()` подключён в `main.js`, чтобы разбирать тела `PUT`
(`{ delta, hostId, hostSecret }`/`{ state, hostId, hostSecret }` — `/rank`
принимает дельту матча, не абсолютное значение, с server-rating этапа 1; см.
[auth.md](auth.md#rest-api)).

### GET /auth/leaderboard, GET /auth/placement

Проксирует `GET /leaderboard` и `GET /placement` центрального auth-сервиса
(lobby-page-plan, см. [auth.md](auth.md#rest-api)) под origin мастера:

- `GET /auth/leaderboard?game=&limit=&period=` — публичный (без Bearer-токена), идёт
  через `LeaderboardCache` (`packages/engine/src/master/LeaderboardCache.js`,
  кодревью L2) перед `PlayerDataProxy.getLeaderboard(game, limit)`.
  `400 gameRequired`, если `game` не передан, `404 unknownGame`, если его нет
  в `gameCatalog.ids`, `limit` клампится в `1..leaderboard.maxLimit` (дефолт
  `10`, `maxLimit` из конфига, по умолчанию `100`) ещё до кэша,
  `502 authServiceUnavailable` при сбое апстрима. Ответ несёт
  `Cache-Control: public, max-age=15` (браузерное усиление серверного TTL).
  `period` (`day`/`month`/`all`, по умолчанию `all` — rank-periods)
  проверяется здесь, а не пробрасывается вслепую: незнакомый срез — это
  `400 badPeriod` без похода в auth-сервис. Он же входит в ключ кэша, так
  что три среза одной игры не отвечают друг за друга.
- `GET /auth/placement?game=&period=` — идёт через тот же хелпер `forwardPlayerData`, что
  и `/auth/rank`/`/auth/state` (нужны Bearer-токен и `?game=`, те же случаи
  `400`/`404`/`502`), пробрасывается в `PlayerDataProxy.getPlacement(token, game)`.
  Per-user данные, никогда не кэшируются — `forwardPlayerData` шлёт
  `Cache-Control: no-store` на каждый ответ. `period` читается и
  проверяется перед проксированием ровно так же, как у лидерборда.

`PlayerDataProxy._request` опускает заголовок `Authorization`, если вызван с
`token === null` (так же, как `HostRatingProxy.getPublic` уже делает для
`GET /host-rating/:hosterUserId`) — `getLeaderboard` пользуется этим, чтобы
оставаться без авторизации, пока `getRank`/`getState`/`getPlacement`
по-прежнему пробрасывают Bearer-токен вызывающего как есть.

`LeaderboardCache` оборачивает `PlayerDataProxy.getLeaderboard` keyed-TTL
кэшем в памяти (`` `${game}:${limit}` `` → `{ at, result }`, та же схема, что
и однослотовый TTL-кэш `JwksProxy`): `/auth/leaderboard` — самый частый
анонимный запрос лобби (каждое открытие + переключение игры/вкладки), а
лежащая в основе выборка меняется медленно. Кэшируется только ответ со
`status === 200` — иначе `5xx` апстрима «залипал» бы на весь TTL.
`placement` (per-user, Bearer-токен) через этот кэш не идёт. TTL
(`leaderboard.cacheTtl`, дефолт 15000 мс) и часы (`now`, инъекция для
детерминированных тестов) конфигурируемы; карта не растёт неограниченно —
`limit` клампится, и пространство ключей фактически `O(число игр)`.

### Составной `codeVersion`

`host_registered.codeVersion` — `{ engine, game: { id, version } }` (Этап
6.5): `engine` — `WorkerCatalog.version` (хеш worker-бандла хоста, единый на
весь деплой); `game.id`/`game.version` — id объявленной игры и
`GameCatalog.getManifest(id).version` (fallback на самоприсланный хостом
`gameVersion` только если каталог не знает эту игру). Расхождение любой
половины — деплой движка ИЛИ деплой игры-плагина — это рассинхрон кода: хост
перечитывает `GET /worker/manifest.json` **и** `GET /games/:id/manifest.json`,
затем меняет Worker сразу на свежий бандл *и* свежие
`entries.host`/`entries.wasm` одной эстафетой — деплой только игры запускает
её точно так же, как деплой только движка. Протокол свопа и
`HANDOFF_VERSION` — см. [host.md](host.md#эстафета-workerов).

### POST /debug/report (только dev)

Приёмник браузерной половины отладочного контура: вкладка хоста выгружает
сюда записанный сценарий или дамп состояния, файл ложится в тот же
`.debug/`, куда пишет headless-runner, — см.
[debugging.md](debugging.md#выгрузка-post-debugreport).

Маршрут регистрируется **только при `!isProduction`**: в проде это была бы
запись на диск по запросу произвольного клиента. У него свой парсер тела
(`express.json({ limit: '8mb' })`, поднят до глобального стокилобайтного) —
записанный матч заведомо не влезает в дефолтный лимит.

```
POST /debug/report
{ "kind": "scenario" | "dump" | "divergence", "payload": {...}, "note": "танк в стене" }

→ 200 { "file": "scenario-<метка>-1.json", "bytes": 24576 }
→ 400 { "error": "unknown kind 'x'" }   // kind из закрытого списка: имя файла собирается из данных запроса
→ 413 { "error": "payload too large: ... > 8388608" }
```

`packages/engine/src/master/DebugReportStore.js` пишет
`{ kind, note, receivedAt, payload }` и логирует результат как
`[vimp:debug] report saved: …`.

## Сигнальный протокол (WebSocket)

Сообщения — JSON-объекты с полем `type`. При подключении соединение проходит проверку `Origin` (allowlist через `security.createOriginValidator`; отсутствие `Origin` — немедленный `terminate`, чужой — закрытие с кодом `4001`), затем получает:

```json
{ "type": "welcome", "id": "<uuid соединения>", "iceServers": [{ "urls": "stun:…" }] }
```

`iceServers` — ICE-конфигурация для `RTCPeerConnection` (STUN обязателен; TURN — опциональный релей).

Клиентская сторона сигналинга — [packages/engine/src/client/network/SignalingClient.js](../../packages/engine/src/client/network/SignalingClient.js): подключается к этому WS, потребляет `welcome`/`iceServers`, шлёт `webrtc_offer`/`ice_candidate`/`ping_host`/`like_host`/`unlike_host` и ретранслирует входящие сообщения по `type`. Игровой трафик после установки P2P идёт по WebRTC (`WebRtcManager`), минуя мастер — см. [client.md](client.md#сетевой-слой-packagesenginesrcclientnetwork) и [network.md](network.md#транспорт-webrtc).

### Сообщения хоста

| → мастеру | Ответ / эффект |
| --- | --- |
| `register_host { name, maxPlayers, mapName, gameId, gameVersion, token }` | `host_registered { hostId, hostSecret, gameId, mapsVersion, codeVersion }` (`hostSecret` — per-room возможность для атрибуции rank/state, см. выше); регион — из заголовка, IP — из соединения; `token` — Bearer identity-токен хостера (server-rating этап 2), проверяется по JWKS central auth-сервиса (`JwksProxy`) — его `sub` становится `hosterUserId`, сохраняется в сессии для атрибуции рейтинга; отсутствие/неверная подпись → ошибка `invalidToken`. Перед созданием комнаты мастер также запрашивает у auth-сервиса собственный рейтинг хостера (`HostRatingProxy.getRating`) — `blocked: true` → ошибка `blocked` (хостер с рейтингом на `rating.blockAt` не может поднять комнату); сбой самого запроса (auth недоступен) шлёт ошибку `authServiceUnavailable` вместо того, чтобы оставить клиента без ответа навсегда (фикс кодревью); `gameId`/`gameVersion` — какую игру-плагин и версию манифеста запустил хост (сохраняются в сессии, эхо в ответе; с Этапа 6.4 их шлёт каждый хост — `connectAsHost` собирает `room.game` из активного `GameManifest`); `mapsVersion` — `GameManifest.maps.version` объявленной игры через `GameCatalog` (`null`, если `gameId` неизвестен каталогу); `codeVersion` — составной `{ engine, game: { id, version } }` (Этап 6.5, см. выше; `engine` — версия worker-бандла) — при re-register после разрыва (деплой рестартует мастер) хост сверяет их со своими: расхождение карт → перечитывание каталога, расхождение любой половины `codeVersion` → эстафета Worker'ов. Ошибки: `alreadyRegistered`, `gameUnavailable` (`gameId` называет игру, помеченную каталогом несовместимой — `compat.ok === false`), `hostLimit` (уже есть комната с этого IP) |
| `update_host { currentPlayers, mapName }` | актуализация данных комнаты (одновременно heartbeat) |
| `heartbeat {}` | обновление `lastSeen` |
| `webrtc_answer { clientId, sdp }` | пересылается клиенту как `webrtc_answer { hostId, sdp }` |
| `pong_host { clientId, pingId }` | пересылается клиенту как `pong_host { hostId, pingId }` |

Хост держит сигнальный WS постоянно. Комната без heartbeat дольше `host.heartbeatTimeout` (30 с) удаляется из реестра, её соединение закрывается кодом `4000` (проверка каждые `host.sweepInterval`). Разрыв WS хоста также удаляет комнату.

### Сообщения клиента

| → мастеру | Ответ / эффект |
| --- | --- |
| `webrtc_offer { hostId, sdp }` | пересылается хосту как `webrtc_offer { clientId, sdp }`; ошибка `unknownHost` |
| `ping_host { hostId, pingId }` | пересылается хосту; ограничен rate limiter'ом по IP (`pingRateLimit`, ошибка `rateLimited`). Замер **приблизительный** (клиент→мастер→хост, не P2P RTT) |
| `like_host { hostId, reason, token }` / `unlike_host { hostId, reason, token }` | голос рейтинга сервера (+1 / -1), заменяет прежнюю жалобу `/ban`: принимается **только от сессии, слававшей `webrtc_offer` этой комнате** (иначе ошибка `voteRejected`); `token` — Bearer identity-токен голосующего, проверяется так же, как у `register_host` (ошибка `invalidToken` при отсутствии/невалидности); причина обязательна (голос без неё не отправляется). Голос проксируется в central auth-сервис (`HostRatingProxy.vote`, цель — `hosterUserId` комнаты) — `voteHost` перезаписывает одну строку на пару `(hoster, voter)` (мнение меняемо, `like`↔`unlike`, а не копится) и пересчитывает `score = clamp(SUM(value), rating.min, rating.max)`; `blocked: true` в ответе эвакуирует хостера (`_evacuateHoster`, см. ниже). Сбой запроса к апстриму (auth недоступен) шлёт ошибку `authServiceUnavailable` вместо того, чтобы молча проглотить голос (фикс кодревью) |

### Общие сообщения

| → мастеру | Эффект |
| --- | --- |
| `ice_candidate { targetId, candidate }` | пересылается адресату (`targetId` — `hostId` или `clientId`) как `ice_candidate { fromId, candidate }` |

Ошибки приходят как `{ "type": "error", "code": "<код>" }`. Невалидный JSON и неизвестные `type` молча игнорируются.

## Рейтинг сервера (`/like`·`/unlike`)

Единственная анти-чит-мера проекта. Браузерный хост физически исполняет
симуляцию у себя в процессе — WASM-память доступна ему из JS, и модифицированный
клиент может читерить в обход логики ядра. Техническая защита против этого
невозможна без переноса авторитетности обратно на доверенный сервер (что
противоречит цели P2P), поэтому единственная мера — социальная.

Голос перехватывается **на клиенте** (`packages/engine/src/client/main.js`, команды `/like <причина>`/`/unlike <причина>`) и уходит **напрямую мастеру** по сигнальному WS, минуя хоста: его `CommandProcessor` мог бы отфильтровать голос против самого себя. Причина обязательна (гейт на стороне клиента), публично не отображается.

Логика рейтинга (`SignalingServer` + central auth-сервис, [auth.md](auth.md#схема-бд)):

- голос принимается только от сессии, реально подключавшейся к комнате (слала ей `webrtc_offer`) — проверка членства в `SignalingServer._vote` (`session.offeredHosts`); причина обязательна — голос без непустого `reason` не отправляется.
- и `register_host`, и `like_host`/`unlike_host` несут Bearer identity-токен; `SignalingServer` проверяет его по JWKS auth-сервиса (тот же `verifyIdentityToken`, каким пользуется Worker хоста), чтобы получить доверенный `hosterUserId`/`voterUserId` — IP здесь для идентичности не годится: вся суть в блокировке именно *хостера*, а не IP, который тривиально меняется новой вкладкой.
- фактическое хранение score/голосов централизовано в БД auth-сервиса (`host_ratings`/`host_votes`), не в памяти мастера: оно должно быть глобальным (заблокированный на одном мастере хостер остаётся заблокированным везде) и персистентным (нужно для аннулирования rank/skills, этап 4 плана). `HostRegistry` лишь кэширует текущий `rating` на каждую комнату (этап 3 — чтобы `GET /servers` не ходил в БД на каждый запрос) — источником истины он не является.
- `HostRatingProxy.vote` возвращает `{ score, blocked, counted }`; при `blocked: true` `SignalingServer` закрывает сигнальный WS хоста кодом `4002` — новые WebRTC-офферы к нему больше не маршрутизируются (уже установленные P2P-пиры это не рвёт, host-migration нет: читер остаётся в комнате один). Возвращённый `score` тут же обновляет кэш `HostRegistry` для этой комнаты (`registry.setRating`), поэтому голос отражается в лобби, не дожидаясь очередного периодического опроса.
- при `register_host` `HostRatingProxy.getRating` сначала проверяет собственный рейтинг хостера — `blocked: true` отклоняет комнату ошибкой `blocked` ещё до её создания; его `score` заодно сеет закэшированный `rating` новой комнаты.
- `SignalingServer.refreshRatings()` (этап 3) периодически переопрашивает рейтинг каждой активной комнаты через `HostRatingProxy.getPublic` (`GET /host-rating/:hosterUserId`, без авторизации — Bearer-токен конкретного хостера между запросами не хранится) и записывает его в `HostRegistry` через `setRatingForHoster`, по ключу `hosterUserId` (не `hostId` — если хостер держит несколько комнат, обновляются все разом). Это единственный путь, который подхватывает изменение счёта голосом на *другом* мастере или после рестарта этого; `main.js` запускает его самоперезапускающимся циклом на `setTimeout`, а не обычным `setInterval` (фикс кодревью — медленный auth с большим числом активных хостеров иначе мог бы наслаивать циклы друг на друга), выжидая `rating.refreshInterval` (по умолчанию 30 с) после завершения каждого цикла. Сбой опроса одного хостера логируется и не прерывает обход остальных. Если опрос вернул `blocked: true`, `refreshRatings` вызывает тот же хелпер `_evacuateHoster`, что и голос, пересёкший `blockAt` на этом мастере (фикс кодревью): закрывает сигнальный WS всех активных комнат этого хостера кодом `4002` и удаляет их из `HostRegistry` через `getHostIdsForHoster`. Без этого хостер, заблокированный на мастере A (или заблокированный до последнего рестарта этого мастера), держал бы присоединяемую комнату здесь до следующей попытки `register_host`.

Осознанное ограничение принятой модели «минимум анти-чита»: базовая гигиена
среды (см. «Защита» ниже) отсекает «уличных» злоумышленников, но не хоста,
исполняющего оригинальный WASM и правящего его память из JS — более тяжёлые
схемы (кросс-валидация состояний хоста через теневых валидаторов, серверные
реплей-проверки, криптографические подписи снапшотов) были рассмотрены и
отклонены: все они в итоге доверяют потоку вводов/данных, которым управляет
сам проверяемый хост.

**Наблюдаемость**: заблокированный хостер пишется в консоль мастера (`[rating] hoster ... blocked (score ...)`) — это единственное место, где это видно со стороны мастера (админ-панель лобби покрывает только модерацию игр; причины голосов наружу не отдаются, они существуют только как аудит в колонке `host_votes.reason` auth-сервиса).

## Защита

- **Origin-allowlist** — паттерн `packages/engine/src/lib/security.js` (`createOriginValidator` с параметрами мастера).
- **1 комната на IP** — проверка в `HostRegistry.add`; хостер с рейтингом на `blockAt` отклоняется независимо от IP (`HostRatingProxy.getRating`, см. выше).
- **Rate limiting пингов** — `RateLimiter` (фиксированное окно, по умолчанию 10 запросов/с с IP).
- **Адрес для обоих ограничений** даёт `clientIp()` (`src/lib/clientIp.js`): адрес сокета, а за прокси — `X-Real-IP` (`trustProxy`, приходит из `lobby.js` как `isProduction`). `X-Forwarded-For` не используется намеренно: Nginx деплоя ставит его через `$proxy_add_x_forwarded_for`, то есть *дописывает* реальный адрес к присланному клиентом, и первый адрес списка задаёт сам клиент — ключ по нему снимал бы оба ограничения одним заголовком и позволял занять чужой бакет, закрыв человеку возможность поднять комнату. `X-Real-IP` тот же Nginx ставит из `$remote_addr`, перезаписывая присланное клиентом. Прокси, который его не ставит, схлопывает всех клиентов на свой собственный адрес — один общий бакет, то есть на всём мастере смогла бы существовать ровно одна комната; `clientIp()` в этом случае один раз пишет предупреждение в лог, а обязательный `proxy_set_header` перечислен в [deployment.md](deployment.md#обязательный-заголовок-прокси-x-real-ip). Соединение, у которого адреса нет вовсе (сокет уже разорван), обрывается; слушатель `error` вешается до этого, поэтому поздний `ECONNRESET` на нём не станет `uncaughtException`.
- **Security-заголовки** (гигиена среды) — мастер ставит `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY` на все ответы; `Content-Security-Policy` — только в проде (в dev сломала бы Vite HMR). Прод-статику и `.wasm` с CSP отдаёт Nginx — см. [deployment.md](deployment.md); единый source of truth политики — `packages/engine/src/config/master.js` (`security.csp`, функция от `authServiceUrl` — см. [auth.md](auth.md#вход-в-лобби-клиент) — чтобы `connect-src` разрешал fetch `POST /nick` лобби к central auth-сервису; `security.authServiceUrl` переопределяется `VIMP_AUTH_SERVICE_URL` в проде).
- Санитизация входных строк (`sanitizeMessage`), clamp числовых полей.

## Тесты

`tests/master/` (node-проект Vitest): `HostRegistry.test.js` (регистрация и атрибуция `hosterUserId`, лимит по IP, heartbeat/уборка, вся логика выборки `GET /servers` включая поиск `gameId/name` — lobby-page-plan, хранение `gameId`/`gameVersion`, закэшированный `rating`/`setRating`/`setRatingForHoster`/`getHosterUserIds` — этап 3), `SignalingServer.test.js` (жизненный цикл соединений, маршрутизация всех сигнальных сообщений на фейковых ws, проверка identity-токена по настоящему RSA-подписанному JWKS, rate limiting, membership-проверка и блокировка голосов рейтинга, уборка протухших хостов, `mapsVersion`/`codeVersion` в `host_registered`, per-game `mapsVersion` через стаб `gameCatalog`, кэш `rating` при регистрации/голосе и периодический опрос `refreshRatings()` — этап 3), `MapCatalog.test.js` (манифест, выдача карт, стабильность версии), `WorkerCatalog.test.js` (версия-хеш и URL бандла, пустой каталог в dev, выбор новейшего из нескольких), `GameCatalog.test.js` (резолв сконфигурированных `{id, package}` в `node_modules/<package>/dist/manifest.json`, per-game каталоги карт, несобранная/неизвестная игра, подмена entries на `/@fs/` в dev), `JwksProxy.test.js` (проксирование, TTL-кэш и его истечение, сбой апстрима — инъекция `fetchImpl`), `PlayerDataProxy.test.js` (проксирование GET/PUT `/rank`+`/state`, публичный `getLeaderboard` (без заголовка `Authorization`, `limit` в query) и per-user `getPlacement` — lobby-page-plan, отсутствие кэша, сбой апстрима — инъекция `fetchImpl`), `LeaderboardCache.test.js` (промах зовёт proxy, хит в пределах TTL — нет, рефетч после истечения TTL, не-200 не кэшируется, `game`/`limit` — разные ключи кэша — инъекция `now`, кодревью L2), `HostRatingProxy.test.js` (проксирование GET `/host-rating` + PUT `/host-rating/:hosterUserId` с Bearer-токеном, `getPublic` без авторизации (`GET /host-rating/:hosterUserId`), отсутствие кэша, сбой апстрима — инъекция `fetchImpl`). Направление реестра добавляет `GameRegistryProxy.test.js` (все вызовы реестра, проброс токена), `npmRegistry.test.js` (пакумент, разрешение версии, несовпадение `integrity`/`shasum`, потолки размера и числа файлов), `gamePackageCheck.test.js` (структурные правила, код не исполняется), `GameStore.test.js` (скачивание, идемпотентный `ensure`, стейджинг, который физически не попадает в раздачу, `prune`), `GameSync.test.js` (проход, отказ реестра не трогает каталог, прилинкованная игра важнее, per-game `lastError`), `rebaseManifest.test.js` (версионная база, `wasmNode` не тронут), `adminAuth.test.js` (подпись, issuer, клейм `role`) и `lobbyGamesRoutes.test.js` (обработчики заявки и модерации на стабах зависимостей). Rate limiter — `tests/lib/rateLimiter.test.js`.

---

[← Предыдущая: Архитектура](architecture.md) · [Следующая: Центральный auth-сервис →](auth.md)
