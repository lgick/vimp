# Этап 6. Членство гостя после рестарта мастера ✅ выполнен

Находка: **F9** ([review.md](review.md), раздел F9).
Уровень: 🟠 важно. Критерии: работоспособность.

Зависит от этапа 3 (поле `re` в ошибках мастера).

## Проблема

Каждый push в `main` деплоит и рестартует мастер. Реестр комнат в памяти
пуст, пока хост не вернёт комнату `reclaim_host`.

- `packages/engine/src/client/main.js:4069-4082`: на `welcome` гость шлёт
  `join_room` один раз и только при `!awaitingAnswer` (после этапа 3 —
  `!offerPending()`).
- `packages/engine/src/master/SignalingServer.js:896-901`: комнаты ещё нет
  → `error {code: 'unknownRoom', re: 'join_room'}`.
- Клиент (`handleSignalingError`) повторять `join_room` не умеет
  (`room_joined` клиент вообще не слушает).

**Итог.** Гость, чей сигналинг переподключился раньше хоста, играет по
P2P, но мастер его не знает: не считает в лобби, не делает бетой, не даёт
голосовать. Если хост потом уйдёт, `hostLost` увидит комнату без людей и
закроет её — гости вылетят в быструю игру. Гость, который в момент
`welcome` переподключал WebRTC, `join_room` не шлёт вовсе.

## Решение

### 6.1 Флаг членства вместо состояния транспорта

`client/main.js`:

1. Переменная `let memberJoined = false;` рядом с `currentRoomId`
   (строка ~1836), комментарий: вкладка объявила мастеру членство
   (`join_room`) и должна повторять его после реконнекта сигналинга.
2. `memberJoined = true` там, где гость шлёт `join_room`: после
   `AUTH_RESULT` (строки 682-689) и в `demoteHost` (строка 3003).
3. `memberJoined = false` там, где вкладка покидает комнату или
   становится хостом: `handleDisconnect` (рядом с `currentRoomId = null`,
   строка 1604), `leaveServer`, `adoptHostRole`.
4. `welcome` (строки 4069-4082): `else if (currentRoomId && memberJoined)`.

### 6.2 Повтор `join_room`, пока комната не вернулась

Новый модуль `packages/engine/src/client/lib/JoinRetry.js` (без DOM,
таймеры инъектируются):

```js
/**
 * Повтор join_room на unknownRoom: после рестарта мастера комната
 * появляется, только когда хост вернёт её reclaim_host.
 * @param {Object} opts
 * @param {Function} opts.send - () отправить join_room.
 * @param {number[]} [opts.delaysMs] - задержки попыток.
 * @param {number} [opts.windowMs] - сколько всего пытаться.
 * @param {Object} [opts.timers] - { setTimeout, clearTimeout }.
 * @param {Function} [opts.now]
 */
export default class JoinRetry {
  schedule() {
    /* следующая попытка, если окно не истекло */
  }
  stop() {
    /* снять таймер и сбросить окно */
  }
}
```

- Задержки по умолчанию `[1000, 2000, 4000, 8000, 8000, 8000]`, окно —
  `lobbyConfig.session.joinRetryWindowMs` = 30000 (больше
  `master.room.hostReclaimGraceMs` 10 с с запасом на бэкофф сигналинга
  хоста). Окно отсчитывается от первого `schedule()` после `stop()`.
- `client/main.js`:
  - экземпляр создаётся в лобби-режиме, `send` — тот же
    `signaling.joinRoom({ roomId: currentRoomId, memberId, token, caps })`;
  - в `handleSignalingError`, `case 'unknownRoom'`: если
    `msg.re === 'join_room'` и `msg.roomId === currentRoomId`, вкладка не
    хост (`!hostController`), `memberJoined` и супервизор не закрыт
    (`supervisor?.state !== 'closed'`) → `joinRetry.schedule()`;
    `decideUnknownRoom` (этап 3) для `re: 'join_room'` уже возвращает
    `ignore` — добавить ветку до него;
  - новая подписка `signaling.publisher.on('room_joined', msg => { if (msg.roomId === currentRoomId) joinRetry.stop(); })`;
  - `joinRetry.stop()` в `handleDisconnect`, `leaveServer`, `adoptHostRole`,
    на `room_closed`.
- Окно истекло, а комната так и не появилась — ничего не делать: P2P-матч
  может жить; уход решат транспорт и супервизор.

## Тесты (сначала падающие)

- `tests/client/lib/JoinRetry.test.js` (новый): попытки по задержкам;
  после окна — тишина; `stop()` снимает таймер и обнуляет окно; повторный
  `schedule()` во время ожидания не плодит таймеры.
- `tests/client/lib/signalingErrors.test.js` (из этапа 3): если ветка
  решения о повторе вынесена туда — её случаи.
- `tests/master/SignalingServer.test.js`: сценарий рестарта — гость шлёт
  `join_room` до `reclaim_host` (ошибка `unknownRoom`, `re: 'join_room'`),
  после `reclaim_host` повторный `join_room` делает его участником, он
  попадает в `currentPlayers` и в кандидаты.

## Документация (en и ru одинаково)

- `docs/{en,ru}/client.md`: членство гостя после реконнекта сигналинга и
  рестарта мастера (`memberJoined`, `JoinRetry`).
- `docs/{en,ru}/master.md`: что видит гость, пока комната не возвращена
  (`unknownRoom` на `join_room`, повтор).
- `docs/{en,ru}/configuration.md`: `session.joinRetryWindowMs`.

## CHANGELOG

`[Unreleased]` → `### Added`, запись про `join_room` / `leave_room`:
гость повторяет `join_room`, пока комнату после рестарта мастера не
вернул хост. Новой записи не заводить.

## Критерии готовности

- После рестарта мастера все гости комнаты снова её участники (проверка
  тестом мастера + ручная: рестарт dev-мастера при открытом матче на
  двух вкладках → `GET /servers` показывает 2 игрока).
- Prettier, eslint, vitest — зелёные. Release impact: npm `vimp-engine`,
  уточнение `[Unreleased]`.
