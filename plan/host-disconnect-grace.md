# План: выдержка перед миграцией при обрыве сигналинга хоста (D2)

Основание — пункт **D2** раздела «На решение разработчика» в
`plan/done/host-migration-review/review.md`. Решение разработчика
(2026-10-07): выдержка **2000 мс** + вкладка-хост делает первую попытку
переподключения сигналинга **сразу** (0 мс).

> **Как исполнять.** План самодостаточен: всё нужное — ниже. Репозиторий
> `/Users/dmitry/Sites/my/vimp`, пути — от его корня; исходники движка —
> `packages/engine/src/`, тесты — `tests/` (зеркально `src/`). Коммитов не
> делать, `version` не трогать, файлы с префиксом `_` не читать. Шаг
> помечается «✅ выполнен» в своём заголовке. Всё, что меняет наблюдаемое
> поведение и не зафиксировано здесь, — согласовать с разработчиком
> **до** кода (вопрос по-русски, варианты, рекомендуемый помечен).

## Контекст

Сейчас закрытие WebSocket хоста на мастере **сразу** запускает аварийную
миграцию (решение 7.0 плана `plan/done/host-migration/stage_7.md`: «хост не
приоритетен»). Короткий обрыв одного сигналинга (Wi-Fi, прокси, сон
ноутбука на секунду) у живого хоста почти всегда проигрывает гонку
прогретой бете: мастер шлёт гостям `host_migrating`, гости рвут P2P с
хостом, бета поднимает матч из контрольной точки — откат мира на интервал
точек у всех, хотя P2P-матч был цел. Возврат хоста через `reclaim_host` до
регистрации беты миграцию отменяет (`host_changed { mode: 'reclaimed' }`),
но гости к этому моменту уже бросили транспорт и переподключаются.

Цель: мастер выжидает `hostDisconnectGraceMs` (2 с), прежде чем начать
миграцию по обрыву WS хоста. Если за это время хост вернулся
(`reclaim_host`), гости ничего не замечают. Отчёт гостя `host_unreachable`
(P2P тоже умер) во время выдержки запускает миграцию немедленно — так
настоящая смерть хоста не ждёт лишнего, а выдержка действует только когда
P2P цел.

### Как устроено сейчас (проверено по коду 2026-10-07)

- `packages/engine/src/master/SignalingServer.js`, `_removeSession(session)`
  (около строки 1482): для сессии хоста — `this._hostSessions.delete`,
  `this._registry.detachHost(roomId, this._now())`,
  `this._registry.detachMember(session.id, this._now())`, затем
  `this._migration.hostLost(room, 'disconnected', { keepIfNoCandidate: true })`.
  Код закрытия WS не анализируется (`ws.on('close')` без аргументов).
- `packages/engine/src/master/MigrationCoordinator.js`:
  - конструктор (строка ~61): `this._now`, `this._setTimer`,
    `this._clearTimer` из `deps`; `this._timings = { …defaults, ...deps.timings }`
    (строка ~85); карты таймеров `_promotionTimers`, `_probes`, `_lastAckAt`
    (строка ~103);
  - `hostLost(room, reason, { keepIfNoCandidate })` (строка ~140): уже
    `migrating` → `false`; `handing_off` → `_degradeHandoff`; людей нет →
    `_closeRoom(room,'noHost')`; кандидата нет → комната остаётся `online`
    с отсоединённым хостом (при `keepIfNoCandidate`); иначе `status =
'migrating'`, `pendingEpoch`, `_promoteNext` (рассылает `host_migrating`);
  - `onUnreachable(room, memberId, epoch)` (строка ~911): если у комнаты нет
    сессии хоста (`!this._hostSessionId(room.roomId)`) — сразу
    `hostLost(room, 'disconnected', { keepIfNoCandidate: true })`;
  - `onHostLeaving` (строка ~779): `host_leaving` (вкладка хоста уходит,
    `pagehide`) — сразу `hostLost(room, 'leaving')`; WS закрывается уже у
    комнаты в `migrating`, поэтому выдержка этот путь не затрагивает;
  - `forget(roomId)` (строка ~1093): чистит таймеры комнаты.
- `SignalingServer._onReclaimHost` (строка ~832): после всех проверок, если
  комната `migrating`, — `this._migration.cancelByReclaim(room)`; затем
  `this._registry.attachHost(...)` (строка ~919) возвращает хоста.
- `SignalingServer.sweep` (строка ~256): комнаты, чей отсоединённый хост не
  вернулся за `master:room:hostReclaimGraceMs` (10 с), → `hostLost` без
  `keepIfNoCandidate` (миграция или закрытие).
- Пока хост отсоединён: оффер нового гостя получает `error { code:
'migrating' }` и повторяется через `webrtc.offerRetryMs`; комната скрыта в
  `GET /servers`. Это поведение подходит и для выдержки — менять не нужно.
- Клиент: `packages/engine/src/client/session/GuestSession.js`, `bind()`,
  обработчик `publisher.on('close')` (строка ~174): задержка переподключения
  `Math.min(maxDelay, baseDelay * 2 ** reconnectAttempt)` — 1 с, 2 с, 4 с…
  для всех вкладок, включая хоста. `config/lobby.js` → `reconnect: {
baseDelay: 1000, maxDelay: 30000 }` (строка ~176). На `welcome` хост
  вызывает `hostRole.reRegister()` → `reclaim_host`.
- Тесты мастера (`tests/master/MigrationCoordinator.test.js`) создают
  `SignalingServer` с ручным планировщиком (`setTimer`/`clearTimer`/
  `advance(ms)`, строки ~93–145) и блоком `migration: {…}` без новой
  выдержки. 37 мест `host.ws.drop()` ждут миграцию синхронно — поэтому
  **дефолт выдержки в коде координатора — 0**, а 2000 задаётся только
  конфигом мастера.

## Шаг 1. Конфиг

1. `packages/engine/src/config/master.js`, раздел `room` (строки ~84–95):
   - добавить `hostDisconnectGraceMs: 2000` рядом с `hostReclaimGraceMs`;
   - переписать комментарий над ними: обрыв WS хоста запускает миграцию не
     сразу, а через `hostDisconnectGraceMs`, если хост не вернулся
     `reclaim_host` и ни один гость не сообщил `host_unreachable`;
     `hostReclaimGraceMs` — по-прежнему ожидание возврата, когда повышать
     некого.
2. `packages/engine/src/master/lobby.js`, объект `migration` в опциях
   `SignalingServer` (строка ~362): добавить
   `hostDisconnectGraceMs: config.get('master:room:hostDisconnectGraceMs'),`.
3. `packages/engine/src/config/lobby.js`, `reconnect` (строка ~176):
   добавить `hostFirstDelay: 0` и дописать комментарий: вкладка-хост
   переподключается первой попыткой сразу — мастер держит её комнату
   `master:room:hostDisconnectGraceMs`, и вторая попытка (через
   `baseDelay`) тоже должна уложиться в выдержку.

## Шаг 2. Мастер: выдержка в `MigrationCoordinator` (тест первым)

`packages/engine/src/master/MigrationCoordinator.js`:

1. В дефолты `this._timings` добавить `hostDisconnectGraceMs: 0`.
2. В конструкторе: `this._hostGraceTimers = new Map(); // roomId -> таймер выдержки после обрыва WS хоста`.
3. Приватный `_clearHostGrace(roomId)`: снять таймер из карты
   (`this._clearTimer`), удалить запись.
4. Новый публичный метод (JSDoc по-русски, как у соседей):

   ```js
   /**
    * WS хоста закрылся без host_leaving. Миграция — не сразу: короткий обрыв
    * одного сигналинга при живом P2P не должен откатывать матч у всех.
    * @returns {boolean} комната ушла в миграцию сейчас.
    */
   hostDisconnected(room) {
     if (!room) {
       return false;
     }

     const graceMs = this._timings.hostDisconnectGraceMs;

     // передача (handing_off) деградирует сразу, как раньше; миграция уже идёт
     if (graceMs <= 0 || room.status !== 'online') {
       return this.hostLost(room, 'disconnected', { keepIfNoCandidate: true });
     }

     const { roomId, epoch } = room;

     this._clearHostGrace(roomId);
     this._hostGraceTimers.set(
       roomId,
       this._setTimer(() => {
         this._hostGraceTimers.delete(roomId);

         const current = this._registry.get(roomId);

         // хост вернулся, эпоха сменилась или комнату уже ведёт другой путь
         if (
           !current ||
           current.epoch !== epoch ||
           current.status !== 'online' ||
           current.host.sessionId !== null
         ) {
           return;
         }

         this.hostLost(current, 'disconnected', { keepIfNoCandidate: true });
       }, graceMs),
     );

     return false;
   }

   // хост вернулся reclaim_host'ом — выдержка больше не нужна
   hostReturned(roomId) {
     this._clearHostGrace(roomId);
   }
   ```

5. `hostLost(...)`: первой строкой тела — `if (room) this._clearHostGrace(room.roomId);`
   (любой путь, начавший миграцию или закрытие, — отчёт гостя, уборка,
   голосование, — снимает выдержку).
6. `forget(roomId)`: добавить `this._clearHostGrace(roomId);`.
7. `onUnreachable` менять не нужно: при отсоединённом хосте он уже зовёт
   `hostLost` немедленно (п. 5 снимет таймер). Обновить комментарий там:
   «сигналинг хоста уже потерян (в том числе во время выдержки) —
   свидетельства гостя достаточно».

`packages/engine/src/master/SignalingServer.js`:

8. `_removeSession`: заменить вызов
   `this._migration.hostLost(this._registry.get(roomId), 'disconnected', { keepIfNoCandidate: true })`
   на `this._migration.hostDisconnected(this._registry.get(roomId))`;
   переписать комментарий над веткой хоста (вместо «комната сразу уходит в
   миграцию (этап 7.0)» — «миграция после выдержки
   `hostDisconnectGraceMs`; `reclaim_host` в выдержке её не допускает,
   после — отменяет до регистрации преемника»).
9. `_onReclaimHost`: сразу перед `this._registry.attachHost(...)` (ветка
   существующей комнаты, строка ~919) вызвать
   `this._migration.hostReturned(roomId);`.
10. `sweep` менять не нужно (`hostReclaimGraceMs` 10 с > 2 с выдержки;
    уборка зовёт `hostLost`, который снимет таймер, если он ещё жив).

### Тесты (сначала падающие) — `tests/master/MigrationCoordinator.test.js`

Новый `describe('выдержка после обрыва WS хоста (D2)')` со своим
`SignalingServer`, у которого в `migration` задано
`hostDisconnectGraceMs: 2000` (остальное — как в общем `beforeEach`;
вынести фабрику опций, если удобнее). Сценарии (комната с хостом, бетой и
гостем, как в тесте «обрыв WS хоста → host_migrating → promote(checkpoint)…»
строка ~243):

1. Обрыв WS хоста → в течение 1999 мс (`advance(1999)`) никто не получил
   `host_migrating`, комната `online`, хост отсоединён; `advance(1)` →
   `host_migrating` всем, кроме старого хоста, `promote` бете.
2. Обрыв WS → `reclaim_host` той же эпохи через 1000 мс → гости не получили
   ни `host_migrating`, ни `host_changed`; после `advance(5000)` миграции
   нет; таймер снят (нет срабатываний).
3. Обрыв WS → гость шлёт `host_unreachable` через 500 мс → миграция сразу
   (`host_migrating` до истечения выдержки); после `advance(2000)` второй
   миграции/повторных сообщений нет.
4. `host_leaving` → затем закрытие WS → миграция сразу, как раньше (без
   ожидания 2 с).
5. Комната в `handing_off` (плановая передача) + обрыв WS хоста →
   деградация в аварийную миграцию сразу, как раньше.
6. Хост один в комнате + обрыв WS → в выдержке комната жива и скрыта;
   `reclaim_host` в выдержке возвращает её без `restore`; без возврата —
   после выдержки `room_closed`/удаление, как раньше.
7. Комната удалена/забыта (`forget`) во время выдержки → таймер снят, ничего
   не происходит.

Существующие тесты (дефолт 0) должны остаться зелёными без правок.
`tests/master/SignalingServer.test.js` — один тест, что `_removeSession`
хоста зовёт `hostDisconnected` (если есть удобный шов) не обязателен:
сценарии выше покрывают путь через настоящий `SignalingServer`.

## Шаг 3. Клиент: первая попытка переподключения хоста — сразу

`packages/engine/src/client/session/GuestSession.js`, `bind()`, обработчик
`close`:

```js
publisher.on('close', () => {
  const { baseDelay, maxDelay, hostFirstDelay = 0 } = this._config.reconnect;
  // хост: мастер держит комнату hostDisconnectGraceMs — первая попытка
  // сразу, дальше тот же бэкофф, сдвинутый на одну ступень
  const isHost = Boolean(this._hostRole.controller);
  const delay =
    isHost && reconnectAttempt === 0
      ? hostFirstDelay
      : Math.min(maxDelay, baseDelay * 2 ** (isHost ? reconnectAttempt - 1 : reconnectAttempt));

  reconnectAttempt += 1;
  this._timers.setTimeout(() => this._signaling.connect(), delay);
});
```

Попытки хоста: 0 мс, +1 с, +2 с, +4 с… (накопленно 0, ~1, ~3 с) — две
первые укладываются в выдержку 2 с. Гости — без изменений (1 с, 2 с, 4 с…).

Тесты — `tests/client/session/GuestSession.test.js` (рядом с тестом
бэкоффа, строки ~354–376, `vi.useFakeTimers`):

- вкладка-хост (`hostRole.controller` задан): `close` → `connect` вызван
  через 0 мс; второй `close` → через 1000 мс; третий → через 2000 мс;
- гость: прежний ряд 1000 / 2000 (существующий тест не меняется);
- `welcome` сбрасывает счётчик (у хоста снова 0 мс).

## Шаг 4. Связка таймингов

`tests/config/migrationTimings.test.js` — два новых `it`:

- `master.room.hostDisconnectGraceMs > lobby.reconnect.hostFirstDelay + lobby.reconnect.baseDelay`
  (вторая попытка хоста начинается внутри выдержки);
- `master.room.hostDisconnectGraceMs < master.room.hostReclaimGraceMs`
  (уборка не обгоняет выдержку).

## Шаг 5. Документация (en и ru одинаково)

Найти абзацы по цитатам (номера строк сдвигаются):

- `docs/{en,ru}/master.md`: абзац «A host whose signaling closed is detached
  and the room goes into migration at once…» и строка списка причин «the
  host's WS closed (`disconnected`, at once — no grace)» → описать выдержку
  `hostDisconnectGraceMs`, отмену её `reclaim_host`'ом (гости ничего не
  получают), немедленную миграцию по `host_unreachable` гостя и по
  `host_leaving`; раздел «Cancel by reclaim» — уточнить, что он про возврат
  уже после начала миграции.
- `docs/{en,ru}/configuration.md`: строка `hostReclaimGraceMs` (сейчас «the
  host's WS closing starts a migration at once…») + новая строка
  `hostDisconnectGraceMs`; в разделе `config/lobby.js` → `reconnect` —
  `hostFirstDelay`.
- `docs/{en,ru}/host.md`: абзацы «the master notices the host's signaling
  closing and moves the room into migration» и про переподключение
  сигналинга/`reclaim_host`; в «Manual run checklist» → «Rooms, links and
  migration» добавить строку: «Хост: offline на 1 с (DevTools) → у гостей
  нет „Switching host…“, матч без отката; offline на 5 с → обычная
  аварийная миграция».
- `docs/{en,ru}/client.md`: абзац о переподключении сигналинга с
  `lobbyConfig.reconnect` — первая попытка хоста сразу.
- `docs/{en,ru}/architecture.md` (аварийный путь: «the master detects the
  host lost (WS closed, …)») и `docs/{en,ru}/network.md` («host lost (its
  signaling closed, …)») — «после выдержки».
- `plan/host-migration-smoke.md`, блок 3: добавить сценарий 3.7 «Хост:
  offline на 1 с → без миграции и отката; на 5 с → миграция» (источник
  `D2`).

## Шаг 6. CHANGELOG

`packages/engine/CHANGELOG.md` → `## [Unreleased]` → `### Changed` (patch;
миграция хоста уже выпущена в 0.36.0, это изменение поведения):

- The master waits `master:room:hostDisconnectGraceMs` (2 s) after the
  host's signaling closes before migrating the room; a `reclaim_host` within
  it keeps the room without touching the guests, while a guest's
  `host_unreachable` or the host's `host_leaving` still migrates at once.
  The host's tab retries its signaling at once
  (`lobbyConfig.reconnect.hostFirstDelay`), then backs off as before.

## Проверки

`npx prettier --write <изменённые файлы>`, `npx eslint .`,
`npx vitest run --reporter=dot` — зелёные. Rust не трогается.

Ручная проверка (два профиля браузера, dev-контур из
`docs/en/getting-started.md`): хост — DevTools → Network → Offline на 1 с:
у гостя нет оверлея «Switching host…», матч идёт без отката; Offline на 5 с
— обычная аварийная миграция к бете.

## Release impact

npm `vimp-engine` — `### Changed` → patch. Крейт, `create-vimp-game`,
auth-сервис, репозитории игр — не затрагиваются. Протокол сигналинга не
меняется (новых сообщений нет), `contract/surface.json` не меняется.

## Критерии готовности

- Обрыв WS хоста без `host_leaving` не трогает гостей 2 с; возврат в
  выдержку — без единого сообщения гостям.
- `host_unreachable` гостя и `host_leaving` мигрируют сразу.
- Существующие тесты мастера зелёные без правок; новые сценарии шага 2 и 3
  зелёные; связка таймингов проверена тестом.
- Доки en/ru и CHANGELOG обновлены.
