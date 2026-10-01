# Этап 8. Плановая миграция: «Leave server», «Hand over host», `beforeunload`/`pagehide`

Цель: хост уходит или отдаёт роль **без отката** — мир замораживается на
границе кадра, финальная контрольная точка уходит бете, бета продолжает с
того же тика. Это же действие — основа всех автотриггеров (этап 9) и
голосования (этап 10): все они вызывают одну функцию
`startPlannedHandoff({ reason, stay, defer })`.

Зависит от этапа 7 (промоушен, переключение клиентов, ограждение эпохой).

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
  видят паузу ≤ 8 с. Если `reason: 'leave'` — хост уходит всё равно
  (аварийный путь).
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
   шлёт `leave_room` мастеру и уходит в лобби этой игры
   (`reloadTo(formatGameLink(gameId))`) — без системных диалогов
   (`isExiting = true`).

Повторный вызов во время идущей передачи — игнор (флаг, как guard у
`swapWorker` в `main.js`/`HostController`).

## 8.3. UI: меню комнаты (создано в этапе 3)

`components/{model,view,controller}/RoomMenu.js`, `views/includes/roomMenu.pug`:

- **«Leave server»** — у всех (только лобби-режим). Гость: порт `LEAVE`
  (этап 4) хосту + `leave_room` мастеру → закрыть транспорт →
  `reloadTo(formatGameLink(gameId))`. Хост: `startPlannedHandoff({reason:
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

`config/lobby.js` (`migration.*`): `finalWaitMs`, `handoffGoTimeoutMs`;
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
  остатками.

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
