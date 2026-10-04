# Этап 3. Офферы во время миграции и привязка ошибок мастера к запросу ✅ выполнен

Находка: **F4** ([review.md](review.md), раздел F4).
Уровень: 🔴 критично. Критерии: работоспособность, тестируемость,
поддерживаемость.

Этап вводит поле `re` в ошибках мастера — на него опираются этапы 6 и 7.

## Проблема

1. `packages/engine/src/master/SignalingServer.js:950-979`
   `_onWebRtcOffer`: код `migrating` (клиент повторит оффер через
   `offerRetryMs`) отдаётся только комнате в `handing_off`. В аварийной
   миграции `MigrationCoordinator.hostLost` сразу отвязывает сессию хоста
   (`_unbindHost`, `master/MigrationCoordinator.js:186`), и любой оффер в
   комнату `migrating` получает `error {code: 'unknownRoom'}`. То же для
   комнаты `online`, чей хост отсоединён и ждёт `reclaim_host`
   (`keepIfNoCandidate`).
2. `packages/engine/src/client/main.js:4204-4211`: на `unknownRoom` при
   `awaitingAnswer === true` вкладка уходит из комнаты
   (`leaveRoomWith('Room no longer exists…')`). `awaitingAnswer`
   (строки 1905, 2175, 2178) ставится на каждую попытку транспорта и
   снимается только на `open`; на `host_migrating` транспорт бросается, а
   флаг остаётся `true`.
3. Ошибки мастера (`_sendError`, строки 1210-1212) — `{type: 'error',
code}` без указания, на какой запрос это ответ и про какую комнату.
   Клиент угадывает контекст по глобальным флагам.

**Сценарий.** Хост закрыл вкладку. Гость замечает обрыв DataChannel
почти одновременно с мастером; супервизор сразу шлёт оффер с `resume`.
Мастер уже отвязал хоста → `unknownRoom` → гость уходит в быструю игру,
хотя через секунды у комнаты новый хост.

## Решение

### 3.1 Ошибки мастера несут `re` и `roomId`

`packages/engine/src/master/SignalingServer.js`:

1. `_sendError(session, code, { re = null, roomId = null, ...extra } = {})`
   → `{ type: 'error', code, ...(re ? { re } : {}), ...(roomId ? { roomId } : {}), ...extra }`.
   JSDoc: `re` — тип сообщения, на которое это ответ; `roomId` —
   комната запроса. Поля только добавляются: старые клиенты читают
   `code`.
2. Все вызовы `_sendError` и прямые `this._send(session, {type: 'error'…})`
   получают `re` (и `roomId`, где он известен):
   - `_onRegisterHost`: `re: 'register_host'`;
   - `_onPromotedRegister`: `re: 'register_host', roomId: msg.roomId`;
   - `_onReclaimHost`: `re: 'reclaim_host', roomId`;
   - `_onJoinRoom`: `re: 'join_room', roomId`;
   - `_onWebRtcOffer`: `re: 'webrtc_offer', roomId: id` (алиас
     `alias: 'unknownHost'` сохранить);
   - `_onPingHost`: `re: 'ping_host'`.
3. `packages/engine/src/master/HostVoteManager.js` (`reject` и
   `noSuccessor`, строки 65-71, 112): добавить `re: 'host_vote_start'`,
   `roomId: room.roomId`.

### 3.2 Оффер в комнату без доступного хоста — `migrating`, а не `unknownRoom`

`SignalingServer._onWebRtcOffer` (строки 950-979) переписать так:

```js
const id = roomId ?? hostId;
const room = this._registry.get(id);
const host = this._getHostSession(id);

// комната жива, но принять оффер сейчас некому: хост сменяется (этапы
// 7–8) или его сигналинг отсоединён и ждёт reclaim_host — гость повторит
// оффер через offerRetryMs, уже к тому, кто будет хостом
if (room && (!host || this._migration.inTransition(room))) {
  this._sendError(session, 'migrating', { re: 'webrtc_offer', roomId: id });
  return;
}

if (!host) {
  // unknownHost — код страниц до этапа 2, оставлен алиасом
  this._sendError(session, 'unknownRoom', {
    re: 'webrtc_offer',
    roomId: id,
    alias: 'unknownHost',
  });
  return;
}
```

`unknownRoom` остаётся только для комнаты, которой нет в реестре. Если
комната так и не получит хоста, мастер закроет её (`room_closed` —
участникам, а следующий оффер получит `unknownRoom`).

### 3.3 WebRtcManager отбрасывает чужие ошибки и сообщает, открыт ли он

`packages/engine/src/client/network/WebRtcManager.js`:

1. `onSignalingError(msg)`: в начало —
   `if (msg?.roomId && msg.roomId !== this._roomId) return;` и
   `if (msg?.re && msg.re !== 'webrtc_offer') return;`.
2. Геттер `get isOpen()` → `this._openChannels === 2 && !this._closed`.

### 3.4 Клиент: решение по `unknownRoom` — чистая функция

Новый модуль `packages/engine/src/client/lib/signalingErrors.js`
(изоморфный, без DOM):

```js
/**
 * Что делать с error {code: 'unknownRoom'} мастера.
 * @param {Object} ctx
 * @param {Object} ctx.msg - сообщение ошибки ({ code, re, roomId }).
 * @param {string|null} ctx.currentRoomId
 * @param {boolean} ctx.promoting - вкладка занимает комнату (hostPromotion).
 * @param {string|null} ctx.sessionState - состояние SessionSupervisor.
 * @param {boolean} ctx.offerPending - текущий транспорт — WebRTC, ещё не открыт.
 * @returns {'abandonPromotion'|'leave'|'ignore'}
 */
export function decideUnknownRoom({ msg, currentRoomId, promoting, sessionState, offerPending }) {
  if (msg.roomId && currentRoomId && msg.roomId !== currentRoomId) return 'ignore';
  if (promoting && (!msg.re || msg.re === 'register_host')) return 'abandonPromotion';
  // комната сменяет хоста: исход решат host_changed / room_closed и таймер
  // миграции супервизора, а не ответ на оффер, ушедший в момент смены
  if (sessionState === 'migrating') return 'ignore';
  if ((!msg.re || msg.re === 'webrtc_offer') && offerPending) return 'leave';
  return 'ignore';
}
```

`ignore` для `re === 'join_room'` — обработка повтора появится в этапе 6.

### 3.5 Клиент: `awaitingAnswer` → состояние текущего транспорта

`packages/engine/src/client/main.js`:

1. Удалить переменную `awaitingAnswer` и все присваивания (строки 1605,
   1905, 2175, 2178). Вместо неё функция
   ```js
   // оффер ушёл, каналы ещё не открыты: unknownRoom в этот момент —
   // комнаты нет
   function offerPending() {
     const transport = supervisor?.transport;
     return transport instanceof WebRtcManager && !transport.isOpen;
   }
   ```
2. `welcome` (строка 4074): `currentRoomId && !offerPending()` (этап 6
   заменит условие на флаг членства).
3. `signaling.publisher.on('error', handleSignalingError)` — обработчик
   принимает сообщение целиком: `function handleSignalingError(msg = {})`,
   `const { code, reason } = msg;`. Ветка `unknownRoom`:
   ```js
   case 'unknownRoom': {
     const action = decideUnknownRoom({
       msg,
       currentRoomId,
       promoting: Boolean(hostPromotion),
       sessionState: supervisor?.state ?? null,
       offerPending: offerPending(),
     });
     if (action === 'abandonPromotion') abandonPromotion({ code, report: true });
     else if (action === 'leave') leaveRoomWith('Room no longer exists. Finding another room…');
     break;
   }
   ```

## Тесты (сначала падающие)

- `tests/master/SignalingServer.test.js`:
  - оффер в комнату `migrating` (хост закрыл WS при живом кандидате) →
    `{type: 'error', code: 'migrating', re: 'webrtc_offer', roomId}`;
  - оффер в `online`-комнату с отсоединённым хостом (WS закрыт, кандидатов
    нет) → `migrating`;
  - оффер в несуществующую → `unknownRoom` с `re`, `roomId`, `alias`;
  - `join_room` в несуществующую → `re: 'join_room'`;
  - ошибки `register_host` / `reclaim_host` несут `re`.
    Существующий тест «оффер в неизвестную комнату — unknownRoom (алиас
    unknownHost)» (строка ~784) дополнить проверкой `re`/`roomId`.
- `tests/master/HostVoteManager.test.js`: `voteRejected` и `noSuccessor`
  несут `re: 'host_vote_start'`.
- `tests/client/network/WebRtcManager.test.js`: ошибка `migrating` чужой
  комнаты и ошибка с `re: 'join_room'` не запускают повтор; `isOpen`.
- `tests/client/lib/signalingErrors.test.js` (новый): все ветки
  `decideUnknownRoom`, в том числе «`migrating` + `offerPending` →
  `ignore`» (регрессия F4).

## Документация (en и ru одинаково)

- `docs/{en,ru}/master.md`: формат ошибок (`re`, `roomId`); оффер в
  комнату, которой сейчас некому ответить, — `migrating`.
- `docs/{en,ru}/network.md`: таблица ошибок сигналинга.
- `docs/{en,ru}/client.md`: как клиент решает по `unknownRoom`
  (`client/lib/signalingErrors.js`).

## CHANGELOG

`[Unreleased]` → `### Added`, запись о миграции хоста (подпункт о гостях):
оффер в комнату, которая меняет хоста или ждёт возврата хоста,
отклоняется кодом `migrating` и повторяется; ошибки сигналинга несут `re`
и `roomId`. Новой записи не заводить.

## Критерии готовности

- Гость, отправивший оффер в момент аварийной миграции, остаётся в
  комнате и возвращается к новому хосту.
- В `main.js` нет `awaitingAnswer`.
- Prettier, eslint, vitest — зелёные. Release impact: npm `vimp-engine`,
  уточнение `[Unreleased]`.
