# Клиентские модули и системы

Клиент — браузерное приложение на PixiJS (сборка Vite, шаблоны Pug в [packages/engine/src/client/views/](../../packages/engine/src/client/views/)). Точка входа — [packages/engine/src/client/main.js](../../packages/engine/src/client/main.js).

## Единый экземпляр PixiJS

Движок и динамически загружаемый game-plugin (`@vimp-games/*`) должны в браузере резолвить `pixi.js` в один и тот же модуль — два независимых бандла означают два разных реестра расширений/пайпов PixiJS, что ломает рендер (`RenderTargetSystem` получает render target, забинженный по реестру «чужого» рендерера). Это обеспечивается сквозной цепочкой:

- `pixi.js` — `external` в продакшен-сборке движка ([packages/engine/vite.config.js](../../packages/engine/vite.config.js)) — клиентский чанк больше не бандлит свою копию.
- [packages/engine/scripts/sync-pixi-vendor.mjs](../../packages/engine/scripts/sync-pixi-vendor.mjs) (запускается через `predev`/`prebuild`) esbuild'ом бандлит `pixi.js` и `pixi.js/unsafe-eval` в самодостаточные ESM-файлы без голых импортов (`bundle: true`, резолвится через `import`-условие пакета — а не сырое дерево `lib/**/*.mjs`, файлы которого сами импортируют свои npm-зависимости, например `eventemitter3`, голыми спецификаторами и не резолвятся в браузере) и `splitting: true` — оба входа делят общий чанк классов, это обязательно, чтобы патчи прототипов из `pixi.js/unsafe-eval` попадали в те же классы, что использует основной бандл. Результат — в `packages/engine/public/vendor/pixi/`, сгенерированной директории, не попадающей в git, которую Vite отдаёт/пакует как статику.
- [packages/engine/index.html](../../packages/engine/index.html) объявляет `importmap`, резолвящий голые спецификаторы `pixi.js` и `pixi.js/unsafe-eval` в эти собранные файлы, до входного `<script type="module">` — браузер резолвит и импорт движка, и внешний импорт плагина в один и тот же файл.
- Сборка самого game-plugin'а тоже должна externalize'ить `pixi.js` (как `peerDependency`, не бандлить) — это плагинная половина контракта, реализуется в репозитории плагина.
- `pixi.js` зафиксирован точной версией (без `^`) в [packages/engine/package.json](../../packages/engine/package.json): в отличие от `ENGINE_API_VERSION`, который силой проверяет `GameCatalog`, ничего не проверяет, что эта версия попадает в диапазон `peerDependencies` плагина — незафиксированный диапазон мог бы молча уйти за пределы поддерживаемого плагином и вернуть баг с двумя экземплярами.

Движковые и плагинные релизы, затрагивающие это, нужно выкатывать вместе: плагин, собранный с внешним `pixi.js`, не запустится отдельно без import map движка, а рассинхрон версии `pixi.js` движка с диапазоном `peerDependencies` плагина возвращает баг с двумя экземплярами.

## main.js — бутстрап, диспетчер и рендер-цикл

- **Бутстрап**: прежде всего фетчит каталог игр мастера (`GET /games/manifest.json`, `GameCatalog` — см. [master.md](master.md)) и динамически грузит `ClientPlugin` активной игры по `entries.client` её манифеста (`packages/engine/src/lib/gamePlugin.js`, `loadClientPlugin`), отклоняя несовпадение `engineApi`. Пока в каталоге одна игра — берётся первая запись манифеста, а селектор игры в лобби скрыт (см. [plugin-api.md](plugin-api.md)). Также независимо от сигнального сокета поднимает экран входа **LobbyAuth** (см. ниже) и подключает `SignalingClient`. Лобби (`initLobby`) открывается только после того, как прилетели оба события — `welcome` от мастера и `authenticated` от LobbyAuth: `#lobby` скрыт, пока игрок не авторизован. Выбор сервера → `connectToHost` создаёт `WebRtcManager`, устанавливает P2P и запоминает `currentHostId` (для `/like`·`/unlike`).
- **Рейтинг сервера (`/like`·`/unlike`)**: исходящий чат идёт через `handleChatSend` — он перехватывает `/like <причина>`/`/unlike <причина>` и вместо отправки хосту (порт `CHAT_DATA`) шлёт голос напрямую мастеру (`signaling.likeHost`/`unlikeHost(currentHostId, reason, token)`, `token` — identity-токен голосующего из `LobbyAuth`), минуя хоста-читера. Причина обязательна, доступно только авторизованному гостю (`currentHostId` есть); у хоста-игрока или неавторизованного игрока команда даёт локальную подсказку; при разорванном сигнальном WS — честное сообщение об ошибке (голос не отправлен). Мастер дополнительно принимает голос только от сессии, реально подключавшейся к комнате, и проверяет identity-токен — см. [master.md](master.md#рейтинг-сервера-likeunlike). Остальной чат — хосту как обычно.
- Ветвит входящие пакеты хоста (`handleMessage`) по типу данных: строка → JSON `[portId, payload]` → обработчик `socketMethods[portId]`; `ArrayBuffer` → `clientCore.push_frame` (распаковка, вставка в буфер по seq и reconciliation предикта — в ядре; несовпадение версии — кадр отброшен).
- По `CONFIG_DATA` (порт 0) инициализирует все модули: PixiJS `Application`-ы, MVC-компоненты, `BakingProvider` (запекание текстур), `SoundManager` и **клиентское ядро** (`ClientPlugin.createClientCore(configJson, { wasmUrl })`, где `wasmUrl` — `entries.wasm` манифеста активной игры: плагин сам зовёт свой wasm-bindgen `init()` и возвращает `{ core, memory }`; конфиг собирает [packages/engine/src/lib/clientCoreConfig.js](../../packages/engine/src/lib/clientCoreConfig.js) из секций `prediction`/`interpolation` CONFIG_DATA); отвечает `CONFIG_READY`.
- Первый кадр (`FIRST_SHOT_DATA`, порт 4) применяется немедленно (`applyShot`), минуя ядро.
- **Рендер-цикл** `renderTick` на `Ticker.shared` (rAF): `clientCore.sample(now)` → чтение плоского hot-буфера zero-copy из памяти WASM (танки/динамика/камера/предсказанный танк) + `take_frames()` для редких событийных кадров → применение прежним `parse`-конвейером (см. «Клиентское ядро» ниже).
- Сбросы: смена карты (`MAP_DATA` → `set_map`) и `CLEAR` (→ `reset`) очищают буфер кадров и предикт в ядре.
- **Разрыв P2P** (`handleDisconnect`): выход хоста = смерть комнаты (host-migration нет) — останавливает рендер-тик и `Application`-ы, показывает заглушку и возвращает в лобби перезагрузкой. Терминальная причина закрытия, уже показанная tech-informer'ом (кик, полная комната — любые коды, кроме `loading`), общим сообщением «Host left…» не затирается; причину Worker хоста доставляет `TECH_INFORM_DATA`-сообщением непосредственно перед закрытием канала (см. [network.md](network.md#rtt-pingpong-и-кики)). `techInformList` имеет дефолт из бандла (`packages/engine/src/config/clientDefaults.js`) — отказ полной комнаты приходит до `CONFIG_DATA`.
- **Отсутствие WebRTC** (`ensureWebRtcAvailable`): если `RTCPeerConnection` недоступен (Firefox с `media.peerconnection.enabled = false`, resistFingerprinting и т.п.), `connectToHost`/`connectAsHost` показывают честное сообщение и не покидают лобби вместо падения с чёрным экраном.
- **Роль хоста**: `connectAsHost` перед стартом Worker'а фетчит каталог карт мастера (fallback на бандл), после `ready` регистрирует комнату и держит heartbeat; сигнальный WS хоста при разрыве переподключается с бэкоффом (`lobbyConfig.reconnect`) и заново регистрирует комнату (повторный `welcome` лобби не пересоздаёт — guard в `initLobby`). Сбой инициализации Worker'а (`error`) гасит комнату с сообщением и возвращает в лобби.

## Сетевой слой (packages/engine/src/client/network/)

Игровой транспорт — WebRTC, а не WebSocket (детали каналов — [network.md](network.md#транспорт-webrtc)):

- **`SignalingClient`** — тонкая обёртка сигнального WebSocket мастера: `connect()`, кэш `id`/`iceServers` из `welcome`, ретрансляция входящих сообщений подписчикам по полю `type` (через `Publisher`), методы `sendOffer`/`sendIceCandidate`/`pingHost`/`likeHost`/`unlikeHost`. Транспорт инъектируется фабрикой ради тестов.
- **`WebRtcManager`** — P2P-соединение с хостом: `RTCPeerConnection` + каналы `meta` (reliable-ordered) и `state` (unreliable-unordered). Клиент — offerer: создаёт каналы/оффер, обменивается SDP/ICE через `SignalingClient`. События `Publisher`: `open` (оба канала открыты), `message` (данные из любого канала одним потоком), `close` (разрыв). `RTCPeerConnection` инъектируется фабрикой ради тестов.

Роль клиента выбирается в лобби (`packages/engine/src/client/main.js`): **присоединиться** (`connectToHost` → `WebRtcManager`, offerer) или **создать сервер** (`connectAsHost` → браузерный хост в этой же вкладке). Для хоста игровой транспорт — **`LoopbackTransport`**: тот же интерфейс, что у `WebRtcManager` (`publisher` с `message`/`close`, `send`/`close`), но данные ходят через `HostController` → Web Worker постмесседжами, минуя WebRTC. Клиентский код при этом одинаков — транспорт прозрачен.

Хост-вкладка дополнительно поднимает главнопоточную инфраструктуру роутинга (главный поток — не Worker): **`HostController`** спавнит Worker с ядром и мостит его с транспортами; **`HostConnectionManager`** — **WebRTC-answerer** удалённых клиентов (зеркало `WebRtcManager`): слушает `webrtc_offer` через `SignalingClient`, на каждого создаёт `RTCPeerConnection`, ловит каналы `meta`/`state` в `ondatachannel`, шлёт `webrtc_answer`+ICE, регистрирует комнату у мастера (`register_host`/heartbeat) и отвечает на лобби-пинг (`ping_host`). Данные удалённых клиентов идут в тот же Worker, что и loopback хоста-игрока. Детали — [host.md](host.md).

Classic-фолбэка на Worker нет (запретил бы ESM и потребовал инлайн WASM — см. риск №5 PLAN.md), поэтому «Создать сервер» сперва фича-детектит поддержку модульных Worker'ов (`packages/engine/src/client/network/workerSupport.js`, `supportsModuleWorker` — браузер читает опцию конструктора `type`, только если понимает module-воркеры). На неподдерживающем браузере показывается честное сообщение «этот браузер не может быть хостом» без побочных эффектов — присоединение к существующим комнатам не затрагивается.

## MVC-компоненты (packages/engine/src/client/components/)

Десять троек `model/` + `view/` + `controller/`: **LobbyAuth**, **Auth**, **Lobby**, **CanvasManager**, **Controls**, **Game**, **Chat**, **Panel**, **Stat**, **Vote**.

**LobbyAuth** — экран входа перед лобби (`plan/done/central-auth/auth_b2.md`):

- **model** — говорит с central auth-сервисом (`packages/auth`, см. [auth.md](auth.md)) напрямую, не через мастер. `boot(search)` один раз при старте разбирает query string OAuth-редиректа (`?token=`/`?pendingToken=`/`?authError=`), иначе восстанавливает identity JWT из `localStorage`; `submitNick` — единственный сетевой вызов, который эта модель делает сама (`POST /nick` с pending-токеном, в отличие от остальных моделей, публикующих сигнальный I/O событиями) — это обычный кросс-доменный fetch, а не сигнальный трафик. Публикует `login-required`/`nick-required`/`authenticated`/`login-error`/`nick-error`. Payload identity JWT декодируется на клиенте только для отображения (`packages/engine/src/lib/jwt.js`, `decodeJwtPayload`, без проверки подписи) — авторитетную проверку по `/jwks` делает хост (`plan/done/central-auth/auth_b3.md`; см. [auth.md](auth.md#вход-в-комнату-проверка-хостом)).
- **view** — переключает `#lobby-auth-login`/`#lobby-auth-nick` (`views/includes/lobbyAuth.pug`) и по `authenticated` прячет `#lobby-auth`, показывает `#lobby` и бейдж ника/выхода `#lobby-user` (`views/includes/lobby.pug`) — сам `#lobby` в шаблоне стартует скрытым, включает его только `LobbyAuthView` (или `LobbyCtrl.open`). Кнопки провайдеров (`.lobby-auth-provider`, `data-provider`) фильтруются по списку из конфига.
- **controller** — `login(provider)` переводит браузер (`window.location.href = model.loginUrl(provider)`) на `GET /oauth/:provider/start` auth-сервиса — это навигация верхнего уровня, а не fetch, поэтому CSP `connect-src` её не касается. `nick`/`logout` проксируются в модель.

Конфиг — [packages/engine/src/config/authClient.js](../../packages/engine/src/config/authClient.js) (бандлится в сборку, как `lobby.js` — `serviceUrl` должен указывать на реальный домен auth-сервиса per-деплою; CSP `connect-src` мастера (`config/master.js`, `security.csp`) шаблонизируется тем же `authServiceUrl`, чтобы fetch лобби `POST /nick` не блокировался в проде. `GET /oauth/:provider/start` и редирект колбэка — навигация верхнего уровня, CSP их не касается в любом случае).

**Lobby** — экран выбора сервера ДО подключения к хосту:

- **model** — реестр серверов (ответы `GET /servers` мастера), пагинация, поиск, умный пинг. I/O не делает: публикует `fetch` (запросить REST), `ping-request` (сигнальный ping), `join` (выбран сервер), `list`/`ping-update` (для view). `latency` живёт отдельно от списка и переживает refresh/пагинацию.
- **view** — рендер карточек, поиск, «Загрузить ещё»; **умный пинг** через `IntersectionObserver`: карточка в видимой зоне → `visible` → контроллер шлёт `ping_host`; `pong` обновляет задержку и пересортировывает карточки по возрастанию. `IntersectionObserver` инъектируется ради тестов. Карточка также показывает закэшированный рейтинг хостера (server-rating этап 3 — `.lobby-card-rating`, прямо из поля `rating` объекта сервера, со знаком для положительных значений (`+7`/`-3`/`0`); это движковый UI лобби, игровой плагин его не рисует.
- **controller** — проксирует view-события в модель; дросселирование пинга — в модели (`pingHost` возвращает `false`, если сервер пинговали недавно, интервал `pingInterval`).

Конфиг — [packages/engine/src/config/lobby.js](../../packages/engine/src/config/lobby.js) (бандлится в сборку, т.к. лобби проходит до подключения к хосту). Замер пинга **приблизительный** (клиент→мастер→хост, не P2P RTT) — так и подаётся в UI.

Форма «Создать сервер» **генерируется** по ключам `roomDefaults` манифеста активной игры (`populateRoomForm` в `main.js`) — движок не знает игровых полей. Тип контрола выводится из дефолтного значения: `boolean` → чекбокс, `number` → числовое поле, специальный ключ `map` → select из `manifest.maps.list`; подпись строится из camelCase-ключа (`friendlyFire` → «Friendly fire»). Движковые ключи получают подсказки из `lobbyConfig.form`: `secondsKeys` (`roundTime`/`mapTime` хранятся в миллисекундах, в форме — секунды) и `attrs` (min/max числовых полей). Селектор игры (`#lobby-game`) скрыт, пока в каталоге мастера одна игра. При отправке все ключи `roomDefaults` (дефолты, перекрытые значениями формы) уходят объектом комнаты в `connectAsHost` → `HostController` → Worker, где `applyRoomOverrides` (`packages/engine/src/lib/applyRoomOverrides.js`) читает `maxPlayers`/`roundTime`/`mapTime`/`friendlyFire`/`map`.

Publisher-паттерн связей внутри тройки:

- `main.js` или `view` → методы `controller` вызываются **напрямую**;
- `controller` → методы `model` вызываются **напрямую**;
- `model` → `view` — **через `Publisher`** ([packages/engine/src/lib/Publisher.js](../../packages/engine/src/lib/Publisher.js)): модель публикует событие, view подписана; на модель могут подписываться и внешние подписчики.

Назначение компонентов:

- **LobbyAuth** — экран входа перед лобби через central auth-сервис (см. выше).
- **Auth** — комнатная форма входа только для игро-специфичных полей
  (например, `model`), клиентская валидация (`validators.js`), localStorage.
  Ник здесь больше не вводится (Этап B3, см.
  [auth.md](auth.md#вход-в-комнату-проверка-хостом)): `main.js` прикладывает
  `LobbyAuthModel.getToken()` к payload `AUTH_RESPONSE` как `token`, хост
  проверяет его по `/auth/jwks` и берёт ник оттуда.
- **CanvasManager** — управляет несколькими PixiJS `Application` одновременно: `vimp` (основной игровой canvas) и `radar` (мини-карта); canvas-элементы генерирует `main.js` из конфига канвасов игры (`modules.canvasManager.canvases`, включая стартовые `width`/`height`) — в HTML их нет. Адаптивное масштабирование (эталон 1920px), `aspectRatio`/`fixSize`/`baseScale`, динамическая камера (look-ahead, zoom от скорости) и тряска — параметры в [configuration.md](configuration.md#modulescanvasmanager--полотна-и-камера).
- **Controls** — перехват клавиатуры (`InputListener`), активный набор клавиш диктует сервер (порт 17), режимы `chat`/`vote`/`stat`, отправка ввода `"seq:action:name"`.
- **Game** — ядро рендеринга: `GameCtrl.parse(name, data)` создаёт/обновляет/удаляет экземпляры сущностей по снапшот-данным через `Factory`.
- **Chat** — вывод сообщений (лимит строк, время жизни), командная строка; экранирование на выводе (`textContent`).
- **Panel** — HUD: время раунда, здоровье, боезапас, активное оружие (по строкам `'ключ:значение'`). `PanelView` **генерирует DOM по схеме игры** (`modules.panel.fields`: упорядоченный список `{ name, elem, type }`; семантику ячейки задаёт `type: 'bar' | 'value' | 'time' | 'weapon'`, а не имя поля — у `bar` дополнительно `max` и `blocks`) внутри движкового контейнера `#panel`; внешний вид ячеек — CSS игры (блоки бара — нейтральные движковые классы `panel-bar-*`).
- **Stat** — таблицы scoreboard с сортировкой (`sortList`), показывается по Tab. `StatView` **генерирует шапку и таблицы по схеме игры** (`modules.stat.params`: `columns` — подписи колонок, `bodies` — произвольное число команд) внутри контейнера `#stat`; цвета/подписи команд — CSS игры.
- **Vote** — окна голосований из шаблонов, пагинация, таймер жизни.

## Клиентское ядро (ClientCore)

Клиентская математика — интерполяция снапшотов, предикт своего танка,
визуальный спавн снарядов и распаковка кадров v3 — живёт в Rust-ядре
(`packages/engine/core/src/client/` + собственный `core/src/client/`
игры-плагина, например в `vimp-tanks`,
wasm-bindgen класс `ClientCore` из того же WASM-бинаря,
что `GameCore` хоста). JS-оболочка (`main.js`) только пересылает данные и
применяет результат к рендеру; ABI и раскладки — в [core.md](core.md#clientcore--клиентский-режим-ядра).

Поток данных:

- **Вход**: `handleMessage` передаёт бинарный кадр в `push_frame(bytes, now)` —
  ядро распаковывает (несовпадение версии — кадр отброшен), вставляет в буфер
  по `seq` с дедупликацией и, если кадр несёт player-блок, делает
  reconciliation предикта. Порты `MAP_DATA`/`PANEL_DATA`/`KEYSET_DATA`/`CLEAR`
  зеркалятся в `set_map`/`sync_panel`/`set_active`/`reset`; модель танка —
  `set_model` при авторизации.
- **Рендер-тик**: `sample(now)` возвращает длину плоского **hot-буфера** —
  `new Float32Array(wasm.memory.buffer, hot_ptr(), len)` читается zero-copy
  (view пересоздаётся каждый тик: рост памяти WASM детачит buffer). Буфер несёт
  флаги, камеру (уже разрешённую: предсказанная позиция либо интерполированная),
  интерполированные записи акторов/динамики и predicted-запись своего актора
  последней. Адаптер `reconstructHot` (~40 строк в `main.js`) собирает из него
  объект прежней формы `{ m1: { id: [...] }, c1: {...} }` и отдаёт в
  существующий `applyGameData` — GameCtrl/parts не менялись; predicted-запись
  перекрывает свой актор тем же конвейером.
- **Событийные кадры** (флаг `hasFrames`): `take_frames()` отдаёт JSON-массив
  `[{ game, camera }, …]` — пересечённые `renderTime` кадры целиком ровно один
  раз (события `w1`/`w2e`, создания/удаления, reset/shake камеры), уже с
  подавленными дублями своих выстрелов; применяются прежним `applyShot`.
  Звук и эффекты триггерятся, как и раньше, самими parts при создании
  сущностей — отдельного eventId-диспетчера нет.
- **Ввод**: `apply_input(action, name, now)` пишет историю предикта; игровые
  действия идут через хук `ClientPlugin.hooks.onLocalAction` (`try_fire(now)` —
  гейты кулдауна/патронов/pending-бомбы/жив внутри ядра — возвращает JSON
  спавна для `applyGameData`; `nextWeapon`/`prevWeapon` — `cycle_weapon`).
  Отправка хосту `"seq:action:name"` не изменилась.

**ClientPlugin игры** (`src/client/index.js` игры-плагина, например в
`vimp-tanks`; грузится движком
динамически по `GameManifest` мастера, этап 6.3 —
`packages/engine/src/lib/gamePlugin.js`) поставляет `parts` (рендеры сущностей), `bakers`
(процедурные текстуры), игровой CSS и хуки. Игровые методы ядра зовутся только
из его хуков — `onAuth` (`set_model` при авторизации), `onPanel` (`sync_panel` на
кадр панели), `onLocalAction` (напр. `try_fire`/`cycle_weapon` в `vimp-tanks`);
`main.js` игровых методов ядра не знает. Игровой CSS (ячейки панели, полотна,
цвета команд) — собственный `src/client/*.css` игры-плагина (например,
`vimp-tanks`'ы `tanks.css`), движковый каркас UI —
`packages/engine/src/client/style.css`.

Внутри ядро реализует следующие алгоритмы:

- **интерполяция** (`client/interpolator.rs`): EMA-оффсет серверного времени,
  `renderTime = serverNow − delay` (конфиг `interpolation.delay: 100` мс),
  лерп акторов/динамики/камеры (углы — по кратчайшему пути), дискретные поля из
  опорного кадра, hold без экстраполяции, вставка по `seq` + немедленная выдача
  событий опоздавших кадров;
- **предикт** (`client/predictor.rs`): реплика авторитетного движения без
  Rapier-коллизий фикс-шагом `timeStep`; формулы тика **общие** с
  собственным кодом обновления актора игры-плагина (напр. `vimp-tanks`'ы
  `core/src/motion.rs`) — реплика не может разойтись с
  авторитетным путём по формулам, паритет интеграции (ручная против Rapier)
  закрепляют cargo-тесты `client_parity`; история ввода, replay от `serverTime`
  кадра, `visualError` с экспоненциальным затуханием и снапом, freeze при
  `condition 0`, сброс по forceReset камеры/смене карты/keySet;
- **спавн снарядов** (`client/shot.rs` + `client/raycast.rs`): реплика
  авторитетного гейта и формул дула, DDA-raycast по тайлам стен + OBB-тест по
  динамике и акторам, гейт одного pending-снаряда, RTT-компенсация его
  позиции, подавление авторитетных дублей по id автора (FIFO с таймаутом,
  локальные ключи `L<n>`) — имена полей и точный гейтинг заданы игрой
  (напр. `vimp-tanks`'ы блоки сущностей `tracers`/`bombs`, см.
  [network.md](network.md)). Любая чисто клиентская визуальная случайность
  (напр. разброс трассера) — визуальный эффект, авторитетная сущность
  приходит кадром.

## Рендеринг

### parts/ — сущности

Собственный `src/client/parts/` игры-плагина (например,
[`vimp-tanks`'ы](https://github.com/lgick/vimp-tanks/tree/main/src/client/parts)) —
классы, отрисовываемые на PixiJS-полотнах, по одному на игровой тип сущности
(напр. `vimp-tanks`'ы `Tank`, `TankRadar`, `Map`, `MapRadar`, `Bomb`,
`Smoke`, `Tracks`). Эффекты следуют той же плагин-собственной конвенции
(напр. `vimp-tanks`'ы `parts/effects/`), анимируются на `Ticker.shared`.

Соответствие снапшот-ключей классам и распределение по полотнам — `gameSets`/`entitiesOnCanvas` в `client.js`. Фиксированного контракта у part нет — при создании новой смотреть существующие как образец.

### Factory

[packages/engine/src/lib/factory.js](../../packages/engine/src/lib/factory.js) — реестр имя сущности → класс. `GameCtrl.parse(name, data)` по входным данным создаёт экземпляр, вызывает `update(data)` существующего или удаляет (`null`).

### Провайдеры

- **`BakingProvider`** ([providers/BakingProvider.js](../../packages/engine/src/client/providers/BakingProvider.js)) — однократная генерация процедурных текстур при старте по конфигу `bakedAssets`; функции запекания — в [`src/client/bakers/` игры-плагина](https://github.com/lgick/vimp-tanks/tree/main/src/client/bakers) (например, в `vimp-tanks`; фиксированного интерфейса нет, ориентироваться на существующие).
- **`DependencyProvider`** — инъекция сервисов (`renderer`, `soundManager`) в компоненты по карте `componentDependencies`.

## SoundManager

[packages/engine/src/client/SoundManager.js](../../packages/engine/src/client/SoundManager.js) (на Howler.js). Звуки описаны в `src/config/sounds.js` игры-плагина (например, в `vimp-tanks`); поле `path` переопределяется на клиенте (`main.js`, обработчик `CONFIG_DATA`) на `${activeGameManifest.assetsBase}sounds/` — собственную копию звуков сборки игры рядом с её client/host-бандлами (`dist/sounds/` игры-плагина), вместо бандловой `/sounds/` движка.

- **UI/системные** (без позиции): `playSystemSound(name)` — немедленно, в обход приоритетов (используется и для звуков порта 6).
- **Пространственные** (позиция в мире): `registerSound(name, { position })` → `processAudibility()` → `updateActiveSounds()` — менеджер сам решает, что слышно, соблюдая лимит голосов (`WORLD_VOICE_LIMIT = 30`) и приоритеты из конфига.

## InputListener

[packages/engine/src/client/InputListener.js](../../packages/engine/src/client/InputListener.js) — низкоуровневый перехват keydown/keyup для Controls; `modes`/`cmds` имеют приоритет над игровым набором клавиш.

## Иерархия UI (z-index)

`vimp` (1) → `radar` (2) → `chat` (3) → `panel` (4) → `vote` (5) → `game-informer` (6) → `stat` (7) → `lobby`/`auth` (8) → `tech-informer` (9). Лобби (`#lobby`, z-index 8) — стартовый экран выбора сервера, показывается до подключения к хосту и скрывается при входе в игру.

---

[← Предыдущая: Rust-ядро](core.md) · [Следующая: Сетевой протокол →](network.md)
