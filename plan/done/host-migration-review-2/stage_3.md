# Этап 3. Голосуют только подтверждённые; чужой `memberId` в оффере; одна вкладка — одно членство ✅ выполнен

Находки: **N3**, **N4** ([review.md](review.md#n3--голосуют-участники-которых-хост-не-подтвердил-остаток-f5),
[N4](review.md#n4--чужой-memberid-в-оффере-не-участника-дыры-одна-вкладка--одно-членство-остаток-f18f7)).
Уровень: 🔵 безопасность (N3), 🟡 качество (N4). Критерии: безопасность,
работоспособность.

Делать после этапа 2 (тот же `SignalingServer.js`).

## Проблема

### N3 — голосование «Change host»

`packages/engine/src/master/HostVoteManager.js`:

- `start()` (строки ~97-98): `if (!this._isVoter(room, member, now))
return reject('tooNew');`
- eligible (строки ~139-142): `liveMembers(...).filter(live =>
this._isVoter(room, live, now))`
- `_isVoter` (строки ~418-426) проверяет только: `userId` не `null`, не
  пользователь хоста, в комнате ≥ `minVoterAgeMs`.

Подтверждение хостом (`RoomRegistry.isConfirmed(room, member)`: отчёт
`room_peers` содержит участника, или хост отчётов не шлёт, или это сам
хост) не проверяется. Сигнальная сессия без WebRTC-пира (фантом) с
валидным токеном через 30 с начинает голосование и голосует. Два
аккаунта-фантома в комнате «хост + 1 гость» дают 2 из 3 «за»: хост снят,
откат у всех, повтор раз в 2 мин.

### N4 — членство и `memberId`

`packages/engine/src/master/SignalingServer.js`:

1. `_onWebRtcOffer` (строки ~1086-1099): если сессия не участник этой
   комнаты, хосту уходит присланный `memberId` после проверки только
   формата — в том числе `memberId` другой **живой** сессии комнаты
   (беты, хоста). Хост по нему отдаёт канал `standby`
   (`HostConnectionManager.peerConnectionOf` — первый открытый пир с этим
   id) и подтверждает участника в `room_peers`.
2. `_onJoinRoom` (строка ~1007): `this._leaveMembership(session, roomId)`
   снимает только членство в **другой** комнате; та же сессия с другим
   `memberId` в той же комнате оставляет старую запись, привязанную к
   живой сессии.
3. `_onJoinRoom` от сессии, которая сама хостит комнату, удаляет **запись
   хоста в его комнате** (`_leaveMembership` не знает, что сессия — хост).
4. `_onReclaimHost` (перед `_bindHost`, строка ~837) не снимает прежнее
   членство сессии в чужой комнате; `register_host` (этап 4 прошлого
   плана) — снимает.

## ⚠️ Подтвердить у разработчика до начала

1. **Причина отказа инициатору-фантому.** **(рекомендуется)** новая
   причина `voteRejected { reason: 'notConnected' }`: клиент
   (`client/lib/hostVoteCommand.js`, `rejectionMessageKey`) неизвестную
   причину показывает общим `HOST_VOTE_UNAVAILABLE` — новых текстов в играх
   не нужно. Альтернатива — переиспользовать `tooNew` (меньше в доках,
   но причина в журнале неверная).
2. **`host_unreachable`.** **(рекомендуется)** отчёты о недоступном хосте
   по подтверждению **не** фильтровать: гость с порванным P2P к моменту
   отчёта обычно уже выпал из `room_peers`, а принудительная миграция и так
   требует ≥ `minUnreachableReporters` (2) разных аккаунтов. Альтернатива —
   принимать отчёт только от участника, подтверждённого хотя бы раз в
   текущей эпохе (новое поле участника, сброс в `promoteHost`).
3. **Оффер с `memberId` отсоединённого участника** (запись в grace,
   `sessionId === null`). **(рекомендуется)** пересылать как есть: это
   обычный реконнект — оффер с `resume` может обогнать повторный
   `join_room` (тот ждёт проверки токена). Альтернатива — не пересылать
   (сломает передачу `standby` вернувшейся бете до следующего оффера).

Согласованное вписать сюда в раздел «Согласовано» до правки кода.

## Согласовано

Согласовано с разработчиком 2026-10-05 — все три пункта по рекомендованному
варианту:

1. Инициатор-фантом получает новую причину
   `voteRejected { reason: 'notConnected' }` (клиент показывает её общим
   `HOST_VOTE_UNAVAILABLE`).
2. Отчёты `host_unreachable` по подтверждению **не** фильтруются; в
   `docs/*/master.md` записано, что так задумано, и почему.
3. Оффер с `memberId` отсоединённого участника (grace,
   `sessionId === null`) пересылается хосту как есть.

## Решение

### 3.1 Голосуют только подтверждённые (N3)

`HostVoteManager.js`:

1. `_isVoter(room, member, now)` — добавить условие
   `this._registry.isConfirmed(room, member)` (поле `this._registry` уже
   есть — `deps.registry`). Комментарий: «…и подключённый к хосту
   (`room_peers`): сигнальная сессия без пира не голосует».
2. `start()`: **перед** проверкой `tooNew` вставить

   ```js
   // сигнальная сессия без WebRTC-пира к хосту (фантом) голосование не
   // начинает
   if (!this._registry.isConfirmed(room, member)) {
     return reject('notConnected'); // или 'tooNew' — по решению п. 1
   }
   ```

3. `answer()` не меняется: голос принимается от пользователя из
   `eligible`, а `eligible` теперь без фантомов.
4. Шапка класса (строки 1-12): «…голосует только пробывший в комнате
   minVoterAgeMs и подтверждённый хостом участник».

`host_unreachable` (`MigrationCoordinator.onUnreachable`) — по решению
п. 2 (рекомендуемый вариант: без изменений; в `docs/*/master.md` записать,
что так задумано, и почему).

### 3.2 `memberId` в оффере (N4.1)

`SignalingServer.js`, новый приватный метод и его вызов в
`_onWebRtcOffer` вместо текущего тернарного выражения `memberId: …`:

```js
// memberId пира для хоста: участник комнаты — только свой
// зарегистрированный; не участник (первый оффер идёт до join_room) —
// присланный, если он не принадлежит другой живой сессии комнаты: иначе
// хост принял бы этот пир за неё (канал standby, room_peers)
_offerMemberId(session, room, roomId, memberId) {
  if (session.memberOf?.roomId === roomId) {
    return session.memberOf.memberId;
  }

  if (!isValidMemberId(memberId)) {
    return undefined;
  }

  const holder = room?.members.get(memberId);

  return holder && holder.sessionId !== null && holder.sessionId !== session.id
    ? undefined
    : memberId;
}
```

(вариант для отсоединённого владельца — по решению п. 3; рекомендуемый
записан выше.)

### 3.3 Одна вкладка — одно членство (N4.2–N4.4)

`SignalingServer.js`:

1. `_onJoinRoom`, сразу после `if (!isValidMemberId(memberId)) return;`:

   ```js
   // хост — участник своей комнаты через register_host; join_room от его
   // сессии снял бы запись хоста в собственной комнате
   if (this._hostedRoom(session)) {
     return;
   }
   ```

2. `_onJoinRoom`, вместо `this._leaveMembership(session, roomId);`:

   ```js
   // одна вкладка — одно членство: другая комната или другой memberId той
   // же сессии снимают прежнюю запись
   if (
     session.memberOf &&
     (session.memberOf.roomId !== roomId || session.memberOf.memberId !== memberId)
   ) {
     this._leaveMembership(session);
   }
   ```

   Проверка `memberTaken` остаётся выше этого места без изменений.

3. `_onReclaimHost`, перед `this._bindHost(session, room);` (строка ~837):
   `this._leaveMembership(session, roomId);` — как в `_onRegisterHost`.

## Тесты (сначала падающие)

`tests/master/HostVoteManager.test.js` (хелперы файла: `advance`, `join`,
`joinTab`, `setupRoom`, `setupVoteRoom`; отчёт хоста `room_peers` — как в
`describe('room_peers …')` около строки 1076):

1. «фантом (нет в room_peers) не начинает голосование»: хост прислал
   `room_peers` с одним гостем A; второй аккаунт B вошёл `join_room`,
   `advance(minVoterAgeMs)`; B шлёт `host_vote_start` → `error {
code: 'voteRejected', reason: 'notConnected' }` (или `tooNew` по
   решению п. 1), голосования нет.
2. «фантом не в eligible»: A (подтверждён) начинает голосование → B не
   получает окна `host_vote`; `host_vote_result.eligibleCount === 1`
   (поле итога — как в существующих тестах); `host_vote_answer` от B
   игнорируется.
3. «хост без room_peers — голосуют все, как раньше»: без отчёта хоста B
   начинает голосование (совместимость со старым хостом).

`tests/client/lib/hostVoteCommand.test.js`:

4. `rejectionMessageKey({ code: 'voteRejected', reason: 'notConnected' })`
   → `'HOST_VOTE_UNAVAILABLE'` (закрепить фолбэк; не падающий — фиксирует
   контракт).

`tests/master/SignalingServer.test.js` (хелперы `connect`, `connectHost`,
`joinRoom`, `signToken`, `memberIdOf`, `flushAsync`, `typed`):

5. «оффер не-участника с memberId живого участника уходит хосту без
   memberId»: гость A вошёл (`join_room`), его сессия жива; другая сессия
   (не участник) шлёт `webrtc_offer { roomId, memberId: <A>, sdp }` →
   хост получает `webrtc_offer` с `memberId: undefined`.
6. «оффер не-участника со свободным memberId пересылается как есть»
   (регрессия первого оффера до `join_room`).
7. «оффер с memberId отсоединённого участника пересылается» (решение
   п. 3): A вошёл, его WS закрыт (`ws.drop()` / `handlers.close()`), новая
   сессия шлёт оффер с `memberId: <A>` → хост получает `memberId: <A>`.
8. «join_room той же сессией с другим memberId снимает прежнюю запись»:
   после второго `join_room` в `room.members` только новый `memberId`.
9. «join_room от сессии хоста игнорируется»: сессия хоста комнаты X шлёт
   `join_room` в комнату Y → запись хоста в X цела, в Y хоста нет, ответа
   `room_joined` нет.
10. «reclaim_host снимает членство сессии в чужой комнате»: сессия
    вошла гостем в комнату Y (`join_room`), затем шлёт `reclaim_host` своей
    комнаты X → в Y её записи нет.

Проверить, что тесты 1, 2, 5, 8, 9, 10 падают до правки кода.

## Документация

`docs/en/master.md` + зеркало `docs/ru/master.md`:

- раздел «Change host vote» (около строк 1110-1120): голосует и начинает
  голосование только участник, которого хост подтвердил (`room_peers`; хост
  без отчётов — все, как раньше); причина отказа `notConnected`;
- таблица сообщений, строка `host_vote_start` (около строки 761): список
  причин `voteRejected` дополнить `notConnected`;
- абзац про `memberId` (около строк 812-818, «A `memberId` belongs to its
  user …»): оффер не может назваться `memberId` другой живой сессии комнаты
  (хост получает оффер без `memberId`); одна сессия — одно членство (новый
  `memberId` той же сессии снимает прежнюю запись); сессия хоста
  `join_room` не шлёт (игнорируется); `reclaim_host` снимает прежнее
  членство, как `register_host`;
- раздел об отчётах `host_unreachable` (кворум): одна фраза, что отчёты по
  подтверждению не фильтруются намеренно, и почему (решение п. 2).

## CHANGELOG

`## [Unreleased]`:

- запись о голосовании «Change host» (строки ~286-288 файла: «… one vote
  per account …, for at least `minVoterAgeMs` (30 s; `voteRejected` reason
  `tooNew`)»): дописать «… and only members the host confirms as connected
  (`room_peers`; reason `notConnected`)»;
- запись `join_room`/`leave_room` («A `memberId` belongs to its user
  (`join_room` with another user's is refused with `memberTaken`) …»):
  дописать «, an offer cannot claim the `memberId` of another live member,
  and a tab holds one membership (a new `memberId` replaces the old one;
  `reclaim_host` leaves the previous room too)».

## Критерии готовности

- Тесты этапа зелёные, новые до правки падали (кроме 3, 4, 6, 7).
- prettier, `npx eslint .`, `npx vitest run --reporter=dot` — зелёные.
- Доки en/ru и CHANGELOG обновлены; раздел «Согласовано» заполнен.
- Этап помечен «✅ выполнен» здесь и в `README.md`.

## Release impact

npm `vimp-engine` (мастер), уточнение `[Unreleased]`. Протокол только
дополнен (новая причина отказа). Игры: новых системных сообщений нет —
причину показывает существующий `HOST_VOTE_UNAVAILABLE`. Крейт,
`create-vimp-game`, auth не затронуты.
