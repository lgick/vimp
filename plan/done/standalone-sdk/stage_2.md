# Этап 2: Клиентские режимы загрузки, DOM-каркас, WebSocketTransport ✅ выполнен

_Цель: научить единственный клиент движка (`src/client/main.js`) стартовать в
трёх режимах — `lobby` (как сейчас), `solo` (хост в этой же вкладке, без
мастера), `dedicated` (прямой WebSocket к Node-серверу) — и дать ему
недостающие транспорт и DOM-каркас._

## Задача 2.1: `packages/engine/src/client/boot.js` (новый)

```js
export function setBootConfig(cfg)      // вызывает SDK до import('./main.js')
export async function resolveBootConfig()
```

`resolveBootConfig()`:

1. если конфиг уже задан (`solo`) — вернуть его;
2. иначе `GET /config` → `{ mode: 'dedicated' | 'lobby', … }`;
3. сеть/404/невалидный ответ → `{ mode: 'lobby' }` (обратная совместимость).

Форма конфига:

```js
{
  mode: 'lobby' | 'solo' | 'dedicated',
  manifest,        // solo: манифест-подобный объект в памяти
  clientPlugin,    // solo: живой ClientPlugin (минуя dynamic import)
  hostPlugin,      // solo: живой HostPlugin (для inline-хоста)
  room,            // solo: переопределения комнаты (map/maxPlayers/…, seed)
  autoAuth,        // solo: { name, model, … } → AUTH_RESPONSE без формы
  startupCommands, // solo: чат-команды после FIRST_SHOT_READY (боты игры)
  wsUrl,           // dedicated: адрес игрового WS (по умолчанию wss://host/game)
  gameId,          // dedicated
}
```

Модульное состояние (общий экземпляр модуля в графе бандлера) — это и есть
канал передачи от SDK к `main.js`; глобалов на `window` не вводим.

## Задача 2.2: `packages/engine/src/client/views/gameShell.js` (новый)

`ensureGameShell(container = document.body)` — идемпотентно создаёт
отсутствующие контейнеры игрового интерфейса: `#panel` (+ `#logo`), `#chat`
(+ `#chat-box`, `#cmd`), `#stat`, `#game-informer`, `#tech-informer`, `#auth`
(+ `#auth-form`, `#auth-title`, `#auth-error`, `#auth-fields`, `#auth-enter`,
`#auth-informs`). Уже существующие элементы не трогает — поэтому в
lobby-режиме (разметка из pug) функция ничего не делает.

Дополнительно:

- `#vote` не создаём: его делает `view/Vote.js:33-79` в рантайме.
  **Пропуск, закрытый в [review.md](review.md) (P1-2):** точку монтирования
  `#vote` тогда не получил и уходил в `document.body` — в solo это выносило
  окно голосования за пределы контейнера SDK. Теперь `VoteView` принимает
  контейнер третьим аргументом, `main.js` передаёт `gameContainer`.
- Канвасы (`vimp`, `radar`) не создаём: их делает `main.js:271-280` по
  `CONFIG_DATA` (см. задачу 2.5, точка ветвления 5 — точка монтирования).
- Контейнер SDK обязан быть полноэкранным и позиционированным
  (`position: relative; width/height: 100%`): `#panel`, `#stat`, `#vote` в
  `style.css` — `position: absolute` (строки 14, 140, 223), их containing
  block — ближайший позиционированный предок. Требование фиксируется в
  доках SDK (Этап 3.3).
- **Перенести базовые правила из `packages/engine/index.html:12-33` в
  `src/client/style.css`** (`html/body`, `body > * { display: none }`,
  `body.hide-cursor`) и удалить `<style>` из `index.html`. Иначе в
  `index.html` репозитория игры все экраны окажутся видимыми сразу.
  CSP это не задевает: sha256 в `script-src` покрывает только inline-importmap.
  **Отклонение, закрытое в [review.md](review.md) (P1-1):** перенос был
  выполнен буквально, и внутри контейнера SDK правило `body > *` не работало
  (экраны показывались разом), а сам контейнер, будучи прямым потомком `body`,
  этим правилом скрывался — чёрный экран. Класс-маркер ставит
  `ensureGameShell`. **Уточнено в [review-2.md](review-2.md) (R2-1):** в
  `style.css` осталась только форма `.vimp-shell > *` — форма `body > *`
  гасила бы и разметку самой страницы игры, поэтому она вернулась инлайном в
  `index.html` (защита от FOUC до исполнения JS, после которого класс на
  `body` делает обе формы тождественными). Исключение
  `body > .vimp-shell { display: revert }` стало не нужно.
- Вызов `ensureGameShell()` — первой строкой исполняемой части `main.js`
  (до `document.getElementById('tech-informer')` на `:185`).

## Задача 2.3: `packages/engine/src/client/network/WebSocketTransport.js` (новый)

Интерфейсный близнец `WebRtcManager`/`LoopbackTransport`:

- `constructor(url, { socketFactory = u => new WebSocket(u) } = {})`;
- `connect()` — создаёт сокет, `ws.binaryType = 'arraybuffer'` (**обязательно**:
  `main.js:1077` различает форматы через `data instanceof ArrayBuffer`, а
  дефолтный браузерный WS отдаёт `Blob`);
- `send(data, reliable)` — `reliable` игнорируется (у WS нет уровней
  надёжности), отправка только при `readyState === OPEN`;
- `close()`;
- `publisher`: `open`, `message` (raw `event.data`), `close`.

Следствия для документации: на dedicated-сервере разделение meta/state
исчезает — PING/PONG идут надёжным каналом (замер RTT становится замером
TCP-пути), а бэкпрешер вместо дропа позиционных кадров в
`HostConnectionManager` живёт на серверной стороне (Этап 4).

## Задача 2.4: `packages/engine/src/client/network/InlineHostBridge.js` (новый)

Замена `HostController` для solo-режима: тот же интерфейс, который дёргает
`LoopbackTransport` (`open(socketId, {onMessage,onClose})`, `send(socketId, data)`,
`disconnect(socketId)`), но вместо Worker'а — хост в этом же потоке:

1. `createHostRuntime(room, { loadHostPlugin: async () => hostPlugin, hostOptions: { playerDataFetch: offlinePlayerData(), onMapChange } })`;
2. `new PortMachine({ …runtime, identity: createGuestIdentity(), makeSocket })`,
   где `makeSocket(socketId)` отдаёт `{ send(port, data), sendBinary(buffer), close(code, data) }`,
   которые кладут кадр в `onMessage` соответствующего клиента
   (JSON — строкой через `JSON.stringify([port, data])`, бинарь — как
   `ArrayBuffer`, ровно как `makeWorkerSocket`);
3. `await ready` до первого `open()`;
4. `destroy()` → `host.destroy()`.

Так `LoopbackTransport` переиспользуется без изменений, а весь solo-режим —
это ~120 строк моста плюс ветки в `main.js`.

## Задача 2.5: ветвления в `packages/engine/src/client/main.js`

Ровно пять точек (везде `lobby` — текущее поведение без изменений):

1. **Источник манифеста и плагина** (`:85-103`): `boot.manifest ?? await fetchGamesManifest(...)`, `boot.clientPlugin ?? await loadClientPlugin(manifest)`.
2. **Сигналинг и лобби** (`:137-138`, `:1801-1828`): `SignalingClient`,
   `LobbyAuth`/`Lobby` MVC и `signaling.connect()` — только в `lobby`. В
   `solo`/`dedicated` перехват `/like`·`/unlike` (`:899-929`) отключён (нет
   мастера — команда уходит хосту как обычный чат).
3. **Транспорт**: `solo` → `InlineHostBridge` + `LoopbackTransport('local')`;
   `dedicated` → `WebSocketTransport(boot.wsUrl)`; `lobby` → как сейчас
   (`connectToHost`/`connectAsHost`). Вызовы `lobby.close()` (`:1192`, `:1390`)
   обернуть — вне lobby-режима объекта нет.
4. **Авто-аутентификация и автостарт**: в обработчике `AUTH_DATA` при
   `boot.autoAuth` не строить Auth-MVC, а сразу
   `sending(PC_AUTH_RESPONSE, { ...defaultsFrom(params), ...boot.autoAuth })`.
   После `FIRST_SHOT_READY`, **на первом `renderTick`** (не в том же
   синхронном вызове), отправить в строгом порядке:
   `boot.startupVotes` → `PC_VOTE_DATA` (порт 7), затем
   `boot.startupCommands` → `PC_CHAT_DATA` (порт 6).
   Порядок именно такой и он обязателен, разбор ниже.
5. **Точка монтирования канвасов** (`main.js:271-280`): сейчас
   `document.body.appendChild(canvas)` безусловно. Заменить на
   `(boot.container ?? document.body).appendChild(canvas)` — иначе в solo
   канвасы окажутся снаружи контейнера SDK. Хардкодить чужой id
   (`getElementById('game')`) нельзя: `#game` — разметка репозитория игры,
   движок её не знает. Ветка `document.getElementById(canvasId) ?? create`
   сохраняется: если игра сама положила `<canvas id="vimp">` в контейнер,
   элемент переиспользуется (`!canvas.parentNode`) и не переносится.

### Почему порядок «vote → commands» обязателен

- Порт **`CHAT_DATA` client→server — это 6**, и он включается ещё в
  обработчике `MODULES_READY` (`host.worker.js:212-224`), то есть **до**
  `MAP_READY`/`FIRST_SHOT_READY`. Отдельного состояния `PLAYING` у порт-машины
  нет.
- Реальный гейт — `HostGame.pushMessage:882`: сообщение отбрасывается, пока
  `user.isReady === false`; флаг ставится **синхронно** в
  `firstShotReady:491`. Порядок доставки гарантирован (solo — синхронный
  loopback, dedicated — TCP), поэтому отправка сразу после `FIRST_SHOT_READY`
  технически проходит; сдвиг на первый `renderTick` берём как страховку и
  для симметрии с задержкой `interpolation.delay`.
- **Настоящая блокировка — команда, а не порт**: участник входит
  наблюдателем, а игра может требовать активной команды. У танков
  `botCommand.handler` первым делом отбивает `/bot` при
  `user.teamId === ctx.spectatorId` (`BOT_PLAYERS_ONLY`). Выйти из
  наблюдателей можно только ответом на initialVote
  (`SocketManager.sendFirstVote` → `VOTE_DATA`), который приезжает внутри
  `firstShotReady`: клиент отвечает `['teamChange', '<team>']` на порт 7 →
  `HostGame.parseVote:936` → `RoundManager.changeTeam`. Поэтому
  `startupVotes` идут **строго раньше** `startupCommands`.
- Лимита частоты чата на хосте нет (в `Chat`/`pushMessage` его не
  существует) — ограничение только по длине, `chatMaxLength = 60`
  (`pushMessage:890`). Дробить команды «по одной на кадр» не требуется.

Дополнительно: `handleDisconnect` (`:1091-1138`) сейчас перезагружает
страницу (`location.reload()`). В `solo` перезагрузка бессмысленна (матч
поднимается заново с нуля) — показать `techInformer` и остановить рендер;
в `dedicated` — оставить reload (сервер жив, переподключение уместно).

**Проверки WebRTC править не нужно** (проверено): `ensureWebRtcAvailable()`
вызывается только из `connectToHost:1175` и `connectAsHost:1207`, а
`supportsModuleWorker()` — только из `connectAsHost:1198`. Оба пути —
lobby-режим, в `solo`/`dedicated` они не исполняются вовсе. Это даёт
бесплатное свойство, которое надо зафиксировать в приёмке: игра стартует в
окружении с полностью отключённым WebRTC и без поддержки module-worker'ов.

## Тесты

- `tests/client/network/WebSocketTransport.test.js` — фейковый `WebSocket`:
  `binaryType`, строковая и бинарная отправка, дроп до `open`, события
  `open/message/close`.
- ~~`tests/client/network/LoopbackTransport.test.js` — контракт транспорта
  (сегодня не покрыт вовсе; нужен как эталон для WS и inline).~~
  **Отклонено при исполнении**: посылка неверна — `LoopbackTransport` уже
  покрыт в `tests/host/LoopbackTransport.test.js` (connect/message/send/
  двойной close/`close_client`). Дублирующий файл ничего бы не проверял;
  эталоном для WS и inline послужил этот же тест.
- `tests/client/network/InlineHostBridge.test.js` — на фикстуре `miniGame`:
  `open` → приходит `CONFIG_DATA`, отправка `CONFIG_READY` → `AUTH_DATA`.
- `tests/client/boot.test.js` — три ветки `resolveBootConfig` (инъекция,
  `/config`, сбой сети).
- порядок автостарта: `startupVotes` уходят раньше `startupCommands`, оба —
  после `FIRST_SHOT_READY` (проверяется на записанном потоке `sending`);
  канвасы примонтированы в `boot.container`, а не в `body`.
- `tests/client/gameShell.test.js` — идемпотентность + **паритет с pug**:
  тест регуляркой собирает набор `#id` из
  `src/client/views/includes/{panel,chat,stat,auth,informer}.pug` и сверяет с
  набором, который создаёт `ensureGameShell()` в happy-dom (страховка от
  расхождения двух источников разметки).

## Документация и журнал

- `docs/en/client.md` + `ru`: режимы загрузки (`boot.js`), `gameShell`,
  `InlineHostBridge`, автостарт.
- `docs/en/network.md` + `ru`: третий транспорт (`WebSocketTransport`),
  таблица «WebRTC / loopback / websocket» и что происходит с meta/state и RTT.
- `CHANGELOG.md` → `### Added`.

## Проверка

```bash
npx eslint . && npm test
npm run dev       # лобби-режим: комната создаётся, второй клиент по WebRTC
```
