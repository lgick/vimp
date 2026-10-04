# Этап 9. Ожидание гостей и согласованность таймингов клиента и мастера ✅ выполнен

Находка: **F12** ([review.md](review.md), раздел F12).
Уровень: 🟡 качество. Критерии: работоспособность, поддерживаемость,
тестируемость.

## Проблема

1. **Гости сдаются раньше мастера.** Гость ждёт `host_changed` не дольше
   `session.migrationWaitMs` = 40 с (`config/lobby.js:248-255`,
   `client/network/SessionSupervisor.js:274-299`). Мастер на каждого
   кандидата даёт `promotionTimeoutMs` (10 с) или
   `coldPromotionTimeoutMs` (25 с) (`master/MigrationCoordinator.js:239-276`).
   Цепочка «бета с точкой + два холодных» = 60 с > 40 с: гости уходят в
   быструю игру, пока комната ещё ищет хоста. Повторный `migrate()` при
   идущей миграции ничего не продлевает. То же ограничение у ожидания
   комнаты по ссылке (`client/main.js:3906-3938` `waitRoomOnline`).
2. **Связки таймингов не проверяются.** В комментариях записано, но ничем
   не гарантировано:
   - `lobby.migration.handoffDeadlineMs` (10 000) >
     `master.room.handoffTimeoutMs` (8000);
   - `master.room.checkpointMaxAgeMs` (12 000) ≥
     2 × `lobby.migration.standbyStatusIntervalMs` (5000);
   - `lobby.session.migrationWaitMs` ≥ сумма дедлайнов промоушена;
   - `lobby.session.reconnectWindowMs` (15 000) <
     `hostDefaults.resumeGraceMs` (20 000).
3. **Сторожок тишины против ожидания восстановленного матча.**
   `hostDefaults.resumeWaitMs` = 3000 равен `session.hostSilenceMs` = 3000.
   Гость, первым вернувшийся к новому хосту, до старта матча (хост ждёт
   остальных до `resumeWaitMs`) не получает ни кадров, ни пингов почти
   столько же, сколько сторожок считает смертью транспорта.

## Решение

### 9.1 Мастер сообщает гостям, сколько ждать

`packages/engine/src/master/MigrationCoordinator.js`:

1. Новый тайминг `migrationNoticeMarginMs` (по умолчанию 5000;
   `config/master.js` → `room.migrationNoticeMarginMs`, проброс в
   `timings` в `master/lobby.js`).
2. Перенести рассылку `host_migrating` из `hostLost` (строки 189-198) в
   `_promoteNext`: перед отправкой `promote` очередному кандидату —
   ```js
   this._broadcast(
     room,
     {
       type: 'host_migrating',
       roomId: room.roomId,
       epoch: room.pendingEpoch,
       reason: migration.reason,
       // сколько гостям ждать host_changed: дедлайн этой попытки с запасом
       waitMs: timeout + this._timings.migrationNoticeMarginMs,
     },
     [migration.oldHostMemberId],
   );
   ```
   (кандидат тоже получает — его супервизор в аварии бросает транспорт к
   мёртвому хосту; плановая передача шлёт свой `host_migrating` в
   `beginHandoff`, там бета исключена — этап 2). Для первой попытки
   поведение то же, для следующих — повтор с новым `waitMs`.
3. `beginHandoff` (строки 629-638): `waitMs: handoffTimeoutMs + margin`;
   `_degradeHandoff` (815-844): повторить `host_migrating` гостям (кроме
   беты и старого хоста) с `waitMs: promotionTimeoutMs + margin`.

### 9.2 Клиент продлевает ожидание

`packages/engine/src/client/network/SessionSupervisor.js`:

1. `migrate({ keepTransport, waitMs } = {})`: таймер миграции —
   `Math.max(this._migrationWaitMs, clampWait(waitMs))`, где `clampWait` —
   конечное число в `[0, 120000]`, иначе 0.
2. Новый метод `extendMigration(waitMs)`: в состоянии `migrating`
   перезапускает таймер на `max(осталось, clampWait(waitMs))`; иначе
   ничего. Возвращает `true`, если продлил.

`client/main.js`, обработчик `host_migrating` (строки 4087-4098):
`if (supervisor?.state === 'migrating') supervisor.extendMigration(msg.waitMs); else supervisor?.migrate({ waitMs: msg.waitMs });`
(проверка эпохи — как сейчас; повтор приходит с той же `pendingEpoch`).

`waitRoomOnline` (строки 3906-3938): крайний срок —
`lobbyConfig.session.linkWaitMaxMs` (новый ключ, 90 000); пока
`GET /rooms/:roomId` отвечает `status: 'migrating' | 'handing_off'`,
опрос продолжается до этого срока.

### 9.3 Тест связок таймингов

Новый `tests/config/migrationTimings.test.js`: импортирует
`packages/engine/src/config/lobby.js`, `config/master.js`,
`config/hostDefaults.js` (default-экспорты) и проверяет:

- `lobby.migration.handoffDeadlineMs > master.room.handoffTimeoutMs`;
- `master.room.checkpointMaxAgeMs >= 2 * lobby.migration.standbyStatusIntervalMs`;
- `lobby.session.migrationWaitMs >= master.room.promotionTimeoutMs + master.room.coldPromotionTimeoutMs`;
- `lobby.session.reconnectWindowMs < hostDefaults.resumeGraceMs`;
- `lobby.migration.maxRestoreAgeMs >= master.room.checkpointMaxAgeMs`
  (ключ из этапа 5; если этап 5 ещё не сделан — пропустить строку);
- `lobby.session.resumeSilenceGraceMs >= hostDefaults.resumeWaitMs` (9.4).

Каждая проверка — отдельный `it` с объяснением, что ломается при
нарушении.

### 9.4 Сторожок тишины даёт фору восстановленному матчу

`SessionSupervisor`:

1. Тайминг `resumeSilenceGraceMs` (`config/lobby.js` →
   `session.resumeSilenceGraceMs`, по умолчанию 3000 — не меньше
   `hostDefaults.resumeWaitMs`).
2. После успешного `resumeResult` — `_awaitingFrame = true`;
   `_checkSilence` использует `silenceMs + resumeSilenceGraceMs`, пока
   `_awaitingFrame`.
3. Метод `noteFrame()` снимает `_awaitingFrame`. `client/main.js`
   `handleMessage` (строки 1551-1566) зовёт `supervisor?.noteFrame()` на
   бинарный кадр.

## Тесты (сначала падающие)

- `tests/master/MigrationCoordinator.test.js`: каждая попытка промоушена
  рассылает `host_migrating` с `waitMs` (10 000 + 5000 для `checkpoint`,
  25 000 + 5000 для `cold`); `_degradeHandoff` рассылает гостям, кроме
  беты; `beginHandoff` несёт `waitMs`.
- `tests/client/network/SessionSupervisor.test.js`: `migrate({ waitMs: 60000 })`
  держит ожидание 60 с; `extendMigration` продлевает, но не укорачивает;
  мусорный `waitMs` игнорируется; после resume без кадров сторожок
  срабатывает только после `silenceMs + resumeSilenceGraceMs`;
  `noteFrame()` возвращает обычный порог.
- `tests/config/migrationTimings.test.js` — новый.

## Документация (en и ru одинаково)

- `docs/{en,ru}/master.md`, `docs/{en,ru}/network.md`: `host_migrating`
  приходит на каждую попытку промоушена, поле `waitMs`.
- `docs/{en,ru}/client.md`: ожидание гостя продлевается мастером; фора
  сторожка после возобновления; ожидание комнаты по ссылке.
- `docs/{en,ru}/configuration.md`: `room.migrationNoticeMarginMs`,
  `session.linkWaitMaxMs`, `session.resumeSilenceGraceMs`; у связанных
  ключей — ссылка на тест связок.

## CHANGELOG

`[Unreleased]` → `### Added`, запись о миграции хоста: гости ждут смены
хоста столько, сколько мастер ещё ищет преемника (`host_migrating.waitMs`).
Новой записи не заводить.

## Критерии готовности

- При цепочке из нескольких кандидатов гости дожидаются нового хоста.
- Тест связок таймингов зелёный и падает при нарушении любой связки.
- Prettier, eslint, vitest — зелёные. Release impact: npm `vimp-engine`,
  уточнение `[Unreleased]`.
