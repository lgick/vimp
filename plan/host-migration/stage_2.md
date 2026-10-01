# Этап 2. Стабильная комната: `roomId` без имени, эпоха, участники на мастере, реконнект хоста ✅ выполнен

Цель: перевести мастер с «реестра хостов» на «реестр комнат». У комнаты
стабильный публичный `roomId` (переживает смену хоста и реконнект
сигналинга), номер эпохи хоста, список участников (мастер знает, кто в
комнате) и правило жизни «комната живёт, пока в ней есть участник». Поле
«Server name» удаляется. Миграции ещё нет: потеря хоста пока закрывает
комнату, но теперь мастер **уведомляет** участников (`room_closed`).

Зависит от этапа 1 (рейтинг уже удалён).

## 2.1. Идентификаторы

- Новый модуль `packages/engine/src/lib/roomId.js` (изоморфный — нужен и
  мастеру, и клиенту для валидации ссылок): алфавит crockford-base32 в нижнем
  регистре `0123456789abcdefghjkmnpqrstvwxyz`, длина 8;
  `generateRoomId(randomBytes)` (мастер передаёт `crypto.randomBytes`),
  `isValidRoomId(str)` (`/^[0-9a-hjkmnp-tv-z]{8}$/`). Длина — константа
  модуля, не конфиг (её проверяет клиентский роутер этапа 3).
- `memberId` — клиент генерирует `crypto.randomUUID()` один раз при загрузке
  страницы (`client/main.js`, рядом с бутстрапом лобби), живёт в памяти
  вкладки (не в storage — две вкладки одного профиля = два участника).
- `hostSecret` → `roomSecret`, и он больше **не случайный UUID**, а
  вычисляется мастером:
  `roomSecret = HMAC-SHA256(roomSecretKey, roomId + ':' + epoch + ':' + hostUserId)`
  в base64url (новый модуль `master/roomSecret.js`: `deriveRoomSecret`,
  `verifyRoomSecret` с `crypto.timingSafeEqual`). Зачем: после рестарта
  мастера реестр в памяти пуст, и `reclaim_host` должен отличить
  настоящего хоста от любого, кто видел `roomId` в адресной строке.
  HMAC проверяется без хранения состояния, привязан к пользователю хоста
  (его `userId` берётся из проверенного токена в `reclaim_host`) и сам
  меняется со сменой эпохи (новый хост → новый секрет, этап 7).
  `roomSecretKey` — из окружения `VIMP_ROOM_SECRET_KEY`
  (`config/env.js`): в production обязателен (мастер не стартует без
  него), в dev при отсутствии генерируется случайный на время процесса —
  тогда комнаты после рестарта dev-мастера не восстанавливаются, это
  допустимо (или задать ключ в `.env`).

## 2.2. Мастер: реестр комнат

`git mv packages/engine/src/master/HostRegistry.js packages/engine/src/master/RoomRegistry.js`
(и тест). Сущность `Room`:

```js
{
  roomId, epoch: 1, status: 'online',            // 'online' | 'migrating' (этап 7) | 'handing_off' (этап 8)
  gameId, gameVersion, mapName, maxPlayers, region, hidden,
  createdAt, lastSeen,                            // heartbeat хоста
  host: { sessionId, memberId, userId, ip },      // текущий хост
  // roomSecret не хранится: deriveRoomSecret(roomId, epoch, host.userId)
  members: Map<memberId, { memberId, userId, nick, sessionId|null,
                           joinedAt, detachedAt|null, caps: {} }>,
}
```

- `add({...}, hostSession)` — создаёт комнату с уникальным `roomId`
  (повторить генерацию при коллизии), хост сразу участник. Лимит «1 комната
  на IP» — теперь «IP не хостит другую комнату» (`getByIp` по `host.ip`);
  этапы 7/8 добавят обход лимита для промоушена.
- `joinMember(roomId, {memberId, userId, nick, sessionId})`,
  `detachMember(sessionId)` (WS закрылся — `sessionId = null`,
  `detachedAt = now`), `leaveMember(roomId, memberId)`,
  `liveMembers(roomId)`.
- `currentPlayers` = число участников с `sessionId !== null` **или**
  `detachedAt` моложе `room.memberGraceMs` (см. конфиг) — то есть люди в
  комнате; самоотчёт хоста о числе пиров больше не нужен (`update_host`
  продолжает нести `mapName` и служит heartbeat).
- `sweep(now)` — (а) хост без heartbeat дольше `heartbeatTimeout` → «хост
  потерян»; (б) участник отсоединён дольше `memberGraceMs` → удалить
  участника; (в) комната без участников → удалить. До этапа 7 «хост
  потерян» = комната закрывается (`room_closed {reason: 'hostLeft'}` всем
  участникам), после этапа 7 — миграция.
- `getList()` / `_toPublic(room)` → `{ roomId, hostId: roomId /* алиас на
переходный период: старые страницы лобби после деплоя */, gameId,
mapName, currentPlayers, maxPlayers, region }` — без `name`, без
  `rating`. Комнаты в статусе ≠ `online` из списка не выпадают (миграция —
  короткое состояние, в лобби комната должна остаться видимой): фильтр
  `status !== 'online'` заменить на «не hidden».
- Поиск `search`: совпадение по префиксу `roomId`, подстроке `gameId`,
  подстроке `mapName`, и форма `gameId/<префикс roomId>` (лобби-карточка
  показывает `gameId/roomId`). Логику `regionThreshold`/пагинации не менять.
- `verifiedAttribution(roomId, secret)` → `verifyRoomSecret(roomId,
secret)`; принимает `hostId` как алиас `roomId`.

## 2.3. Мастер: сигналинг (`SignalingServer.js`)

Сессия: `{ id, ws, ip, region, roomId: null /* комната, где хост */,
memberOf: null /* {roomId, memberId} */ }`. `_hostSessions` →
`roomId → sessionId` текущего хоста.

| Сообщение                                                                   | Поведение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register_host {gameId, gameVersion, maxPlayers, mapName, token, memberId}` | токен проверяется `_verifyToken` (как сейчас) → `userId`, `nick`; `name` из старых клиентов игнорируется; ответ `host_registered {roomId, epoch, roomSecret, mapsVersion, codeVersion}` (поле `hostId: roomId` и `hostSecret: roomSecret` — алиасы для страниц, загруженных до деплоя)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `reclaim_host {roomId, epoch, roomSecret, memberId, token}`                 | токен проверяется → `userId`; `verifyRoomSecret(roomSecret, roomId, epoch, userId)` — неверно → `error {code: 'invalidRoomSecret'}` (это и есть защита от угона). Верно и комната есть с той же эпохой → перепривязать `host.sessionId`, ответ `host_registered` (те же roomId/epoch/secret). Верно, а **комнаты нет** (мастер перезапускался — реестр в памяти) → создать комнату заново с этим `roomId`/`epoch`, хост — этот пользователь. Комната есть, но эпоха новее → `error {code: 'staleEpoch'}` (хоста уже сменили, этап 7) → клиент-хост снимает роль и возобновляется гостем. Секрет верен, но `roomId` занят другой комнатой (невозможно при уникальных id, но проверить) → `roomTaken` → клиент делает обычный `register_host` |
| `update_host {mapName}` / `heartbeat`                                       | только от текущего хоста комнаты (`_hostSessions`), иначе игнор                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `join_room {roomId, memberId, token}`                                       | токен проверяется → участник добавлен/перепривязан (тот же `memberId` после реконнекта); ответ `room_joined {roomId, epoch}`; ошибки `unknownRoom`, `invalidToken`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `leave_room {roomId}`                                                       | участник удалён сразу (без grace)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `webrtc_offer {roomId \| hostId, sdp, memberId, resume?}`                   | маршрут к текущему хосту комнаты; хосту уходит `webrtc_offer {clientId, sdp, memberId, resume, epoch}`; `unknownHost` → `unknownRoom` (старый код оставить алиасом в ответе на время перехода)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `webrtc_answer {clientId, sdp}`                                             | клиенту `webrtc_answer {roomId, hostId: roomId, epoch, sdp}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ice_candidate {targetId, candidate}`                                       | `targetId` — `clientId` или `roomId` (резолвится в текущего хоста); `fromId` хоста = `roomId`, плюс `epoch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ping_host {roomId \| hostId, pingId}` / `pong_host`                        | как сейчас, ключ — `roomId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| закрытие WS                                                                 | хост → «хост потерян» (до этапа 7: `room_closed` всем + удалить комнату; **с паузой `hostReclaimGraceMs`**, чтобы `reclaim_host` успел — иначе реконнект бесполезен); участник → `detachMember`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 2.4. Конфиг

`config/master.js`: `room.memberGraceMs` (15000), `room.hostReclaimGraceMs`
(10000); удалить `maxNameLength` (`:76`, передача в `lobby.js:299`).
`config/env.js`: `VIMP_ROOM_SECRET_KEY` (≥ 32 байт; описать в
`docs/{en,ru}/configuration.md` и `deployment.md` — завести секрет в GitHub
и пробросить в деплой мастера, как остальные секреты окружения).
`config/lobby.js`: удалить `nameId: 'lobby-name'` (`:166`) и
`defaultName: 'My Server'` (`:330`). Те же правила Removed/Breaking, что в
этапе 1.6. Документация — `docs/{en,ru}/configuration.md`.

## 2.5. Клиент

- **Имя сервера**: удалить поле из `views/includes/lobby.pug:34-36`
  (`label 'Server name'`, `input#lobby-name`) и стиль (`style.css:705`);
  чтение в `main.js:2420, 2437-2438`; `room.name` в объекте комнаты
  (`main.js:2459-2460`). Проверить, читает ли кто-то `room.name` в хосте
  (`lib/applyRoomOverrides.js`, `createHostRuntime.js`, dedicated
  `config/env.js`/`VIMP_DEDICATED_ROOM`): если да — подставить `roomId`
  (лобби) / оставить как есть (dedicated, у него своё имя из env), но
  лобби-путь имя больше не передаёт. Solo (`name: 'solo'`, `main.js:1785`)
  не трогать, если имя там нужно движку.
- **Карточка лобби** (`components/view/Lobby.js:287-290`): вместо
  `` `${gameId}/${name}` `` показывать `gameId/roomId` + карта; модель/
  контроллер лобби (`components/{model,controller}/Lobby.js`) — ключ
  `roomId` вместо `hostId` (с фолбэком на `hostId` из ответа).
- **`SignalingClient.js:65-75`**: `registerHost({gameId, gameVersion,
maxPlayers, mapName, token, memberId})`, новые методы `reclaimHost`,
  `joinRoom`, `leaveRoom`.
- **`main.js` — хост** (`connectAsHost`, 1578-1776): `hostRegistration()`
  при первом `welcome` шлёт `register_host`, при последующих (реконнект) —
  `reclaim_host` с сохранёнными `roomId/epoch/roomSecret`; ответ
  `host_registered` сохраняет их и шлёт в Worker
  `HostController.setRoom({roomId, roomSecret, epoch})` (новый метод; старый
  `setHostId` удалить из главного потока, но **Worker продолжает понимать
  `set_host_id`** — см. 2.6).
- **`main.js` — гость**: после `AUTH_RESULT` (вход в комнату состоялся) в
  лобби-режиме слать `join_room {roomId, memberId, token}`; хранить
  `currentRoomId`. Сейчас реконнект сигналинга есть только у хоста
  (`main.js:1720-1730`) — сделать его общим для лобби-режима: при новом
  `welcome` гость в комнате повторяет `join_room` с тем же `memberId`.
- **Ошибки сигналинга**: сейчас `main.js` не подписан на `error` вовсе.
  Подписаться и обрабатывать `unknownRoom` (если ждём ответа на оффер —
  сообщение «Room no longer exists» и возврат в лобби), `invalidToken`
  (разлогин/повторный вход), `hostLimit`, `roomTaken` (см. 2.3).
- **`room_closed`**: показать причину («The host left — the room is
  closed.») и вернуться в лобби (нынешний путь `handleDisconnect`). Это
  быстрее, чем ждать падения WebRTC.
- `HostConnectionManager`: хранить `memberId` пира из `webrtc_offer`
  (понадобится этапу 6) рядом с `clientId`.
- `WebRtcManager.connect(roomId)`: оффер `{roomId, sdp, memberId}`;
  принимать `webrtc_answer`/`ice_candidate` по `roomId` (и `hostId` как
  алиас).

## 2.6. Worker (`host/host.worker.js`, `host/meta/modules/PlayerDataSync.js`)

- Новое сообщение `set_room {roomId, roomSecret, epoch}`; старое
  `set_host_id {hostId, secret}` (`host.worker.js:208`) продолжает
  работать (страница до деплоя + новый Worker) и мапится на `set_room`.
- `PlayerDataSync` (`:78-80`, тела `:563-571`, `:611-618`): слать
  `roomId`/`roomSecret`; мастер (`lobby.js` PUT `/auth/rank`·`/state`)
  принимает и `hostId`/`hostSecret` (старые Worker'ы), и новые имена.
- `createHostRuntime.js:93-95` — то же переименование.
- В auth `session_id` теперь = `roomId` (стабилен за всю жизнь комнаты).

## 2.7. Тесты

- `tests/lib/roomId.test.js` — генерация (алфавит, длина, уникальность на
  выборке), валидация.
- `tests/master/RoomRegistry.test.js` — создание, коллизия id, IP-лимит,
  участники: join/detach/leave/grace, `currentPlayers`, sweep (хост
  потерян → `room_closed`, пустая комната удаляется), поиск по
  `roomId`/`gameId`/`gameId/roomId`, публичная форма без `name`/`rating`.
- `tests/master/roomSecret.test.js` — детерминизм, зависимость от каждого
  из трёх полей и от ключа, сравнение постоянного времени, мусорный ввод.
- `tests/master/SignalingServer.test.js` — все сообщения таблицы 2.3,
  включая `reclaim_host` (живая комната; комната после рестарта мастера с
  верным секретом; **угон**: чужой пользователь с видимым `roomId` и
  подобранным/чужим секретом → `invalidRoomSecret`; устаревшая эпоха),
  алиасы `hostId`, игнор `update_host` не от хоста, `room_closed`
  участникам при закрытии WS хоста после grace.
- `tests/config/env.test.js` — `VIMP_ROOM_SECRET_KEY` (обязателен в
  production, генерация в dev).
- `tests/client/LobbyView.test.js`, `LobbyModel.test.js` — карточка без
  имени; `tests/client/network/SignalingClient.test.js` — новые методы;
  `tests/client/network/HostController.test.js` — `setRoom`;
  `tests/host/PlayerDataSync.test.js`, `tests/lib/createHostRuntime.test.js`
  — новые поля; Worker: тест на `set_host_id` как алиас.

## 2.8. Документация

`docs/{en,ru}/master.md` — модули (RoomRegistry), `GET /servers` (форма
ответа, поиск), протокол сигналинга (таблицы хоста/клиента — все сообщения
2.3), жизнь комнаты; `host.md` — «Registering with the master»
(`register_host`/`reclaim_host`, `set_room`, «the host player leaving kills
the room» пока остаётся верным, но с `room_closed`); `client.md` — лобби без
имени, `join_room`, реконнект сигналинга гостя, обработка `error`/
`room_closed`; `network.md` — `fromId`/`roomId` в ICE; `auth.md` —
`session_id = roomId`; `configuration.md`.

## 2.9. CHANGELOG

`### ⚠️ Breaking` + `### Migration`: лобби-мастер в production без
`VIMP_ROOM_SECRET_KEY` не стартует — окружение, которое раньше запускалось,
теперь отвергается (уточнено при ревью: правило `CLAUDE.md` приоритетнее
плана, где стояло `Changed`).
`### Added`: `join_room`/`leave_room`, мастер ведёт участников комнат;
`gameConfig.lobbyInfo` + `deps.lobby.setInfo` (уточнено при ревью: строку
карточки лобби задаёт игра — `'map'` у tanks, у snakes её нет; пустые
сегменты карточки, включая неизвестный регион, не выводятся).
`### Changed`: rooms get a stable `roomId` (lobby card and search),
signaling `register_host` without `name`, `info` вместо `mapName`,
`reclaim_host` keeps a room across a host signaling reconnect and a master
restart, `room_closed`.
`### Removed`: room name (`#lobby-name`, `config.lobby` `nameId`/
`defaultName`, master `maxNameLength`).

## Проверка

`npx prettier --write …`, `npx eslint .`, `npm test -- --silent`. Ручная
(dev-контур, два профиля Chrome, dev-логин —
`http://localhost:3010/dev/login?nick=P1&returnUrl=https://localhost:3002/`):
создать комнату без имени → карточка `tanks/<roomId>`; второй профиль
входит; перезапустить мастер (nodemon) — комната вернулась с тем же
`roomId`; закрыть вкладку хоста — гость сразу видит «The host left».

## Готово, когда

Проверки зелёные, доки en/ru синхронны, CHANGELOG обновлён, release impact
в отчёте.
