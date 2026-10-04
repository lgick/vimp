# Этап 2. Плановая передача: бета не рвёт канал до финальной точки; разморозка без «перезахода» ✅ выполнен

Находки: **F2**, **F3** ([review.md](review.md), разделы F2 и F3).
Уровень: 🔴 критично. Критерии: работоспособность, тестируемость.

## Проблема A (F2): финальная точка не доходит до беты

Канал `standby` открыт хостом поверх **того же** `RTCPeerConnection`, что
игровой транспорт беты к хосту
(`packages/engine/src/client/network/StandbySender.js:136-153`,
`client/network/WebRtcManager.js` — `ondatachannel` с меткой `standby`).

Порядок в `master/MigrationCoordinator.js` `beginHandoff` (строки
613-638): хосту `handoff_go`, бете `promote {mode: 'planned'}`, затем
**всем, кроме хоста** (то есть и бете) `host_migrating`.

На бете (`client/main.js`):

1. `promote` → `handlePromote` (строки 2830-2903) → `Promotion.start()` →
   `_pickCheckpoint` ждёт финальную точку `finalWaitMs` (3 с,
   `client/network/Promotion.js:249-270`).
2. Сразу следом `host_migrating` → обработчик (строки 4087-4098) →
   `supervisor.migrate()` (`client/network/SessionSupervisor.js:274-299`)
   → `_dropTransport()` → `WebRtcManager.destroy()` → `pc.close()` — канал
   `standby` закрыт.

Финальная точка идёт «мастер → хост → Worker (заморозка, сбор, gzip) →
главный поток → DataChannel → бета» и почти всегда проигрывает прямому
`host_migrating` от мастера. Хост, увидев закрытие пира беты, вызывает
`StandbySender.refresh()` → `_closeChannel()` → `_pendingFinal = null`
(строки 104-127, 155-177) — ждавшая отправки финальная точка выброшена.

Итог: каждая плановая передача ждёт 3 с впустую и поднимает матч из
последней периодической точки — откат ~0,5 с у всех вместо «того же
тика».

## Проблема B (F3): пакет синхронизации после разморозки «перезаводит» хост-игрока

`host/HostGame.js:1523-1537` `unfreeze()` при `_drainedWhileFrozen`
(а он истинен всегда: финальная точка снимается на заморозке) шлёт
`_sendResumeEntry` всем `getNetworkedReady()` — фактически хост-игроку на
loopback (гости уже бросили транспорт). Пакет включает FIRST_SHOT
(`_sendResumeEntry` → `sendFirstShot`, строки 2024-2053).

Клиент хост-игрока не в режиме возобновления (`supervisor.resuming ===
false`), поэтому обработчик FIRST_SHOT_DATA (`client/main.js:849-867`)
шлёт FIRST_SHOT_READY. Порт 4 порт-машины (`host/PortMachine.js:509-526`)
вызывает `HostGame.firstShotReady` (строки 681-715) повторно:

- всем — `USER_JOINED` («<хост> joined the game»);
- хост-игроку — `sendFirstVote` (окно `initialVote`, в tanks — выбор
  команды);
- при `noSpectators` (snakes) — `admitPlayer`: уже играющий участник
  заново ставится на точку респауна.

## Решение

### 2.1 SessionSupervisor: миграция с сохранением транспорта

`packages/engine/src/client/network/SessionSupervisor.js`:

1. `migrate()` → `migrate({ keepTransport = false } = {})`. При
   `keepTransport` не вызывать `_dropTransport()`; остальное (сторожок
   тишины и таймеры переподключения снять, `_resuming = false`, состояние
   `migrating`, таймер `migrationWaitMs`) — как сейчас. JSDoc: транспорт
   сохраняет только бета плановой передачи — по нему же идёт канал
   `standby` с финальной точкой.
2. `_handleMessage` (строки 446-453): в состоянии `migrating` сообщения
   транспорта **не** передавать владельцу (`return`) — у клиента не должно
   быть двух источников кадров; канал `standby` идёт мимо транспорта
   (`StandbyReceiver` слушает свой DataChannel) и не затрагивается.
3. `_handleClose` (строки 481-508): после `_dropTransport()` добавить
   ветку — в состоянии `migrating` закрытие транспорта не терминально,
   `return` (исход решают `host_changed` / `promote` / таймер миграции).
4. `hostChanged` (строки 308-345) и `resumeWith` (365-399) уже вызывают
   `_dropTransport()` — сохранённый транспорт закроется там. Проверить
   тестом.

### 2.2 Бета сама уходит в ожидание при `promote {mode: 'planned'}`

Чтобы не зависеть от порядка сообщений и версии мастера, ожидание
включает `Promotion`:

1. `client/network/Promotion.js`: новая опция конструктора
   `holdSession = () => {}` с JSDoc «плановая передача: поставить сессию
   своего игрока на паузу, не закрывая транспорт к замороженному хосту —
   по нему идёт финальная точка». В `start()` после проверки
   `_state !== 'idle'` и до `_start()`: если
   `this._promote.mode === 'planned'` — вызвать `this._holdSession()`.
2. `client/main.js` `handlePromote` (создание `Promotion`, строки
   2873-2899): передать
   `holdSession: () => supervisor?.migrate({ keepTransport: true })`.
   Последующий `host_migrating` от старого мастера попадёт в
   `supervisor.migrate()` и вернёт `false` (уже `migrating`) — транспорт
   цел.
3. Оверлей и выключение ввода даёт существующий `handleSessionState` на
   состояние `migrating` (`client/main.js:1722-1738`) — ничего добавлять не
   нужно.

### 2.3 Мастер не шлёт бете `host_migrating` при плановой передаче

`packages/engine/src/master/MigrationCoordinator.js` `beginHandoff`
(строки 629-638): список исключений `_broadcast` —
`[room.host.memberId, beta.memberId]`. Комментарий: бета узнала о передаче
из `promote` и держит соединение с замороженным хостом до финальной точки.

`_abortHandoff` по-прежнему шлёт `host_changed {mode: 'reclaimed'}` всем,
кроме старого хоста (бета в их числе): бета в `migrating` с сохранённым
транспортом его отработает — `hostChanged` бросит транспорт и вернёт место
RESUME'ом к тому же хосту. Менять не нужно.

### 2.4 Повторный FIRST_SHOT_READY готового участника — не вход

`packages/engine/src/host/HostGame.js` `firstShotReady` (строка 681): после
проверки `!user` добавить

```js
// уже готовый участник получил пакет синхронизации (разморозка после
// сорвавшейся передачи) и ответил на его первый кадр — это не вход в
// матч: ни USER_JOINED, ни initialVote, ни повторной выдачи актора
if (user.isReady === true) {
  return;
}
```

Почему безопасно: `isReady` сбрасывается в `false` только в
`RoundManager.sendMap` (`host/meta/core/RoundManager.js:279`), то есть
штатный вход и смена карты по-прежнему проходят через `firstShotReady`.
Прогнать все тесты `tests/host/` — если какой-то тест вызывает
`firstShotReady` дважды подряд и ждёт побочных эффектов, разобраться,
не прячет ли он ту же ошибку.

## Тесты (сначала падающие)

- `tests/client/network/SessionSupervisor.test.js`:
  - `migrate({ keepTransport: true })`: `transport.destroy` не вызван,
    `state === 'migrating'`; сообщения транспорта не доходят до
    `onMessage`; сторожок тишины снят (прокрутить часы дальше
    `hostSilenceMs` — `transport.close` не вызван);
  - закрытие транспорта в `migrating` не зовёт `onTerminal`, состояние
    остаётся `migrating`;
  - `hostChanged({ mode: 'reclaimed' })` из такого состояния бросает
    сохранённый транспорт и начинает переподключение;
  - `resumeWith(loopback, …)` бросает сохранённый транспорт.
- `tests/client/network/Promotion.test.js`: `holdSession` вызывается для
  `mode: 'planned'` до ожидания финальной точки и не вызывается для
  `checkpoint`.
- `tests/master/MigrationCoordinator.test.js`: `beginHandoff` — бета
  получает `promote`, но не `host_migrating`; другие гости получают
  `host_migrating`.
- `tests/host/HostGame.checkpoint.test.js` (или `HostGame.resume.test.js`):
  заморозка → `requestCheckpoint({ final: true })` → `unfreeze()` →
  хост-игрок получил пакет; затем `firstShotReady(hostPlayerId)` — нет
  `USER_JOINED` в чате, нет `sendFirstVote`, `roundManager.admitPlayer`
  не вызван (шпион), даже при `noSpectators`.

## Документация (en и ru одинаково)

- `docs/{en,ru}/host.md`, «Planned handoff» / «Плановая передача»: бета
  держит соединение с замороженным хостом, пока не получит финальную
  точку (`holdSession`); мастер шлёт `host_migrating` гостям, кроме беты;
  после разморозки повторный FIRST_SHOT_READY готового участника
  игнорируется.
- `docs/{en,ru}/client.md`: `SessionSupervisor.migrate({ keepTransport })`,
  сообщения транспорта в `migrating` отбрасываются, закрытие не
  терминально.
- `docs/{en,ru}/master.md`, `docs/{en,ru}/network.md`: получатели
  `host_migrating` при плановой передаче, порядок сообщений.

## CHANGELOG

`[Unreleased]` → `### Added`, запись «Planned host handoff»: уточнить, что
бета получает финальную точку по каналу `standby`, не разрывая соединения
с замороженным хостом, а сорвавшаяся передача не «перезаводит» игроков
хоста. Новой записи не заводить.

## Критерии готовности

- В плановой передаче бета поднимает матч из **финальной** точки (тест
  Promotion + StandbyReceiver с сохранённым каналом; ручная проверка —
  пункт плановой передачи в «Manual run checklist» `docs/en/host.md`).
- Сорвавшаяся передача не даёт `USER_JOINED`, окна `initialVote` и
  перестановки игрока.
- Prettier, eslint, vitest — зелёные. Release impact: npm `vimp-engine`,
  уточнение `[Unreleased]`.
