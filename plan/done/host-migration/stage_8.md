# Этап 8. Плановая миграция: «Leave server», «Hand over host», `beforeunload`/`pagehide` ✅ выполнен

Цель: хост уходит или отдаёт роль **без отката** — мир замораживается на
границе кадра, финальная контрольная точка уходит бете, бета продолжает с
того же тика. Это же действие — основа всех автотриггеров (этап 9) и
голосования (этап 10): все они вызывают одну функцию
`startPlannedHandoff({ reason, stay, defer })`.

Зависит от этапа 7 (промоушен, переключение клиентов, ограждение эпохой).

## Подэтапы (согласовано с разработчиком 2026-10-03)

Этап слишком широк для одного прохода — исполняется подэтапами, каждый
заканчивается зелёным прогоном и своими доками (страницы своей области).

| #   | Подэтап                                                                                                                                | Разделы                      | Статус                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| 8a  | Мастер: `handoff_begin`/`handoff_go`/`host_released`/`handoff_aborted`/`handoff_unavailable`, `handing_off`, `host_leaving`            | 8.1 (мастер), 8.5 (мастер)   | ✅ выполнен                                |
| 8b  | Worker и бета: полная синхронизация после `unfreeze`, приоритет финальной точки, `promote {mode: 'planned'}` → `waitForFinal`          | 8.1 (Worker/бета), 8.6       | ✅ выполнен                                |
| 8c  | Клиент: `PlannedHandoff.js`, интеграция в `main.js` (`stay` → RESUME, `!stay` → лобби), `error {code: 'migrating'}` → повтор           | 8.2, 8.5 (лобби)             | ✅ выполнен                                |
| 8d  | Меню комнаты («Leave server», «Hand over host»), `hostUnloadGuard` (`beforeunload`/`pagehide`), ожидание границы раунда без `midRound` | 8.1 (мягкий режим), 8.3, 8.4 | ✅ выполнен                                |
| 8e  | Сквозные доки, CHANGELOG, ручная проверка                                                                                              | 8.7, 8.8, «Проверка»         | ✅ выполнен (ручная проверка → smoke-план) |

### Итог 8a (2026-10-03)

`MigrationCoordinator.beginHandoff`/`onHostLeaving`/`_abortHandoff`/
`_degradeHandoff`, обработчики `handoff_begin`/`host_leaving` в
`SignalingServer`, `master:room:handoffTimeoutMs` (8000). Решения
исполнителя (для 8b–8d):

- `handoff_begin` требует бету со **свежим** `standby_status` (не старше
  `checkpointMaxAgeMs`) — иначе финальной точке не по чему ехать;
  `handoff_unavailable {roomId, epoch, reason}`: `noSuccessor` | `busy` |
  `staleEpoch`. Сообщение не от хоста — молча игнор. Незнакомый `reason`
  → `handover` (белый список `leave`/`handover`; этапы 9/10 дополняют
  `PLANNED_REASONS`).
- Во время `handing_off` хост остаётся привязанным (heartbeat идёт);
  `host_migrating` уходит всем, кроме хоста (бете тоже, как в этапе 7).
- Отмена: гостям `host_changed {epoch: N, mode: 'reclaimed'}` — по
  `host_migrating` они уже бросили транспорт (`SessionSupervisor.migrate`)
  и возобновляются к тому же хосту. Клиенту в 8c ничего для этого не нужно.
- Хост потерян посреди передачи (обрыв WS, нет heartbeat — уборка теперь
  ловит и `handing_off`, `host_leaving`) → `migrating` с тем же кандидатом
  и тем же дедлайном; сбой кандидата → следующий (`cold`), а не отмена;
  успех — `host_changed {mode: 'planned'}`. `reclaim_host` в `handing_off`
  → `staleEpoch` (роль хост отдавал сам).
- `host_leaving` не отменяется `reclaim_host`; людей нет — комната
  закрывается.
- **Для 8c:** `error {code: 'migrating'}` на оффер → повтор через 1 с;
  `roomLink.isMigrating` (status `'handing_off'` в `GET /rooms/:roomId`)
  тоже должна ждать; бывший хост с `!stay` шлёт `leave_room` после
  `host_released` (мастер его принимает — сессия уже не хост).
- **Исправления после код-ревью 8a (одобрены разработчиком 2026-10-03):**
  (1) хост потерян посреди передачи — бета получает повторный `promote`
  той же эпохи и токена с `mode: 'checkpoint'` и обычный
  `promotionTimeoutMs`; **для 8b:** бета, ждущая финальную точку
  (`waitForFinal`), на такой `promote` бросает ожидание и берёт последнюю
  периодическую; (2) `_reviewSuccessor` не работает, пока комната
  `handing_off`/`migrating` (смена беты посреди передачи разводила хоста и
  повышенную бету).
- CHANGELOG: запись «Planned host handoff» (`### Added`) с подпунктом
  мастера — клиентские подпункты добавлять в неё же.

### Итог 8b (2026-10-03)

- `HostGame.unfreeze`: если на заморозке снималась точка (флаг
  `_drainedWhileFrozen`), всем `getNetworkedReady()` уходит пакет входа
  RESUME (`_sendResumeEntry`: keyset, CLEAR, карта `resume: true`, первый
  кадр); повторная разморозка без точки — без синхронизации.
- `StandbySender`: пока финальная ждёт отправки — периодические не уходят;
  периодическая с `seq` ≤ seq финальной отбрасывается. `StandbyReceiver`:
  периодическая не новее финальной её не вытесняет; `discardFinal()`
  снимает флаг `final` с последней точки, а если финальная ещё не дошла —
  первая точка после отмены, будь она финальной, принимается периодической
  (исправление после код-ревью 8b, вариант 1 одобрен разработчиком;
  вместо запоминания `seq` — порядок канала: `seq` недошедшей финальной
  неизвестен).
- `Promotion`: `mode: 'planned'` → `waitForFinal(0, finalWaitMs)`, таймаут →
  `latest()`; `degrade(promote)` (та же эпоха/токен) бросает ожидание;
  `cancel()` тоже. `main.js`: повтор `promote` с `mode: 'checkpoint'` при
  `promotionInFlight` → `degrade`; `promote_cancelled` →
  `standbyReceiver.discardFinal()`. Конфиг `lobby.migration.finalWaitMs`
  (3000).
- **Для 8c:** `handoff_aborted` → `HostController.unfreeze()` — синхронизация
  уйдёт сама; финальную точку запрашивать `requestCheckpoint({final: true})`
  после `freeze()` (снимается сразу, цикл стоит).

### Итог 8c (2026-10-03)

- `client/network/PlannedHandoff.js`: `start({reason, stay})` →
  `handoff_begin`; `handoff_go` → `freeze()` + `requestCheckpoint({final:
true})` + `onFrozen`; `host_released` → `onReleased {stay, epoch}`;
  `handoff_unavailable`/дедлайн → `onAborted` (stay) или `host_leaving` + `onLeave` (!stay) — см. исправление после код-ревью ниже;
  `handoff_aborted` → `unfreeze()` (только stay; уходящий не размораживает,
  а шлёт `host_leaving`); обрыв сигналинга посреди передачи — разморозка
  (stay) / уход без `host_leaving` (!stay). `abort()` — тихо (teardown роли).
- `main.js`: `startPlannedHandoff` (отказ при эстафете Worker'ов и
  промоушене), `stay` → `demoteHost(epoch, {notice: false})` (без
  `HOST_REVOKED` в чате, оверлей «Switching host…»), `!stay` →
  `leaveServer()` (`leave_room` + `reloadTo('')`); `demoteHost` уходящего
  хоста (staleEpoch/host_revoked посреди передачи) — тоже `leaveServer`;
  поздний `host_released` после дедлайна разжалует вкладку;
  `refreshHostWorker` не стартует во время передачи.
- Гость: `WebRtcManager` на `error {code: 'migrating'}` до ответа хоста
  повторяет тот же оффер и уже отправленные ICE-кандидаты через
  `lobby.webrtc.offerRetryMs` (1000), окно `connectTimeoutMs` заново;
  `roomLink.isMigrating` учитывает `handing_off`.
- Решение исполнителя: до меню (8d) точка входа доступна в dev-сборке как
  `window.__vimpDebug.handoff({reason, stay})` — для ручной проверки и
  чтобы `startPlannedHandoff` не был мёртвым кодом.
- **Исправление после код-ревью 8c (вариант 1 одобрен разработчиком):**
  с уточнением разработчика по UX: у передачи один исход и один дедлайн — `lobby.migration.handoffDeadlineMs` (10000 от `handoff_begin`: `handoffTimeoutMs` мастера + запас на дорогу ответа). Нет `handoff_go` за `lobby.migration.handoffSlowMs` (3000) — не отказ, а `onSlow` (плашка «Slow connection…» — в меню, 8d); поздний `handoff_go` до дедлайна штатно замораживает и шлёт финальную точку. Окончательная отмена (`onAborted`, разморозка, если морозили) — только `handoff_unavailable`/`handoff_aborted`/обрыв сигналинга/дедлайн; дедлайн замороженным — страховка (поздний `host_released` всё равно разжалует). Уходящий хост тоже ждёт до дедлайна (поздний go — передача без отката), сразу уходит лишь на явный отказ и обрыв сигналинга. Ошибку передачи показывает статус меню (8d), не чат (системные сообщения — только кодами). Пока передача идёт, повтор и эстафета Worker'ов заблокированы. Мастер не меняется.
- **Решение разработчика (2026-10-03, вариант 1):** в играх без
  `migration.midRound` `stay`-передачи ждут границы раунда — делается в 8d
  вместе с «Hand over host», по образцу эстафеты Worker'ов
  (`RoundManager.requestHandoff`, сообщение Worker'у → уведомление на
  `initiateNewRound`, затем `startPlannedHandoff`). Потолок ожидания —
  временно 30 с (`lobby.migration.deferMaxMs`), этап 9 его переиспользует.
  `leave` не ждёт (мягкая точка, раунд у беты заново). Пока ожидание идёт —
  передача считается начатой (повтор игнорируется, меню «Handing over…»).

### Итог 8d (2026-10-03)

- Граница раунда: `RoundManager.onRoundBoundary`/`cancelRoundBoundary`
  (колбэк один раз, **после** старта следующего раунда — раунд не
  придерживается: сорвавшаяся передача не оставит комнату без раунда, а
  бета всё равно начнёт его заново из мягкой точки),
  `HostGame.awaitRoundBoundary` (у игры с `midRound` — сразу), сообщения
  Worker'у `round_boundary_wait`/`round_boundary_cancel` → ответ
  `round_boundary`, `HostController.awaitRoundBoundary`/`cancelRoundBoundary`.
- `PlannedHandoff.start({reason, stay, defer})`: фаза `deferred` (флаг
  `deferred`), потолок `lobby.migration.deferMaxMs` (30000); slow/дедлайн —
  от `handoff_begin`; `handoff_aborted` в ожидании игнорируется; `abort()`
  и обрыв сигналинга снимают ожидание в Worker'е. `startPlannedHandoff`:
  `defer` по умолчанию = `stay` (этап 9 передаст явно для критичных).
- Меню: модель `setRole({role, othersPresent, hasSuccessor})`,
  `setHandoff(null|'pending'|'slow'|'failed')`, `getState()`; пункты
  статичны в pug (`#room-menu-leave`, `#room-menu-handover`,
  `#room-menu-status`), меню видно, пока вкладка в комнате. Клик не
  закрывает меню (на месте пунктов — статус); «Host handover failed»
  забывается закрытием меню.
- `client/lib/hostUnloadGuard.js` (`HostUnloadGuard`): `update({role,
othersPresent})`, `exit()`; pagehide однократный. В `main.js` —
  `refreshRoomControls()` (роль: `hostController` → host, иначе guest при
  `currentRoomId`; люди — `HostConnectionManager.peerCount`; бета — последнее
  `successor_assigned`), `leaveServerByUser()` (хост с людьми → передача
  `leave`, один или передача невозможна → `host_leaving`; гость → `LEAVE`),
  `leaveServer()` зовёт `unloadGuard.exit()`.
- `window.__vimpDebug.handoff` оставлен (dev-сборка).
- CHANGELOG: подпункты меню/ожидания границы и `beforeunload`/`pagehide`
  добавлены в запись «Planned host handoff»; формулировку 8.8 сверить в 8e.
- **Исправление после код-ревью 8d (вариант 1 одобрен разработчиком
  2026-10-03):** `pagehide` срабатывает и на программной перезагрузке —
  гость (в т. ч. бета перед холодным промоушеном, `reloadToRoom`) объявлял
  уход (`LEAVE` + `leave_room`) и терял место. Все программные перезагрузки
  `main.js` идут через обёртку `reloadPage(hashPart?)`: сначала
  `unloadGuard.exit()`, затем `reloadTo`/`location.reload`; уход объявляется
  только при закрытии вкладки или F5 пользователем. Тест — прямых
  `reloadTo(`/`location.reload(` в `main.js` вне обёртки нет.

### Итог 8e (2026-10-03)

- Доки (en/ru): `host.md` — подраздел «Planned handoff» в «Host migration»
  (шаги `handoff_begin` → `freeze` + финальная точка → `host_released`,
  откат через `unfreeze`, мягкий режим, закрытие вкладки — не плановый
  путь), исправлен обрывок фразы в «Freeze»; `architecture.md` — таблица
  «аварийный / плановый путь»; `master.md` — `handing_off` больше не
  «зарезервирован». `client.md` (меню, `beforeunload`/`pagehide`, UI
  hierarchy) и остальной `master.md` уже были обновлены в 8a–8d.
- CHANGELOG: запись «Planned host handoff» (`### Added`) покрывает 8.8
  целиком — правок не потребовалось.
- Автотесты зелёные. **Ручная проверка** (раздел «Проверка», 3 профиля) —
  за разработчиком; после неё этап 8 помечается «✅ выполнен».

## 8.1. Протокол

```
хост A                       мастер                         бета B
 │ handoff_begin{reason,stay} ─►│ проверка: online, эпоха, бета жива
 │                              │ status='handing_off', pendingEpoch=N+1
 │◄─ handoff_go{epoch:N+1} ─────┤── promote{mode:'planned', N+1, token} ─►│
 │                              │── host_migrating{reason} ─► все         │
 │ Worker.freeze → финальная точка (final) ── standby ──────────────────►│
 │                              │                     init из final точки │
 │                              │◄────────────── register_host{N+1,token} ┤
 │◄─ host_released ─────────────┤── host_changed{N+1,'planned'} ─► все    │
 │ stay ? свой клиент → RESUME к B : уход в лобби                         │
```

- Мастер (`MigrationCoordinator`, этап 7): `handoff_begin` только от
  текущего хоста, `status === 'online'`. Беты нет → `handoff_unavailable
{reason: 'noSuccessor'}`; при `reason: 'leave'` хост уходит всё равно
  (дальше аварийный путь: бета без точки → `cold` у любого способного; людей
  нет → комната закрыта — это ожидаемо). Состояние `handing_off` — офферы
  новых гостей ставятся в ожидание (ответ `error {code: 'migrating'}`,
  клиент повторяет через 1 с).
- Бета на `promote {mode: 'planned'}` ждёт финальную точку
  `StandbyReceiver.waitForFinal(…, finalWaitMs = 3000)`; не дождалась —
  берёт последнюю периодическую (откат минимальный). Дальше — шаги 7.4
  (режим `checkpoint`).
- **Откат при сбое**: бета не зарегистрировалась за `handoffTimeoutMs`
  (8000) или прислала `promote_failed` → мастер: `handoff_aborted` хосту,
  `promote_cancelled` бете, `status = 'online'`, эпоха не меняется
  (эпоха растёт только при успешной смене хоста; `pendingEpoch`
  выбрасывается). Хост: `Worker.unfreeze()` — матч продолжается, игроки
  видят паузу ≤ 8 с.
  > **Из ревью этапа 5 (подтверждено).** `requestCheckpoint` на
  > замороженном хосте зовёт `packBody()` (дренаж — предусловие дампа), а
  > тело кадра никому не уходит: события ядра с последнего отправленного
  > кадра (удаления, взрывы, трассеры) теряются. У преемника это перекрывает
  > полный кадр RESUME, но при откате (`unfreeze`) клиенты старого хоста его
  > не получают — возможны «призраки» сущностей. Сделать: `HostGame.unfreeze`
  > после финальной точки (флаг «тело дренировано вне цикла») шлёт
  > возобновлённым участникам пакет полной синхронизации — как
  > `_sendResumeEntry` (CLEAR + первый кадр + keyset), либо первый кадр
  > после разморозки уходит с `forceReset` всем. Тест: freeze → точка →
  > unfreeze → каждый готовый участник получил CLEAR + полный кадр. Если `reason: 'leave'` — хост уходит всё равно
  > (аварийный путь).
- Игры **без** `migration.midRound` (мягкий режим): `stay`-передачи
  (`handover`, автотриггеры, голосование) ждут границы раунда — тот же
  механизм, что `requestHandoff` у нынешнего Worker handoff
  (`RoundManager.js:259-285`), с потолком `deferMaxMs` (этап 9); `leave`
  — сразу (мягкая точка, раунд начнётся заново у беты).

## 8.2. Хост: `startPlannedHandoff`

Модуль `client/network/PlannedHandoff.js` (чистая логика + зависимости
через аргументы, как у остальных сетевых модулей):

1. отправить `handoff_begin {roomId, epoch, reason, stay}`, ждать
   `handoff_go` (таймаут 3000 → отказ, для `leave` — уйти всё равно);
2. `HostController.freeze()` → `requestCheckpoint({ final: true })` →
   `StandbySender` шлёт её с приоритетом (ждёт `bufferedamountlow`, не
   пропускает);
3. ждать `host_released` (или `handoff_aborted` → `unfreeze()`);
4. `host_released`: снять `beforeunload` (8.4), остановить heartbeat,
   `HostConnectionManager.destroy()` (гости уже переподключаются к B по
   `host_changed`), `HostController.destroy()`;
5. `stay` → собственный клиент: супервизор меняет `LoopbackTransport` на
   `WebRtcManager` к `roomId` (новая эпоха) с RESUME под своим
   `gameId`/`resumeKey` (в точке он был `isHostPlayer`); `!stay` → клиент
   шлёт `leave_room` мастеру и уходит в лобби
   (`reloadTo('')` — не быстрая игра, она вернула бы в комнату) — без системных диалогов
   (`isExiting = true`).

Повторный вызов во время идущей передачи — игнор (флаг, как guard у
`swapWorker` в `main.js`/`HostController`).

## 8.3. UI: меню комнаты (создано в этапе 3)

`components/{model,view,controller}/RoomMenu.js`, `views/includes/roomMenu.pug`:

> После ручной проверки этапа 7 «Copy link» из меню убран, и меню пусто:
> `RoomMenuView.showLink` показывает `#room-menu`, только если в
> `#room-menu-list` есть пункты. Пункты этого этапа делают его видимым.

- **«Leave server»** — у всех (только лобби-режим). Гость: порт `LEAVE`
  (этап 4) хосту + `leave_room` мастеру → закрыть транспорт →
  `reloadTo('')` (лобби). Хост: `startPlannedHandoff({reason:
'leave', stay: false})`; если других людей нет — просто закрыть комнату
  (нынешнее поведение) и уйти.
- **«Hand over host»** — только у текущего хоста и только если в комнате
  есть другие люди **и** мастер назначил бету (`successor_assigned` с не-null
  `successorMemberId`); иначе пункт скрыт.
  `startPlannedHandoff({reason: 'handover', stay: true})`. Подтверждение
  не нужно (действие обратимо — роль можно передать обратно).
- Пока идёт передача — пункты заблокированы, на месте статус
  «Handing over…».
- Модель меню знает роль (хост/гость), наличие беты и число людей —
  подписка на `successor_assigned`, `host_changed`, `room_joined` и
  количество пиров `HostConnectionManager.onPeersChange`.

## 8.4. `beforeunload` и `pagehide`

> **Наблюдение из код-ревью этапа 3.** `host_leaving` в `pagehide` —
> один из вариантов устранения ожидания `hostReclaimGraceMs` после ухода
> хоста (мёртвая комната 10–20 с выдаётся в `GET /servers`, быстрая игра
> гостей зацикливается на ней). Полный список вариантов и лавина комнат при
> закрытии — `stage_7.md` → 7.0; выбор не сделан, решает исполнитель. Если
> этап 7 выбрал вариант 1 (`host_leaving` раньше этапа 8) — здесь
> дорабатывается только плановая часть.

Модуль `client/lib/hostUnloadGuard.js`:

- `beforeunload` регистрируется, **только пока** вкладка — текущий хост
  **и** в комнате есть другие люди; снимается при потере роли
  (`host_released`, `host_revoked`, `host_changed` на другого), при уходе
  последнего гостя и при `isExiting` (кнопка «Leave server»). Обработчик:
  `event.preventDefault(); event.returnValue = '';` — браузер покажет
  стандартное окно «Leave site?». Цель — защита от случайных Ctrl+W/F5.
  **Не обещать** финальный дамп во время диалога: пока диалог открыт,
  главный поток стоит (этап 0 это проверил), ретрансляция Worker →
  DataChannel невозможна — комната для гостей на это время замирает.
- `pagehide` (срабатывает и после «Leave», и при закрытии без диалога):
  если вкладка всё ещё хост — синхронно `signaling.send({type:
'host_leaving', roomId, epoch})` (WS-сообщение в `pagehide` по данным
  этапа 0 доставляется — если нет, это лишь ускорение: закрытие WS всё
  равно запустит аварийный путь). Мастер на `host_leaving` начинает
  аварийную миграцию сразу (бета с последней периодической точкой).
- Гость в `pagehide`: best-effort `LEAVE` хосту и `leave_room` мастеру
  (тогда его слот освобождается сразу, а не через `resumeGraceMs`).
- Мобильные: `beforeunload` там ненадёжен — полагаемся на `pagehide` и
  аварийный путь; документировать.

## 8.5. Конфиг

`config/lobby.js` (`migration.*`): `finalWaitMs`, `handoffSlowMs`, `handoffDeadlineMs`;
`config/master.js` (`room.*`): `handoffTimeoutMs`. Доки
`configuration.md`.

## 8.6. Тесты

- `tests/client/network/PlannedHandoff.test.js` — счастливый путь `stay`
  и `!stay`, отказ `handoff_unavailable` (для `leave` — уход всё равно),
  `handoff_aborted` → `unfreeze`, повторный вызов игнорируется.
- `tests/master/MigrationCoordinator.test.js` — `handoff_begin` (не от
  хоста, не `online`, без беты), `handing_off` → офферы получают
  `migrating`, таймаут → `handoff_aborted`/`promote_cancelled`, эпоха не
  выросла; успех — эпоха +1, `host_released`.
- `tests/client/lib/hostUnloadGuard.test.js` — регистрация/снятие по
  ролям и числу людей, `isExiting`, `pagehide` шлёт `host_leaving` только
  хостом.
- `tests/client/RoomMenu*.test.js` — видимость пунктов по роли/бете/числу
  людей, блокировка во время передачи.
- `tests/host/HostGame.checkpoint.test.js` — `freeze`: точка снимается на
  границе кадра, цикл и таймеры стоят; `unfreeze` — продолжают с теми же
  остатками; после финальной точки `unfreeze` шлёт полную синхронизацию
  (находка ревью этапа 5, см. «Откат при сбое»).

## 8.7. Документация

`docs/{en,ru}/host.md` — «Host migration» → «Planned handoff»; `client.md`
— меню комнаты (оба пункта), `beforeunload`/`pagehide`, таблица «UI
hierarchy»; `master.md` — `handoff_begin`/`handoff_go`/`host_released`/
`handoff_aborted`/`host_leaving`, состояние `handing_off`; `architecture.md`
— плановый и аварийный путь рядом.

## 8.8. CHANGELOG

`### Added`: planned host handoff — «Leave server» and «Hand over host» in
the room menu continue the match on the successor from the same tick; the
host's tab asks for confirmation before closing; `pagehide` starts the
migration at once.

## Проверка

Ручная часть вынесен в отдельный план `plan/host-migration-smoke.md` (2026-10-05).

Автотесты зелёные. Вручную (3 профиля, tanks `midRound`): «Hand over host»
посреди боя — снаряды в полёте долетают, позиции не прыгают, пауза ≤ 1–2
с, бывший хост играет дальше гостем; «Leave server» хостом — то же, хост в
лобби; Ctrl+W у хоста — окно подтверждения, «Остаться» → игра идёт,
«Покинуть» → аварийная миграция с откатом ≤ интервала точек; в игре без
`midRound` (временно выключить флаг в tanks) «Hand over host» ждёт
границы раунда.

## Готово, когда

Проверки зелёные, доки en/ru синхронны, CHANGELOG обновлён, release impact
в отчёте.
