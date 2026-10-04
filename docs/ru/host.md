# Браузерный хост

Браузерный хост разворачивает **авторитетную часть матча прямо во вкладке
текущего хоста** — сначала создателя комнаты, затем того участника, к
которому перешла роль (см. [Миграция хоста](#миграция-хоста)): WASM-ядро симуляции (`core/`) и JS-мету — в Web Worker'е, а
`RTCPeerConnection`-роутер — в главном потоке. Это каноничная «серверная часть»
игры: легаси авторитетный WS-сервер (`src/server/`) полностью демонтирован.

Код хоста — `packages/engine/src/host/` (Worker + ядро + мета-модули `packages/engine/src/host/meta/`) и
`packages/engine/src/client/network/` (роутер главного потока + транспорты).

## Топология вкладки хоста

```
Вкладка хоста
├─ Главный поток (клиент + роутер)
│   ├─ client (packages/engine/src/client/main.js): рендер, предикт, звук — как обычный клиент
│   ├─ HostController: спавнит Worker, роутит пакеты Worker ↔ клиенты
│   ├─ LoopbackTransport: транспорт хоста-игрока (интерфейс WebRtcManager
│   │  поверх postMessage)
│   └─ HostConnectionManager: WebRTC-answerer для удалённых клиентов
│      (register_host, meta/state, бэкпрешер)
└─ Web Worker (packages/engine/src/host/host.worker.js): авторитетная симуляция
    ├─ GameCore (WASM, core/pkg-web игры-плагина, например vimp-tanks)
    ├─ GameCoreAdapter: поверхность физики/ботов/упаковки поверх ядра
    └─ HostGame-фасад + мета packages/engine/src/host/meta/ (RoundManager, Participant-
       Manager, Chat, Vote, Stat, Panel, TimerManager, RTTManager,
       CommandProcessor, VoteCoordinator, SocketManager) + цикл ~120 Гц
```

Ключевое правило: `RTCPeerConnection` **живут в главном потоке** (в Worker их
создать нельзя), а игровой цикл — **в Worker'е** (его таймеры не троттлятся
браузером в фоновой вкладке, в отличие от главного потока). Главный поток —
дамб-пайп: пересылает wire-кадры между DataChannel/loopback и Worker'ом.

## Web Worker (`packages/engine/src/host/host.worker.js`)

Загружает `HostPlugin` игры (динамический `import(room.game.hostEntryUrl)`,
Этап 6.4 — Worker не знает игру на этапе сборки), строит `HostGame` с
настройками комнаты и отдаёт per-client хендшейк в `PortMachine`
(см. [ниже](#порт-машина-portmachinejs)) — автомат клиентских портов 0–8
(см. [network.md](network.md)). Сам Worker — тонкий адаптер: транспорт
`postMessage`, лобби-стратегия идентичности и свитч сообщений главного
потока. Сообщения главного потока:

- `init(room, handoff?)` — динамически импортирует `HostPlugin` по
  `room.game.hostEntryUrl` (`room.game = { id, version, hostEntryUrl,
wasmUrl }`, собирается `HostRole.createRoom` из активного `GameManifest`),
  собирает конфиг игры (merge движковых дефолтов
  `packages/engine/src/config/hostDefaults.js` и представления `gameConfig` —
  `packages/engine/src/lib/gameConfigView.js`, единственная точка чтения
  конфига плагина: проверяет четыре обязательных пути и подставляет
  задокументированное умолчание для всех остальных полей, поэтому грузится
  игра любого возраста; см.
  [plugin-api.md](plugin-api.md#поля-gameconfig-и-их-умолчания)) и
  применяет к нему настройки комнаты (`applyRoomOverrides`,
  `packages/engine/src/lib/applyRoomOverrides.js`: имя/карта/лимит
  ≤ `roomDefaults.maxPlayers`/таймеры (`roundTime`/`mapTime` клампятся в
  `roomTimeMin…roomTimeMax`)/friendly fire; карты —
  из `room.maps`, если главный поток скачал каталог мастера), инициализирует
  ядро через `HostPlugin.createCore(coreConfigJson, { wasmUrl:
room.game.wasmUrl })`, создаёт `HostGame`, отвечает
  `ready { mapName, lobbyInfo, seed }`. Всё, кроме postMessage-обвязки, — это
  `packages/engine/src/lib/createHostRuntime.js`, та же функция, которой
  поднимает матч headless-runner, так что разъехаться они не могут (её точки
  расширения — `loadHostPlugin`, `createSocketManager`, `hostOptions`,
  `overrideGameConfig` — в проде не задаются и дают поведение выше). `seed`
  в `ready` — тот PRNG-сид, на котором реально идёт матч: `room.seed`, если
  задан, иначе розыгрыш через `clock`; именно он делает запись
  воспроизводимой, см. [debugging.md](debugging.md); `handoff` —
  состояние эстафеты Worker'ов: комната восстанавливается вместо холодного
  старта; `checkpoint` (gzip-байты, списком переноса) + `seqFloor` —
  контрольная точка хоста (host-migration этап 5): матч поднимается **на
  паузе**, люди отсоединены, см. [Контрольные точки](#контрольные-точки).
  Сбой (импорт игры/WASM/конфиг/handoff-мета/контрольная точка) — сообщение
  `error { message }`: при холодном старте главный поток гасит комнату и
  возвращает в лобби, при эстафете — возобновляет старый Worker;
- `connect(socketId)` — новый клиент: регистрирует wire-сокет в `SocketManager`,
  шлёт `CONFIG_DATA` (порт 0), запускает handshake config→auth→map→firstShot.
  **Полная комната** (`HostGame.isFull`, **люди** против `maxPlayers`; боты
  слот не занимают — при подключении человека сверх суммарного лимита один бот
  кикается, `_freeSlotForHuman`) — отказ: закрытие соединения кодом `4006`
  с причиной `roomFull` (очереди ожидания в P2P-комнате нет). Клиент из
  handoff-меты эстафеты восстанавливается минуя handshake — порт-машина
  поднимается сразу в игровом состоянии;
- `message(socketId, data)` — входящее сообщение клиента (`JSON [port, payload]`),
  диспетчеризуется по разрешённым портам;
- `disconnect(socketId)` — удаляет участника из игры и реестра;
- `update_maps(maps)` — обновлённый каталог карт мастера →
  `HostGame.updateMaps`;
- `prepare_handoff` / `cancel_handoff` / `resume` / `handoff_complete` —
  протокол эстафеты Worker'ов (см. одноимённый раздел ниже);
- `checkpoint_start { intervalMs }` / `checkpoint_stop` /
  `checkpoint_request { final }` / `start_after_restore { waitForResume }` /
  `freeze` / `unfreeze` — контрольные точки хоста (см.
  [Контрольные точки](#контрольные-точки); `waitForResume` —
  [Промоушен преемника](#промоушен-преемника));
- `round_boundary_wait` / `round_boundary_cancel` — плановая передача в игре
  без `migration.midRound` ждёт следующего раунда (этап 8d миграции хоста):
  Worker отвечает `round_boundary`, когда следующий раунд стартовал (раунд
  не придерживается — преемник всё равно начнёт его заново из мягкой точки,
  а сорвавшаяся передача не должна оставить комнату без раунда), а у игры с
  `midRound` — сразу;
- `shutdown { timeoutMs }` — хост закрывает комнату («Leave server», когда
  в ней больше никого): Worker вызывает `HostGame.destroy()` — закрывает
  игры участников и ждёт срочной записи профилей — не дольше `timeoutMs`
  (по умолчанию 3 с) и отвечает `shutdown_done`; исключение в `destroy`
  уходит как `diagnostic { kind: 'shutdown' }`, `shutdown_done` — всё
  равно. С этого момента новый `connect` (гость, чей оффер дошёл до хоста
  раньше `host_closing`) получает `close_client` без кода — в лобби-режиме
  гость ищет другую комнату, а не входит в закрывающийся матч. Worker не
  гасится — это делает главный поток;
- `debug { action, requestId }` — отладочные запросы, только в dev
  (`startRecording`/`stopRecording`/`dump`), ответ — `debug_result` с тем же
  `requestId`. Промис в главном потоке имеет таймаут 5 с: отладка нужна
  ровно на зависшем Worker'е, а молча висящий `await` — тот же отказ, против
  которого вся эта оснастка и написана. См. [debugging.md](debugging.md).

Обратно в главный поток Worker шлёт `to_client` (wire-кадр: JSON-строка или
бинарный `ArrayBuffer` через Transferable), `close_client`,
`ready { mapName, lobbyInfo, seed }`, `error` (сбой инициализации),
`map_changed { mapName }` (смена карты голосованием/таймером; оставлено для
главного потока, загруженного до этапа 2 host-migration), `lobby_info { info }`
(сменилась строка карточки комнаты в лобби — главный поток актуализирует
комнату у мастера; см. `gameConfig.lobbyInfo` в
[plugin-api.md](plugin-api.md#поля-gameconfig-и-их-умолчания)), `handoff_state { state }` (эстафета:
состояние комнаты на границе раунда),
`checkpoint { checkpointId, seq, createdAt, final, mode, bytes }`
(контрольная точка, `bytes` — списком переноса; сбой кодирования —
`diagnostic` с `kind: 'checkpoint'`), `health { health }` (здоровье хоста,
см. ниже) и `debug_result { requestId, … }`.
Per-user **wire-сокет** (`makeWorkerSocket`) реализует контракт `SocketManager`
(`send`/`sendBinary`/`close`) поверх `postMessage`. Особенности транспорта:

- `close(code, data)`: закрытие data channel не несёт код/причину — причина
  (кик за бездействие/RTT, полная комната) доставляется отдельным
  `TECH_INFORM_DATA` по meta **до** `close_client` (reliable-ordered
  гарантирует порядок), клиент показывает её вместо общего «Host left»;
- `send(port, data, reliable)`: `reliable: false` уводит JSON-сообщение в
  ненадёжный state-канал — так ходит только `PING` (см. `network.md`).

Игровой цикл ~120 Гц стартует сам (конструктор `HostGame` → `RoundManager.createMap`
→ `TimerManager.startGameTimers`); кадры уходят только готовым к игре участникам.

**Здоровье хоста** (host-migration этап 9a). Цикл меряет себя окнами ~1 с
(`TimerManager`, `onLoopStats`): `tickRate` (итераций цикла в секунду,
номинал 120), `maxGapMs` (самый длинный разрыв между итерациями) и `lostMs`
(время, срезанное капом `dt` 0.1 с, — симуляция отстаёт от реального
времени), плюс `windowMs`. `HostGame` добавляет `peerRttMedian` /
`peerCount` — медиану сглаженного RTT удалённых людей, ответивших хотя бы
на один пинг (хост-игрок на loopback и стартовая догадка 100 мс не в счёт;
таких нет — `null` / `0`), — и Worker шлёт главному потоку
`health { health }` (`HostController.onHealth`). Пока матч заморожен или на
паузе, цикл стоит и метрик нет — заморозка никогда не выглядит перегрузкой.
Пока вкладка-хост скрыта, главный поток копит метрики и пишет в журнал
клиентских ошибок одну сводку за эпизод скрытия (см.
[debugging.md](debugging.md)).

### Порт-машина (`PortMachine.js`)

`packages/engine/src/host/PortMachine.js` — сам автомат хендшейка, и он
**изоморфен**: ни `self`, ни `postMessage`, ни DOM — всё, что он знает про
транспорт, приходит через зависимости. Именно это позволяет крутить один и
тот же автомат в Worker'е, в inline-хосте браузера и в Node-процессе; вторая
его копия разъехалась бы ровно так, как разъезжались бы копии
`createHostRuntime`.

```js
new PortMachine({ host, socketManager, clientCfg, authSchema, makeSocket, identity });
```

`makeSocket(socketId)` отдаёт wire-сокет (`send`/`sendBinary`/`close`,
контракт `SocketManager`), `identity` — стратегия идентичности (ниже).
Методы: `connect(socketId)` (регистрация сокета, `CONFIG_DATA`, старт
хендшейка — либо отказ **полной комнаты** кодом `4006`/`roomFull`),
`restore(socketId, gameId)` (участник, уже восстановленный из handoff-меты:
машина поднимается в игровом состоянии, хендшейк не повторяется),
`message(socketId, data)` (wire-кадр `JSON [port, payload]`, диспетчеризация
по разрешённым портам), `disconnect(socketId)`, `has(socketId)` и геттер
`socketIds` (то, чем кормят `HostGame.completeHandoff(new Set(...))`),
`startGraceFor(gameIds)` (этап 7 миграции хоста: заводит ожидание
участникам, поднятым из контрольной точки отсоединёнными, — обрыва на этом
хосте у них не было, и больше его никто не заведёт; при `resumeGraceMs`
`0` они снимаются сразу).

**Возобновление сессии** (этап 4 миграции хоста) включается ещё двумя
зависимостями — `resumeGraceMs` и `resumeRequestTimeoutMs`. Передаёт их
только Worker лобби (из `config/hostDefaults.js`: 20 с / 5 с); dedicated-
сервер и inline-хост оставляют `resumeGraceMs` равным `0` и ведут себя
ровно как раньше. С включённым возобновлением:

- после `FIRST_SHOT_READY` участник получает секрет возобновления
  (`HostGame.issueResumeKey`, 128 случайных бит, hex, не логируется) в
  `SESSION_DATA { resumeKey, gameId }`;
- `disconnect` участника с ключом **отсоединяет** его
  (`HostGame.detachUser`) и запускает таймер ожидания; таймер снимает
  участника, только если тот всё ещё отсоединён. Участник без ключа (ещё в
  хендшейке) и хост-игрок снимаются сразу;
- `LEAVE` (клиентский порт 10) снимает участника сразу;
- `connect(socketId, { resume: true })` не шлёт `CONFIG_DATA`, открывает
  только `RESUME_REQUEST` и закрывает соединение кодом `4008`, если за
  `resumeRequestTimeoutMs` ничего не пришло;
- `RESUME_REQUEST` проверяется по порядку — версия формата, участник и его
  ключ (сравнение постоянного времени; неизвестный `gameId` и чужой ключ
  оба отвечают `unknown`), ник токена против ника, под которым участник
  входил (`auth`), — и перепроверяется после асинхронной проверки личности.
  При успехе старое соединение, ещё привязанное к участнику, закрывается
  (перехват сессии), таймер ожидания снимается, открываются игровые порты,
  и `HostGame.resumeUser` шлёт `RESUME_RESULT`, пакет входа и новый
  `SESSION_DATA`. Отказ шлёт `RESUME_RESULT { ok: false, reason }` и
  закрывает соединение; отсоединённый участник продолжает ждать.

Проводная сторона протокола — в
[network.md](network.md#возобновление-сессии).

### Стратегии идентичности (`identity.js`)

Кто именно входит в комнату — единственное, чего хендшейк не решает сам, —
подключаемая стратегия, `packages/engine/src/host/identity.js`:

| Стратегия                                  | Контур                 | `params`         | `errorField` | `resolve`                                 |
| ------------------------------------------ | ---------------------- | ---------------- | ------------ | ----------------------------------------- |
| `createTokenIdentity({ jwksUrl, issuer })` | лобби (прод)           | `[]`             | `token`      | claim `nick` проверенного identity-токена |
| `createGuestIdentity({ fallbackPrefix })`  | standalone / dedicated | одно поле `name` | `name`       | ник из формы, заглушка `Player_xxxx`      |

Контракт — `{ params, errorField, resolve(data, socketId) }`. `params`
встают перед `authSchema.params` игры в обе стороны (ник — первое, что
заполняет игрок): уезжают в `AUTH_DATA`
(гостевое поле ника доходит до формы клиента ровно тем же каналом, что и
собственные поля игры) и проверяются `validateAuth` на `AUTH_RESPONSE`.
Отказ `resolve` отвечает `AUTH_RESULT` с
`[{ name: <errorField>, error: 'invalid' }]`, участник не создаётся.

Гостевая стратегия объявляет поле `name` с движковым валидатором
`isValidName` (`packages/engine/src/lib/validators.js`) — хост валидирует ник
без единой строки кода игры. **Её ограничения приняты осознанно**: гостевые
ники не уникальны и не защищены от подмены — центральной идентичности в этом
контуре нет вовсе.

### Ответ авторизации (Этап B3)

Порт 1 (`AUTH_RESPONSE`) по-прежнему прогоняет `validateAuth` по
`HostPlugin.authSchema.params`/`.validators` игры (только игро-специфичные
поля, например `model` — `name` убран из
`src/config/auth.js` игры-плагина, например `vimp-tanks`). После этой проверки хост сам —
источник истины об идентичности: в лобби Worker подключает
`createTokenIdentity`, чей `resolve(data)` лениво фетчит и кэширует
`GET /auth/jwks` (проксирование мастером центрального auth-сервиса, см.
[auth.md](auth.md#вход-в-комнату-проверка-хостом) и
[master.md](master.md#get-authjwks)) на время жизни стратегии, затем
`verifyIdentityToken` (`packages/engine/src/lib/jwt.js`) проверяет подпись
RS256 (Web Crypto `crypto.subtle`, без JWT-зависимости), `iss`
(`config/authClient.js`, поле `issuer`) и срок годности, и возвращает claim
`nick` токена. Только после этого выполняется `host.createUser({ ...data,
name: nick }, socketId, cb)` — клиент больше не может ввести произвольное
имя. Отсутствующий/невалидный/просроченный токен шлёт `AUTH_RESULT` с
`[{ name: 'token', error: 'invalid' }]`, пользователь не создаётся; клиент,
отключившийся во время проверки, сверяется с живым реестром соединений
порт-машины перед вызовом `createUser`.

### Синхронизация rank и state игрока (Этап B4)

После разовой проверки identity-токена (см. выше) он ещё и **сохраняется**
на участнике — `HumanParticipant.token` (проставляется из `params.token` в
`ParticipantManager.createHuman`), — чтобы поздние аутентифицированные
записи обратно в auth-сервис могли переиспользовать его без повторной
проверки.

`meta/modules/PlayerDataSync.js` — пер-участниковая карта в памяти вида
`{ token, rank, state, rankLoaded, stateLoaded }`. `rankLoaded`/`stateLoaded`
(добавлены по итогам кодревью после B4, `plan/done/central-auth/auth_fixes.md`) отмечают,
подтверждено ли текущее значение auth-сервисом, или это всё ещё дефолт со
входа:

- **Загрузка на join**: `HostGame.createUser()` запускает
  `playerDataSync.load(gameId, params.token)` fire-and-forget — не блокирует
  вход. `load()` дёргает мастеровские `GET /auth/rank` и `GET /auth/state`
  (тот же паттерн относительного fetch, каким Worker уже пользуется для
  JWKS, см. [auth.md](auth.md#вход-в-комнату-проверка-хостом) и
  [master.md](master.md#getput-authrank-getput-authstate)) собственным
  токеном участника. При любом сбое (auth-сервис недоступен, сетевая
  ошибка) остаётся на дефолтах — rank `0` и объявленный игрой
  `playerState.defaultState` (`HostGame` читает его из
  `data.playerState?.defaultState`, например `src/config/game.js`
  игры-плагина, например `vimp-tanks`,
  клонируется на каждого участника, а не расшаривается) — недоступность
  auth-сервиса никогда не блокирует вход, а `rankLoaded`/`stateLoaded`
  остаются `false`, пока значение не подтвердится. Дельта ранга, прибавленная
  через `addRank` пока загрузка ещё идёт, прибавляется к серверному значению,
  а не теряется под ним.
- **Накопление**: `RoundManager.reportKill()` — единый чокпоинт для rank,
  зеркалирует то, как там же уже накапливается эфемерный score `Stat`, —
  `playerDataSync.addRank(killerId, +1 или -1)` с той же веткой
  победа/тимкилл, что и у обновления score.
- **Синхронизация обратно**: `flush(participantId)` шлёт `PUT` текущего
  state и _дельты rank_ участника на мастер (`Promise.allSettled`,
  best-effort — сбой не прорастает в раунд, следующий flush повторит попытку
  с уже накопленными данными; при этом он логируется, а не проглатывается,
  см. «Диагностика синхронизации rank/state» ниже). С server-rating этапа 1 `/rank` на auth —
  append-only леджер, не абсолютное значение: `PlayerDataSync` копит
  `pendingRankDelta` (всё, что `addRank` добавил с последнего успешного
  flush) и шлёт именно его, а не локально накопленный итог; при `200`
  вычитается ровно отправленная дельта, так что `addRank`, произошедший
  параллельно с запросом, не теряется (тот же приём, что и в фиксе гонки с
  `load` ниже). Если `rankLoaded`/`stateLoaded` всё ещё `false`
  (исходная `load` ни разу не удалась), `flush` сперва повторяет `load()` и
  шлёт `PUT` только для той части, что теперь подтверждена загруженной —
  иначе временный сбой auth-сервиса на входе затёр бы реальный сохранённый
  rank игрока дефолтным `0` на ближайшей границе карты/раунда. `flushAll()`
  сливает всех текущих участников. Две точки жизненного цикла вызывают
  `flushAll()`: `RoundManager.createMap()` (смена карты) и
  `RoundManager._resolveRound()` (конец раунда) — обе рядом с уже
  существующими вызовами `Stat.reset()`/`Stat.updateHead()` на тех же
  границах. `HostGame.removeUser()` делает ещё один best-effort `flush()`
  для выходящего участника перед удалением его записи в `PlayerDataSync`.
- **Нумерованные записи** (host-migration 7.7): запись результата игры
  получает номер (`writeSeq`) в момент отправки, и её сумма уходит из
  `pendingPoints`/`pendingBest` в очередь `writes: [{ writeSeq, points,
best }]`. Там она живёт до ответа auth: `ok` или `4xx`, кроме `429`,
  закрывают её; `5xx`, `429` или сетевой сбой оставляют, и следующий flush
  повторяет её **с тем же номером и той же суммой** — лишь затем, в той же
  серии flush, уходят остаток очереди и очки, накопленные за это время.
  `serialize()` везёт `writes` отдельно (в `pendingPoints` их нет), поэтому
  хост, поднятый из контрольной точки, или эстафета Worker'ов, чей
  финальный flush не уложился в таймаут, повторяет запись, которую
  предшественник мог уже донести, и auth отбрасывает повтор
  ([auth.md](auth.md), «Идемпотентная запись»). `restore()` **не**
  продолжает номера точки — старый хост мог после неё занять
  `writeSeq + 1, + 2…`, и свежие очки под этими номерами ушли бы в дубли.
  Вместо этого очки, накопленные на момент точки, сразу закрепляются под
  `writeSeq + 1` (номер, который дал бы им старый хост, — если он их
  отправил, auth отсеет повтор), а все следующие записи берут номера из
  нового случайного диапазона. Остаются игры, законченные в откатываемом
  окне (≤ ~1 с): они могут засчитаться дважды. Номера начинаются со
  случайной точки 48-битного диапазона на запись профиля
  (`crypto.getRandomValues`; в тестах его подменяет опция конструктора
  `writeSeqStart`): в ключе auth нет комнаты, а участник, вышедший и
  вернувшийся, получает новую запись — счёт с нуля совпал бы с номерами
  первого входа. `PUT /auth/state` не нумеруется — это абсолютное значение,
  побеждает последняя запись.
- **Диагностика синхронизации rank/state**: раз ничему из перечисленного не
  позволено ломать раунд, каждый путь сбоя терпится — поэтому каждый из них
  пишет предупреждение `[playerData]` в консоль Worker'а, а не проходит
  незамеченным: неуспешный `GET` на входе (он оставляет
  `rankLoaded`/`stateLoaded` в `false` и тем самым отключает _все_
  последующие `PUT`), неуспешный `PUT` на флаше и любой отклонённый запрос.
  Тишина за весь матч означает, что запросов не было вовсе, — и это указывает
  на `createUser`, а не на синхронизацию. Смежный инвариант: модуль принимает
  `fetchImpl` и обязан звать его как самостоятельную функцию — дефолт
  конструктора ради этого оборачивает глобальный `fetch` стрелкой. Голый
  `fetch` в поле, вызванный как `this._fetch(...)`, передаёт получателем
  экземпляр, а это `TypeError` в браузере/воркере ещё до отправки запроса,
  причём тесты с обычной функцией в `fetchImpl` его не видят.
- **Контур без мастера** (headless-раннер, standalone- и dedicated-хосты) не
  имеет откуда брать профиль — относительный URL вне вкладки не разрешается
  вовсе. Он передаёт `hostOptions.playerDataFetch: offlinePlayerData()`
  (`packages/engine/src/lib/offlinePlayerData.js`), у которого любой ответ —
  `{ rank: 0, state: null }`. Это не заглушка ради тишины: пустой профиль и
  _есть_ корректное состояние такого матча, а вместе с ним уходят сетевые
  вызовы, предупреждения `[playerData]` и ретраи.
- **Атрибуция**: каждое тело `PUT` несёт `roomId` **и секрет комнаты
  `roomSecret`**, чтобы мастер мог проставить событию проверенный `sessionId`
  этой комнаты перед тем, как переслать его в auth, и вести по нему per-room
  потолок записи (см. [master.md](master.md#getput-authrank-getput-authstate)).
  Секрет доказывает, что хост хостит `roomId` (публичный через
  `GET /servers`), поэтому читер-хост не может приписать свои записи чужой
  активной комнате. `PlayerDataSync` не знает свои `roomId`/`roomSecret` при
  создании (Worker стартует раньше ответа мастера `host_registered`);
  `setRoom({ roomId, roomSecret, epoch })` вызывается, когда этот ответ
  приходит — сообщением `set_room` в `host.worker.js`, которое отправляет
  `HostController.setRoom` (вызывается из обработчика `host_registered` в
  `client/session/HostRole.js`) — а также, не дожидаясь свежего ответа, из
  `room.roomId`/`room.roomSecret`/`room.epoch` при `init` после эстафеты
  Worker'ов (Этап 5.2): `HostController` сохраняет их в `_room`, поэтому
  подменённый Worker наследует их сразу. Worker, поднятый страницей,
  загруженной до этапа 2 host-migration, по-прежнему получает `set_host_id
{ hostId, hostSecret }` (или `room.hostId`/`room.hostSecret`) — Worker
  мапит его на `set_room`.

`HostGame` даёт `getPlayerRank(gameId)`/`isPlayerRankLoaded(gameId)`/
`addPlayerRank(gameId, delta)`/`flushPlayerData()`/
`overrideMapData(mapData)`/`getPlayerState(gameId)`/
`setPlayerState(gameId, state)`/`setRoom({ roomId, roomSecret, epoch })` для игровых плагинов (и
будущей чат-команды `/rank`, Этап B5), чтобы читать/писать rank и
непрозрачный блок state. `getPlayerRank` отвечает `0` и для незнакомого
`gameId`, и пока `PlayerDataSync.load()` не вернулся с мастера, поэтому игре,
которая сама пишет ранг в колонку stat с `bodyMethod: '='`, нужен
`isPlayerRankLoaded`: он отличает «ранг 0» от «ранга ещё нет» и не даёт
затереть настоящее значение стартовым нулём. `flushPlayerData()` синхронизирует
профили всех текущих участников на мастер прямо сейчас: обе штатные границы
`flushAll()` живут в `RoundManager` (смена карты, конец раунда), и игра с
`endlessRound`, пересобирающая геометрию через `overrideMapData` вместо смены
карты, не проходит ни через одну — без него накопленный за матч ранг уезжает
в auth только на выходе участника, а закрытая вкладка хоста теряет его вовсе.
Метод best-effort, как и весь `PlayerDataSync`: промис не отвергается.
Rust/WASM-ядро игры вообще не участвует —
rank/state это чисто engine/JS-концепция.

## HostGame (`packages/engine/src/host/HostGame.js`)

Host-фасад — wiring модулей + жизненный цикл участников:

- симуляция/боты/упаковка снапшотов — в Rust-ядре через `GameCoreAdapter`;
- мета (`RoundManager`, `ParticipantManager`, `Chat`, `Vote`, `Stat`, `Panel`,
  `TimerManager`, `RTTManager`, `CommandProcessor`, `VoteCoordinator`,
  `SocketManager`, `PlayerDataSync`) — модули `packages/engine/src/host/meta/` (см. раздел «Мета-модули»),
  зависимости передаются через конструкторы (DI);
- горячий тик `_onShotTick` core-driven: `adapter.updateData(dt)` (шаг ядра +
  дренаж событий), троттлинг отправки (`SnapshotThrottle` — кадр каждый
  `networkSendRate`-й тик), `adapter.packBody()` один раз/тик, затем per-user
  `adapter.packFrame(...)` (ядро само собирает player-блок предикшена по
  `playerId`);
- **жизненный цикл соединения**: `createUser` (регистрация спектатора во всех
  модулях — вызывается с проверенным Worker'ом ником, а не со свободно
  введённым именем, см. «Ответ авторизации» выше), `removeUser`, `mapReady`,
  `firstShotReady`, `sendMap` (прокси к RoundManager); **ввод**
  `updateKeys(gameId, 'seq:action:name')` — той же точкой входа приходит канал
  указателя `'seq:aim:x:y:flags'` (мировая точка плюс бит 0 «прижат» / бит 1
  «двойной тап»), до ядра он доходит через `GameCoreAdapter.applyAim`; у
  наблюдателя указатель отбрасывается, как и клавиши; **чат и
  голосования** `pushMessage` (санитизация, `/команды` → CommandProcessor) и
  `parseVote`; мосты колбэков `TimerManager`/`RTTManager` (кики), `reportKill`,
  `triggerCameraShake`, `updateRTT`;
- **хост-игрок исключён из kick-политик** (idle- и RTT-кики): его loopback —
  сама комната, кик убил бы её для всех. `hostSocketId` приходит в опциях
  (из `lobbyConfig.create.hostSocketId`, значение `'local'` согласовано с
  `LoopbackTransport`); гости кикаются штатно;
- `isFull`/`maxPlayers` — гейт заполненности комнаты для порт-машины Worker'а:
  считаются только люди; боты уступают место (при входе игрока в полную
  команду бота кикает `RoundManager.changeTeam`, при подключении человека
  сверх суммарного лимита — `_freeSlotForHuman`);
- `updateMaps(maps)` — обновление каталога карт: `_maps`/`_mapList`
  правятся на месте (эти же ссылки держит `RoundManager` и голосования) —
  новые данные применяются со следующей смены карты, без правок `RoundManager`;
- смена карты отслеживается в тике (`onMapChange` → `map_changed` в главный
  поток) — лобби мастера видит актуальную карту комнаты;
- **эстафета Worker'ов**: `requestHandoff(cb)` (остановка игры и
  сбор handoff-меты на ближайшей границе раунда), `completeHandoff(socketIds)`
  (в новом Worker'е: кик не переподключившихся, возобновление таймеров, первый
  раунд), `resumeAfterHandoff()` (откат при сбое нового Worker'а), опция
  конструктора `handoff` (восстановление вместо холодного старта) — см. раздел
  «Эстафета Worker'ов»;
- **контрольные точки**: `setCheckpointSink(fn)`, `startCheckpoints(ms)` /
  `stopCheckpoints()`, `requestCheckpoint({ final })`,
  `freeze()`/`unfreeze()`, `startAfterRestore()`,
  `startAfterResume(onStart)` (старт у преемника, когда люди вернулись),
  `detachedGameIds()`, опции конструктора `checkpoint`/`seqFloor`/`roomSettings`/`mapsVersion` —
  см. раздел «Контрольные точки»;
- **плановая передача**: `awaitRoundBoundary(cb)` / `cancelRoundBoundary()`
  (`RoundManager.onRoundBoundary`: `cb` один раз, сразу после старта
  следующего раунда; у игры с `migration.midRound` — немедленно);
- `destroy()` — публичный teardown: останавливает таймеры, делает `flushAll()`
  профилей и снимает всех участников, возвращая промис синхронизации. Во
  вкладке матч умирает вместе с Worker'ом, а долгоживущему процессу
  (dedicated-сервер) нужен graceful shutdown — иначе таймеры держат процесс, а
  rank/state теряются.

Клиентский `CONFIG_DATA` (порт 0: базовый конфиг + время голосования + данные
prediction) собирает `packages/engine/src/lib/buildClientConfig.js`.

### Отладочный рекордер (только dev)

При включённом `gameConfig.isDevMode` (`room.isDevMode`, который
`client/session/hostRoomPrep.js` берёт из `import.meta.env.DEV`) `HostGame` держит
`DebugRecorder` (`packages/engine/src/host/DebugRecorder.js`, Worker-safe —
только `clock`): он пишет живой матч в формат сценария headless-runner'а —
seed, входы и каждый `updateKeys`/`pushMessage`/`parseVote` с номером тика.
В проде рекордер `null`, и все точки записи вырождаются в `?.`.

Публичная поверхность: `startRecording()`, `stopRecording()`, `isRecording`,
`debugSnapshot()` (мета хоста — seed, seq, тик, участники, текущая карта —
плюс `debug_json` ядра). До вкладки это доезжает парой сообщений Worker'а
`debug`/`debug_result` и методами `HostController.startRecording/
stopRecording/dump()`; события самого рекордера дополнительно уходят в
консоли клиентов портом `CONSOLE`. Контур целиком:
[debugging.md](debugging.md#браузерная-половина).

## GameCoreAdapter (`packages/engine/src/host/GameCoreAdapter.js`)

Реализует поверхность физики/ботов/упаковки, которую потребляют
`RoundManager`/`SocketManager`/`HostGame`, но за ней стоит `GameCore`:

- **жизненный цикл/физика** → ABI ядра: `createMap` → `load_map` (карта уже
  отмасштабирована в JS `RoundManager.scaleMapData`, поэтому грузится со
  `scale: 1` — ядро не масштабирует повторно); `createPlayer`/`removePlayer`
  различают scripted-участника и человека по `participant.isScripted`
  (`spawn_scripted_actor`/`remove_scripted_actor` — танк + ИИ в ядре — против
  `spawn_actor`/`remove_actor`); `changePlayerData` → `reset_actor`; на
  слоёной (2.5D) карте точка респауна может называть свой уровень
  (`[x, y, angle, level]`), и сразу после
  `spawn_actor`/`spawn_scripted_actor`/`reset_actor` адаптер довозит его
  вызовом `set_actor_level(gameId, level)`. Вызов защищён проверкой
  `typeof` не для красоты: в `dist` уже опубликованной игры лежит glue-код
  своего поколения ядра, и такого метода там нет — тогда уровень выводится
  из геометрии внутри ядра, как и для точки без уровня;
- **ввод** → `apply_input` (seq подтверждается ядром в player-блоке кадра);
- **проекция событий**: после `step` дренирует `take_events()` и роутит
  стандартный движковый словарь (Wasm Host ABI, `packages/engine/core/src/events.rs`) сам, без
  игрового посредника: `panelSet`/`panelActive` → `panel.updateUser(...,
'set')`/`panel.setActiveWeapon` (`field` — ключ схемы панели игры, не
  завязан на конкретное оружие), `death` → `HostGame.reportKill`, `shake` →
  `HostGame.triggerCameraShake` (здоровье/боезапас живут в ядре, панель — их
  проекция). `custom` — единственный тип с игровым смыслом вне словаря:
  дренируется как есть в опциональный `HostPlugin.onCoreEvent(data, { panel,
vimp })` (у танков не используется — `onCoreEvent` не задан). Ядро
  оперирует числовыми id (u32), мета ключует строками — id событий адаптер
  приводит к строкам на этой границе;
- **упаковка**: `packBody` → `pack_body`, `packFrame` → `pack_frame` +
  `frame_bytes` (копия из памяти WASM, работает и на web-, и на nodejs-таргете);
- **первый кадр**: `getPlayersData` → `players_data()` ядра (полный снапшот
  игроков без дренажа накопителей — для `FIRST_SHOT_DATA`).

Scripted-модуль игры (`src/host/` игры-плагина, например `vimp-tanks`'а
`TanksBotManager.js`) — тонкий менеджер ботов: регистрация участников и
связка со `Stat`/`Panel` (ИИ, навигация и пространственная сетка — в
ядре). Создаётся фабрикой `createModules(ctx)` (`src/host/createModules.js`
игры-плагина возвращает `{ scripted }`); движок дергает контракт
scripted-модуля: `createMap`, `createScripted(count, team?)`,
`removeScripted(team?)`, `removeOneForHuman(team)`, `getCount`,
`getCountsPerTeam`. Параметры — `scripted` из конфига игры (`namePrefix`,
`defaultModel`).

**HostPlugin игры** (`src/host/index.js` игры-плагина, например в
`vimp-tanks`; default export
host-entry сборки игры) — вся игровая половина хоста одним объектом: `id`,
`engineApi`, `createCore(coreConfigJson, { wasmUrl })`, `gameConfig`,
`authSchema`, `chatCommands` (напр. команда спавна ботов), `systemMessages`
(группа, заданная плагином), `createModules` (возвращает scripted-модуль),
`buildClientGameConfig()` (игровая половина CONFIG_DATA); опционально
`onCoreEvent` для игровых `custom`-событий ядра (`vimp-tanks` его не
задаёт). `host.worker.js` грузит его
динамическим `import(room.game.hostEntryUrl)` на `init` (Этап 6.4) —
`room.game` (`{ id, version, hostEntryUrl, wasmUrl }`) приходит из
`entries` `GameManifest` через `HostRole.createRoom`, поэтому движок не
импортирует игру статически вовсе. Его потребляют `host.worker.js`
(`createCore`, конфиги/авторизация) и `HostGame` (команды, коды, модули,
`onCoreEvent`).

## Мета-модули (`packages/engine/src/host/meta/`)

JS-мета Worker'а: игровая логика поверх событий ядра. Модули инъекционны и
Worker-safe (только изоморфные API — `Date`/`Math`/`performance`/`setTimeout`/
`queueMicrotask`, никаких Node-глобалов).

### ParticipantManager — реестр участников (`meta/player/`)

**Единый источник истины об участниках** (люди + scripted-участники/боты):

- классы `Participant` (база: `gameId`, `name`, `model`, `team`, `teamId`,
  `status`) → `HumanParticipant` (`socketId`, `isReady`, `currentMap`,
  `isWatching`, `watchedGameId`, `forceCameraReset`, `pendingShake`,
  `lastActionTime`, `lastInputSeq`) и `ScriptedParticipant`;
- различение scripted/человек — геттеры `isScripted`/`isNetworked`,
  **не** по формату id: люди и
  scripted-участники делят единое числовое пространство id (генератор —
  наименьший свободный);
- API: `createHuman`/`createScripted`/`remove`/`get`/`getAll`/`getHumans`/
  `getScripted`/`getNetworkedReady` (готовые к рассылке), `checkName`
  (дедупликация имён; имя scripted — `scripted.namePrefix` + id из конфига
  игры), размеры команд (`getTeamSize`/`addToTeam`/`resetTeamSizes`), список
  активных для наблюдения
  (`addActive`/`removeActive`/`getActiveList`/`replaceWatched`),
  лимит `maxPlayers` (`totalCount`).

Боты и игроки уже делят этот реестр и единое числовое пространство id, но
поведение (сетевой ввод vs. ИИ ядра) по-прежнему обрабатывается разными путями
— полная унификация в одну абстракцию остаётся задачей на будущее.

### Менеджеры `meta/core/`

**RoundManager** — раунды, команды, карты. Владеет состоянием: `currentMap`,
`currentMapData`, `scaledMapData`, `isRoundEnding`, `removedPlayersList`.

- `createMap()` — остановка таймеров, сброс Panel/Stat/Vote и команд,
  пересоздание мира (в ядре через `GameCoreAdapter`), каждому человеку —
  набор клавиш наблюдателя (`KEYSET_DATA`), затем `CLEAR`, все — в
  наблюдатели, рассылка карты, перезапуск таймеров, воссоздание ботов.
  Keyset уходит **до** `CLEAR` намеренно: он выключает клиентский предикт,
  иначе тот успевает пересоздать свою сущность уже после очистки полотна и
  она остаётся призраком;
- `initiateNewRound()`/`_startRound()` — очистка активных, пересоздание карты,
  применение отложенной смены команд, дефолтная панель, полный stat, keySet по
  статусу, респауны и создание танков;
- `changeTeam(gameId, team)` — с проверкой свободных респаунов (может вытеснить
  бота), grace-period в начале раунда, иначе — смена со следующего раунда;
- `changeName`, `changeMap` (голосование за карту от игрока), `forceChangeMap`,
  `onMapTimeEnd` (голосование за следующую карту по таймеру; если никто не
  проголосовал — продление текущей);
- `reportKill(victimId, killerId)` — статистика (фраги/смерти/friendly fire),
  перенос наблюдателей на убийцу, `_checkTeamWipe` → завершение раунда, когда
  живые остались не более чем в одной команде (победа ей, кто бы ни сделал
  последнее убийство — суицид и огонь по своим включительно; без выживших —
  ничья), команда-победитель объявляется всем, наблюдателям тоже; `victory`
  команде-победителю и наблюдателям (при любом исходе, ничья включительно),
  `defeat` остальным, рестарт через
  `roundRestartDelay`. Каждой вымершей команде `deaths +1` в шапку — один раз
  за раунд (при ничьей — последние игроки нескольких команд погибли в одном
  тике — всем вымершим командам сразу). При 3+ командах вайп может оставить
  живых в нескольких командах; раунд тогда ждёт, и `checkRoundOutcome()` —
  его вызывают `changeTeam`, `HostGame.removeUser` и кик бота, освобождающий
  место входящему человеку, — завершает его, когда уход оставил живых только
  в одной (без вайпа в раунде или пока `destroy()` закрывает матч уход ничего
  не решает). Смена карты забывает записанные вайпы раунда;
- `setActive`/`setSpectator` — переводы игрок↔наблюдатель с отправкой keySet
  и панели.

**CommandProcessor** — парсинг чат-команд (сообщения, начинающиеся с `/`).
Своих команд у движка НЕТ: это чистый реестр, который целиком наполняет игра
через `HostPlugin.chatCommands` → `registerCommand(name, handler)`; обработчик
получает контекст меты — `handler(ctx, gameId, args)`. Бывшие движковые
`/name`, `/nr`, `/timeleft`, `/mapname`, `/rank` теперь код игры (в шаблоне
`create-vimp-game` — `src/host/metaCommands.js`), поэтому одно имя в разных
играх может делать разное или отсутствовать. Игра регистрирует свои команды
через этот же механизм (напр. `vimp-tanks` регистрирует команду спавна ботов —
синтаксис см. в доках этого плагина); если активных людей больше одного,
вместо немедленного исполнения запускается голосование (категория
`botManagement` в примере с танками). Неизвестная команда — системное
сообщение «Command not found».

**VoteCoordinator** — создание голосований поверх модуля `Vote`:
`canCreateVote` (проверка кулдауна темы), `createVote` (payload + колбэк
результата + список участников), `reset`. Кулдаун темы — `timeBlockedVote`
(30 с).

### Модули `meta/modules/`

- **`Panel`** — HUD per-user: схема из `game:panel` (`fields` — ключи,
  заданные игрой, напр. `vimp-tanks`'ы health/ammo; `activeKey` — ключ
  активного элемента, напр. активного оружия в `vimp-tanks`),
  `updateUser(gameId, param, value, op)` с накоплением `pendingChanges`,
  `processUpdates()` раз в тик снапшота отдаёт только изменения (строки
  `'ключ:значение'`, время раунда `t` — при смене секунды),
  `getFullPanel`/`getEmptyPanel`, `setActiveWeapon` (пишет `activeKey`
  схемы), `hasResources`/`getCurrentValue`. Авторитетное игровое состояние
  (напр. health/ammo) живёт в ядре — панель наполняется проекцией его
  событий (`GameCoreAdapter`).
- **`Stat`** — scoreboard: строки (body) и итоги команд (head) по конфигу
  `game:stat`; `addUser`/`removeUser`/`moveUser`/`updateUser`/`updateHead`;
  `getLast()` — дельта за тик, `getFull()` — полное состояние (при входе).
- **`PlayerDataSync`** (Этап B4) — per-участниковые rank/state, загружаются с
  и сливаются обратно на прокси мастера `/auth/rank`/`/auth/state`; полный
  поток — см. «Синхронизация rank и state игрока (Этап B4)» выше.
- **`Chat`** (`meta/modules/chat/`) — пользовательские сообщения и системные
  шаблоны (`systemMessages.js`): `push` (общее), `pushSystem`/`pushSystemByUser`
  (шаблонные `'группа:номер:параметры'`), очереди `shift`/`shiftByUser`.
  Реестр кодов — движковые группы `s`/`v`/`m`/`c`/`n`; игровые коды
  регистрируются через `registerCodes` (у танков — группы `b:*` и `t:*`, из
  `src/host/systemMessages.js` игры-плагина, например `vimp-tanks`); тексты
  шаблонов — на клиенте, и код без текста там молча отбрасывается. Миграция
  хоста добавляет `s:7` `HOST_CHANGED` (всем, когда преемник запустил
  восстановленный матч), `s:8` `HOST_REVOKED` (добавляет локально клиент
  бывшего хоста, по проводу не ходит) и — вместо `s:7` после
  автоматической передачи — `s:9` `HOST_CHANGED_OVERLOAD`, `s:10`
  `HOST_CHANGED_HIDDEN`, `s:11` `HOST_CHANGED_NETWORK` (причина приходит из
  `promote` в `start_after_restore`). Любое системное сообщение — код:
  данные — в параметрах, никогда не сырой текст массивом.
- **`Vote`** — механика голосований: очередь (новое голосование во время
  активного не отклоняется, а ждёт), время жизни `voteTime`, пагинация списков
  (более 7 вариантов — страницы Back/More), разрешение ничьей случайным
  выбором, персональные выдачи (`pushByUser`/`shiftByUser`), `addInVote`,
  `getResult`.
- **`TimerManager`** — все таймеры игры: игровой цикл (`onShotTick`, ~120 Гц),
  раунд (`onRoundTimeEnd`), карта (`onMapTimeEnd`), RTT-пинги, проверка
  бездействия, отложенные вызовы (рестарт раунда, смена карты);
  `getRoundTimeLeft`/`getMapTimeLeft`.
- **`RTTManager`** — учёт пингов: `scheduleNextPing()` (кому слать и с каким
  id), `handlePong` (расчёт latency, EMA), колбэки кика при
  `maxLatency`/`maxMissedPings`. Ping/pong ходят по ненадёжному state-каналу —
  замер не искажается ретрансмиссиями reliable-потока.

### SocketManager (`meta/SocketManager.js`)

Единственная точка отправки: JSON `_send(socketId, port, data, reliable)` и
бинарная `sendShot(socketId, frameBuffer, reliable)`; типизированные методы
(`sendConfig`, `sendMap`, `sendPanel`, `sendStat`, `sendChat`, `sendVote`,
`sendKeySet`, `sendGameInform`, `sendTechInform`, …) и `close` с техническим
кодом. Игровая параметризация — из конфига игры: `sendSoundCue(socketId, cue)`
маппит движковые события (`roundStart`/`victory`/`defeat`/`frag`/`death`) на
имена звуков игры по `soundCues`, `sendFirstVote` шлёт голосование
`initialVote` (у танков — выбор команды). Составные отправки: `sendFirstShot` (первый кадр + полный stat + пустая
панель + keySet 0), `sendPlayerDefaultShot`/`sendSpectatorDefaultShot`.
Транспорт абстрагирован: в Worker'е под ним wire-сокеты `postMessage`
(`makeWorkerSocket`), флаг `reliable` классифицирует каналы meta/state.

## Главный поток: роутер и транспорты (`packages/engine/src/client/network/`)

- **`HostController`** — спавнит Worker (по `workerUrl` из манифеста мастера;
  без него — бандловый `new Worker(new URL('host.worker.js'),
{ type: 'module' })`; фабрика инъектируется для тестов), шлёт `init(room)`,
  роутит `to_client`/`close_client` зарегистрированным клиентам и пересылает
  входящие сообщения в Worker. Общий для loopback и удалённых клиентов;
  `onReady` (Worker поднят) — момент регистрации комнаты у мастера (при
  эстафете повторно не вызывается); `swapWorker(url)` — эстафета Worker'ов
  (см. одноимённый раздел).
- **`LoopbackTransport`** — транспорт хоста-игрока: реализует интерфейс
  `WebRtcManager` (`publisher` с `message`/`close`, `send`/`close`), но данные
  ходят через `HostController` → Worker постмесседжами. Для клиентского кода
  транспорт прозрачен; флаг `reliable` игнорируется (loopback надёжен и
  упорядочен по определению).
- **`HostConnectionManager`** — WebRTC-answerer удалённых клиентов (зеркало
  `WebRtcManager`, который у клиента offerer). Через `SignalingClient`
  ловит `webrtc_offer`, на каждого клиента создаёт `RTCPeerConnection`,
  `ondatachannel` принимает каналы `meta`/`state`, шлёт `webrtc_answer` и
  обменивается ICE. Когда оба канала клиента открыты — поднимает его соединение
  в Worker'е (`HostController.open` → `connect`). Отвечает на сигнальный
  `ping_host` клиента (`pong_host` — замер задержки в лобби). Оффер с
  `resume: true` (переподключение гостя, этап 4 миграции хоста) передаётся
  как `HostController.open(clientId, { resume: true })` → `connect {
socketId, resume: true }` Worker'а; если пир с тем же `clientId` ещё
  полуоткрыт, он сначала закрывается (Worker отсоединяет участника и затем
  забирает его обратно по `RESUME_REQUEST`). Повторный оффер без `resume`
  по-прежнему игнорируется.

### Классификация каналов и бэкпрешер

Исходящий Worker-кадр раскладывается по каналам: **события → `meta`**
(reliable-ordered), **чистые позиции → `state`** (unreliable). Решение —
по флагу `reliable`, который `HostGame` вычисляет per-user:
`core.body_has_events()` (трассеры/бомбы/взрывы/удаления в теле, stateless-
геттер ядра — не меняет сигнатуру `pack_body`) ∨ `forceReset` камеры ∨
`shake`. JSON-протокол (порты `[portId, payload]`) — всегда по `meta`. Флаг
идёт через `SocketManager.sendShot(socketId, buffer, reliable)` → worker-сокет
→ `to_client` → answerer. **Бэкпрешер**: перед отправкой позиционного кадра
проверяется `bufferedAmount` state-канала; выше порога кадр дропается
(следующий компенсирует), `meta` не дропается никогда.

### Регистрация у мастера

По `onReady` хост шлёт `register_host` (игра/лимит/строка карточки/`memberId`
— строка карточки, `info`, приходит из Worker'а в `ready.lobbyInfo` и равна
`null`, если игра её не задаёт; имени у комнаты нет) и заводит heartbeat
(`update_host { info }` каждые
`lobbyConfig.create.heartbeatInterval` мс, меньше `heartbeatTimeout`
мастера). Мастер отвечает `host_registered { roomId, epoch, roomSecret }`;
`HostRole` хранит их (`HostRole.room`) и передаёт в Worker
(`HostController.setRoom` → `set_room`). Число игроков мастер считает сам по
участникам комнаты — хост его больше не сообщает. `info` — при каждой смене
строки карточки (`lobby_info` из Worker'а: смена карты при `lobbyInfo: 'map'`
или `lobby.setInfo` модуля). Когда хост-игрок уходит, `handleDisconnect`
гасит heartbeat, закрывает пиров (`HostConnectionManager.destroy`) и Worker
(`HostController.destroy`); мастер замечает закрытие сигналинга хоста и
переводит комнату в миграцию ([Миграция хоста](#миграция-хоста)); только
комната, которую некому принять, получает `room_closed`
([master.md](master.md#жизнь-комнаты)).

**Reconnect сигналинга**: сигнальный WS хоста должен жить постоянно (офферы,
heartbeat, выдача в списке) — при разрыве `GuestSession` переподключается с
экспоненциальным бэкоффом (`lobbyConfig.reconnect`), повторный `welcome`
шлёт `reclaim_host { roomId, epoch, roomSecret, … }`: комната сохраняет свой
`roomId` и через реконнект, и через рестарт мастера (секрет — HMAC, который
перезапущенный мастер умеет проверить). Если вернуть комнату нельзя
(`roomTaken` или `invalidRoomSecret` — dev-мастер без `VIMP_ROOM_SECRET_KEY`
после рестарта), хост регистрирует новую комнату через `register_host`. Уже
установленные P2P-соединения разрыв сигналинга не рвёт. В ответе
`host_registered` мастер передаёт `mapsVersion` и `codeVersion` —
расхождение с версиями, на которых поднята комната, инициирует
перечитывание каталога карт (см. ниже) / эстафету Worker'ов.

### Динамические карты

Комната стартует на актуальных картах мастера, а не на вшитых в бандл:
`HostRole.createRoom` фетчит `GET /games/:id/maps/manifest.json` (`:id` — id
манифеста активной игры, Этап 6.4) + все карты и передаёт их в
`init` Worker'а (`room.maps`; недоступность каталога некритична — fallback на
карты из бандла). Обновление на лету: `host_registered.mapsVersion` (после
reconnect) или сигнал `update_available` мастера → `HostRole.refreshMaps` → fetch
каталога → `HostController.updateMaps` → Worker `update_maps` →
`HostGame.updateMaps`. Новые данные применяются **со следующей смены карты**
(штатный путь `RoundManager.createMap`: масштабирование в JS → `load_map` ядра
со `scale: 1`); список карт в голосованиях актуализируется сразу. Гости
изменений не требуют — карту им шлёт хост по порту 3.

### Эстафета Worker'ов

Обновление кода живой комнаты: при деплое новой версии Worker хоста заменяется
на новый бандл **без разрыва WebRTC-соединений** — `RTCPeerConnection` живут в
главном потоке и подмену Worker'а не замечают. Реализована **мягкая эстафета
на границе раунда**: ядро не дампится (мир и так пересоздаётся с нуля стартом
каждого раунда — `RoundManager._startRound`), переносится только JS-мета;
клиенты видят обычный старт раунда. Дамп ядра здесь не участвует — его
использует [контрольная точка](#контрольные-точки), которая переносит
комнату на другую машину посреди раунда.

**Обнаружение новой версии.** Worker комнаты создаётся по `url` из
`GET /worker/manifest.json` мастера (`lobbyConfig.worker.manifestUrl`) — Vite
хеширует имена ассетов, и после деплоя бандловый URL старой страницы исчезает
из раздачи; запоминается составной `hostCodeVersion`: `{ engine, game: { id,
version } }` (Этап 6.5). Деплой рестартует мастер → сигнальный WS рвётся →
штатный reconnect → `reclaim_host` → `host_registered.codeVersion` расходится с
нашим по любой половине (деплой движка меняет `engine`, деплой только
игры-плагина — `game.version`) → `HostRole.refreshWorker()`: повторный фетч
**обоих** манифестов — `GET /worker/manifest.json` и активной игры
`GET /games/:id/manifest.json` (`lobbyConfig.game.manifestUrl`) — собирает
свежий `room.game` (`{ id, version, hostEntryUrl, wasmUrl }` из свежих
`entries.host`/`entries.wasm`) и зовёт
`HostController.swapWorker(url, свежийRoomGame)` — деплой только игры
запускает эстафету точно так же, как деплой только движка, а новый Worker
никогда не импортирует протухший `hostEntryUrl`. Версия (по тому же
составному ключу), своп на которую не удался, запоминается и не ретраится на
каждом re-register. Также обрабатывается `update_available { codeVersion }`
(push мастера, на будущее). В dev манифест worker-бандла пуст
(`version: null`) — обновления кода отключены, Worker бандловый.

**Протокол свопа** (`HostController.swapWorker(url, game)`):

1. старому Worker'у уходит `prepare_handoff` → `HostGame.requestHandoff`
   ставит колбэк в `RoundManager`; игра продолжается до ближайшей границы
   раунда (единая воронка `initiateNewRound`: таймер раунда, отложенный
   рестарт после team wipe, рестарт при смене команды);
2. на границе старый Worker останавливает игру (`stopGameTimers` + idle),
   синхронизирует профили игроков с мастером (`PlayerDataSync.flushAll({
urgent: true })`, ждёт не дольше `handoffFlushTimeoutMs`, см.
   [configuration.md](configuration.md) — `terminate()` оборвал бы летящие
   записи) и шлёт `handoff_state { state }`; с этого момента
   `HostController` буферизует входящие сообщения клиентов (очередь с
   капом);
3. `HostController` подменяет `room.game` свежим манифестом, переданным в
   `swapWorker` (Этап 6.5 — без него остаётся прежний `room.game`), создаёт
   новый Worker по URL новой версии и шлёт ему `init { room, handoff: state }`
   (в `room.maps` — актуальный каталог карт, в `room.game` — свежие
   `hostEntryUrl`/`wasmUrl`);
4. новый Worker импортирует `room.game.hostEntryUrl` (Этап 6.4), восстанавливает
   комнату (см. ниже) и отвечает `ready` → `HostController` переподключает
   всех живых клиентов внутренними `connect`'ами (порт-машины поднимаются
   минуя handshake), доставляет накопленную очередь, шлёт `handoff_complete`
   и гасит старый Worker (`terminate`);
5. `handoff_complete` в новом Worker'е: `HostGame.completeHandoff` кикает
   восстановленных участников, чей `connect` не пришёл (отвалились в паузу),
   возобновляет таймеры (карта — с остатком времени, `TimerManager.
startMapTimer(duration)`) и стартует первый раунд — клиенты получают
   штатные `sendClear`/респаун/старт раунда (`sendSoundCue`+`sendGameInform`).

**Handoff-мета** (`HostGame._collectHandoff`, формат версионирован —
`HANDOFF_VERSION = 4` с host-migration этапа 5: формат
[контрольной точки](#контрольные-точки) с `kind: 'boundary'` и всегда
`mode: 'soft'`, плюс `localTokens: { [gameId]: token }`. Токены едут
**только** здесь — `postMessage`'ем в следующий Worker той же вкладки — и
никогда в сетевой точке; новый Worker поднимает с ними профили
(`PlayerDataSync.restore`) и догружает те, что так и не доехали с мастера, —
rank/state продолжают писаться после свопа (до v4 они терялись до конца
сессии). Новый Worker по-прежнему принимает **v3** от Worker'а прежней
версии кода. v3 — Этап Д3, переименовавший поле `bots` в `scripted`; v2
Этапа 6.5 добавила `gameId`/`gameVersion`. Всё, что несёт v3, несёт и v4): id
загруженного `HostPlugin` и версия игры комнаты (чтобы восстановление в
несовпадающую игру — если такое вообще случится — падало явной ошибкой, а не
тащило бессмысленное состояние), участники-люди с `isReady`
(gameId/socketId/имя/модель/команда) и scripted-участники (с исходными gameId — единое
числовое пространство сохраняется), счёт `Stat` целиком, текущая карта +
остаток её времени, `seq` кадров (нумерация снапшотов продолжается —
интерполятор клиентов не ломается) и текст карточки лобби, выставленный
модулем игры через `lobby.setInfo` (`lobbyInfo`, необязательное поле — модули
нового Worker'а создаются с нуля и сами его не повторят; мета без поля текста
не восстанавливает). `ready.lobbyInfo` нового Worker'а сразу уходит в
карточку у мастера (`HostController` → `onLobbyInfoChange`): своё начальное
значение Worker сам не сообщает. **Осознанно не переносятся**:
чат-история, активные голосования и кулдауны, RTT-статистика, panel
(здоровье/боезапас живут в ядре и сбрасываются стартом раунда), не
завершившие handshake гости (их строки в scoreboard вычищаются, клиенту
такой гость проходит handshake заново).

**Отказоустойчивость**: сбой init нового Worker'а (`error`: несовместимая
`HANDOFF_VERSION`, рассинхрон `gameId`, карта ушла из каталога, сбой WASM)
или таймаут (15 с) → новый Worker гасится, старому уходит `resume`
(`resumeAfterHandoff`: возврат таймеров + перезапуск прерванного раунда) —
**комната продолжает жить на прежней версии кода**, игроки ничего не
замечают. Параллельные свопы исключены (guard в `HostRole` и в
`HostController`).

**Уступка плановой передаче.** Своп, ещё ждущий границы раунда (в игре с
длинными раундами — до часа), уступает
[плановой передаче](#плановая-передача) — преемник и так готовит комнату из
актуального worker-бандла. `HostController.cancelPendingSwap()` шлёт
старому Worker'у `cancel_handoff` (`HostGame.cancelHandoff` снимает колбэк
границы, ближайший `initiateNewRound` стартует раунд как обычно) и
отвергает промис свопа с `swap preempted`; `HostRole.refreshWorker` не помечает
эту версию сбойной. Если Worker успел отдать `handoff_state` до прихода
`cancel_handoff`, на запоздавшее состояние отвечается `resume`. Своп, уже
переносящий состояние (после `handoff_state`), не снимается — передача
отклоняется. Если передача сорвалась и вкладка осталась хостом,
`HostRole.refreshWorker()` запускается снова и повторяет своп, если версия всё
ещё отличается.

### Миграция хоста

В лобби-режиме комната переживает вкладку, которая её создала: роль хоста
переходит к другому участнику под тем же `roomId` со следующей `epoch`, и
матч продолжается. Части — в том порядке, в каком их использует миграция:

1. [Контрольные точки](#контрольные-точки) — дамп ядра плюс вся мета,
   снятые на границе кадра;
2. [Преемник (standby)](#преемник-standby) — выбранный мастером участник
   получает точки ~2/с по каналу `standby` и держит прогретый Worker;
3. [Аварийная миграция](#аварийная-миграция) — хост пропал, преемник
   поднимает последнюю периодическую точку (откат);
4. [Плановая передача](#плановая-передача) — хост отдаёт роль сам («Leave
   server», «Hand over host», [автотриггеры](#автотриггеры),
   [голосование `/changehost`](#голосование)) через финальную точку, без
   отката;
5. [Промоушен преемника](#промоушен-преемника) — как новый хост поднимает
   матч и занимает комнату; затем гости делают `RESUME`;
6. [Ограничения](#ограничения).

Сторона мастера (участники, выбор преемника, детекция, голоса) —
[master.md](master.md#миграция-хоста); протокол —
[network.md](network.md#миграция-хоста).

### Контрольные точки

**Контрольная точка** — всё, что нужно, чтобы продолжить матч на другом
хосте — возможно, на другой машине — с того же тика: дамп ядра плюс вся
мета.

**Снятие.** Только на границе кадра: сразу после `pack_body` в конце
отправляющего `_onShotTick` (накопители снапшота ядра опустошены —
предусловие `serialize_state`). `requestCheckpoint({ final })` снимает одну
точку на ближайшей границе; `startCheckpoints(intervalMs)` — периодически
(не чаще интервала). Пока цикл стоит (`freeze` или восстановленный матч
ждёт `startAfterRestore`), запрос исполняется сразу, после собственного
`packBody`. Worker кодирует результат `lib/checkpointCodec.js` и шлёт
`checkpoint { …, bytes }`, `bytes` — **списком переноса**: `serialize_state`
и так отдаёт копию в JS-куче, а сжатый буфер новый, так что второй копии
2 раза в секунду нет.

**Формат** (`HANDOFF_VERSION = 4`). Контейнер —
`[u32 metaLen LE][meta JSON utf-8][байты ядра]`, весь сжат gzip
(`CompressionStream`, есть в Worker'е и в Node ≥ 18); `decode` отвергает
больше `maxCheckpointBytes` в распакованном виде («zip-бомба» от чужого
хоста). Мета — целиком JSON, **без токенов и секретов**:

| Поле                                                                                         | Содержимое                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`, `kind`, `mode`                                                                    | `4`; `'checkpoint'` или `'boundary'` (эстафета внутри вкладки); `'midRound'` или `'soft'`                                                                                                                                                                                              |
| `gameId`, `gameVersion`, `engineVersion`, `createdAt`, `checkpointId`, `seq`, `snapshotTick` | идентичность и счётчик кадров                                                                                                                                                                                                                                                          |
| `room`                                                                                       | `{ roomId, epoch, settings, game: { id, version } }` — `settings` — то, что читает `applyRoomOverrides`: преемник собирает тот же конфиг ядра (без `isDevMode` — dev-режим определяет сборка вкладки)                                                                                  |
| `map`                                                                                        | `{ name, data, mapsVersion, override }` — JSON текущей карты из каталога (у преемника каталог может быть другим) и карта, подменённая игрой через `overrideMapData`                                                                                                                    |
| `timers`                                                                                     | `TimerManager.serialize()`: остаток карты/раунда, `teamChangeGraceLeft`, `pending` (отложенный рестарт раунда, смена карты с `targetMap`), `voteCooldowns`                                                                                                                             |
| `round`                                                                                      | `isRoundEnding`, `wipedTeamIds`, `removedPlayers`, `startMapNumber`                                                                                                                                                                                                                    |
| `participants`                                                                               | люди (`gameId`, имя, модель, команда, статус, камера, `respawnIndex`, `lastInputSeq`, `chatColor`, `resumeKey`, `identityName`, `isHostPlayer`), scripted, `teamSizes`, `activePlayers`, `dropped` (люди, не попавшие в точку, — восстановление `midRound` снимает их акторов из ядра) |
| `stat`, `panel`, `playerData`                                                                | счёт, значения панели, профили (`PlayerDataSync.serialize`: рейтинги, неотправленные очки, state, `writeSeq`, неотвеченные записи с номерами `writes`)                                                                                                                                 |
| `plugin`                                                                                     | `{ [имяМодуля]: module.serializeState() }`                                                                                                                                                                                                                                             |
| `lobbyInfo`                                                                                  | текст карточки лобби, выставленный модулем игры                                                                                                                                                                                                                                        |

Сетевая точка несёт людей с `resumeKey` (вошедших в матч); эстафета внутри
вкладки — завершивших handshake, с их `socketId`.

**Режим.** `'midRound'` — только если игра включила
`gameConfig.migration.midRound` (см. [plugin-api.md](plugin-api.md)) **и**
дамп ядра (и `serializeState` каждого модуля) снялся; тогда прикладываются
байты ядра, и восстановление продолжает раунд с того же тика. Иначе
`'soft'`: ядра нет, восстановление — нынешняя эстафета: мета переносится,
раунд начинается заново. Сбой дампа логируется (`[checkpoint] mid-round
state skipped: core serialize_state failed: …`), матч продолжается.

**Восстановление** (опция `HostGame` `checkpoint: { meta, core }` +
`seqFloor`): первым десериализуется ядро (битый дамп валит `init` до того,
как тронута мета); JS-сторона карты собирается из `map.data` без
`createMap`/`load_map` (`RoundManager.restoreMap` — `scripted.createMap`
только запоминает точки респауна); участники возвращаются
**отсоединёнными** (этап 4: слот занят, рассылки уходят в заглушку, ждут
RESUME со своим `resumeKey`), профили — без токенов (записи ждут
`attachToken` при возобновлении); `seq = max(meta.seq, seqFloor) + 30` —
клиенты видели кадры новее точки, и меньший номер их интерполятор отбросил
бы. Матч стоит **на паузе** (ни цикла, ни таймеров) до
`start_after_restore`: в `'midRound'` все таймеры идут с остатков
(`TimerManager.resumeFromState`, отложенную смену карты заново ставит
`RoundManager.scheduleMapChange`), цикл — с того же тика; в `'soft'` карта
идёт с остатком времени и стартует новый раунд.

**Заморозка.** `freeze()` останавливает цикл и все отсчёты с остатками
(`TimerManager.pause` — таймеры, голосования, кулдауны, пинги, проверка
бездействия); `unfreeze()` продолжает их — так плановая передача снимает финальную
точку. Точка на заморозке осушает тело кадра вне цикла (`pack_body` —
предусловие дампа), и его события (удаления, взрывы, трассеры) никому не
уходят; поэтому при сорвавшейся передаче `unfreeze()` шлёт каждому готовому
участнику на связи пакет входа RESUME (keyset, `CLEAR`, карта с
`resume: true`, первый кадр) — иначе на полотне остались бы «призраки»
удалённых сущностей.

**Осознанно не переносятся**: активные голосования (их `resultFunc` —
замыкания; клиенты закрывают окно голосования при возобновлении), история
чата (живёт у клиентов), RTT (перемеряется), `lastActionTime` (сбрасывается
на «сейчас»).

`HostController` (главный поток) оборачивает протокол:
`startCheckpoints(ms)`, `stopCheckpoints()`, `requestCheckpoint({ final })`,
`onCheckpoint(cb)` (возвращает отписку), `freeze()`, `unfreeze()`,
`startAfterRestore({ waitForResume })`, `initFromCheckpoint(room, bytes,
callbacks)` (прогретый Worker); конструктор принимает `{ checkpoint, seqFloor }` и
передаёт байты в `init` списком переноса. Headless-проверка для игр — шаг
`vimp-sim` `checkpointRestore`, см. [debugging.md](debugging.md).

### Преемник (standby)

В комнате, где двое и больше людей, мастер назначает **преемника** (см.
[master.md](master.md#rtt-участников-и-преемник)) и сообщает хосту
`successor_assigned`. Хост шлёт ему контрольные точки; преемник держит
последнюю и прогретый Worker; сама передача —
[Аварийная миграция](#аварийная-миграция) или
[Плановая передача](#плановая-передача).

**Канал** (`client/network/StandbySender.js`). Хост находит пира преемника
по `memberId` в `HostConnectionManager` (`peerConnectionOf` — пир с
открытыми `meta`/`state`) и открывает на нём
`pc.createDataChannel('standby', { ordered: true })`: ре-согласование SDP не
нужно, SCTP-ассоциация уже есть. Канал прежнего преемника закрывается.
Преемник, подключившийся позже назначения или переподключившийся с новым
`RTCPeerConnection`, получает новый канал на ближайшей смене состава пиров
(`refresh()`). Пока канал есть, включён
`HostController.startCheckpoints(migration.checkpointIntervalMs)`; без него —
`stopCheckpoints()`. Канал, закрывшийся сам при живом пире преемника,
открывается заново по таймеру с экспоненциальной задержкой
(`migration.standbyReopenDelayMs` 1 с, удвоение до
`standbyReopenMaxDelayMs` 10 с; открытие её сбрасывает; новый преемник или
`destroy` таймер снимают) — иначе поток точек стоял бы до ближайшей смены
состава пиров.

**Куски** (`client/network/standbyChunks.js`). Логический поток одной точки —
`[u16 descLen][desc JSON][байты точки]`, где
`desc = { checkpointId, createdAt, mode, game }` — преемник сообщает мастеру
id и свежесть и прогревает игру (`game: { id, version }` из сообщения
`checkpoint` Worker'а или `null`; приёмник оставляет только непустые строки
не длиннее 64 символов), не распаковывая точку. Хост старше поля `game` его
не шлёт — тогда прогрев читает `room.game` из самой точки. Поток режется на куски не больше
`migration.standbyChunkBytes` (64 КБ) вместе с 24-байтным little-endian
заголовком:

| Смещение | Тип | Поле                                        |
| -------: | --- | ------------------------------------------- |
|        0 | u32 | `wireId` — номер точки у отправителя        |
|        4 | u32 | `index`                                     |
|        8 | u32 | `count`                                     |
|       12 | u32 | `totalBytes` — длина логического потока     |
|       16 | u32 | `seq` — номер кадра хоста                   |
|       20 | u8  | `final` (последняя точка плановой передачи) |
|       21 | u8  | версия формата куска (1)                    |
|       22 | u16 | резерв                                      |

**Backpressure.** Если `bufferedAmount` канала выше
`migration.standbyHighWaterBytes` (1 МБ), очередная периодическая точка
пропускается (следующая всё равно свежее; пропуск уходит в журнал ошибок как
`engine.standby.skipped`). `final`-точка не пропускается никогда: она ждёт
открытия канала и `bufferedamountlow` и имеет приоритет: пока она ждёт,
периодические не уходят, а периодическая, снятая не позже неё (`seq` не
новее — кодирование в Worker'е асинхронно), отбрасывается. Приёмник
зеркалит это: периодическая не новее финальной её не вытесняет. `stats`
(отправлено, пропущено,
размер, интервал, задержка) в dev-сборке пишется в консоль как
`standby sent`.

**Прогрев.** `HostController` принимает `{ preload: true, onPreloaded }`:
Worker получает `preload { room }` вместо `init`, импортирует `HostPlugin`,
проверяет форму его `gameConfig` и компилирует wasm (`preloadHostRuntime` в
`lib/createHostRuntime.js`: `compileStreaming`, с откатом на
`compile(arrayBuffer)`), отвечает `preloaded` и матч не создаёт; сбой —
ответ `error`. Повторный `import` того же URL в этом Worker'е берётся из
кэша модулей, а wasm — из HTTP-кэша. Прогрев даёт HTTP-кэш и кэш кода wasm
браузера (`compileStreaming`), сам скомпилированный `WebAssembly.Module` не
переиспользуется. Сторона преемника — в [client.md](client.md).

### Аварийная миграция

Хост пропал молча (вкладка закрыта, сеть оборвалась, сбой); части выше
превращают это в паузу 1–3 с:

1. **До**: хост шлёт контрольные точки (каждые
   `migration.checkpointIntervalMs`, 500 мс) по каналу `standby`
   преемнику, выбранному мастером; преемник держит последнюю полную точку и
   прогретый Worker (см. [Преемник (standby)](#преемник-standby)).
2. **Детекция** — за мастером: закрылся сигналинг хоста, остановился его
   heartbeat или гости сообщили `host_unreachable`, а хост не ответил на
   `probe` (см. [master.md](master.md#миграция-хоста)).
3. **Промоушен**: `promote { mode: 'checkpoint' }`, если точка преемника
   свежая, иначе `'cold'` на любом способном участнике (см.
   [Промоушен преемника](#промоушен-преемника)).
4. **Гости** на `host_migrating` сразу закрывают транспорт к старому хосту,
   ждут под «Switching host…» и на `host_changed` возобновляют свои места у
   нового хоста (см. [network.md](network.md#миграция-хоста)).
5. **Старый хост**, если вернулся, становится гостем новой эпохи.

Что видит игрок: паузу 1–3 с, затем мир контрольной точки — до ~0.5 с
назад, тот же раунд, карта и счёт (игра без `migration.midRound`
начинает раунд заново с сохранённой метой). Номера кадров продолжают расти
(`seq = max(seq точки, seqFloor) + 30`), все команды отпущены, клиенты
повторяют нажатия удерживаемых клавиш, активные голосования отменяются.
Перезапуск `cold` начинает матч заново в той же комнате.

### Плановая передача

Та же механика без отката: хост отдаёт роль сам — «Leave server» или
«Hand over host» в меню комнаты ([client.md](client.md#иерархия-ui-z-index));
автотриггеры и голосование ниже входят в ту же
`HandoffFlow.start({ reason, stay, defer })` (`client/network/PlannedHandoff.js`).

1. Хост шлёт `handoff_begin { roomId, epoch, reason, stay }`; мастер
   переводит комнату в `handing_off` и отвечает `handoff_go` (преемнику —
   `promote { mode: 'planned' }`, остальным — `host_migrating`) либо
   `handoff_unavailable` — тогда передача роли просто не делается, а уход
   продолжается аварийной миграцией (`host_leaving`). Преемник
   `host_migrating` не получает: по `promote { mode: 'planned' }` он сам
   ставит сессию своего игрока на паузу (опция `holdSession` у
   `Promotion` → `SessionSupervisor.migrate({ keepTransport: true })`) и
   держит соединение с замороженным хостом — поверх него идёт канал
   `standby` с финальной точкой.
2. `handoff_go` → `freeze()` → `requestCheckpoint({ final: true })`:
   финальная точка уходит по `standby` раньше любой периодической.
3. Преемник ждёт её (`migration.finalWaitMs`, см.
   [Промоушен преемника](#промоушен-преемника)), поднимает матч с того же
   тика и регистрируется со следующей эпохой.
4. `host_released` → старый хост сворачивает Worker и пиров; при `stay` его
   игрок возобновляется гостем нового хоста, без него вкладка уходит в
   лобби. `handoff_aborted`, отказ, обрыв сигналинга или
   `migration.handoffDeadlineMs` → `unfreeze()` (с полной синхронизацией,
   см. «Заморозка» в [Контрольные точки](#контрольные-точки)): матч идёт
   дальше, вкладка остаётся хостом, эпоха не меняется. Игрок самого хоста
   не в режиме возобновления и отвечает на первый кадр синхронизации
   `FIRST_SHOT_READY`; `firstShotReady` уже готового участника
   игнорируется — ни `USER_JOINED`, ни `initialVote`, ни повторного актора
   при `noSpectators`.

Игра без `migration.midRound` передаёт роль (`stay`) только на границе
раунда (`awaitRoundBoundary`, не дольше `migration.deferMaxMs`); уход не
ждёт — преемник начинает новый раунд из мягкой точки. Эстафета Worker'ов,
ждущая границы раунда, передачу не блокирует — она снимается (см.
«Уступка плановой передаче» в [Эстафета Worker'ов](#эстафета-workerов)).
Закрытие вкладки хоста — не плановая передача: `beforeunload` просит подтверждения, пока в
комнате есть другие люди, а `pagehide` шлёт `host_leaving` — аварийная
миграция с обычным откатом (диалог останавливает главный поток, финальная
точка во время него уйти не может).

#### Автотриггеры

`client/network/HostHealthPolicy.js` (лобби-режим) следит за сэмплами
`health` Worker'а (~1 в секунду, см. «Здоровье хоста» выше), видимостью
вкладки и тем, назначил ли мастер преемника, и сама начинает плановую
передачу со `stay: true` (`migration.auto` в
[configuration.md](configuration.md)):

| Триггер            | Условие                                                                                                              | Действие                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| мягкая перегрузка  | среднее `tickRate` за последние `overloadWindowMs` (5 с) ниже `overloadTickRate` (100)                               | `reason: 'overload'`, ждёт границы |
| жёсткая перегрузка | среднее за `criticalWindowMs` (3 с) ниже `criticalTickRate` (60) или `lostMs > 0` у `lostWindows` (3) сэмплов подряд | `reason: 'overload'`, сразу        |
| скрытая вкладка    | скрыта непрерывно `hiddenHandoffMs` (1.5 с)                                                                          | `reason: 'hidden'`, сразу          |

Новой передаче нужны преемник, `minHostTenureMs` (30 с) в роли хоста и
`autoHandoffCooldownMs` (90 с) с прошлой автоматической передачи этой
вкладки (от её запуска, при любом исходе; политика живёт дольше роли хоста,
кулдаун тоже); скрытая вкладка, которую они задержали, отдаёт роль в
момент их истечения, даже если матч стоит. Разрыв потока сэмплов (матч был заморожен или на паузе)
начинает окна заново. Жёсткий триггер или скрытая вкладка, пока передача
ждёт границы раунда, ускоряют её (`PlannedHandoff.hurry`:
`round_boundary_cancel`, затем сразу `handoff_begin`). Если мягкая
перегрузка прошла до границы — все сэмплы за последние `recoverWindowMs`
(5 с) выше `recoverTickRate` (110), гистерезис над порогом входа, чтобы
тикрейт около 100 Гц не дёргал флаг, — политика отменяет свою отложенную
передачу (`cancelDeferred`, `round_boundary_cancel`) и возвращает кулдаун.
Отложенную «Hand over host» пользователя она не отменяет никогда.

**Сетевой лаг** решает мастер — только он может сравнить сеть
хоста с сетью преемника: `HostHealthReporter` шлёт `host_health { tickRate,
peerRttMedian, peerCount }` не чаще раза в
`migration.auto.hostHealthIntervalMs` (2 с) по последнему сэмплу (пока матч
заморожен — ничего); при стойком лаге и заметно лучшем преемнике мастер
отвечает `request_handoff { reason: 'network', defer: true }`
([master.md](master.md#сетевой-лаг-хоста)), и хост начинает плановую
передачу со `stay: true`, ждущую границы раунда (если
`migration.auto.enabled` не `false`). Политика её не отменяет — только свою
`overload`, — но жёсткий триггер или скрытая вкладка её ускоряют. Гости
раз в `migration.auto.fpsReportIntervalMs` (10 с) сообщают средний FPS рендера за интервал
(`client/lib/FpsMeter.js`: кадры ÷ прошедшее время, окно заново при
возврате видимости; `Ticker.FPS` — скорость одного кадра) в
`member_update.caps.fps`, чтобы мастер не назначил преемником слабую
вкладку.

Игроки узнают, почему сменился хост: Worker преемника шлёт вместо
`HOST_CHANGED` «Host changed: the previous host was lagging» (`overload`),
«… went inactive» (`hidden`) или «… had a poor connection» (`network`) — см.
«Промоушен преемника» ниже. При любой другой причине остаётся «Host
changed».

#### Голосование

Отнять роль могут и игроки (только лобби-режим): `/changehost`
гостя начинает голосование «Change host», которое считает **мастер** —
хост окна не видит и не может отфильтровать голосование в своих модулях
чата или голосований ([master.md](master.md#голосование-change-host)).
Прошедшее голосование шлёт хосту `request_handoff { reason: 'vote', defer:
false }`: страница сразу начинает плановую передачу со `stay: true`,
независимо от `migration.auto.enabled` и не дожидаясь границы раунда. Хост,
не начавший её за `room.vote.voteForceAfterMs` (5 с) или с сорвавшейся
передачей, снимается принудительно — аварийным путём с обычным откатом к
последней точке преемника и `host_revoked` для бывшего хоста. В любом
случае бывший хост остаётся гостем и `room.vote.demotedCooldownMs` (10 мин)
не может быть ни преемником, ни хостом комнаты. У dedicated-сервера и
standalone SDK голосования нет: там `/changehost` — обычный текст чата для
игры.

### Промоушен преемника

Когда мастер повышает участника (`promote { roomId, epoch, promotionToken,
mode }`, [master.md](master.md#миграция-хоста)), вкладка поднимает матч и
занимает комнату `register_host { roomId, epoch, promotionToken, … }` —
комната та же, растёт только эпоха.

**`checkpoint`** (`client/network/Promotion.js`): последняя полная точка
`StandbyReceiver` поднимается в прогретом Worker'е (`HostPrewarm.take()` +
`HostController.initFromCheckpoint(room, bytes, callbacks)`), если он той же
версии игры, что в точке, иначе — в новом `HostController` с
`{ checkpoint, seqFloor }`; `seqFloor` — большее из последнего кадра хоста,
который видел этот клиент, и `seq` точки. Комната получает `hostSocketId`,
`roomId` и новую эпоху. Точку шлёт хост — другой игрок, поэтому это
недоверенные данные: из `meta.room.settings` берутся только ключи
`sanitizeRoomSettings` (`lib/roomSettings.js`: `map`, `maxPlayers`,
`roundTime`, `mapTime`, `friendlyFire`, числа клампятся), а игра, карты
мастера и dev-режим — собственные (`prepareHostRoom`; `isDevMode` в точку
не попадает вовсе). `room.game` точки сверяется с игрой, которую
подтверждает мастер, — `promote.game { id, versions }`: другая игра или
неподтверждённая версия → `promote_failed` (мастер без этого поля —
проверка пропускается). Прогрев так же сверяет точку со
`standby_assigned.game` и такую точку игнорирует (прогретый Worker
остаётся). `ready` (матч на паузе) → вкладка берёт роль хоста
(те же `HostConnectionManager`/`StandbySender`/heartbeat, что у созданной
комнаты) и регистрируется. `host_registered` → `start_after_restore {
waitForResume: true, reason }` (`reason` из `promote`; главный поток
старого движка его не шлёт): `HostGame.startAfterResume`
запускает матч, когда вернулись все люди точки или прошло `resumeWaitMs`
(3 с) — что раньше, шлёт в чат `HOST_CHANGED` (`HOST_CHANGED_OVERLOAD`/
`_HIDDEN`/`_NETWORK` после автоматической передачи) и отдаёт всё ещё отсоединённых
`PortMachine.startGraceFor` — окно возврата считается от старта, пауза
переключения его не съедает. Свой игрок преемника возвращается через
`LoopbackTransport(controller, 'local', { resume: true })` со своим
`resumeKey`; участник перепривязывается к `'local'`, и исключения
хоста-игрока (не кикается, не отсоединяется) переезжают на него. Точка,
полученная раньше `migration.maxRestoreAgeMs` (15 с) назад, не
поднимается — откат мира на столько хуже холодного старта; финальная точка
плановой передачи свежая всегда. Сбой на
любом шаге (нет точки или она слишком старая, нет секрета места своего игрока, плагин/wasm,
`init` → `error`, мастер отверг регистрацию) — `promote_failed`, вкладка
снова ждёт как гость; `promote_cancelled` гасит Worker так же. После
регистрации комната — этой вкладки: если свой игрок всё же не вернулся
(отказ RESUME, loopback закрыт, окно истекло), роль хоста остаётся —
Worker, пиры, heartbeat и поток точек живут, гости играют; вкладка
показывает «Your player could not be restored — the room keeps running for
the others.» вместо перезагрузки.

**`planned`** (плановая передача): то же, что `checkpoint`, но
сначала `StandbyReceiver.waitForFinal(0, migration.finalWaitMs)` (3 с) ждёт
финальную точку замороженного хоста — матч продолжается с того же тика. Не
дождались — последняя периодическая (откат минимален). Повторный `promote`
той же эпохи и токена с `mode: 'checkpoint'` (хост пропал посреди передачи)
сразу бросает ожидание (`Promotion.degrade`); `promote_cancelled`
(передача сорвалась) ещё и зовёт `StandbyReceiver.discardFinal()` — эта
финальная остаётся последней точкой, но следующую передачу не завершит.
Если она ещё не дошла (ждала разгрузки канала), то по приходе примется
периодической: канал ordered, а хост не шлёт периодических, пока не ушла
финальная, — устаревшая финальная может быть только первой точкой после
отмены.

**`cold`** (свежей точки нет): вкладка сохраняет `{ roomId, epoch,
promotionToken, gameId, settings }` в `sessionStorage` (`vimp.promotion`)
и перезагружается по ссылке на комнату. Бутстрап маршрута забирает запись
(удаляя её при любом исходе), запускает `HostRole.createRoom` с дефолтами
комнаты плюс `settings` мастера и регистрируется с токеном вместо создания
комнаты. Матч начинается заново; остальные участники перезагружаются в
комнату и входят с полным рукопожатием.

**Бывший хост** (`host_revoked` или `staleEpoch` на его `reclaim_host`
после возврата сети) гасит Worker, пиров, поток точек и heartbeat,
показывает в чате `HOST_REVOKED` и возвращается гостем новой эпохи:
`join_room`, затем возобновление по WebRTC под своим `gameId` (его место
есть в точке преемника как отсоединённый участник); `RESUME_RESULT !ok` →
чистый вход в комнату.

В лобби (`packages/engine/src/client/main.js`):

- **присоединиться** — карточка сервера → `GuestSession.connectToRoom(roomId)` →
  `WebRtcManager` (offerer);
- **создать сервер** — кнопка в лобби (`#lobby-host`,
  `packages/engine/src/config/lobby.js`) → `HostRole.createRoom(room)` → `HostController` + Worker +
  `LoopbackTransport` (хост-игрок) + `HostConnectionManager` (удалённые
  клиенты, у каждого пира хранится `memberId` из оффера) + регистрация у
  мастера.

Дальше клиентский код одинаков (транспорт абстрагирован). Выход хоста комнату
не убивает: мастер повышает преемника (см.
[Промоушен преемника](#промоушен-преемника)); сама уходящая вкладка проходит
через `handleDisconnect`, который останавливает рендер.

### Ограничения

- **Аварийная миграция откатывает мир** к последней периодической точке —
  до ~`migration.checkpointIntervalMs` (0.5 с) игры плюс время передачи;
  с того же тика продолжает только плановая передача.
- **Пауза 1–3 с** при каждом переключении: резервных соединений к
  преемнику у гостей нет, новые WebRTC-пиры они открывают после
  `host_changed`.
- **`beforeunload` не спасает финальную точку**: пока открыт диалог
  подтверждения, главный поток — ретранслятор Worker ↔ DataChannel —
  стоит; закрытие вкладки — аварийная миграция (`pagehide` →
  `host_leaving` лишь ускоряет детекцию).
- **Мягкий режим** для игры без `gameConfig.migration.midRound` (все игры,
  опубликованные до него): мета переносится, раунд начинается заново;
  плановая «Hand over host» ждёт границы раунда.
- **Не переносятся**: активные голосования, история чата, RTT, таймеры
  простоя (см. «Осознанно не переносятся» в
  [Контрольных точках](#контрольные-точки)).
- **Свежей точки нет** (хост и преемник пропали разом, преемник только
  что назначен) → перезапуск `cold`: тот же `roomId`, новый матч.
- **Dedicated-сервер и standalone SDK** — хост один по определению: ни
  преемника, ни меню комнаты, ни `/changehost`.

## Тесты

Тесты хоста и мета-модулей — `tests/host/`:

- `GameCoreAdapter.test.js` — юнит на фейковом ядре: маппинг команд на ABI,
  различение бот/человек, проекция событий в панель/фасад, флаги камеры.
- `HostGame.fixture.test.js` — интеграция поверх встроенной **фикстуры
  miniGame** (`packages/engine/tests/fixtures/`), ядро которой — обычный
  JS-объект, реализующий Wasm Host ABI: набору не нужны ни сборка Rust, ни
  игра-плагин, и он доказывает, что хост работает с _любым_ корректным
  `HostPlugin`. Аналогичный набор на настоящем WASM-ядре живёт в репозитории
  игры-плагина. Покрыто: онбординг, активный игрок с player-блоком,
  движение, стрельба (трассер + боезапас), боты, `players_data`, `removeUser`
  (null-маркер в кадре), лимит комнаты (`isFull`), kick-исключение
  хоста-игрока, `updateMaps`/`onMapChange`, эстафета Worker'ов (сбор меты на
  границе раунда, восстановление участников/счёта/`seq`, `completeHandoff` с
  киком не переподключившихся, `resumeAfterHandoff`, отказ по несовместимой
  версии/ушедшей карте); бинарные кадры декодирует клиентское ядро
  (`ClientCore.decode_frame`; каркас — `tests/host/fixtureHarness.js`
  с `FakeSocketManager`).
- `portMachine.test.js` — автомат хендшейка на той же фикстуре, без Worker'а
  и без сети: гостевой путь до созданного участника, ник, отбитый схемой,
  ник-заглушка, отказ стратегии идентичности, сообщение на выключенном порту,
  полная комната (`4006`/`roomFull`, машина не создана), `disconnect`,
  `restore` (участник эстафеты поднимается в игровом состоянии) и клиент,
  отключившийся во время `resolve`.
- `identity.test.js` — стратегии идентичности: дескриптор гостевого поля и
  его заглушка, токеновая стратегия на подставленном JWKS-`fetch` с
  подписанным в тесте RS256-токеном (кэш и сбой, который не должен
  закэшироваться навсегда).
- `LoopbackTransport.test.js` — юнит на фейковом Worker: `HostController`
  (роутинг, очередь connect до `ready`, флаг `reliable`,
  `error`/`map_changed`/`updateMaps`; эстафета — `workerUrl`, буферизация на
  паузе, порядок connect/flush/`handoff_complete`, откат на старый Worker при
  `error`, guard параллельного свопа) и `LoopbackTransport`.
- `HostConnectionManager.test.js` — юнит на фейковых peer/каналах:
  оффер→answer, каналы meta/state, классификация reliable, бэкпрешер, ICE,
  сигнальный pong, закрытие, гонка open/close, cleanup при сбое SDP,
  нефатальность транзиентного `'disconnected'`.
- юнит-тесты мета-модулей: `RoundManager`, `CommandProcessor`,
  `VoteCoordinator`, `ParticipantManager` (включая `restoreHuman`/`restoreScripted`
  эстафеты), `Chat`, `Vote`, `Stat` (включая `serialize`/`restore`), `Panel`,
  `TimerManager`, `RTTManager`, `SocketManager`.
- смежные: `tests/client/network/SignalingClient.test.js` (исходящие хоста —
  `register_host`/`update_host`/`webrtc_answer`/`pong_host`),
  а в репозитории игры-плагина — `tests/core/core.test.js`
  (`body_has_events()` — классификация meta/state, поверх настоящего ядра
  этой игры).

## Сборка

Worker грузит `core/pkg-web` игры-плагина (web-таргет ядра, например, в
`vimp-tanks`). Эта WASM-сборка происходит в собственном репозитории
игры-плагина, не здесь — см. [core.md](core.md#сборка) и
[getting-started.md](getting-started.md) о том, как пакет игры-плагина
устанавливается/линкуется в `node_modules` для локальной разработки.

## Ручной прогон (чек-лист)

P2P-миграция завершена: клиентская математика (интерполяция, предикт, спавн
снарядов, распаковка кадров) целиком перенесена в Rust-ядро
(`packages/engine/core/src/client/` +
собственный `core/src/client/` игры-плагина, например в `vimp-tanks`); легаси JS-модули и JS-паритет-тесты удалены. Остался
только этот ручной прогон на двух вкладках — Vitest не воспроизводит реальный
WebRTC и его реордеринг, поэтому сквозная проверка матча — ручная, в браузере:

```bash
npm run dev            # мастер: лобби + сигналинг, https://localhost:3002
```

Web-таргет ядра собирается в собственном репозитории игры-плагина (её
собственный `npm run core:build`, напр. `vimp-tanks`'ы) — это не скрипт
этого репозитория — до того, как плагин линкуется/устанавливается в
`node_modules`; см. [core.md](core.md#сборка) и
[getting-started.md](getting-started.md).

Открыть `https://localhost:3002`, «Создать сервер» → хост-вкладка. Удалённые
клиенты — другие вкладки/машины: лобби → комната появляется в списке → вход.

Чек-лист (игровые шаги ниже — на примере `vimp-tanks` как референсного
плагина; для другого плагина подставьте его собственные эквиваленты):

- [ ] движение своего актора (prediction/reconciliation без рывков);
- [ ] игровые действия (напр. стрельба), урон, смерть и респаун, смена
      команды (чат-команда или меню);
- [ ] боты: спавн, патруль, бой (ИИ в ядре);
- [ ] чат, голосования (смена карты/команды), статистика, панель — обновляются;
- [ ] раунд: старт/таймер/победа команды/новый раунд;
- [ ] полный матч с несколькими игроками + боты end-to-end;
- [ ] обрыв хоста (лобби, 3 профиля): закрыть вкладку хоста посреди раунда →
      у остальных «Switching host…» на 1–3 с, мир откатился максимум на
      ~0.5 с, раунд и счёт продолжаются, новый хост — преемник; хост
      offline (DevTools) → то же через отчёты/пробу; вернуть сеть старому
      хосту → он гость; хост и преемник пропали разом → холодный перезапуск
      того же `roomId` у третьего игрока.

**Комнаты, ссылки и миграция** (лобби-режим; `npm run dev:auth` + `npm run
dev`, dev-логин по закладке
`http://localhost:3010/dev/login?nick=P1&returnUrl=https://localhost:3002/`;
три профиля Chrome + Firefox):

| #   | Сценарий                                                  | Ожидание                                                                 |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Создать комнату (имени нет), скопировать ссылку           | карточка `tanks/<roomId>`, ссылка `#/tanks/<roomId>`                     |
| 2   | Открыть ссылку в незалогиненном профиле                   | логин → сразу экран авторизации игры в этой комнате                      |
| 3   | `#/tanks` при пустом и непустом лобби                     | создаёт / входит                                                         |
| 4   | Гость: offline на 5 с                                     | «Reconnecting…», тот же танк                                             |
| 5   | Хост: «Hand over host» посреди боя                        | пауза ≤ 2 с, без отката, бывший хост — гость                             |
| 6   | Хост: «Leave server»                                      | то же, бывший хост в лобби                                               |
| 7   | Хост: закрыть вкладку (подтвердить)                       | откат ≤ 0.5–1 с, матч продолжается у преемника                           |
| 8   | Хост: offline                                             | миграция через отчёты/пробу; вернуть сеть → бывший хост стал гостем      |
| 9   | Хост и преемник одновременно закрыты                      | холодный перезапуск у третьего игрока, тот же `roomId`                   |
| 10  | CPU throttling 6× у хоста                                 | передача на границе раунда или через 30 с                                |
| 11  | Свернуть вкладку хоста на 10 с                            | передача                                                                 |
| 12  | Slow 3G у хоста                                           | передача ~через 10 с, повтор не раньше 90 с                              |
| 13  | Голосование `/changehost`                                 | проходит большинством, хост не видит голосования; в меню `M` пункта нет  |
| 14  | Snakes: всё из 5, 7                                       | длины змей и кристаллы сохранены                                         |
| 15  | Перезапуск мастера (nodemon) во время матча               | комната вернулась с тем же `roomId`, матч не прерывался                  |
| 16  | Standalone (`startStandaloneGame`) и `npm run dedicated`  | работают как раньше; `/changehost` не перехватывается                    |
| 17  | Кик за простой                                            | без перезагрузки: адрес без hash, «Kicked for inactivity.», клик → лобби |
| 18  | Комната закрылась (уход последнего хоста / `room_closed`) | перезагрузка на `#/tanks` — быстрая игра той же игры                     |

**Эстафета Worker'ов** проверяется только на собранном `dist`
(в dev манифест кода пуст): `npm run build` → мастер в prod-режиме → создать
комнату + подключить гостя → внести правку в код хоста → `npm run build:app`
→ перезапустить мастер → дождаться reconnect/re-register хоста:

- [ ] на границе раунда комната переезжает на новый Worker (консоль:
      `[worker] room migrated to code version …`);
- [ ] P2P-соединения живы, гость видит обычный старт раунда;
- [ ] счёт scoreboard и имена сохранены, боты на месте, `/timeleft` карты
      продолжает отсчёт (не сброшен);
- [ ] чат/голосования работают после переезда.

---

[← Предыдущая: Центральный auth-сервис](auth.md) · [Следующая: Rust-ядро →](core.md)
