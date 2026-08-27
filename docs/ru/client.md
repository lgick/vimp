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

## Режимы загрузки (`boot.js`)

Клиент движка один, а контуров у него три. Режим определяет `packages/engine/src/client/boot.js` до того, как `main.js` сделает что-либо ещё:

| Режим | Мастер | Хост | Транспорт |
| --- | --- | --- | --- |
| `lobby` | есть (каталог, сигналинг, OAuth) | Web Worker во вкладке хоста | WebRTC / loopback |
| `solo` | нет | inline, в главном потоке страницы | loopback |
| `dedicated` | нет | процесс Node.js | WebSocket |

`resolveBootConfig()` возвращает по убыванию приоритета: конфиг, инъектированный standalone SDK (`setBootConfig(cfg)`), затем `GET /config` (его отдаёт dedicated-сервер), и наконец `{ mode: 'lobby' }` — сбой сети, 404 и мусор в ответе одинаково означают «прод-лобби», так что существующие развёртывания не задеты. Канал между SDK и `main.js` — модульное состояние: оба резолвят `boot.js` в один экземпляр графа бандлера, глобалов на `window` не появляется.

Форма конфига (обязателен только `mode`): `container` (точка монтирования каркаса и канвасов), `manifest`, `clientPlugin`, `hostPlugin`, `room`, `autoAuth`, `startupVotes`, `startupCommands` (solo), `wsUrl`, `gameId` (dedicated).

`main.js` ветвится по режиму ровно в пяти точках: источник манифеста/плагина, сигналинг + лобби + перехват `/like`·`/unlike`, транспорт, авто-аутентификация с автостартом и точка монтирования канвасов. Всё остальное — диспетчер, MVC-модули, ClientCore, рендер-цикл — во всех трёх режимах одинаково.

Отсюда бесплатно следуют два свойства, которые стоит зафиксировать: в `solo` и `dedicated` `ensureWebRtcAvailable()` и `supportsModuleWorker()` не вызываются вовсе (обе проверки живут только на lobby-путях), то есть игра стартует в браузере с отключённым WebRTC и без поддержки модульных Worker'ов.

### DOM-каркас (`views/gameShell.js`)

Прод-разметку даёт pug (`views/includes/*.pug`), но standalone SDK встраивается в страницу репозитория игры, где pug нет вовсе, — а движковые модули ищут элементы по фиксированным id. `ensureGameShell(container)` достраивает недостающие (`#panel`+`#logo`, `#chat`+`#chat-box`+`#cmd`, `#stat`, `#auth` со своей формой, `#game-informer`, `#tech-informer`) и идемпотентен: в режиме `lobby`, где разметка уже есть, он не делает ничего. `#vote` здесь не создаётся (его строит в рантайме `components/view/Vote.js` — **в контейнере загрузки**), канвасы — тоже: их размеры приезжают в `CONFIG_DATA`, поэтому ими занимается `ensureCanvas(id, size, container)` из обработчика `CONFIG_DATA`. Уже размещённый игрой `<canvas>` переиспользуется как есть и не переносится.

Контейнер **обязан быть полноэкранным и позиционированным** (`position: relative`): `#panel`, `#stat`, `#vote` — а после правки леттербокса и само полотно — `position: absolute`, и их containing block — ближайший позиционированный предок. Центрирование полотна даёт `style.css`: `.vimp-shell > canvas { position: absolute; inset: 0; margin: auto }`. Размер элементу уже посчитал `CanvasManagerModel.resize` под заданный `aspectRatio`, поэтому `margin: auto` делит чёрные полосы поровну, а не сваливает их на одну сторону. Отсюда два следствия: у непозиционированного контейнера полотно уедет к вьюпорту, а `<canvas>`, размещённый игрой не прямым потомком контейнера, правилу не достаётся (`ensureCanvas` переиспользует его там, где он лежит) — раскладку такого полотна игра держит сама. Видимостью экранов движок занимается сам: `ensureGameShell` ставит на контейнер класс `vimp-shell` (экспортируется как `SHELL_CLASS`), а `style.css` скрывает `.vimp-shell > *` — дальше каждый экран показывает свой модуль (`main.js` проходит по `initIdList` и ставит инлайновый `display`, `AuthView.show`, `StatView.show`, информеры). Правило целится в контейнер, а не в `body`, поэтому разметка встраивающей SDK страницы не задета, а контейнеру `display` от страницы не нужен на любой глубине вложенности. Следствие для CSS игры: правило — селектор по классу, поэтому элемент первого уровня внутри контейнера, который игра показывает правилом по типу или классу (`canvas { display: block }`), правилу проиграет — целитесь по id либо отдавайте показ `initIdList`.

Своя страница движка держит до-JS форму того же правила (`body > *`) инлайном в `packages/engine/index.html`: пока `ensureGameShell` не поставил класс на `body`, `vimp-shell` ещё нет и pug-разметка мигнула бы. После этого обе формы выбирают одни и те же элементы.

Два источника разметки не должны разъехаться: `tests/client/gameShell.test.js` собирает id из pug-инклюдов и сверяет с набором, который строит каркас.

### Авто-аутентификация и автостарт (solo)

При заданном `boot.autoAuth` обработчик `AUTH_DATA` не строит Auth-MVC вовсе — он сразу отвечает дефолтами схемы, перекрытыми `autoAuth`. После `FIRST_SHOT_READY`, **на первом `renderTick`** (не в том же синхронном вызове), `client/lib/autostart.js` отправляет `boot.startupVotes` на `VOTE_DATA` и только затем `boot.startupCommands` на `CHAT_DATA`.

Порядок обязателен, и дело не в гонке доставки. Реальный гейт чата — `HostGame.pushMessage`: он отбрасывает сообщения, пока `user.isReady === false` (флаг ставится синхронно в `firstShotReady`). Настоящая же блокировка — команда: участник входит наблюдателем, а игра вправе требовать активной команды (у танков `/bot` наблюдателю отбивается). Выйти из наблюдателей можно только ответом на initialVote (`['teamChange', '<team>']` на порт `VOTE_DATA`) — отсюда голоса строго раньше команд. Игре с `gameConfig.noSpectators` это не нужно вовсе: наблюдателей в ней нет, участник входит сразу в играющую команду, и `startupVotes` для неё пустые. Лимита частоты чата на хосте нет (только по длине, `chatMaxLength`), поэтому дробить команды по кадрам не нужно.

## main.js — бутстрап, диспетчер и рендер-цикл

- **Бутстрап**: прежде всего фетчит каталог игр мастера (`GET /games/manifest.json`, `GameCatalog` — см. [master.md](master.md)) и динамически грузит `ClientPlugin` активной игры по `entries.client` её манифеста (`packages/engine/src/lib/gamePlugin.js`, `loadClientPlugin`), отклоняя несовпадение `engineApi`. Первая запись каталога (или `boot.gameId`) — лишь **начальная** активная игра, она не заморожена: `bindActiveGame` перенаправляет `activeGameManifest`, `clientPlugin` и внедрённый игровой CSS на игру, которую выбрал игрок, а `client/lib/gameActivator.js` грузит её `ClientPlugin` по требованию (кеш по `gameId`; отказ **не** кешируется — повторная попытка импортирует заново). Переключение безопасно потому, что всё пер-игровое состояние — сущности `Factory`, Pixi-приложения, `clientCore`, звук — строится на старте матча (`CONFIG_DATA`) по актуальным на тот момент привязкам, а lobby-режим перезагружает страницу после матча: лобби всегда в чистом до-матчевом состоянии. Активация происходит **по клику**, а не по смене селектора, поэтому просмотр каталога ничего не качает. Селектор игры в лобби (`#lobby-game`, `populateGameSelect`) заполняется всем каталогом; его смена синхронно пересобирает форму создания комнаты и переключает игру вкладки Leaderboard. Также независимо от сигнального сокета бутстрап поднимает экран входа **LobbyAuth** (см. ниже) и подключает `SignalingClient`. Лобби (`initLobby`) открывается только после того, как прилетели оба события — `welcome` от мастера и `authenticated` от LobbyAuth: `#lobby` скрыт, пока игрок не авторизован. Выбор сервера активирует игру этой комнаты (payload `join` несёт её `gameId`; хосты старше 6.4 его не шлют — тогда вход идёт на активной игре), после чего `connectToHost` создаёт `WebRtcManager`, устанавливает P2P и запоминает `currentHostId` (для `/like`·`/unlike`). Отказ загрузки плагина показывается строкой в `#lobby-error` и оставляет лобби рабочим — `#tech-informer` кроет вкладку целиком и зарезервирован под терминальные причины.
- **Рейтинг сервера (`/like`·`/unlike`)**: исходящий чат идёт через `handleChatSend` — он перехватывает `/like <причина>`/`/unlike <причина>` и вместо отправки хосту (порт `CHAT_DATA`) шлёт голос напрямую мастеру (`signaling.likeHost`/`unlikeHost(currentHostId, reason, token)`, `token` — identity-токен голосующего из `LobbyAuth`), минуя хоста-читера. Причина обязательна, доступно только авторизованному гостю (`currentHostId` есть); у хоста-игрока или неавторизованного игрока команда даёт локальную подсказку; при разорванном сигнальном WS — честное сообщение об ошибке (голос не отправлен). Мастер дополнительно принимает голос только от сессии, реально подключавшейся к комнате, и проверяет identity-токен — см. [master.md](master.md#рейтинг-сервера-likeunlike). Остальной чат — хосту как обычно.
- Ветвит входящие пакеты хоста (`handleMessage`) по типу данных: строка → JSON `[portId, payload]` → обработчик `socketMethods[portId]`; `ArrayBuffer` → `clientCore.push_frame` (распаковка, вставка в буфер по seq и reconciliation предикта — в ядре; несовпадение версии — кадр отброшен).
- По `CONFIG_DATA` (порт 0) инициализирует все модули: PixiJS `Application`-ы, MVC-компоненты, `BakingProvider` (запекание текстур), `SoundManager` и **клиентское ядро** (`ClientPlugin.createClientCore(configJson, { wasmUrl })`, где `wasmUrl` — `entries.wasm` манифеста активной игры: плагин сам зовёт свой wasm-bindgen `init()` и возвращает `{ core, memory }`; конфиг собирает [packages/engine/src/lib/clientCoreConfig.js](../../packages/engine/src/lib/clientCoreConfig.js) из секций `prediction`/`interpolation` CONFIG_DATA); отвечает `CONFIG_READY`.
- Первый кадр (`FIRST_SHOT_DATA`, порт 4) применяется немедленно (`applyShot`), минуя ядро.
- **Рендер-цикл** `renderTick` на `Ticker.shared` (rAF): `clientCore.sample(now)` → чтение плоского hot-буфера zero-copy из памяти WASM (танки/динамика/камера/предсказанные записи) + `take_frames()` для редких событийных кадров → применение прежним `parse`-конвейером (см. «Клиентское ядро» ниже).
- Сбросы: смена карты (`MAP_DATA` → `set_map`) и `CLEAR` (→ `reset`) очищают буфер кадров и предикт в ядре; `reset` вдобавок обнуляет идентичность игрока (`my_game_id`), чтобы предикт не рисовал сущность, которой на хосте уже нет.
- **Пробуждение вкладки** (`visibilitychange` → visible): помимо размьюта оболочка зовёт `clientCore?.resync?.()` — часы интерполятора пересеиваются со следующего кадра, а не догоняются EMA. Вызов опциональный: у старой сборки плагина такого метода ABI нет. Зовётся только после паузы не короче `RESYNC_AFTER_HIDDEN_MS` (3 с): ресинк выбрасывает весь буфер кадров, включая событийные (создание/удаление сущностей), поэтому после короткого alt-tab он заморозил бы сцену на время задержки интерполяции и потерял бы удаления.
- **Потеря WebGL-контекста** (`webglcontextlost` на каждом полотне): весь видимый контент — GPU-only `RenderTexture` без CPU-источника, поэтому при потере контекста сцена рисовалась бы пустой. Обработчик зовёт `preventDefault()` (без него браузер не пришлёт `webglcontextrestored`) и останавливает рендер-цикл. Потеря учитывается по каждому полотну отдельно (`lib/contextTracker.js`): полотна — независимые контексты, браузер восстанавливает их асинхронно, и перепечка по первому `webglcontextrestored` ушла бы в ещё мёртвый контекст (пустые текстуры), а второе событие уже ничего бы не сделало. На `webglcontextrestored`, когда живы **все** контексты, оболочка удаляет все контроллеры (они держат мёртвые текстуры), перепекает ассеты (`BakingProvider.bakeAll` в тот же экземпляр `Map`, который держит `GameModel._assets`, — старые render-текстуры перед этим уничтожаются, каждая ровно один раз), пересобирает карту из сохранённого payload'а `MAP_DATA` **без** повторного `MAP_READY` (хост его больше не ждёт) и возвращает рендер-цикл. Танки и динамика восстановятся сами из ближайших кадров. `renderTick` попадает на тикер и снимается только через `startRenderLoop`/`stopRenderLoop` — `Ticker.add` дубликаты не отсеивает.
- **Нулевой resize** (свёрнутая вкладка/окно) игнорируется `CanvasManagerModel`: он увёл бы scale в `0`, а renderer — в `0x0`, и ни то, ни другое не восстановится до следующего настоящего resize; отдаваемые размеры зажаты снизу единицей.
- **Разрыв P2P** (`handleDisconnect`): выход хоста = смерть комнаты (host-migration нет) — снимает рендер-тик (не `app.stop()`: при общем тикере это останавливает его глобально, а `autoStart` оживит его на первом же `add()` из любого part'а — уже без `renderTick`), снимает слушатели контекста и чистит сохранённые рендер-контексты (иначе восстановление контекста после разрыва вернуло бы рендер уже мёртвой игре), показывает заглушку и возвращает в лобби перезагрузкой. Терминальная причина закрытия, уже показанная tech-informer'ом (кик, полная комната — любые коды, кроме `loading`), общим сообщением «Host left…» не затирается; причину Worker хоста доставляет `TECH_INFORM_DATA`-сообщением непосредственно перед закрытием канала (см. [network.md](network.md#rtt-pingpong-и-кики)). `techInformList` имеет дефолт из бандла (`packages/engine/src/config/clientDefaults.js`) — отказ полной комнаты приходит до `CONFIG_DATA`. Перезагрузки нет в `solo` (возвращаться некуда) и на политических кодах закрытия dedicated-сервера — `shouldReloadAfterClose` в `client/network/policyClose.js` по карте `config/closeCodes.js` (`invalidOrigin`, `roomFull`, `handshakeTimeout`, `tooManyConnections`; полная таблица — в [network.md](network.md#жизненный-цикл-соединения)). Перезагрузка только сожгла бы ещё одно соединение того же лимита, перезапустила бы тот же таймер, оставила бы тот же origin или не освободила бы слот, поэтому клиент показывает причину и остаётся на месте. Текст даёт `POLICY_CLOSE_INFORMS`, и записи там запасные: клиент пишет их только тогда, когда сервер причину не прислал сам (причина 4006 приходит с сервера кадром `TECH_INFORM`, и она побеждает). См. [dedicated.md](dedicated.md#игровой-websocket).
- **Отсутствие WebRTC** (`ensureWebRtcAvailable`): если `RTCPeerConnection` недоступен (Firefox с `media.peerconnection.enabled = false`, resistFingerprinting и т.п.), `connectToHost`/`connectAsHost` показывают честное сообщение и не покидают лобби вместо падения с чёрным экраном.
- **Роль хоста**: `connectAsHost` перед стартом Worker'а фетчит каталог карт мастера (fallback на бандл), после `ready` регистрирует комнату и держит heartbeat; сигнальный WS хоста при разрыве переподключается с бэкоффом (`lobbyConfig.reconnect`) и заново регистрирует комнату (повторный `welcome` лобби не пересоздаёт — guard в `initLobby`). Сбой инициализации Worker'а (`error`) гасит комнату с сообщением и возвращает в лобби.
- **Отладочный API (только dev-сборка)**: `window.__vimpDebug` (`packages/engine/src/client/debug.js`) — `dump()`, `startRecording()`, `stopRecording()`, `divergence()`, `save()`. Ветка стоит под `import.meta.env.DEV`, поэтому прод-бандл её вырезает; тот же флаг уезжает в `room.isDevMode` и включает рекордер хоста. Порт 12 (`CONSOLE`) приносит отладочный лог хоста в консоль этой вкладки как `[vimp:debug][host] …`. См. [debugging.md](debugging.md#браузерная-половина).

## Сетевой слой (packages/engine/src/client/network/)

Игровой транспорт — WebRTC, а не WebSocket (детали каналов — [network.md](network.md#транспорт-webrtc)):

- **`SignalingClient`** — тонкая обёртка сигнального WebSocket мастера: `connect()`, кэш `id`/`iceServers` из `welcome`, ретрансляция входящих сообщений подписчикам по полю `type` (через `Publisher`), методы `sendOffer`/`sendIceCandidate`/`pingHost`/`likeHost`/`unlikeHost`. Транспорт инъектируется фабрикой ради тестов.
- **`WebRtcManager`** — P2P-соединение с хостом: `RTCPeerConnection` + каналы `meta` (reliable-ordered) и `state` (unreliable-unordered). Клиент — offerer: создаёт каналы/оффер, обменивается SDP/ICE через `SignalingClient`. События `Publisher`: `open` (оба канала открыты), `message` (данные из любого канала одним потоком), `close` (разрыв). `RTCPeerConnection` инъектируется фабрикой ради тестов.

Роль клиента выбирается в лобби (`packages/engine/src/client/main.js`): **присоединиться** (`connectToHost` → `WebRtcManager`, offerer) или **создать сервер** (`connectAsHost` → браузерный хост в этой же вкладке). Для хоста игровой транспорт — **`LoopbackTransport`**: тот же интерфейс, что у `WebRtcManager` (`publisher` с `message`/`close`, `send`/`close`), но данные ходят через `HostController` → Web Worker постмесседжами, минуя WebRTC. Клиентский код при этом одинаков — транспорт прозрачен.

Вне лобби клиент использует ещё два объекта той же формы:

- **`WebSocketTransport`** (`dedicated`) — обычный WebSocket к игровому серверу. `binaryType` принудительно `'arraybuffer'` (диспетчер отличает кадр снапшота от JSON-порта по `data instanceof ArrayBuffer`, а браузерный WebSocket отдал бы `Blob`); `reliable` игнорируется — уровней надёжности у WebSocket нет. Следствия — [network.md](network.md#транспорт-webrtc).
- **`InlineHostBridge`** (`solo`) — не транспорт, а замена `HostController`: тот же интерфейс `open`/`send`/`disconnect`, поэтому `LoopbackTransport` переиспользуется без изменений, но авторитетный хост крутится в этом же потоке, а не в Worker'е. Внутри — `createHostRuntime` + `PortMachine` с гостевой идентичностью и offline-профилем (`lib/offlinePlayerData.js`); перед первым `open()` обязателен `await bridge.ready`. `HostPlugin` принципиально непередаваем в Worker (`postMessage` не несёт функции) — отсюда inline; прод-путь не меняется, расхождение dev/prod осознанное.

Хост-вкладка дополнительно поднимает главнопоточную инфраструктуру роутинга (главный поток — не Worker): **`HostController`** спавнит Worker с ядром и мостит его с транспортами; **`HostConnectionManager`** — **WebRTC-answerer** удалённых клиентов (зеркало `WebRtcManager`): слушает `webrtc_offer` через `SignalingClient`, на каждого создаёт `RTCPeerConnection`, ловит каналы `meta`/`state` в `ondatachannel`, шлёт `webrtc_answer`+ICE, регистрирует комнату у мастера (`register_host`/heartbeat) и отвечает на лобби-пинг (`ping_host`). Данные удалённых клиентов идут в тот же Worker, что и loopback хоста-игрока. Детали — [host.md](host.md).

Classic-фолбэка на Worker нет (запретил бы ESM и потребовал инлайн WASM — см. риск №5 PLAN.md), поэтому «Создать сервер» сперва фича-детектит поддержку модульных Worker'ов (`packages/engine/src/client/network/workerSupport.js`, `supportsModuleWorker` — браузер читает опцию конструктора `type`, только если понимает module-воркеры). На неподдерживающем браузере показывается честное сообщение «этот браузер не может быть хостом» без побочных эффектов — присоединение к существующим комнатам не затрагивается.

## MVC-компоненты (packages/engine/src/client/components/)

Десять троек `model/` + `view/` + `controller/`: **LobbyAuth**, **Auth**, **Lobby**, **CanvasManager**, **Controls**, **Game**, **Chat**, **Panel**, **Stat**, **Vote**.

**LobbyAuth** — экран входа перед лобби (`plan/done/central-auth/auth_b2.md`):

- **model** — говорит с central auth-сервисом (`packages/auth`, см. [auth.md](auth.md)) напрямую, не через мастер. `boot(search)` один раз при старте разбирает query string OAuth-редиректа (`?token=`/`?pendingToken=`/`?authError=`), иначе восстанавливает identity JWT из `localStorage`; `submitNick` — единственный сетевой вызов, который эта модель делает сама (`POST /nick` с pending-токеном, в отличие от остальных моделей, публикующих сигнальный I/O событиями) — это обычный кросс-доменный fetch, а не сигнальный трафик. Публикует `login-required`/`nick-required`/`authenticated`/`login-error`/`nick-error`. Payload identity JWT декодируется на клиенте только для отображения (`packages/engine/src/lib/jwt.js`, `decodeJwtPayload`, без проверки подписи) — авторитетную проверку по `/jwks` делает хост (`plan/done/central-auth/auth_b3.md`; см. [auth.md](auth.md#вход-в-комнату-проверка-хостом)).
- **view** — переключает `#lobby-auth-login`/`#lobby-auth-nick` (`views/includes/lobbyAuth.pug`) и по `authenticated` прячет `#lobby-auth`, показывает `#lobby` и бейдж ника/выхода `#lobby-user` (`views/includes/lobby.pug`) — сам `#lobby` в шаблоне стартует скрытым, включает его только `LobbyAuthView` (или `LobbyCtrl.open`). Кнопки провайдеров (`.lobby-auth-provider`, `data-provider`) фильтруются по списку из конфига.
- **controller** — `login(provider)` переводит браузер (`window.location.href = model.loginUrl(provider)`) на `GET /oauth/:provider/start` auth-сервиса — это навигация верхнего уровня, а не fetch, поэтому CSP `connect-src` её не касается. `nick`/`logout` проксируются в модель.

Конфиг — [packages/engine/src/config/authClient.js](../../packages/engine/src/config/authClient.js) (бандлится в сборку, как `lobby.js` — `serviceUrl` должен указывать на реальный домен auth-сервиса per-деплою; CSP `connect-src` мастера (`config/master.js`, `security.csp`) шаблонизируется тем же `authServiceUrl`, чтобы fetch лобби `POST /nick` не блокировался в проде. `GET /oauth/:provider/start` и редирект колбэка — навигация верхнего уровня, CSP их не касается в любом случае).

**Lobby** — экран выбора сервера ДО подключения к хосту. Панель разбита на
две колонки (lobby-page-plan — `#lobby-setup-panel`/`#lobby-browser-panel`,
`.lobby-grid` в `style.css`, один столбец ниже 800px): настройки/создание
слева, вкладки Active Servers / Leaderboard справа. Обе лежат в обёртке
`.lobby-column`, под ними — `#lobby-footer`: та же полоса из трёх ячеек, что и
в футере формы входа, и по тем же правилам стилей — ссылка на репозиторий
движка, его версия и копирайт. `LobbyView` пишет обе ячейки один раз из
`client/lib/engineVersion.js`, который импортирует собственный `package.json`
пакета движка (`version` плюс `repository`/`homepage`) и запекается в бандл на
сборке: version-эндпоинта у мастера нет. Ссылку в обоих футерах строит одна пара
`resolveProjectUrl`/`projectLink` (`src/lib/packageLink.js`, рендер —
`client/lib/footerLink.js`): `repository` пакета (иначе `homepage` — в том
числе когда объявленный `repository` ни во что не разрешается),
приведённый к https, с подписью `GitHub` либо по хосту. Фолбэка нет — пакет,
не объявивший ни того, ни другого, ссылки не получает, и ячейка остаётся
пустой: именно это и делает недостающие метаданные видимыми. О них
предупреждает правило контракта `A7`, а
`npm create vimp-game --repository <url>` проставляет поле сразу. Крейта
`vimp-engine-core` там сознательно нет: он `rlib`-only, его WASM собирает
репозиторий игры, и каждая игра пинит свою версию крейта — на экране лобби
такая версия была бы утверждением, которого страница не может подтвердить.

- **model** — реестр серверов (ответы `GET /servers` мастера), пагинация, поиск, умный пинг, а также состояние Leaderboard выбранной игры (`setLeaderboard`/`setPlacement`/`clearLeaderboard`, lobby-page-plan). I/O не делает: публикует `fetch` (запросить REST), `ping-request` (сигнальный ping), `join` (выбран сервер), `list`/`ping-update` (для view) и `leaderboard` (leaderboard/total/myPlacement/loaded — `loaded` отличает «ещё грузится» от «ответ пришёл, реально пусто» для заглушки view). `setLeaderboard`/`setPlacement`/`clearLeaderboard` схлопывают эмит `leaderboard` в один через `queueMicrotask` (code review M2 — `Promise.all` в `main.js` обычно резолвит оба вызова подряд; без коалесинга первый эмит рисовал бы новый список рядом с `myPlacement` *прошлой* игры на один кадр). `latency` живёт отдельно от списка и переживает refresh/пагинацию.
- **view** — рендер карточек, поиск, «Загрузить ещё», переключение вкладок Active Servers/Leaderboard (`showTab`, переключает `.lobby-tab-btn.active` и оба контейнера, чисто UI — fetch не запускает) и рендер самого списка лидеров (`renderLeaderboard`: нумерованные строки по серверному competition-ranking `place`, не по индексу строки — иначе ничьи расходились бы с плашкой позиции вызывающего (code review M3, см. `GET /leaderboard` ниже), заголовок `"<TITLE> TOP-N"`, общее число игроков, заглушка «No ranked players yet» при пустом списке и `loaded === true` у модели, либо «Loading…», пока `loaded === false` (`clearLeaderboard` ставит `false`, `setLeaderboard` — обратно `true`; отличает «ещё грузится» от «ответ пришёл, реально пусто», чтобы заглушка не мелькала во время запроса) и строка позиции вызывающего: «Not ranked yet», если `myPlacement.placement === null`, полностью скрыта, если собственный ник вызывающего (`setSelfNick`, задаётся один раз `main.js` при открытии лобби из `LobbyAuthModel.getNick()`) уже присутствует в отрисованном топе, иначе разделитель `…` (`.lobby-placement-gap`). Видимость решается **членством по нику** в отрисованном списке, а не сравнением `myPlacement.placement` с `leaderboard.length` (code review M4: это разные шкалы — `placement` — competition ranking с разрывами при ничьих, `leaderboard.length` — просто размер страницы — и могли разойтись ровно на ничье, упирающейся в границу `LIMIT`, из-за чего игрок с ничьей пропадал бы и из списка, и из строки позиции; ники глобально уникальны, так что членство однозначно). **Умный пинг** через `IntersectionObserver`: карточка в видимой зоне → `visible` → контроллер шлёт `ping_host`; `pong` обновляет задержку и пересортировывает карточки по возрастанию, при равном пинге — тай-брейк по `rating` по убыванию (lobby-page-plan). `IntersectionObserver` инъектируется ради тестов. Имя карточки — `"<gameId>/<name>"` (lobby-page-plan — совпадает с синтаксисом поиска `gameId/name` у `GET /servers`, см. [master.md](master.md#get-servers)), карточка также показывает закэшированный рейтинг хостера (server-rating этап 3 — `.lobby-card-rating`, прямо из поля `rating` объекта сервера, со знаком для положительных значений (`+7`/`-3`/`0`); это движковый UI лобби, игровой плагин его не рисует.
- **controller** — проксирует view-события в модель; дросселирование пинга — в модели (`pingHost` возвращает `false`, если сервер пинговали недавно, интервал `pingInterval`). Сам fetch не делает (lobby-page-plan): **единственный** триггер — `gameChanged(gameId, title)` (вызывается `main.js` по `change` `#lobby-game`, а также один раз при открытии лобби для игры по умолчанию), только он эмитит `leaderboard-needed` с целевым `gameId` на собственном `publisher` контроллера. Переключение вкладок (`showTab`) — чисто UI и никогда само по себе не запускает fetch (code review L4/L5 — более ранняя ветка «ленивая загрузка при первом открытии вкладки» могла сработать раньше `gameChanged`, уйдя в запрос с `gameId: null`); данные Leaderboard всегда готовы заранее, до открытия вкладки. `main.js` слушает `leaderboard-needed`, сначала сбрасывает в модели устаревшие leaderboard/placement (code review M1 — иначе строки прошлой игры видны под заголовком новой до ответа сети, а при сетевом сбое — навсегда), помечает запрос монотонно растущим id, чтобы более медленный устаревший ответ не затёр более быстрый от игры, на которую переключились позже (latest-wins), затем вызывает `fetchLeaderboard`/`fetchPlacement` (`GET /auth/leaderboard`/`GET /auth/placement`, проксируются мастером — см. [master.md](master.md#get-authleaderboard-get-authplacement)) и возвращает результат в `model.setLeaderboard`/`setPlacement`.

Конфиг — [packages/engine/src/config/lobby.js](../../packages/engine/src/config/lobby.js) (бандлится в сборку, т.к. лобби проходит до подключения к хосту). Замер пинга **приблизительный** (клиент→мастер→хост, не P2P RTT) — так и подаётся в UI.

Форма «Создать сервер» **генерируется** по явной схеме `roomForm` манифеста активной игры — упорядоченному массиву дескрипторов полей (`populateRoomForm` в `main.js`, рендерится через `client/lib/formBuilder.js`) — см. [plugin-api.md](plugin-api.md#схема-формы). Движок больше не выводит контрол из типа значения по умолчанию: манифест без `roomForm` пишет предупреждение в консоль и рендерит пустой список полей вместо угадывания. Селектор игры (`#lobby-game`, `populateGameSelect`) теперь всегда заполнен **всем** каталогом мастера (lobby-page-plan — раньше держал только активную игру и был скрыт при одной игре в каталоге); выбор другой записи пересобирает форму комнаты по её `roomForm` и обновляет Leaderboard через `gameChanged`. При отправке форма сначала валидируется (неверная форма не стоит загрузки плагина), значения полей снимаются **до** `await`, активирующего выбранную игру, а перекрываемые `roomDefaults` и уезжающие в Worker `room.game` берутся из *выбранного* манифеста (см. заметку в «Бутстрап» выше). Значение каждого поля (`getValue()`, уже сконвертированное по `unit`, например `unit:'s'` секунды→мс) перекрывает соответствующий ключ `roomDefaults`, и результат уходит объектом комнаты в `connectAsHost` → `HostController` → Worker, где `applyRoomOverrides` (`packages/engine/src/lib/applyRoomOverrides.js`) читает `maxPlayers`/`roundTime`/`mapTime`/`friendlyFire`/`map`.

Publisher-паттерн связей внутри тройки:

- `main.js` или `view` → методы `controller` вызываются **напрямую**;
- `controller` → методы `model` вызываются **напрямую**;
- `model` → `view` — **через `Publisher`** ([packages/engine/src/lib/Publisher.js](../../packages/engine/src/lib/Publisher.js)): модель публикует событие, view подписана; на модель могут подписываться и внешние подписчики.

**LobbyCtrl** (lobby-page-plan) — единственный контроллер, у которого тоже
есть собственный `Publisher`, по той же причине, что и у модели: `main.js`
должен реагировать на чисто UI-событие (смена селектора игры, первое
открытие вкладки Leaderboard), не заставляя контроллер самого делать
сетевой I/O — см. `leaderboard-needed` выше.

Назначение компонентов:

- **LobbyAuth** — экран входа перед лобби через central auth-сервис (см. выше).
- **Auth** — комнатная форма входа только для игро-специфичных полей
  (например, `model`), клиентская валидация (`validators.js`), localStorage.
  Поля строятся тем же `formBuilder.js`, что и room-форма, из
  `PS_AUTH_DATA.params[]` — см. [plugin-api.md](plugin-api.md#схема-формы).
  Ник здесь больше не вводится (Этап B3, см.
  [auth.md](auth.md#вход-в-комнату-проверка-хостом)): `main.js` прикладывает
  `LobbyAuthModel.getToken()` к payload `AUTH_RESPONSE` как `token`, хост
  проверяет его по `/auth/jwks` и берёт ник оттуда.
- **CanvasManager** — управляет несколькими PixiJS `Application` одновременно: `vimp` (основной игровой canvas) и `radar` (мини-карта); canvas-элементы генерирует `main.js` из конфига канвасов игры (`modules.canvasManager.canvases`, включая стартовые `width`/`height`) — в HTML их нет. Адаптивное масштабирование (эталон 1920px), `aspectRatio`/`fixSize`/`baseScale`, динамическая камера (look-ahead, zoom от скорости) и тряска — параметры в [configuration.md](configuration.md#modulescanvasmanager--полотна-и-камера).
- **Controls** — перехват клавиатуры (`InputListener`), активный набор клавиш диктует сервер (порт 17), режимы `chat`/`vote`/`stat`, отправка ввода `"seq:action:name"`. Дополнительно — **канал указателя** (мышь, палец, стилус: один набор Pointer Events): игра объявляет его как `modules.controls.pointer`, по проводу идёт `"seq:aim:x:y:flags"` с **мировой** точкой (пересчёт — `CanvasManagerView.toWorld`) и битами: бит 0 «прижат», бит 1 «двойной тап». Гейты те же, что у клавиш: выключенный ввод, открытый режим или набор клавиш вне `pointer.keySets` гасят канал и отпускают прижатый указатель. Игра, не объявившая `pointer`, не получает ни слушателя, ни трафика — см. [../ai/04-client-plugin.md](../ai/04-client-plugin.md).
- **Game** — ядро рендеринга: `GameCtrl.parse(name, data)` создаёт/обновляет/удаляет экземпляры сущностей по снапшот-данным через `Factory`.
- **Chat** — вывод сообщений (лимит строк, время жизни), командная строка; экранирование на выводе (`textContent`).
- **Panel** — HUD: время раунда, здоровье, боезапас, активное оружие (по строкам `'ключ:значение'`). `PanelView` **генерирует DOM по схеме игры** (`modules.panel.fields`: упорядоченный список `{ name, elem, type }`; семантику ячейки задаёт `type: 'bar' | 'value' | 'time' | 'weapon'`, а не имя поля — у `bar` дополнительно `max` и `blocks`) внутри движкового контейнера `#panel`; внешний вид ячеек — CSS игры (блоки бара — нейтральные движковые классы `panel-bar-*`). Заголовок `#logo` внутри `#panel` показывает название игры из `authSchema.texts.title` (то же значение, что и `#auth-title`), применяется при получении `PS_AUTH_DATA`, до этого/при отсутствии — резервное `'VIMP'`; CSS `#panel`/`#logo` построен на flex, так что таблица панели подстраивается под название любой длины. Тот же обработчик заполняет футер формы входа (`#auth-link`) — полосу из трёх ячеек, такую же, как в лобби: `#auth-package-link` (репозиторий активной игры) и `#auth-version` (её npm-версия) берутся из метаданных пакета, которые мастер кладёт в манифест — `packageVersion` и `packageUrl`, вычитанные `GameCatalog`'ом из `package.json` самого пакета игры (см. [master.md](master.md)). Это именно npm-semver, а не `manifest.version` (хеш бандла). Манифест без этих полей (например, standalone-манифест) оставляет обе ячейки пустыми, раскладка не страдает: три ячейки — равные флекс-колонки, поэтому версия остаётся по центру, даже когда соседние пусты.
- **Stat** — таблицы scoreboard с сортировкой (`sortList`), показывается по Tab. `StatView` **генерирует шапку и таблицы по схеме игры** (`modules.stat.params`: `columns` — подписи колонок, `bodies` — произвольное число команд) внутри контейнера `#stat`; цвета/подписи команд — CSS игры.
- **Vote** — окна голосований из шаблонов, пагинация, таймер жизни.

## Клиентское ядро (ClientCore)

Клиентская математика — интерполяция снапшотов, предикт своего танка,
визуальный спавн снарядов и распаковка кадров v3 — живёт в Rust-ядре
(`packages/engine/core/src/client/` + собственный `core/src/client/`
игры-плагина, например в `vimp-tanks`,
wasm-bindgen класс `ClientCore` из того же WASM-бинаря,
что `GameCore` хоста). JS-оболочка (`main.js`) только пересылает данные и
применяет результат к рендеру; ABI и раскладки — в [core.md](core.md#rust-трейты-vimp-engine-core).

Поток данных:

- **Вход**: `handleMessage` передаёт бинарный кадр в `push_frame(bytes, now)` —
  ядро распаковывает (несовпадение версии — кадр отброшен), вставляет в буфер
  по `seq` с дедупликацией и, если кадр несёт player-блок, делает
  reconciliation предикта. Порты `MAP_DATA`/`PANEL_DATA`/`KEYSET_DATA`/`CLEAR`
  зеркалятся в `set_map`/`sync_panel`/`set_active`/`reset`; модель танка —
  `set_model` при авторизации. `reset` означает «мира больше нет»: вместе с
  буфером и предиктом обнуляется `my_game_id`, идентичность восстановится из
  первого же player-блока (у наблюдателя его нет — значит и предсказанной
  сущности не будет).
- **`resync()`**: чистит только сетевую половину — буфер интерполяции и
  очередь исходящих кадров, — не трогая предикт и идентичность. Зовётся
  оболочкой, когда вкладка снова становится видимой после долгой паузы:
  оффсет часов пересеивается точно, а не догоняется EMA, при этом сущности
  на полотне остаются живыми.
- **Рендер-тик**: `sample(now)` возвращает длину плоского **hot-буфера** —
  `new Float32Array(wasm.memory.buffer, hot_ptr(), len)` читается zero-copy
  (view пересоздаётся каждый тик: рост памяти WASM детачит buffer). Буфер несёт
  флаги, камеру (уже разрешённую: предсказанная позиция либо интерполированная),
  интерполированные записи акторов/динамики и predicted-записи игры
  последними: сначала свой актор (`render_overlay`), затем тела, которые
  игра предсказывает сама (`render_rows`: динамика карты, чужие акторы
  в контакте). Адаптер `reconstructHot`
  (`packages/engine/src/lib/reconstructHot.js`: `buildSnapshotKeysById` —
  обратный индекс схемы, `reconstructHot(hot, keysById)` — обход буфера;
  общий с headless-runner'ом, который разбирает кадры тем же кодом) собирает
  из него
  объект прежней формы `{ m1: { id: [...] }, c1: {...} }` и отдаёт в
  существующий `applyGameData` — GameCtrl/parts не менялись; хвостовая запись
  ложится в `game[key][id]` наравне с прочими, поэтому перекрывает
  интерполированную строку той же сущности тем же конвейером. Флаг
  `PREDICTED` поднимается при любом из двух хвостов — записи своего актора
  или строк самой игры, — а потребитель гейтит по нему весь разбор
  (`GAME | PREDICTED`), поэтому буфер с одними строками тоже разбирается.
- **Событийные кадры** (флаг `hasFrames`): `take_frames()` отдаёт JSON-массив
  `[{ game, camera }, …]` — пересечённые `renderTime` кадры целиком ровно один
  раз (события `w1`/`w2e`, создания/удаления, reset/shake камеры), уже с
  подавленными дублями своих выстрелов; применяются прежним `applyShot`.
  Звук и эффекты триггерятся, как и раньше, самими parts при создании
  сущностей — отдельного eventId-диспетчера нет.
- **Ввод**: `apply_input(action, name, now)` пишет историю предикта, а
  `apply_aim(x, y, flags, now)` пишет в ту же историю ввод указателем (оба —
  методы трейта; у `apply_aim` дефолтная пустая реализация, так что ядру без
  указателя править нечего); игровые
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
  закрепляют cargo-тесты `client::predictor::parity`; история ввода, replay от `serverTime`
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

- **`BakingProvider`** ([providers/BakingProvider.js](../../packages/engine/src/client/providers/BakingProvider.js)) — однократная генерация процедурных текстур при старте по конфигу `bakedAssets`; функции запекания — в [`src/client/bakers/` игры-плагина](https://github.com/lgick/vimp-tanks/tree/main/src/client/bakers) (например, в `vimp-tanks`; фиксированного интерфейса нет, ориентироваться на существующие). Пекарь владеет тем, что вернул: перепечка уничтожает прежний результат (каждый объект ровно один раз за проход, даже если он лежал под несколькими ключами) вместе с его `TextureSource`, поэтому возвращать вьюху на общий атлас нельзя.
- **`DependencyProvider`** — инъекция сервисов (`renderer`, `soundManager`, `assetsBase`, `localPlayer`) в компоненты по карте `componentDependencies`. `localPlayer` (`{ id, is(id) }`, [lib/localPlayer.js](../../packages/engine/src/client/lib/localPlayer.js)) отвечает, своя ли это сущность: part сравнивает id, полученный четвёртым аргументом конструктора (`{ id }`), со своим gameId, который сервис читает у клиентского ядра лениво. Так игра играет звук только за своего персонажа, а не за каждую сущность на полотне. `assetsBase` — база ассетов активной игры из её манифеста: part, рисующий из файлов-картинок, строит URL сам как `${assetsBase}img/<file>` — тем же способом, каким разрешаются звуки (`${assetsBase}sounds/`). Картинок игры движок не везёт: они едут в пакете плагина (`dist/img/`). Рядом с движковыми сервисами в пуле лежат **игровые**: необязательный `ClientPlugin.hooks.services(core)` возвращает карту, которая подмешивается в пул перед движковыми ключами, — так игра достаёт из part'а своё ядро, а движок не знает, что именно она отдаёт (плагин танков раздаёт так `mapDynamics` — геометрию предсказанной динамики карты, по которой эффект выстрела привязывает осколки к задетому ящику). При совпадении имён движковый ключ побеждает, а сервис, не объявленный никем в `componentDependencies`, просто не выдаётся.

## SoundManager

[packages/engine/src/client/SoundManager.js](../../packages/engine/src/client/SoundManager.js) (на Howler.js). Звуки описаны в `src/config/sounds.js` игры-плагина (например, в `vimp-tanks`); поле `path` переопределяется на клиенте (`main.js`, обработчик `CONFIG_DATA`) на `${activeGameManifest.assetsBase}sounds/` — собственную копию звуков сборки игры рядом с её client/host-бандлами (`dist/sounds/` игры-плагина), вместо бандловой `/sounds/` движка.

- **UI/системные** (без позиции): `playSystemSound(name)` — немедленно, в обход приоритетов (используется и для звуков порта 6).
- **Пространственные** (позиция в мире): `registerSound(name, { position })` → `processAudibility()` → `updateActiveSounds()` — менеджер сам решает, что слышно, соблюдая лимит голосов (`WORLD_VOICE_LIMIT = 30`) и приоритеты из конфига.
- **Снятие с регистрации**: `unregisterSound(id)` останавливает звук и
  снимает регистрацию — для сущности, чей звук обязан умереть вместе с ней.
  `releaseSound(id)` снимает регистрацию, но даёт уже звучащему одноразовому
  сэмплу доиграть (луп при этом всё равно останавливается: он обязан
  замолчать вместе с владельцем). Для сущностей, которые исчезают раньше
  своего звука, — взорвавшаяся бомба доигрывает сэмпл постановки.
- **`reset()`** останавливает все звучащие инстансы и **сохраняет луповые
  регистрации**, лишь обнуляя их активные id: регистрациями владеют
  сущности, которые снимают их сами в `destroy()`. При полном `CLEAR` реестр
  и так пуст, а при частичном уцелевший луп перезапустит ближайший
  `processAudibility()`. Одноразовые регистрации, наоборот, снимаются:
  `Howler.stop()` не шлёт событие `end`, поэтому регистрация уже сыгравшего
  сэмпла уцелела бы и прозвучала бы второй раз с начала. Реестр целиком
  чистит только `destroy()`.

## InputListener

[packages/engine/src/client/InputListener.js](../../packages/engine/src/client/InputListener.js) — низкоуровневый перехват keydown/keyup для Controls; `modes`/`cmds` имеют приоритет над игровым набором клавиш.

## Иерархия UI (z-index)

`vimp` (1) → `radar` (2) → `chat` (3) → `panel` (4) → `vote` (5) → `game-informer` (6) → `stat` (7) → `lobby`/`auth` (8) → `tech-informer` (9). Лобби (`#lobby`, z-index 8) — стартовый экран выбора сервера, показывается до подключения к хосту и скрывается при входе в игру.

---

[← Предыдущая: Rust-ядро](core.md) · [Следующая: Сетевой протокол →](network.md)
