# План: исправления по код-ревью `9ca1f5bb` (host-migration-review-2)

Основание — код-ревью коммита `9ca1f5bb` (2026-10-05): остатки находок N2,
N3, N5 прошлого ревью (`plan/done/host-migration-review-2/review.md`), гонка
в правке N4.3, лишние запросы манифестов и мелочи. Находки 1 и 3
подтверждены воспроизводящими тестами (scratchpad).

Общие правила — как в `plan/done/host-migration-review-2/README.md`: тест
первым (падает до правки), доки en/ru в том же изменении, правится текст
существующих записей `[Unreleased]` (новых записей и подзаголовков нет),
протоколы только дополняются, `contract/surface.json` не трогается, без
коммитов. В конце — `npx prettier --write`, `npx eslint .`,
`npx vitest run --reporter=dot`.

## Находки

| #   | Уровень | Суть                                                                                                                                                                                                  |
| --- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 🔵      | После смены хоста `promoteHost` обнуляет `peersReportedAt`: до первого `room_peers` нового хоста фантомы «подтверждены», начинают голосование и попадают в `eligible` (остаток N3)                    |
| R2  | 🔵      | `reclaim_host` после рестарта мастера (ветка `restore`) принимает любую версию игры, а `_roomGame` подтверждает её бетам: гости возвращаются сами, бета исполняет застейдженный бандл (остаток N2)    |
| R3  | 🟡      | `HostRole._swapPreempted` «липкий»: передача, начатая и сорванная за время загрузки манифестов, теряет обновление кода; ветка `else` в `HandoffFlow.start` недостижима и не сработала бы (остаток N5) |
| R4  | 🟡      | `_onJoinRoom` проверяет `_hostedRoom` до `await _verifyToken`: `join_room` + `register_host`/`reclaim_host` подряд снимают запись хоста в его комнате (гонка в правке N4.3)                           |
| R5  | 🟡      | `cancelDeferred` безусловно зовёт `refreshWorker` (2 GET манифестов) — при колебании нагрузки до ~12 запросов в минуту на хост                                                                        |
| R6  | 🟡      | Мелочи: журнал `swap preempted by planned host handoff` и при снятии роли/закрытии комнаты; поиск версии каталога в трёх местах `SignalingServer`; двойной `isConfirmed` в `HostVoteManager.start`    |

## Согласовано

Решения принимает исполнитель по поручению разработчика («решение на твоё
усмотрение», 2026-10-05):

1. **R1.** Старт голосования отклоняется причиной `migrating` (уже есть,
   клиент показывает `HOST_VOTE_UNAVAILABLE`), пока текущий хост не прислал
   ни одного `room_peers`, но не дольше нового порога
   `master.room.vote.peersReportGraceMs` = **20 000 мс** с начала его роли
   (`room.hostSince`) — больше `lobby.migration.peersReportIntervalMs`
   (15 000): потерянный первый отчёт повторится внутри окна; по его
   истечении — прежняя совместимость (хост старше `room_peers` подтверждает
   всех). Правило единое; на свежей и восстановленной после рестарта
   комнате оно ничего не меняет (участники младше `minVoterAgeMs` >
   окна), действует после смены хоста. В харнессе
   `HostVoteManager.test.js` комната «стареет» так же, как участники
   (`hostSince -= 60000` — их `joinedAt` по `Date.now()`, часы сервера
   впереди). Связка — в `tests/config/migrationTimings.test.js`. Счётчик
   лобби и выбор беты не меняются (там окно транзиентно: `pickSuccessor`
   снимает фантома на первом отчёте).
2. **R2.** Ветка `restore`: версия, заявленная хостом, сохраняется (и
   `hidden` по `isStaged`, как сейчас), но если каталог знает игру и версия
   не совпадает с его текущей — комната получает
   `unverifiedGameVersion = <заявленная>`, и `_roomGame` не подтверждает
   бетам `room.gameVersion`, пока она равна `unverifiedGameVersion`
   (`versions` — только каталожная). Каталог игру не знает — пометки нет
   (пустой список версий бета трактует как «любая»). Цена: аварийная
   миграция такой комнаты до эстафеты Worker'ов на версию каталога идёт
   холодным рестартом — после рестарта мастера версия игры у хостов обычно
   и так каталожная (игры синхронизируются без рестарта).
3. **R3, R5.** Флаг `_swapPreempted` убирается: эстафету, качающую
   манифесты, после загрузки останавливает сама идущая передача
   (`getHandoff().active`), а сорвавшаяся за это время передача её не
   останавливает. Вместо флага — `HostRole._codeUpdatePending`: ставится,
   когда эстафету отложила (передача уже идёт) или вытеснила
   (`swap preempted`) передача; новый `HostRole.resumeCodeUpdate()` зовёт
   `refreshWorker` только при нём. `HandoffFlow` зовёт `resumeCodeUpdate()`
   в `_onAborted` и при снятой отложенной передаче; недостижимая ветка
   `else` в `start()` удаляется (отказы `PlannedHandoff.start` — ровно
   проверки выше).
4. **R4.** Проверка `_hostedRoom` повторяется после `_verifyToken` (ранняя
   остаётся — экономит запрос к auth).
5. **R6.** Журнал: `swap preempted` (передача или закрытие комнаты) и
   `swap dropped: host role ended` — раздельно. `SignalingServer` —
   помощник `_catalogManifest(gameId)`. `HostVoteManager._isVoter` →
   `_voterRejection` (причина или `null`), порядок причин прежний.

## Этап 1. Голосование после смены хоста (R1, R6) ✅ выполнен

- `config/master.js` → `room.vote.peersReportGraceMs: 20000` + комментарий;
  дефолт в `HostVoteManager`.
- `HostVoteManager.start`: после проверки `status` —
  `_awaitingPeersReport(room, now)` → `reject('migrating')`;
  `_voterRejection` вместо двойной проверки.
- Тесты (`tests/master/HostVoteManager.test.js`): после промоушена фантом
  до `room_peers` нового хоста получает `migrating` (падает до правки);
  после отчёта — `notConnected`; хост без отчётов — после
  `peersReportGraceMs` голосуют все. `tests/config/migrationTimings.test.js`
  — связка `peersReportGraceMs > peersReportIntervalMs`.
- Доки: `docs/{en,ru}/master.md` (раздел «Change host vote», «Старт»),
  `docs/{en,ru}/configuration.md` (`room.vote`). CHANGELOG — запись о
  голосовании.

## Этап 2. Версия игры комнаты после рестарта мастера (R2, R6) ✅ выполнен

- `RoomRegistry._create`: поле `unverifiedGameVersion` (из `fields`,
  иначе `null`).
- `SignalingServer`: `_catalogManifest(gameId)`; ветка `restore` в
  `_onReclaimHost` передаёт `unverifiedGameVersion`; `_roomGame` его
  учитывает.
- Тесты (`tests/master/SignalingServer.test.js`): рестарт +
  `reclaim_host` с застейдженной версией → комната скрыта, бета получает
  `versions` только каталога (падает до правки); с версией каталога —
  как раньше; без каталога — версия комнаты подтверждается.
- Доки: `docs/{en,ru}/master.md` (строки `reclaim_host`, `promote`).
  CHANGELOG — запись о недоверенной точке/версии.

## Этап 3. `join_room` во время регистрации хоста (R4) ✅ выполнен

- `_onJoinRoom`: повторная проверка `_hostedRoom` после `_verifyToken`.
- Тест: `join_room` с задержанной проверкой токена, затем `register_host`
  той же сессией → запись хоста цела, членства в чужой комнате нет
  (падает до правки).
- Доки/CHANGELOG: поведение уже описано («`join_room` от сессии хоста
  игнорируется») — без правок.

## Этап 4. Эстафета Worker'ов и передача (R3, R5, R6) ✅ выполнен

- `HostRole`: без `_swapPreempted`; `_codeUpdatePending`,
  `resumeCodeUpdate()`, раздельный журнал; `teardown()` сбрасывает флаг.
- `HandoffFlow`: `resumeCodeUpdate()` в `_onAborted` и `cancelDeferred`;
  без `_resumeCodeUpdate` и ветки `else` в `start()`.
- Тесты: `HostRole.test.js` — передача началась и сорвалась за время
  загрузки манифестов → своп состоялся (падает до правки);
  `resumeCodeUpdate` без отложенного обновления манифесты не качает (падает
  до правки); отложенное передачей и вытесненное обновление возвращается.
  `HandoffFlow.test.js` — переписаны на `resumeCodeUpdate`.
- Доки: `docs/{en,ru}/host.md`, `docs/{en,ru}/client.md` (абзацы про
  `preemptSwap`). CHANGELOG — запись «Planned host handoff…» (если
  формулировка расходится) — не расходится, без правок.

## Этап 5. Финал ✅ выполнен

prettier по изменённым файлам, `npx eslint .`, `npx vitest run
--reporter=dot`; план — в `plan/done/`, строка в `plan/done/README.md`.

## Release impact

npm `vimp-engine` (мастер + клиент): уточнение записей `[Unreleased]`,
уровень — minor из-за уже существующего `### ⚠️ Breaking`. Протокол не
меняется (причина `migrating` уже есть; `versions` только сужаются).
Крейт, `create-vimp-game`, auth, `surface.json`, репозитории игр не
затронуты.
