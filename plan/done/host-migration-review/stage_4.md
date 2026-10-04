# Этап 4. Целостность членства: фантомы, голоса и кворум по пользователю, «призраки» ✅ выполнен

Находки: **F5**, **F6**, **F7**, **F18** ([review.md](review.md), разделы
F5, F6, F7, F18). Уровень: 🔵 безопасность. Критерии: безопасность,
работоспособность, масштабируемость.

Делать после этапа 3 (те же файлы мастера).

## ⚠️ Подтвердить у разработчика до начала

Предложенные ниже правила меняют наблюдаемое поведение. Рекомендуемые
значения:

1. **(а)** Голоса `/changehost`, отчёты `host_unreachable` и их кворум
   считаются **по пользователю** (`userId`), а не по вкладке
   (`memberId`). Пользователь хоста (все его вкладки) не голосует.
2. **(б)** Счётчик игроков в лобби и кандидатство в беты/холодного хоста —
   только для участников, которых хост подтвердил как подключённых по
   WebRTC (новое сообщение `room_peers`), если хост такие отчёты шлёт.
   Хост старше этого этапа отчётов не шлёт — поведение прежнее.
3. **(в)** Принудительная миграция по отчётам (`unreachable`) требует
   **не меньше 2 разных пользователей**: кворум
   `max(2, ceil(гостей-пользователей / 2))`. В комнате с одним гостем
   отчёты хоста не снимают; проба без ответа (`unresponsive`) и потеря
   сигналинга хоста работают как раньше.
4. **(г)** Голосовать и начинать голосование может участник, пробывший в
   комнате не меньше `master.room.vote.minVoterAgeMs` = 30 000 мс.

Решения вписать в этот файл (раздел «Согласовано») до правки кода.

### Согласовано (2026-10-04)

Все четыре пункта приняты в рекомендованном виде: (а) голоса, отчёты и
кворум — по `userId`, вкладки пользователя хоста не голосуют; (б)
подтверждение участников хостом через `room_peers`; (в)
`room.minUnreachableReporters = 2`; (г) `room.vote.minVoterAgeMs = 30000`.

## Проблема

- `packages/engine/src/master/SignalingServer.js:884-934` `_onJoinRoom`:
  достаточно валидного токена и любого UUID — подключение к хосту не
  проверяется. Один аккаунт открывает N сигнальных сессий и становится N
  участниками чужой комнаты.
- По `memberId` считаются: `RoomRegistry.currentPlayers`
  (`master/RoomRegistry.js:608-618`), право голоса и голоса
  (`master/HostVoteManager.js:120-125, 176-201`), отчёты и кворум
  (`master/MigrationCoordinator.js:854-892, 941-961`), кандидаты в беты
  (`master/successor.js`, `isCandidate`).
- Последствия: комната «полная» (быстрая игра и прямые ссылки её
  обходят), один пользователь снимает хоста голосованием, принудительные
  миграции раз в 30 с, фантом-бета без пира (точек нет) и фантом-кандидат
  в аварии (25 с ожидания каждого) или захват комнаты.
- F6: при одном госте кворум 1 (`MigrationCoordinator.js:956`) —
  «пинг-понг» роли у пары с плохим P2P.
- F7: `client/main.js:1573-1660` `handleDisconnect` не шлёт `leave_room`
  (кик уводит на главную без перезагрузки — сессия жива), а
  `SignalingServer._onRegisterHost` / `_bindHost` (строки 521-569,
  810-814) не снимают прежнее членство сессии. Вкладка остаётся
  «призраком» комнаты: в счётчике, в голосовании, кандидатом; на
  `promote` молчит — мастер ждёт её 25 с.
- F18: `_onWebRtcOffer` пересылает хосту `memberId` из оффера после
  проверки формата; `_onJoinRoom` позволяет занять **чужой** `memberId`
  (`RoomRegistry.joinMember` перезапишет `userId` и `sessionId` записи) —
  в том числе беты.

## Решение

### 4.1 Хост подтверждает подключённых участников (`room_peers`)

Новое сообщение сигналинга хост → мастер:
`room_peers { roomId, epoch, memberIds: string[] }` — `memberId` пиров, у
которых открыты оба канала (meta и state).

**Клиент:**

1. `packages/engine/src/client/network/HostConnectionManager.js`: метод
   `connectedMemberIds()` → массив `peer.memberId` всех пиров с
   `openCount === 2` и непустым `memberId`.
2. `packages/engine/src/client/network/SignalingClient.js`: метод
   `roomPeers({ roomId, epoch, memberIds })`.
3. Новый маленький класс `packages/engine/src/client/network/RoomPeersReporter.js`
   (без DOM, таймеры инъектируются): `notify()` — отложенная на
   `debounceMs` (500) отправка; `refresh()` — немедленная; сам раз в
   `intervalMs` повторяет отчёт; `destroy()`. Отправляет, только если
   `getRoom()` вернул комнату.
4. `client/main.js` `adoptHostRole` (строки 2371-2425): создать репортёр
   (`send` → `signaling.roomPeers`, `getRoom` → `hostRoom`,
   `getMemberIds` → `hostConnections.connectedMemberIds()`,
   `intervalMs: lobbyConfig.migration.peersReportIntervalMs`); в
   `onPeersChange` звать `notify()`; в обработчике `host_registered`
   (строки 2510-2547) — `refresh()`; в `teardownHostRole` — `destroy()`.
5. `packages/engine/src/config/lobby.js`, раздел `migration`:
   `peersReportIntervalMs: 15000`.

**Мастер:**

1. `SignalingServer.js`: обработчик `'room_peers': this._onRoomPeers` —
   принимать только от **привязанного** хоста этой комнаты
   (`this._hostedRoom(session) === msg.roomId`), при
   `msg.epoch === room.epoch`, `Array.isArray(msg.memberIds)`; взять не
   больше `room.maxPlayers * 2` элементов, оставить `isValidMemberId` →
   `this._registry.setConfirmedPeers(roomId, memberIds, this._now())`,
   затем `this._reviewSuccessor(room)`.
2. `RoomRegistry.js`:
   - в `_create` у комнаты поле `peersReportedAt: null`;
   - `setConfirmedPeers(roomId, memberIds, now)`: `room.peersReportedAt = now`;
     каждому участнику `member.peerConfirmed = set.has(member.memberId)`;
   - `joinMember`: `peerConfirmed: existing?.peerConfirmed ?? false`;
   - `promoteHost`: `peersReportedAt = null`, у всех `peerConfirmed = false`
     (новый хост пришлёт свой отчёт);
   - `isConfirmed(room, member)` → `room.peersReportedAt === null ||
member.memberId === room.host.memberId || member.peerConfirmed === true`;
   - `currentPlayers(room, now)` считает живых участников, для которых
     `isConfirmed` истинно.
3. `successor.js` `isCandidate`: добавить условие
   `member.confirmed !== false`. JSDoc поля `confirmed`.
4. Передать `confirmed: this._registry.isConfirmed(room, member)` в
   описания участников: `SignalingServer._reviewSuccessor` (строки
   402-408) и `MigrationCoordinator._pickCandidate` (строки 302-306 и
   ветка беты 288-300 — бета без подтверждения тоже не кандидат).

### 4.2 Голосование по пользователю

`packages/engine/src/master/HostVoteManager.js`:

1. `start`: инициатор `member.userId === room.host.userId` → `reject('host')`;
   участник моложе `minVoterAgeMs` (`now - member.joinedAt`) →
   `reject('tooNew')` (клиент покажет `HOST_VOTE_UNAVAILABLE` — неизвестные
   причины уже так отображаются, `client/lib/hostVoteCommand.js:81-83`).
2. `eligible` — `Set` **userId** живых участников
   (`registry.liveMembers`), кроме пользователя хоста, с непустым
   `userId` и возрастом ≥ `minVoterAgeMs`. `yes`/`no` — тоже по `userId`;
   инициатор голосует «за» своим `userId`.
3. Окно `host_vote` — всем живым сессиям участников, чей `userId` в
   `eligible`, кроме сессии инициатора.
4. `answer(room, memberId, …)`: `userId = room.members.get(memberId)?.userId`;
   учитывать, только если он в `eligible`. Повторный ответ того же
   пользователя (с любой вкладки) меняет его голос.
5. `_evaluate`: из `eligible` убирать пользователей, у которых не осталось
   участника в `room.members`.
6. `eligibleCount`, `yes`, `no` в сообщениях — по пользователям.
7. `config/master.js` `room.vote`: `minVoterAgeMs: 30000`; пробросить в
   `HostVoteManager` (`timings`).

### 4.3 Отчёты `host_unreachable` и кворум по пользователю

`packages/engine/src/master/MigrationCoordinator.js`:

1. `room.reports` — `Map<userId, время>` (обновить комментарий в
   `RoomRegistry._create`). `onUnreachable(room, memberId, epoch)`:
   `userId = room.members.get(memberId)?.userId`; игнорировать `null` и
   пользователя хоста; интервал `REPORT_MIN_INTERVAL_MS` — по `userId`.
2. `_checkQuorum`: `guests` — число **разных** `userId` живых участников,
   кроме пользователя хоста;
   `quorum = Math.max(this._timings.minUnreachableReporters, Math.ceil(guests / 2))`;
   при `guests < minUnreachableReporters` принудительной миграции по
   отчётам нет. `minUnreachableReporters` — `config/master.js`
   `room.minUnreachableReporters: 2`, проброс в `timings`.

### 4.4 «Призраки»: выход из комнаты снимает членство

1. `client/main.js` `handleDisconnect` (строки 1573-1660): в лобби-режиме
   до `currentRoomId = null` — если `currentRoomId && !hostController`,
   `signaling.leaveRoom(currentRoomId)` (best-effort; хост комнату так не
   покидает — его снимает мастер).
2. `SignalingServer.js`: вынести общий метод
   `_leaveMembership(session)` (снять `session.memberOf` из реестра,
   `votes.membersChanged`, `_reviewSuccessor` прежней комнаты) — из
   `_onJoinRoom` (строки 904-910) — и вызывать его в `_onRegisterHost`
   перед `_bindHost`, если `session.memberOf` указывает на другую комнату.

### 4.5 `memberId` привязан к пользователю и сессии (F18)

`SignalingServer.js`:

1. `_onJoinRoom`: если в комнате уже есть участник с этим `memberId` и
   **другим** `userId` → `_sendError(session, 'memberTaken', { re: 'join_room', roomId })`
   и выход. Тот же пользователь (реконнект сигналинга) — как раньше.
2. `_onWebRtcOffer`: `memberId` для хоста —
   `session.memberOf?.roomId === id ? session.memberOf.memberId : (isValidMemberId(memberId) ? memberId : undefined)`.
3. Клиент на `memberTaken` ничего не делает (сообщение в журнал
   `console.warn`): у честной вкладки `memberId` — `crypto.randomUUID()`.

## Тесты (сначала падающие)

- `tests/master/RoomRegistry.test.js`: `setConfirmedPeers`;
  `currentPlayers` с отчётом и без; `promoteHost` сбрасывает подтверждения;
  `joinMember` сохраняет `peerConfirmed`.
- `tests/master/SignalingServer.test.js`: `room_peers` принимается только
  от привязанного хоста и своей эпохи; лишние/битые `memberId`
  отбрасываются; `join_room` с чужим `memberId` другого пользователя →
  `memberTaken`; `register_host` снимает прежнее членство сессии; оффер
  участника несёт его зарегистрированный `memberId`, а не присланный.
- `tests/master/successor.test.js`: `confirmed: false` — не кандидат.
- `tests/master/MigrationCoordinator.test.js`: отчёты двух вкладок одного
  пользователя — один голос кворума; один гость-пользователь не
  запускает `unreachable`; два пользователя из двух-трёх — запускают;
  неподтверждённый участник не выбирается ни бетой, ни холодным
  кандидатом при наличии отчётов хоста.
- `tests/master/HostVoteManager.test.js`: две вкладки одного пользователя
  = один голос и один `eligible`; вторая вкладка пользователя хоста не
  голосует и не начинает; `tooNew`; `eligibleCount` по пользователям.
- `tests/host/HostConnectionManager.test.js`: `connectedMemberIds`.
- `tests/client/network/RoomPeersReporter.test.js` (новый): дебаунс,
  периодичность, без комнаты — молчит, `destroy`.

## Документация (en и ru одинаково)

- `docs/{en,ru}/master.md`: подтверждение участников хостом (`room_peers`),
  счётчик лобби, кандидаты, голосование и кворум по пользователю,
  `memberTaken`, снятие прежнего членства при регистрации.
- `docs/{en,ru}/network.md`: сообщение `room_peers`, ошибка `memberTaken`.
- `docs/{en,ru}/client.md`: `RoomPeersReporter`; `leave_room` при
  разрыве с комнатой.
- `docs/{en,ru}/configuration.md`: `migration.peersReportIntervalMs`,
  `room.vote.minVoterAgeMs`, `room.minUnreachableReporters`.

## CHANGELOG

`[Unreleased]`: уточнить записи `### Added` про голосование «Change host»
(один голос на аккаунт, минимальный стаж участника), про миграцию хоста
(кворум отчётов по аккаунтам, не меньше двух) и про `join_room` /
`leave_room` (хост подтверждает подключённых участников сообщением
`room_peers`; счётчик лобби и кандидаты — только подтверждённые). Новой
записи не заводить.

## Критерии готовности

- Одна учётная запись с N вкладками даёт один голос, один отчёт и не
  раздувает счётчик лобби (при хосте с `room_peers`).
- Вкладка без WebRTC-соединения с хостом не становится бетой.
- Вкладка после кика не числится в комнате.
- Prettier, eslint, vitest — зелёные. Release impact: npm `vimp-engine`,
  уточнение `[Unreleased]`; протокол сигналинга только дополнен.
