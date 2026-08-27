# Конфигурация

Эта страница описывает **конфигурацию самого движка**. Игра-плагин
(например, `@vimp-games/tanks`) поставляет свою половину через контракт плагина
(`HostPlugin.gameConfig`/`authSchema`/`buildClientGameConfig()`,
`ClientPlugin` — см. [plugin-api.md](plugin-api.md)) и документирует её в
доках своего репозитория (например, `docs/ru/configuration.md` в
`vimp-tanks`).

Конфигурация движка разделена на два уровня:

1. **Переменные окружения** (`.env`) — параметры инстанса мастер-сервера (домен, порт). Применяются только в production.
2. **`packages/engine/src/config/`** — общие конфиги, используемые мастером (Node.js), Worker'ом браузерного хоста и клиентом (Vite-бандл).

Мастер собирает свой конфиг в единое хранилище `packages/engine/src/lib/config.js` (доступ по пути с двоеточием) в [packages/engine/src/master/main.js](../../packages/engine/src/master/main.js); Worker хоста ([packages/engine/src/host/host.worker.js](../../packages/engine/src/host/host.worker.js)) собирает конфиг игры как merge движковых дефолтов (`hostDefaults`) и игровой половины из `HostPlugin`, загружаемого динамически по манифесту активной игры (`gameConfig`, `authSchema`, `buildClientGameConfig()`), применяя поверх настройки комнаты. Клиент получает свой конфиг (CONFIG_DATA) от хоста при подключении (порт `0`).

## Переменные окружения (.env)

Читает [packages/engine/src/config/env.js](../../packages/engine/src/config/env.js). Лобби-мастер применяет их только при `NODE_ENV=production` (запуск `npm start` использует `node --env-file .env`); в режиме разработки они игнорируются — действуют значения из `packages/engine/src/config/master.js`. [Dedicated-сервер](dedicated.md) применяет их **всегда** — другого источника игры, порта и настроек комнаты у него нет.

| Переменная | Назначение | По умолчанию |
| --- | --- | --- |
| `NODE_ENV` | `production` / `development` | — |
| `VIMP_DOMAIN` | Домен мастера. **Обязательна** в production (иначе процесс завершится с ошибкой) | `localhost` |
| `VIMP_MASTER_PORT` | Порт мастер-сервера | `3002` |
| `VIMP_AUTH_SERVICE_URL` | Origin central auth-сервиса (`packages/auth`), переопределяет `security.authServiceUrl` — используется в CSP `connect-src` и прокси-роутах `/auth/*` ([auth.md](auth.md), [deployment.md](deployment.md#central-auth-сервис-packagesauth)) | `http://localhost:3010` |
| `VIMP_DEDICATED_GAME` | id игры из `master:games`; если задана, `src/master/main.js` поднимает [dedicated-сервер](dedicated.md) вместо лобби-мастера | — |
| `VIMP_DEDICATED_ROOM` | JSON-объект с настройками комнаты dedicated-сервера (`map`, `maxPlayers`, `roundTime`, `mapTime`, `friendlyFire`, `seed`); мусор в переменной — отказ при старте | `{}` |
| `GAMES_MATRIX` | JSON-массив, переопределяющий `master:games` (список игр-плагинов, резолвится `GameCatalog`, `{id, package}[]`), читается и в dev — см. [master.md](master.md#get-gamesmanifestjson-get-gamesidmanifestjson-get-gamesidmaps) | `[{"id":"tanks","package":"@vimp-games/tanks"}]` |

Вне прода каталог ещё и **собирается сам**: если `GAMES_MATRIX` не задана, в `master:games` добавляется каждый собранный пакет `@vimp-games/*`, найденный в `node_modules` (обычной зависимостью или симлинком `npm link`) — по возрастанию id и впереди записей конфига (`src/master/localGames.js`). Прилинкованная игра появляется в лобби без правки опубликованного конфига движка. Первая запись каталога — активная игра лобби; чтобы закрепить, какая именно, задайте `GAMES_MATRIX` локально.

Игровые параметры (карта, лимит игроков, таймеры, friendly fire) в лобби-контуре переменными окружения не задаются (`VIMP_DEDICATED_ROOM` там не действует): их выбирает создатель комнаты в лобби, а дефолты живут в `packages/engine/src/config/hostDefaults.js` (движковые) и в собственном конфиге активной игры-плагина (игровые).

У `VIMP_AUTH_SERVICE_URL` есть аналог для сборки: `VITE_AUTH_SERVICE_URL` —
это Docker build `ARG` (не runtime-переменная `.env`), которую Vite
подставляет в клиентский бандл (`authClient.js:serviceUrl`) при сборке
образа (`npm run build:app`) — см. [auth.md](auth.md#вход-в-лобби-клиент) и
[deployment.md](deployment.md#central-auth-сервис-packagesauth). Обе
задаются из одной и той же переменной репозитория GitHub
`AUTH_SERVICE_URL` в `deploy.yml`.

### Auth-сервис (`packages/auth`)

Читаются в [packages/auth/src/main.js](../../packages/auth/src/main.js) при
`NODE_ENV=production`; при отсутствии любой из них сервис завершается при
старте (см. [auth.md](auth.md#запуск)).

| Переменная | Назначение | По умолчанию |
| --- | --- | --- |
| `VIMP_AUTH_DATABASE_URL` | строка подключения к PostgreSQL | `postgres://localhost:5432/vimp_auth` |
| `VIMP_AUTH_PORT` | порт auth-сервиса | `3010` |
| `VIMP_AUTH_PUBLIC_URL` | собственный публичный origin — для OAuth `redirect_uri`. **Обязательна** в production | — (в dev fallback на `http://localhost:PORT`) |
| `VIMP_AUTH_ALLOWED_ORIGINS` | CSV origin'ов мастеров, которым разрешён CORS `POST /nick` и OAuth-редирект (`returnUrl`). **Обязательна** в production | `https://localhost:3002` (только в dev) |
| `VIMP_AUTH_STATE_SECRET` | HMAC-секрет для stateless OAuth `state`. **Обязательна** в production | — |
| `VIMP_AUTH_GITHUB_CLIENT_ID` / `VIMP_AUTH_GITHUB_CLIENT_SECRET` | реквизиты GitHub OAuth App. **Обязательны** в production | — |

## packages/engine/src/config/hostDefaults.js — движковые дефолты хоста

Источник: [packages/engine/src/config/hostDefaults.js](../../packages/engine/src/config/hostDefaults.js). Движковая половина конфига хоста: лимиты, таймеры, кик-политики, спектаторский keyset (наблюдение — механизм движка). Worker хоста merge'ит её с `HostPlugin.gameConfig` активной игры-плагина и применяет поверх настройки комнаты.

| Параметр | Значение | Описание |
| --- | --- | --- |
| `isDevMode` | `false` | Флаг режима разработки: открывает dev-команды чата и отладочный рекордер в `HostGame` ([debugging.md](debugging.md#рекордер)). Комната берёт его из `room.isDevMode`, который клиент выставляет из `import.meta.env.DEV`; в прод-бандле остаётся `false` |
| `maxPlayers` | `30` | Дефолтный лимит участников; комната хоста ограничивает его настройкой создателя (кламп к `roomDefaults.maxPlayers` игры), лимит считается по людям |
| `chatMaxLength` | `60` | Максимальная длина сообщения чата (авторитетно на хосте; должна совпадать с `maxlength` инпута в `chat.pug`) |
| `spectatorKeys` | `nextPlayer`/`prevPlayer` | Команды наблюдателя и неактивного игрока (переключение наблюдаемого) |

### Таймеры (`timers`, мс)

| Параметр | Значение | Описание |
| --- | --- | --- |
| `timeStep` | `1000/120` | Шаг физического тика ядра (~120 Гц) |
| `networkSendRate` | `4` | Снапшот отправляется каждый N-й тик (4 → 30 пакетов/сек) |
| `roundTime` | `120000` | Время раунда |
| `mapTime` | `600000` | Время карты |
| `roomTimeMin` / `roomTimeMax` | `10000` / `3600000` | Серверные границы клампа пользовательских `roundTime`/`mapTime` комнаты (форма лобби — не граница доверия) |
| `voteTime` | `10000` | Время жизни окна голосования |
| `timeBlockedVote` | `30000` | Кулдаун между голосованиями одной темы |
| `teamChangeGracePeriod` | `10000` | Окно смены команды в начале раунда |
| `roundRestartDelay` | `5000` | Пауза между раундами |
| `mapChangeDelay` | `2000` | Пауза перед сменой карты после голосования |
| `rttPingInterval` | `3000` | Интервал RTT-пингов |
| `idleCheckInterval` | `30000` | Периодичность проверки бездействия |

### Кики (`rtt`, `idleKickTimeout`)

- `rtt.maxMissedPings: 5` — количество подряд пропущенных pong-ответов до кика;
- `rtt.maxLatency: 1000` — сглаженная (EMA) задержка (мс), при превышении которой игрок кикается; порог рассчитан на P2P-хостинг с домашних каналов (реальный RTT 200–300 мс и спайки на смене карты — норма);
- `idleKickTimeout.player: 120000` — кик игрока за бездействие (2 минуты);
- `idleKickTimeout.spectator: null` — `null` отключает кик (наблюдатели не кикаются).

## Игровая половина конфига хоста

Игровая половина конфига хоста приходит в Worker полем `gameConfig`
активной игры-плагина (`host.worker.js` грузит `HostPlugin` динамически по
`entries.host` активного `GameManifest`) — параметры вроде `friendlyFire`,
`mapScale`, `teams`, `scripted`, `soundCues`, схемы `stat`/`panel`/
`playerKeys` и `playerState.defaultState`. Это полностью игровые данные —
их конкретные значения см. в доках активной игры-плагина (например,
`docs/ru/configuration.md` в `vimp-tanks`). Механика синхронизации
rank/state (движковая сторона) — [auth.md](auth.md#загрузка-и-синхронизация-rank-и-state-хост)
и [host.md](host.md#синхронизация-rank-и-state-игрока-этап-b4); `rank` и
`state` для движка непрозрачны — форму интерпретирует только игра.

`spectatorKeys` — команды наблюдателя (`nextPlayer`/`prevPlayer`); набор
движковый, живёт в `packages/engine/src/config/hostDefaults.js`.
`playerKeys` (команды игрока) — игровой конфиг, каждая клавиша имеет
битовую маску `key` (`1 << n`, используется предиктором и ядром в истории
ввода) и опциональный `type`:

- `type: 0` (по умолчанию) — многократное действие: начинается на keyDown, завершается на keyUp (движение, поворот башни);
- `type: 1` — срабатывает один раз на keyDown.

## Клиентский конфиг: clientDefaults.js + собственный клиентский конфиг игры

Клиентский CONFIG_DATA собирается из двух половин: движковые дефолты — [packages/engine/src/config/clientDefaults.js](../../packages/engine/src/config/clientDefaults.js) (интерполяция, режимы/служебные клавиши управления, DOM-структуры движковых модулей, `techInformList`) и игровая половина, которую поставляет `HostPlugin.buildClientGameConfig()` активной игры-плагина (`parts.*`, канвасы, keyset игрока, схемы panel/stat, тексты chat/vote/gameInform, `initIdList`). Deep-merge выполняет [packages/engine/src/lib/buildClientConfig.js](../../packages/engine/src/lib/buildClientConfig.js) в Worker'е хоста; перед отправкой он дописывает:

- `modules.vote.params.time` = `game:timers:voteTime`;
- `prediction` — данные для клиентской реплики движения и стрельбы (`timeStep`, `playerKeys`, `models`, `weapons`, всё игровое).

Полная таблица, какие поля конфига движковые, а какие поставляет игра, — в [plugin-api.md](plugin-api.md#clientplugin-api) (раздел `ClientPlugin API`).

### `interpolation` — snapshot-интерполяция (движок)

- `delay: 100` — мс; мир рендерится в прошлом (`renderTime = serverNow − delay`), ~3 кадра при 30 пакетах/сек;
- `maxFrameAge: 1000` — страховочная очистка старых кадров буфера.

### `divergence` — детектор рассинхрона предикта (движок, опционально)

В боевом конфиге секции нет, и тогда путь кадра не делает ничего лишнего.
Читается клиентским ядром, в headless-прогоне задаётся полем `divergence`
сценария: `thresholds` (позиционно по player-блоку), `defaultThreshold`,
`capacity` (кольцевой буфер). См.
[debugging.md](debugging.md#детектор-рассинхрона-предикта).

### `modules.canvasManager` — полотна и камера

Общие параметры `dynamicCamera` — движковые; набор полотен `canvases` — игровой. Canvas-элементы генерирует `main.js` из этого конфига (ключ — id элемента; `width`/`height` — стартовый размер до первого resize):

| Параметр | Описание |
| --- | --- |
| `aspectRatio` | Соотношение сторон (`'16:9'`). Canvas заполняет максимум окна, сохраняя пропорцию. Без параметра — 100% окна |
| `fixSize` | Фиксированный размер в px (`'150'` — квадрат, `'200:100'` — прямоугольник). Отключает `aspectRatio` и адаптивное масштабирование |
| `baseScale` | Базовый зум (`'Числитель:Знаменатель'`). Для адаптивных полотен — масштаб при эталонной ширине 1920px (`итог = ширина/1920 × baseScale`); для фиксированных — постоянный множитель |
| `dynamicCamera` | Включает динамическую камеру (look-ahead + zoom от скорости) |
| `shakeCamera` | Разрешает тряску камеры |

Адаптивное масштабирование гарантирует одинаковый угол обзора на любых мониторах (эталон — Full HD 1920px).

`dynamicCamera` (общие параметры): `lookAheadFactor` (смещение камеры вперёд по движению), `zoomOutFactor`/`maxZoomOut` (отдаление от скорости), `smoothnessPosition`/`smoothnessZoom`/`smoothnessVelocity` (плавность).

**`pointerCanvas`** (игра, необязательный) — полотно, в систему координат которого пересчитывается канал указателя; по умолчанию первое объявленное.

Имена полотен, размеры и зум — данные игры; напр. `vimp-tanks` задаёт `vimp` (16:9, зум 5:1, динамическая камера, тряска) и `radar` (150×150px, масштаб 1:8).

### `modules.controls` — управление

- **`keySetList`** (игра) — массив наборов `keyCode: 'команда'`, целиком заданных игрой (напр. `vimp-tanks` использует два: `[0]` — наблюдатель (`n`/`p` — переключение наблюдаемого игрока), `[1]` — игрок (`w/s/a/d` — движение, `k/l/u` — башня, `j` — огонь, `n/p` — смена оружия)). Какой набор активен, диктует хост через порт `17` (KEYSET_DATA).
- **`pointer`** (игра, необязательный) — канал указателя (мышь/палец/стилус). Без этого ключа движок не вешает ни одного слушателя указателя. Поля: `keySets` (индексы наборов `keySetList`, в которых канал живой; по умолчанию все), `doubleTapMs` / `doubleTapPx` (пороги двойного тапа, по умолчанию `300` / `40`), `sendIntervalMs` (минимум между двумя `move`, по умолчанию `50`). Формат провода — `"seq:aim:x:y:flags"` с **мировой** точкой; см. [client.md](client.md) и [../ai/04-client-plugin.md](../ai/04-client-plugin.md).
- **`modes`** (движок) — режимы UI: `c` — чат, `m` — голосование, `tab` — статистика.
- **`cmds`** (движок) — служебные клавиши (`escape`, `enter`), имеют высший приоритет и используются внутри режимов.

### Прочие модули

DOM-структуры (`elems`) — движковые; тексты и схемы — игровые:

- **`chat`** — id DOM-элементов, лимиты вывода (`listLimit: 5` строк, `lineTime: 15000` мс) и кэш — движок; **шаблоны системных сообщений** (`messages`, игра): реестр кодов групп, движковые группы `s` (статусы/команды), `v` (голосования), `m` (карты), `c` (команды), `n` (имена) плюс любые группы, которые регистрирует игра-плагин (напр. `vimp-tanks` добавляет `b` для ботов). Хост шлёт только `'группа:номер:параметры'`, текст собирает клиент.
- **`panel`** — контейнер `containerId` (движок); сопоставление серверных ключей (`t`, `h`, `wa`, `w1`, `w2`) полям (`keys`) и типизированная схема полей `fields` (игра): упорядоченный список `{ name, elem, type: 'bar'|'value'|'time'|'weapon', max?, blocks? }` — `PanelView` генерирует DOM и поведение по типам, а не по именам полей.
- **`stat`** — id контейнера (движок); подписи колонок `columns`, таблицы шапок/тел (`heads`, `bodies`) и `sortList` (игра) — DOM scoreboard генерирует `StatView` по схеме; `sortList` — параметры сортировки: массив пар `[номер ячейки, по убыванию?]`; при равенстве сравнение переходит к следующей паре.
- **`vote`** — id/классы DOM (движок) и **шаблоны голосований** (`templates`, игра): `[заголовок с плейсхолдерами {0}, варианты (массив — статичные, строка — запросить список у хоста), timeOff]`. `menu` — пункты главного меню голосования.
- **`gameInform`** / **`techInformList`** — шаблоны игровых сообщений (id элемента — движок, тексты `list` — игра) и технических экранов (движок): комната полна, кик за бездействие/задержку и т.д.
- **`initIdList`** (игра) — какие модули/полотна инициализировать при старте (`vimp`, `radar`, `panel`, `chat`); механика инициализации — движковая (`main.js`).

## packages/engine/src/config/master.js

Конфиг мастер-сервера (см. [master.md](master.md)); читается `packages/engine/src/master/main.js` (и `vite.config.js` — `httpsOptions` для dev HMR):

- `protocol`, `domain`, `port` — адрес; порт по умолчанию `3002` (`3001` — Vite HMR). В production домен переопределяет `VIMP_DOMAIN`, порт — `VIMP_MASTER_PORT`;
- `httpsOptions` — пути к локальным сертификатам `.certs/key.pem`/`cert.pem` (только для разработки; в production HTTPS терминирует Nginx);
- `games` — список игр-плагинов, резолвится `GameCatalog`: `{id, package}[]` (по умолчанию — `@vimp-games/tanks`). `package` резолвится как обычная зависимость `node_modules/` (публикуется собственным репозиторием игры, например `vimp-tanks`), поэтому версию плагина задаёт запись в корневом `package.json`, а не этот список. В production переопределяется переменной окружения `GAMES_MATRIX` (JSON). У записи может быть и поле **`maxGameScore`** (snakes-v3) — потолок результата ОДНОЙ игры этой игры, которым мастер клампит `best`/`points` в `PUT /auth/rank`. Не задан — применяется `master:playerData:maxGameScore`: рабочий предел именно пер-игровой, потому что один точный предел на сотни игр неверен по построению;
- `servers` — параметры `GET /servers`: `regionThreshold: 15` (комнат меньше или столько — региональный фильтр и пагинация отключаются), `defaultLimit: 10`, `maxLimit: 50`;
- `leaderboard` — параметры `GET /auth/leaderboard` (кодревью L2, см. [master.md](master.md#get-authleaderboard-get-authplacement)): `cacheTtl: 15000` (TTL кэша `LeaderboardCache` в памяти, мс — это самый частый анонимный запрос лобби, а лежащая в основе выборка меняется медленно), `maxLimit: 100` (верхняя граница клампа `?limit=`, вместо прежней захардкоженной `100`);
- `placement` — параметры `GET /auth/placement` и агрегирующего `GET /auth/placements` (snakes-v3): `cacheTtl: 30000` — TTL кэша `PlacementCache` в памяти, мс. Место меняется медленно, а запрос за ним тяжелее топа (оконная функция по леджеру), и каждый вход участника стоит сразу трёх срезов — именно этот кэш держит оживлённое лобби подальше от auth-сервиса;
- `playerData` — потолок записи профилей (snakes-v3, «игр сотни, серверов сотни»): `writesPerMinute: 240` — `PUT /auth/rank` + `PUT /auth/state` на **проверенную комнату** в минуту, сверх этого `429`; и `maxGameScore: 10000` — дефолтный потолок результата одной игры для игры, не объявившей свой. Минимальный интервал между записями держит сторона хоста (`lobbyConfig.playerData`), а этот блок останавливает сломанный или злонамеренный сервер, который его обошёл;
- `host` — ограничения комнат: `maxNameLength: 30`, `maxPlayersLimit: 8`, `heartbeatTimeout: 30000` (без heartbeat дольше — комната удаляется), `sweepInterval: 10000`;
- `rating` — дефолт рейтинга сервера (`/like`·`/unlike`, заменяет прежний `/ban`, см. [master.md](master.md#рейтинг-сервера-likeunlike)): `min: -10`, `max: 10`, `blockAt: -10` (хостер с рейтингом на этом значении не может создавать комнаты); `refreshInterval: 30000` — как часто `main.js` вызывает `SignalingServer.refreshRatings()`, переопрашивая закэшированный `rating` каждой активной комнаты у auth-сервиса (этап 3 — подхватывает изменение счёта на другом мастере или после рестарта). Зеркалируется в `packages/auth/src/config/auth.js` (`rating`) — фактически клампит/решает `blocked` auth-сервис;
- `regionHeader: 'x-region'` — заголовок с регионом хоста от Nginx/CDN;
- `pingRateLimit` — лимит сигнальных `ping_host` с одного IP (`limit: 10` за `windowMs: 1000`);
- `security` (гигиена среды) — `csp` (строка Content-Security-Policy: single source of truth политики, в проде мастер ставит её на свои ответы, авторитетно на статику/`.wasm` — Nginx, см. [deployment.md](deployment.md)) и `referrerPolicy: 'no-referrer'`; заголовки `nosniff`/`X-Frame-Options`/`Referrer-Policy` мастер шлёт всегда, CSP — только в проде (в dev сломала бы Vite HMR);
- `iceServers` — ICE-конфигурация для клиентов и хостов (STUN; TURN — опционально).

## packages/engine/src/config/lobby.js

Конфиг клиентского лобби (см. [client.md](client.md#mvc-компоненты-packagesenginesrcclientcomponents)). В отличие от игрового клиентского конфига **бандлится в сборку**, а не приходит от хоста: лобби проходит до подключения к хосту.

- `serversUrl: '/servers'` — REST-эндпоинт мастера со списком серверов;
- `gamesManifestUrl: '/games/manifest.json'` — каталог игр мастера (`GameCatalog`): `roomDefaults` формы создания комнаты и ClientPlugin берутся отсюда;
- `maps` — каталог карт мастера, per-game функции-URL: `manifestUrl: gameId => '/games/<id>/maps/manifest.json'`, `baseUrl: gameId => '/games/<id>/maps'` — комната хоста стартует на актуальных картах активной игры (fallback на бандл при недоступности);
- `game` — манифест конкретной игры: `manifestUrl: gameId => '/games/<id>/manifest.json'` — эстафета Worker'ов перечитывает его перед свопом, чтобы новый Worker получил свежие `entries.host/wasm`;
- `worker` — манифест worker-бандла мастера: `manifestUrl: '/worker/manifest.json'` — Worker комнаты создаётся по `url` из манифеста, расхождение `codeVersion` при re-register запускает эстафету Worker'ов (fallback на бандловый URL без обновлений кода — dev/недоступность);
- `auth` — auth-эндпоинты, проксируемые мастером под своим origin: `jwksUrl: '/auth/jwks'` (Worker хоста фетчит его сам и проверяет подпись identity-токена входящего игрока, см. [auth.md](auth.md#вход-в-комнату-проверка-хостом)), `rankUrl: '/auth/rank'` / `stateUrl: '/auth/state'` (хост запрашивает их identity-токеном игрока на join и синхронизирует обратно по границам раунда/карты, см. [host.md](host.md));
- `playerData` — всё, что нужно `PlayerDataSync`, и движковый ответ на вопрос «как часто комнате позволено писать в базу» (snakes-v3). Эндпоинты: `rankUrl: '/auth/rank'` (`PUT` результата игры `{ points, best }`), `stateUrl: '/auth/state'`, `placementsUrl: '/auth/placements'` (агрегирующий роут — все три среза за один поход на входе) и `placementUrl: '/auth/placement'` (перезапрос одного среза из `refreshPlacement`). Бюджет: `minFlushInterval: 60000` мс на участника, `flushJitter: 0.2` (±20 % на комнату, чтобы сотни серверов не писали в одну и ту же секунду), `maxRequestsPerSecond: 5` (очередь запросов комнаты), `backoff: { baseMs: 2000, maxMs: 120000 }` (экспоненциальный откат комнаты на `5xx`/`429`/сетевых сбоях) и `placementTtl: 30000` (троттлинг `refreshPlacement`). Не изменилось — не отправляем, поэтому тихая комната не пишет вообще ничего; игра запись только *просит*;
- `leaderboardUrl: '/auth/leaderboard'`, `placementUrl: '/auth/placement'`, `leaderboardLimit: 10` (lobby-page-plan) — проксируемые мастером эндпоинты рейтинга/позиции игрока (см. [master.md](master.md#get-authleaderboard-get-authplacement)) и размер топ-N для вкладки Leaderboard; тот же origin, что и у мастера — правки CSP не нужны;
- `leaderboardPeriods: [{ id, title }]` и `defaultLeaderboardPeriod: 'all'` (rank-periods) — срезы времени над списком Leaderboard и тот, что открыт при входе. Порядок здесь — порядок кнопок, `id` едет в auth как `?period=` (то есть должен быть одним из `day`/`month`/`all` — на прочее ответом будет `400`), `title` идёт в заголовок списка. `elems.periodBtnIds` сопоставляет каждому id его кнопку;
- `reconnect` — переподключение сигнального WS хоста: экспоненциальный бэкофф от `baseDelay: 1000` до `maxDelay: 30000` (мс);
- `pageSize: 10` — размер страницы для «Загрузить ещё» (`offset`/`limit`);
- `debugReportUrl: '/debug/report'` — эндпоинт выгрузки отладочного контура (`window.__vimpDebug`); маршрут поднимается мастером только в dev, см. [debugging.md](debugging.md#выгрузка-post-debugreport);
- `pingInterval: 5000` — минимальный интервал повторного `ping_host` одного сервера (защита от спама при скролле/перерисовке);
- `elems` — id DOM-элементов лобби (из `lobby.pug`), включая `nameId`/`hostBtnId` — поле имени и кнопка «создать сервер» (браузерный хост, [host.md](host.md)) — `gameId` (селектор игры, заполняется каталогом мастера) и `fieldsId` (контейнер полей комнаты, генерируется по ключам `roomDefaults` активной игры — движок не знает игровых полей), и, с lobby-page-plan, id вкладок/leaderboard (`tabServersBtnId`, `tabLeaderboardBtnId`, `serversContentId`, `leaderboardContentId`, `leaderboardListId`, `leaderboardTitleId`, `leaderboardTotalId`, `myPlacementId`);
- `create` — настройки создания комнаты: `defaultName`, `heartbeatInterval: 10000` (период `update_host` у мастера; должен быть меньше `master.host.heartbeatTimeout`, 30 с, иначе комнату выметет), `hostSocketId: 'local'` — socketId loopback-соединения хоста-игрока (по нему Worker исключает хоста из kick-политик). Лимит игроков, время раунда/карты, огонь по своим и карта по умолчанию **не** здесь: они приходят из `roomDefaults` манифеста активной игры ([plugin-api.md](plugin-api.md#gamemanifest)).

## Игровой конфиг авторизации

Схема формы авторизации (`HostPlugin.authSchema`: id DOM-элементов,
параметры формы, игровые валидаторы, тексты) — полностью игровые данные;
движок лишь предоставляет нейтральный шаблон `auth.pug` (заголовок,
справочные секции, кнопка `Start` — без поля `name`, см.
[auth.md](auth.md#вход-в-комнату-проверка-хостом)) и `AuthView`, которая
подставляет заголовок/подсказки игры из `texts`. `authSchema.params` обычно
объявляет только игровые поля (например, `model` у `vimp-tanks`,
валидируемый её же `isValidModel`); движковый валидатор `isValidName`
([packages/engine/src/lib/validators.js](../../packages/engine/src/lib/validators.js))
существует для игры, которая захочет добавить в форму поле ника, но в
дефолтной форме не используется — ник берётся из проверенного токена
identity лобби, а не вводится пользователем. Валидация выполняется и на
клиенте (валидаторы из бандла игры), и повторно хостом (Worker) как
итоговым авторитетом; по проводу (`AUTH_DATA`, порт 1) уходят только
`elems`/`params`/`texts` — код валидаторов не передаётся. Собственный
конфиг авторизации игры документирован в её репозитории.

## Игровой каталог звуков

Каталог звуков (имена файлов, приоритеты, громкость, флаги зацикливания,
список кодеков) — игровые данные, отдаются под `assetsBase` игры. Механика
воспроизведения (лимиты голосов, приоритеты) — движковая, см.
[client.md](client.md#soundmanager).

## packages/engine/src/config/wsports.js и packages/engine/src/config/opcodes.js

- **`wsports.js`** — реестр числовых портов игрового протокола (источник истины). Полные таблицы — в [network.md](network.md#порты).
- **`opcodes.js`** — версия бинарного snapshot-формата (`SNAPSHOT_FORMAT_VERSION = 3`), `ENGINE_API_VERSION` и `HOT_FLAGS`. Реестр снапшот-ключей — игровые данные, поставляемые через `HostPlugin.gameConfig.snapshot` (числовой id + `kind` на каждый ключ, задающий байтовую раскладку блока). Незарегистрированный ключ уронит упаковку кадра. Подробности — в [network.md](network.md#бинарный-snapshot-кадр-порт-5).
- **`gameCodes.js`** — коды сообщений `GAME_INFORM_DATA` (порт 7) (`winnerTeam`/`roundStart`/`gameOver`), источник истины, общий для хоста (`SocketManager.sendGameInform`) и клиента (`GAME_ROUND_START_CODE` в `main.js`, запускающий анимацию старта раунда на панели и логотипе).

## lib/clock.js

Источник: [packages/engine/src/lib/clock.js](../../packages/engine/src/lib/clock.js).
Не конфиг, а точка подмены, делающая матч воспроизводимым: синглтон (в
идиоме `lib/config.js`) с методами `now()` (эпоха, мс, `Date.now`),
`monotonic()` (высокое разрешение, `performance.now`), `random()`,
`setTimeout`/`clearTimeout`/`setInterval`/`clearInterval` плюс
`install(custom)` (возвращает функцию отката) и `reset()`.

Все таймеры хоста идут через `lib/AbstractTimer.js`, который берёт
таймер-функции из `clock`; call-site хоста зовут
`clock.now()`/`clock.monotonic()`/`clock.random()` вместо глобалов. Дефолты
резолвят глобалы в момент вызова, поэтому поведение в проде (и
`vi.useFakeTimers()` в тестах) не меняется, а headless-runner подставляет
`VirtualClock` и прогоняет десятиминутный матч за секунды — детерминированно.
См. [debugging.md](debugging.md).

## Игровые данные (модели, оружие, карты)

Параметры моделей/танков, определения оружия и карты — полностью игровые
статические данные, см. доки активной игры-плагина (например,
`docs/ru/configuration.md` в `vimp-tanks`) для их конкретной формы и
значений. Один сквозной инвариант, важный для контрибьютора движка:
коэффициенты модели движения обычно общие между авторитетным ядром игры и
репликой клиентского предикта, поэтому игры закрывают их изменение своими
cargo-тестами на паритет.

---

[← Предыдущая: Сетевой протокол](network.md) · [Следующая: Развертывание →](deployment.md)
