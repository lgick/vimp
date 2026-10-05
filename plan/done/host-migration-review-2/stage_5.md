# Этап 5. Окно повтора `join_room`, шум журнала прогрева, устаревшие комментарии ✅ выполнен

Находки: **N6**, **N7**, **N8** ([review.md](review.md#n6--окно-повтора-join_room-впритык-к-бэкоффу-сигналинга-хоста)).
Уровень: 🟡 качество. Критерии: работоспособность, документированность,
тестируемость.

## Проблема

### N6 — окно повтора `join_room`

После рестарта мастера реестр пуст, комнату возвращает только
`reclaim_host` хоста. Его сигналинг переподключается с бэкоффом до
`lobbyConfig.reconnect.maxDelay` = 30 000 мс
(`packages/engine/src/config/lobby.js:176-179`). Гость, подключившийся
сразу, повторяет `join_room` (`client/lib/JoinRetry.js`, задержки 1, 2, 4,
8, 8, 8 с) в окне `session.joinRetryWindowMs` = 30 000 мс (строка ~294):
последняя попытка — через 31 с после первого `unknownRoom`. Хост, который
проспал полный бэкофф, должен успеть подключиться и пройти проверку токена
в auth меньше чем за ~1 с — иначе гость остаётся вне комнаты (F9). Комментарий
конфига (строки ~282-284) и `docs/*/configuration.md` связывают окно с
`room.hostReclaimGraceMs` — она к рестарту мастера отношения не имеет
(реестр пуст). `tests/config/migrationTimings.test.js` эту пару не проверяет.

### N7 — журнал прогрева

`client/network/HostPrewarm.js`, `warm()` (строки ~99-136): точка без
`room.game`, нераспаковываемая или чужой игры вызывает `this._onError(...)`
на **каждую** точку; `client/session/StandbyRole.js:176` пишет
`console.warn('[standby] prewarm failed:', error)` — дважды в секунду, пока
хост шлёт такие точки.

### N8 — устаревшие комментарии

- `packages/engine/src/lib/createHostRuntime.js:165-167`: «(prepareHostRoom
  в client/main.js)» — функция теперь в `client/session/hostRoomPrep.js`.
- `packages/engine/src/lib/roomSettings.js:1-3`: «передаёт в connectAsHost»
  — теперь `HostRole.createRoom` (`client/session/HostRole.js`).

## ⚠️ Подтвердить у разработчика до начала

1. **Новое значение `session.joinRetryWindowMs`.** **(рекомендуется)**
   45 000 мс — покрывает полный бэкофф хоста (30 с) с запасом 15 с на
   подключение и `reclaim_host`. Альтернатива — 60 000 мс (больше запас,
   дольше бессмысленные повторы в комнату, которая не вернётся). Задержки
   `JoinRetry` не меняются.

Согласованное вписать сюда в раздел «Согласовано» до правки кода.

## Согласовано

1. `session.joinRetryWindowMs` = **45 000 мс** (2026-10-05, разработчик). Задержки
   `JoinRetry` не меняются.

## Решение

### 5.1 `joinRetryWindowMs` (N6)

1. `packages/engine/src/config/lobby.js`: `joinRetryWindowMs: 45000` (по
   решению п. 1). В комментарии блока `session` фразу «(больше
   master.room.hostReclaimGraceMs с запасом на бэкофф сигналинга хоста)»
   заменить на «(больше reconnect.maxDelay — бэкоффа сигналинга хоста — с
   запасом на его reclaim_host)».
2. `tests/config/migrationTimings.test.js` — новая связка:

   ```js
   it('joinRetryWindowMs гостя покрывает бэкофф сигналинга хоста', () => {
     // после рестарта мастера комнату возвращает только reclaim_host
     // хоста, а его сигналинг переподключается не позже reconnect.maxDelay;
     // запас — на подключение и проверку токена
     expect(lobby.session.joinRetryWindowMs).toBeGreaterThanOrEqual(
       lobby.reconnect.maxDelay + 10000,
     );
   });
   ```

   Тест сначала падает (30 000 < 40 000), после правки конфига — зелёный.

### 5.2 Журнал прогрева без повторов (N7)

`client/network/HostPrewarm.js`:

1. Новое поле в конструкторе: `this._rejectedKey = null;` с комментарием
   «последний отказ точке: та же причина на следующих точках (2 раза в
   секунду) в журнал не идёт».
2. Приватный метод:

   ```js
   // отказ точке — в журнал один раз на причину: хост шлёт точки дважды
   // в секунду, а состояние прогрева от отказа не меняется
   _reject(key, error) {
     if (key === this._rejectedKey) {
       return;
     }

     this._rejectedKey = key;
     this._onError?.(error);
   }
   ```

3. В `warm()` три отказа точке заменить на `_reject`:
   - ошибка распаковки → `this._reject('decode', e)`;
   - нет `room.game` → `this._reject('noGame', new Error('checkpoint has no room.game'))`;
   - чужая игра → ``this._reject(`foreign:${gameRef.id}@${gameRef.version}`, new Error('checkpoint game is not the room game'))``.
4. Точка прошла проверки (сразу после `isConfirmedGame`) —
   `this._rejectedKey = null;`.
5. `_fail()` (провал самого прогрева) не трогать: он и так один раз на
   версию (`_failedKey`).

### 5.3 Комментарии (N8)

- `lib/createHostRuntime.js:165-167`: «(prepareHostRoom в
  client/session/hostRoomPrep.js)».
- `lib/roomSettings.js:1-3`: «то, что форма создания комнаты передаёт в
  HostRole.createRoom (client/session/HostRole.js) и что читает
  lib/applyRoomOverrides.js».

## Тесты

1. `tests/config/migrationTimings.test.js` — п. 5.1.2 (падает до правки
   конфига).
2. `tests/client/network/HostPrewarm.test.js` (по образцу существующих
   тестов «чужая игра» / «точка без room.game»):
   - «отказ одной и той же причины пишется один раз»: две подряд точки
     чужой игры → `onError` вызван один раз;
   - «после годной точки отказ снова пишется»: чужая → годная → чужая →
     `onError` вызван два раза;
   - «разные причины пишутся каждая»: без `room.game` → чужая игра → два
     вызова.
     Первые два падают до правки.

## Документация

- `docs/en/configuration.md` (около строки 626, `joinRetryWindowMs`) и
  `docs/ru/configuration.md` (блок `session`): значение 45 000 и
  обоснование «больше `reconnect.maxDelay` (бэкофф сигналинга хоста) с
  запасом на `reclaim_host`; связку проверяет
  `tests/config/migrationTimings.test.js`» вместо упоминания
  `room.hostReclaimGraceMs`.
- `docs/en/client.md` (около строки 397) и `docs/ru/client.md` (абзац
  «Членство в комнате»): «(30 s)» / «(30 с)» → «(45 s)» / «(45 с)».
- `docs/en/master.md` (около строки 844) и `docs/ru/master.md` (около
  строки 818): «30 s on the client» / «30 с на клиенте» → 45.
- `docs/en/host.md`/`docs/ru/host.md` — если в описании прогрева
  (`HostPrewarm`) сказано про `onError` на негодную точку, дописать «один
  раз на причину»; иначе не трогать.

## CHANGELOG

Не меняется: запись `join_room`/`leave_room` в `[Unreleased]` называет
ключ `lobbyConfig.session.joinRetryWindowMs` без значения; журнал и
комментарии — не записи.

## Критерии готовности

- Тесты этапа зелёные, перечисленные до правки падали.
- prettier, `npx eslint .`, `npx vitest run --reporter=dot` — зелёные.
- Доки en/ru обновлены; раздел «Согласовано» заполнен.
- Этап помечен «✅ выполнен» здесь и в `README.md`.

## Release impact

npm `vimp-engine` (клиентский конфиг и прогрев), без новой записи
CHANGELOG (уточнение невыпущенного значения). Игры, крейт,
`create-vimp-game`, auth не затронуты.
