# Синхронизация клиент ↔ хост

Игровой протокол между клиентом и хостом использует два формата сообщений:

- **JSON**: `[portId, payload]` — все каналы, кроме снапшота. `portId` — числовой id из [packages/engine/src/config/wsports.js](../../packages/engine/src/config/wsports.js) (источник истины).
- **Бинарный**: кадр игрового снапшота (порт `5`, SHOT_DATA) — `ArrayBuffer`, упакованный ядром (`packages/engine/core/src/snapshot.rs`).

Клиент различает форматы по типу входящих данных: строка → JSON-диспетчер `socketMethods[portId]` ([packages/engine/src/client/main.js](../../packages/engine/src/client/main.js) `handleMessage`), `ArrayBuffer` → `ClientCore.push_frame` (распаковка и буфер интерполяции — в клиентском ядре, см. [core.md](core.md#rust-трейты-vimp-engine-core)).

## Транспорт (WebRTC)

Игровой транспорт — прямое P2P-соединение клиента с браузерным хостом (два `RTCDataChannel`), а не WebSocket. Протокол портов и форматы от этого не меняются — только транспорт. Клиентский сетевой слой — [packages/engine/src/client/network/](../../packages/engine/src/client/network/):

- **`SignalingClient`** — сигнальный WebSocket мастер-сервера ([master.md](master.md)): координация установки P2P (welcome с `iceServers`, обмен SDP-офферами/ответами и ICE-кандидатами, сигнальный ping/pong, жалобы). Игрового трафика по нему нет.
- **`WebRtcManager`** — транспорт P2P: два канала данных с хостом.
  - **`meta`** (reliable-ordered): весь JSON-протокол `[portId, payload]` (порты 0–4, 6–17) **плюс** бинарные кадры, несущие одноразовые события (`w1`/`w2`/`w2e`, создания/удаления сущностей, clear/shake камеры). Гарантия доставки обязательна — потеря такого кадра навсегда теряет взрыв или несозданный танк.
  - **`state`** (unreliable-unordered, `ordered: false, maxRetransmits: 0`): чисто позиционные бинарные кадры (`m1`/`c1`/`c2` + камера + player-блок). Их потерю компенсирует следующий кадр.
  - Классификация кадра meta/state — на стороне хоста при упаковке (кадр с событийными блоками → meta, иначе → state). Клиент принимает данные из обоих каналов одним потоком (`handleMessage`) и не различает их источник.

Клиент — инициатор (offerer): создаёт каналы и SDP-оффер, обменивается с хостом SDP/ICE через `SignalingClient`. Исходящие сообщения клиента (порты 0–8 client→server) — управляющие, идут по надёжному `meta`.

**Хост — answerer** ([host.md](host.md)): `HostConnectionManager` в главном потоке вкладки хоста через `SignalingClient` ловит `webrtc_offer`, на каждого клиента создаёт `RTCPeerConnection`, `ondatachannel` принимает каналы клиента, шлёт `webrtc_answer` + ICE. Классификация meta/state реализована так: `HostGame` вычисляет per-user флаг `reliable` = `core.body_has_events()` (событийные блоки в теле — stateless-геттер ядра, не меняет `pack_body`) ∨ `forceReset` ∨ `shake`; флаг идёт через `SocketManager.sendShot(socketId, buffer, reliable)` в главный поток, который выбирает канал. Бэкпрешер: позиционный кадр дропается при переполнении `bufferedAmount` state-канала, `meta` — никогда. Хост регистрирует комнату у мастера (`register_host` + heartbeat `update_host`).

**Буфер интерполятора** переведён с «push в конец» (корректно только при TCP-порядке) на **вставку по `seq`** с дедупликацией: кадры из ненадёжного `state`-канала могут приходить не по порядку и дублироваться. События опоздавшего reliable-кадра, чей `serverTime` уже позади `renderTime`, выдаются немедленно следующим `sample()` — «ровно один раз» сохраняется (см. [client.md](client.md#клиентское-ядро-clientcore)).

**Голос рейтинга сервера `/like`·`/unlike`** идёт **вне игрового протокола портов**: клиент перехватывает команду до отправки хосту и шлёт `like_host`/`unlike_host { hostId, reason, token }` по сигнальному WS мастера (`SignalingClient.likeHost`/`unlikeHost`), минуя P2P-канал с хостом. Причина — в том, что хост исполняет `CommandProcessor` у себя и мог бы отфильтровать голос против самого себя. `token` — Bearer identity-токен голосующего; логика рейтинга — на мастере и central auth-сервисе ([master.md](master.md#рейтинг-сервера-likeunlike)).

## Три транспорта (WebRTC / loopback / WebSocket)

Протокол портов и форматы кадров во всех контурах одни и те же — различается только труба под ними. У всех трёх один интерфейс: `Publisher` с `message`/`close` плюс `connect`/`send(data, reliable)`/`close`, поэтому диспетчер клиента не знает, с чем разговаривает.

| | `WebRtcManager` (лобби) | `LoopbackTransport` (вкладка хоста, solo) | `WebSocketTransport` (dedicated) |
| --- | --- | --- | --- |
| Труба | два `RTCDataChannel` | postMessage в Worker / прямой вызов в том же потоке | один WebSocket |
| Разделение meta/state | есть | нет | нет |
| Флаг `reliable` | выбирает канал | игнорируется | игнорируется |
| Порядок кадров | `meta` упорядочен, `state` — нет | упорядочен | упорядочен (TCP) |
| Бинарные кадры | `ArrayBuffer` по `state`/`meta` | `ArrayBuffer` | `ArrayBuffer` (обязателен `binaryType`) |
| Бэкпрешер | дроп позиционных кадров по `bufferedAmount` | не нужен | на стороне сервера |

Для dedicated-сервера отсюда следуют две вещи, которые стоит проговорить. **Замер RTT меняет смысл**: PING/PONG идут надёжным каналом, то есть меряется TCP-путь (с ретрансмиссиями), а не сетевой — таймауты кика те же, но число несопоставимо с WebRTC. **Бэкпрешер переезжает на сервер**: ненадёжного канала, чьи позиционные кадры можно дропать, больше нет, и давление надо разруливать там, где кадры производятся.

`LoopbackTransport` работает в двух разных контурах: поверх `HostController` (вкладка хоста-игрока, за ним Worker) и поверх `InlineHostBridge` (standalone SDK, хост в том же потоке). Сам транспорт при этом не меняется — различается только объект, реализующий `open`/`send`/`disconnect`.

## Порты

### Сервер → клиент

| Порт | Имя | Формат | Описание |
| :--: | --- | :--: | --- |
| 0 | `CONFIG_DATA` | JSON | Клиентский конфиг (merge `packages/engine/src/config/clientDefaults.js` + `src/config/client.js` игры-плагина (например, в `vimp-tanks`) + `prediction`) |
| 1 | `AUTH_DATA` | JSON | Данные формы авторизации |
| 2 | `AUTH_RESULT` | JSON | Ошибки авторизации (или `null`) |
| 3 | `MAP_DATA` | JSON | Данные карты |
| 4 | `FIRST_SHOT_DATA` | JSON | Первый кадр игры (одноразовый, минует буфер интерполяции): `[gameSnapshot, 0, serverTime, 0]` |
| 5 | `SHOT_DATA` | **бинарный** | Snapshot-кадр игры (см. ниже) |
| 6 | `SOUND_DATA` | JSON | Имя системного звука (`roundStart`, `victory`, `frag`, …) |
| 7 | `GAME_INFORM_DATA` | JSON | Игровые сообщения на экране (`[код, параметры?]`: `0` победа команды, `1` старт раунда, `2` game over — источник истины [packages/engine/src/config/gameCodes.js](../../packages/engine/src/config/gameCodes.js), общий для хоста (`SocketManager.sendGameInform`) и клиента (`GAME_ROUND_START_CODE` в `main.js`)) |
| 8 | `TECH_INFORM_DATA` | JSON | Технические сообщения «чёрного экрана» (`[код, параметры?]`: сервер полон, загрузка, кики); без данных — скрыть экран |
| 9 | `MISC` | JSON | Разнообразные данные (`{key, value}`; сейчас — замена имени в localStorage) |
| 10 | `PING` | JSON | id пинга для замера RTT |
| 11 | `CLEAR` | JSON | Полная или частичная (по `setId`) очистка полотен |
| 12 | `CONSOLE` | JSON | Отладочный лог хоста (только dev): `SocketManager.sendConsole`, клиент печатает как `[vimp:debug][host] …` — Worker изолирован от DevTools вкладки, см. [debugging.md](debugging.md#логи-хоста-в-консоли-клиента) |
| 13 | `PANEL_DATA` | JSON | Панель HUD (per-user, только при изменении) |
| 14 | `STAT_DATA` | JSON | Статистика (broadcast, только при изменении) |
| 15 | `CHAT_DATA` | JSON | Сообщение чата (общее или персональное) |
| 16 | `VOTE_DATA` | JSON | Данные голосования |
| 17 | `KEYSET_DATA` | JSON | Активный набор клавиш: `0` — наблюдатель, `1` — игрок; шлётся при смене статуса, а также при смене карты (набор наблюдателя непосредственно перед `CLEAR`) |

### Клиент → сервер

| Порт | Имя | Описание |
| :--: | --- | --- |
| 0 | `CONFIG_READY` | Конфиг получен, canvas готов |
| 1 | `AUTH_RESPONSE` | Данные формы авторизации плюс лобби-JWT личности (`{model, ..., token}`); ник хост берёт из проверенного токена, а не из поля формы (Этап B3, см. [auth.md](auth.md)) |
| 2 | `MODULES_READY` | Клиентские модули инициализированы |
| 3 | `MAP_READY` | Карта загружена и построена |
| 4 | `FIRST_SHOT_READY` | Первый кадр применён, клиент готов к игровому циклу |
| 5 | `KEYS_DATA` | Ввод: строка `"seq:action:name"` (см. ниже) |
| 6 | `CHAT_DATA` | Текст сообщения / чат-команда |
| 7 | `VOTE_DATA` | Ответ голосования `[voteName, value]` или запрос списка (`'maps'`, `'teams'`) |
| 8 | `PONG` | Ответ на PING (id пинга) |

Хост включает обработку клиентских портов поэтапно (порт-машина в [packages/engine/src/host/host.worker.js](../../packages/engine/src/host/host.worker.js)): до авторизации активен только `CONFIG_READY`, после — `AUTH_RESPONSE`, после создания пользователя — остальные. Сообщение на неактивный порт игнорируется.

## Жизненный цикл соединения

Портовый хендшейк исполняет браузерный хост поверх канала `meta` (origin-проверка — забота сигнального WS мастера, в P2P-транспорте её нет):

```
каналы meta+state открыты → connect в Worker
  → CONFIG_DATA → CONFIG_READY
  → AUTH_DATA → AUTH_RESPONSE → AUTH_RESULT
  → createUser (спектатор) → MODULES_READY → MAP_DATA → MAP_READY
  → FIRST_SHOT_DATA (+ полные STAT/PANEL/KEYSET) → FIRST_SHOT_READY
  → пользователь в игровом цикле (SHOT_DATA 30 кадров/сек) → removeUser при close
```

Детали:

- **Полная комната**: очереди ожидания нет — полная комната (люди против `maxPlayers`; боты уступают место) отвечает `TECH_INFORM_DATA` с кодом `roomFull` и закрывает соединение (код `4006`); хост-игрок из kick-политик исключён (см. [host.md](host.md)).
- **Коды закрытия**: весь набор живёт одной картой — [`packages/engine/src/config/closeCodes.js`](../../packages/engine/src/config/closeCodes.js), общий контракт серверных контуров и клиента, чтобы стороны не разъезжались молча. Закрытие WebRTC data channel не несёт код/причину — там причина доставляется отдельным `TECH_INFORM_DATA` по `meta` до закрытия; WebSocket (dedicated, сигналинг) несёт код сам.

  | Код | Ключ | Кто шлёт | Клиент |
  | --- | --- | --- | --- |
  | `4000` | `staleHost` | `master/SignalingServer.js` | сигнальный сокет хоста, игрока не касается |
  | `4001` | `invalidOrigin` | `master/SignalingServer.js`, `dedicated/main.js` | остаётся на месте, показывает причину |
  | `4002` | `blocked` | `master/SignalingServer.js` | хостер заблокирован рейтингом, комната эвакуируется |
  | `4003` | `kickForMaxLatency` | `host/HostGame.js` | перезагрузка через 3 с |
  | `4004` | `kickForMissedPings` | `host/HostGame.js` | перезагрузка через 3 с |
  | `4005` | `kickIdle` | `host/HostGame.js` | перезагрузка через 3 с |
  | `4006` | `roomFull` | `host/PortMachine.js` | остаётся на месте, показывает причину |
  | `4008` | `handshakeTimeout` | `dedicated/main.js` | остаётся на месте, показывает причину |
  | `4009` | `tooManyConnections` | `dedicated/main.js` | остаётся на месте, показывает причину |

  «Остаётся на месте» — правило политики [`src/client/network/policyClose.js`](../../packages/engine/src/client/network/policyClose.js) (`shouldReloadAfterClose`, `POLICY_CLOSE_INFORMS`): перезагрузка потратила бы ещё одно соединение того же лимита, перезапустила бы тот же таймер, оставила бы тот же origin или не освободила бы слот. `4007` свободен.
- После `FIRST_SHOT_READY` пользователь получает начальное голосование игры (напр. голосование выбора команды в `vimp-tanks`) и попадает в рассылку кадров.

## Разделение каналов: горячий снапшот и мета

Каждый тик снапшота (`networkSendRate: 4` → 30 пакетов/сек) хост шлёт **всем готовым** пользователям бинарный кадр порта `5`. Мета-данные идут **своими JSON-каналами и только при изменении** (см. `HostGame._onShotTick` в [packages/engine/src/host/HostGame.js](../../packages/engine/src/host/HostGame.js)):

- **panel (13)** — per-user; массив строк `'ключ:значение'`, ключи из схемы панели игры (`t` — время раунда — единственный ключ, заданный движком; напр. `vimp-tanks` добавляет `h` — здоровье, `w1`/`w2` — боезапас, `wa` — активное оружие). Полная панель шлётся при входе в игру, пустая (только ключи) — наблюдателю.
- **stat (14)** — broadcast, дельта изменений (см. формат ниже).
- **chat (15)** — общее сообщение либо персональное (`shiftByUser`).
- **vote (16)** — общее либо персональное голосование.
- **keyset (17)** — точечно при смене статуса спектатор↔игрок.

## Бинарный snapshot-кадр (порт 5)

Кодек целиком в Rust-ядре: упаковка — `packages/engine/core/src/snapshot.rs` (у хоста), распаковка — `packages/engine/core/src/client/unpack.rs` (у клиента); обе стороны в одном crate — расхождение раскладок исключено по построению. Реестр ключей — данные игры: `src/config/snapshot.js` игры-плагина (например, [в `vimp-tanks`](https://github.com/lgick/vimp-tanks/blob/main/src/config/snapshot.js)) (`gameConfig.snapshot`); версия формата остаётся у движка — [packages/engine/src/config/opcodes.js](../../packages/engine/src/config/opcodes.js) (`SNAPSHOT_FORMAT_VERSION = 3`). Big-endian, ручной block-layout без библиотек. При несовпадении версии клиент отбрасывает кадр.

Сервер пакует **тело** (broadcast-часть) один раз за тик (`packBody`), затем для каждого пользователя собирает кадр `packFrame` = персональный заголовок + копия тела.

### Раскладка кадра (v3)

| Поле | Тип | Описание |
| --- | --- | --- |
| `port` | Uint8 | Всегда `5` (SHOT_DATA) |
| `version` | Uint8 | `SNAPSHOT_FORMAT_VERSION` |
| `seq` | Uint32 | Инкрементный номер кадра |
| `serverTime` | Float64 | `Date.now()` сервера |
| `cameraFlags` | Uint8 | bit0 hasCamera, bit1 forceReset, bit2 hasShake, bit3 hasPlayer |
| camera | 2×Float32 | `[x, y]` (если hasCamera) |
| shake | Uint8 len + ASCII | Строка `'intensity:duration'` (если hasShake) |
| player-блок | см. ниже | Только у играющего (если hasPlayer) |
| блоки тела | до конца буфера | `Uint8 keyId` + содержимое по `kind` |

**Player-блок** (фундамент client-side prediction): `gameId` (Uint8), `lastInputSeq` (Uint32), точное состояние актора игрока Float32×8 — поля заданы игрой (напр. `vimp-tanks`'ы `x, y, angle, vx, vy, angvel, gunRotation, throttle`) (**без округления** — точность нужна предиктору), флаг центрирования башни (Uint8).

### Блоки сущностей (`kind` из снапшот-схемы игры)

Ключи сущностей, значения `kind` и форматы данных целиком заданы схемой
снапшота игры-плагина — движок лишь навязывает раскладку блока (id +
типизированные поля). Пример из референсного плагина (`vimp-tanks`):

| Ключ | id | kind | Формат данных |
| :--: | :--: | --- | --- |
| `m1` | 1 | `tanks` | `{gameId: [x, y, angle, gunRotation, vx, vy, engineLoad, condition, size, teamId] \| null}`; `null` — удалить с полотна |
| `w1` | 2 | `tracers` | массив `[startX, startY, endX, endY, bodyX, bodyY, wasHit, shooterId]` |
| `w2` | 3 | `bombs` | `{shotId(base36): [x, y, angle, size, time, ownerId] \| null}` |
| `w2e` | 4 | `explosions` | массив `[x, y, radius]` |
| `c1`/`c2` | 5/6 | `dynamics` | `{'dN': [x, y, angle]}` — динамические элементы карты |

Все float исходно округлены хостом до 2 знаков; декодер восстанавливает значения повторным округлением Float32 (player-блок — без округления). События игровых сущностей могут нести id автора (`vimp-tanks` использует `shooterId`/`ownerId`, добавлены в v3), чтобы клиент подавлял авторитетные дубли локально заспавненных сущностей (клиентское ядро, `core/src/client/shot.rs` игры-плагина, например в `vimp-tanks`).

Запись схемы — не только `{id, kind}`: `class` (`'hot'` — интерполируется клиентом между кадрами, `'event'` — одноразовый, кадром как есть) и `fields` — схема полей строки (`name`, `ty`: `f32`/`u8`/`u16`/`u32`, `interp`: `lerp`/`lerpAngle`/`discrete` для `class: 'hot'`). `fields` обязана точно совпадать по количеству и порядку типов с Row-структурой ключа в `packages/engine/core/src/snapshot.rs` (`GameCore`/`ClientCore` отклоняют конструктор при расхождении).

При добавлении нового оружия/сущности его snapshot-ключ **обязан** быть зарегистрирован в снапшот-схеме игры-плагина (`src/config/snapshot.js`, например в `vimp-tanks`) — с полным `fields` для своего `kind`, иначе `pack_body`/конструктор ядра бросят ошибку. Если существующие `kind` не подходят — добавить новую раскладку блока в `packages/engine/core/src/snapshot.rs` + `packages/engine/core/src/client/unpack.rs` и поднять версию формата. См. доки активной игры-плагина (например, [vimp-tanks/docs/ru/extending.md](https://github.com/lgick/vimp-tanks/blob/main/docs/ru/extending.md#новое-оружие)).

## Формат ввода: `"seq:action:name"`

Клиент шлёт каждое событие клавиши строкой на порт `5` (client → server):

- `seq` — инкрементный номер ввода (Uint32), пишется в локальную историю предиктора;
- `action` — `down` | `up`;
- `name` — команда (`forward`, `fire`, `nextPlayer`, …).

Сервер сохраняет `lastInputSeq` пользователя и возвращает его в player-блоке кадра — так клиент узнаёт, какие вводы уже учтены authoritative-состоянием, и переигрывает (reconciliation) только более поздние. Подробно — в [client.md](client.md#клиентское-ядро-clientcore).

У наблюдателя те же строки обрабатываются сервером как переключение наблюдаемого игрока (`nextPlayer`/`prevPlayer`).

## RTT (ping/pong) и кики

`TimerManager` каждые `rttPingInterval` (3 c) рассылает `PING` (порт 10) с id; клиент отвечает `PONG` (порт 8). Обе стороны шлют их по **ненадёжному `state`-каналу** (единственный JSON-трафик вне `meta`): замер отражает реальный сетевой путь, а не reliable-поток `meta` с его ретрансмиссиями; потерянный ping покрывается допуском `maxMissedPings`. [RTTManager](../../packages/engine/src/host/meta/modules/RTTManager.js) считает задержку, публикует её в статистику (столбец `latency`) и кикает:

- при сглаженной (EMA) `latency > maxLatency` (1000 мс; порог рассчитан на P2P-хостинг с домашних каналов и спайки при смене карты) — код `4003`;
- при `maxMissedPings` (5) подряд пропущенных ответах — код `4004`.

**Причина закрытия**: data channel, в отличие от WebSocket, не несёт код/причину закрытия — Worker хоста доставляет причину (кик, полная комната) отдельным `TECH_INFORM_DATA` по `meta` непосредственно перед закрытием; клиент показывает её вместо общего «Host left».

## Форматы мета-данных

### Авторизация (порт 1)

Payload `AUTH_DATA` (`PS_AUTH_DATA`): `{ elems, params, texts }`
(`hostPlugin.authSchema` — см. [plugin-api.md](plugin-api.md#схема-формы)):

- `elems` — DOM-id, которые нейтральный каркас `auth.pug` открывает
  игре-плагину (`authId`, `errorId`, `enterId`, `fieldsId`, и для
  текстов ниже — `titleId`/`informsId`); значения плагина должны совпадать
  с реальными id в `auth.pug`.
- `params[]` — `{ name, value, options }`, схема полей игрока (тот же
  контракт дескрипторов, что и `roomForm`): `options` несёт
  `control`/`label`/`min`/`max`/`step`/`unit`/`options`/`source`/`storage`/`regExp`
  плюс уже существующий `validator` (ключ в `authSchema.validators`,
  проверяется только на хосте — код валидатора по проводу не идёт). Клиент
  строит по одному контролу на param через `formBuilder.js` и вставляет в
  `#`+`elems.fieldsId`, подставляя значение из `localStorage[storage]`, если
  оно есть.
- `texts` — опционально `{ title, sections }`, заполняет
  `elems.titleId`/`elems.informsId` нейтрального каркаса.

### Панель (порт 13)

Массив строк `'ключ:значение'`, например `['t:97', 'h:100', 'w1:200', 'wa:w1']`. Отправляются только изменившиеся ключи; `t` (время раунда, сек) — при каждом изменении секунды. Пустая панель (наблюдателю) — время + список ключей без значений (контейнеры скрываются).

### Статистика (порт 14)

`statArray = [tBodies, tHead, fullUpdate?]` (формирует [packages/engine/src/host/meta/modules/Stat.js](../../packages/engine/src/host/meta/modules/Stat.js)):

- **`statArray[0]`** — строки таблиц: `[id строки, номер таблицы, массив ячеек | null, номер tbody]`. `null` вместо ячеек — удалить строку; пустая строка в ячейке — очистить значение; `undefined`/пропуск — не менять.
- **`statArray[1]`** — шапки: `[номер таблицы, массив ячеек, номер строки tHead]`.
- **`statArray[2]`** — флаг полного обновления (boolean, опционально).

Ячейки строки игрока: `[name, status, score, deaths, latency]` (порядок — `key` из `game:stat`).

### Чат (порт 15)

- Пользовательское сообщение: `[текст, имя автора, teamId]`.
- Системное сообщение: строка `'группа:номер:параметры,через,запятую'` — клиент собирает текст из шаблонов `messages` своего конфига (группы `s`, `v`, `m`, `c`, `n`, `b`).

### Голосование (порт 16)

Сервер шлёт `payload`:

- `name` — имя/тип голосования (клиент ищет шаблон в `client.js → modules.vote.params.templates`);
- `params` — опционально; строки для подстановки в плейсхолдеры `{0}`, `{1}` заголовка;
- `values` — опционально; массив готовых вариантов **или** строка-команда (`'maps'`, `'teams'`) — клиент запрашивает актуальный список у сервера (порт 7 client → server).

Ответ клиента: `[voteName, selectedValue]`. Запрос динамического списка: строка `'maps'` | `'teams'`.

---

[← Предыдущая: Клиентские модули](client.md) · [Следующая: Конфигурация →](configuration.md)
