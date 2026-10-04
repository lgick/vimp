# Этап 7. Аварийная миграция: детекция, промоушен, переключение клиентов, холодный фолбэк ✅ выполнен

Цель: хост пропал (вкладка закрыта, браузер упал, интернет оборвался,
P2P-сторона сломалась) → мастер переводит комнату в `migrating`, повышает
бету до хоста; бета поднимает матч из последней контрольной точки (откат
≤ ~0.5–1 с игрового времени), регистрируется хостом той же комнаты с эпохой
N+1; остальные клиенты переподключаются к ней через RESUME (этап 4). Без
беты с точкой — холодный перезапуск комнаты на любом способном участнике.
Комната закрывается, только когда в ней не осталось людей.

Зависит от этапов 4 и 6.

## Подэтапы (согласовано с разработчиком 2026-10-02)

Этап слишком широк для одного прохода — исполняется подэтапами, каждый
заканчивается зелёным прогоном и своими доками (страницы своей области).

| #   | Подэтап                                                                                                                                  | Разделы                          | Статус      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------- |
| 7a  | Мастер: `MigrationCoordinator`, машина состояний, проба/кворум, эпохи, `settings`, конфиг                                                | 7.0, 7.1, 7.3, 7.6, 7.8 (мастер) | ✅ выполнен |
| 7b  | Клиент: супервизор в миграции, оверлей, звук, `host_changed`/`room_closed`, ссылка на `migrating`, задержка перед `autoCreate` (7.0 «a») | 7.2, 7.8 (лобби)                 | ✅ выполнен |
| 7c  | Преемник: `Promotion.js`, `checkpoint`/`cold`, grace восстановленных, старый хост                                                        | 7.4, 7.5, 7.8 (Worker)           | ✅ выполнен |
| 7d  | Идемпотентность записей rank (`writeSeq`, миграция 016)                                                                                  | 7.7                              | ✅ выполнен |
| 7e  | Сквозные доки, CHANGELOG (записи мастера внесены в 7a — свести с клиентскими), ручная проверка                                           | 7.10, 7.11, «Проверка»           | ✅ выполнен |

## 7.0. Решение (выбрано исполнителем 7a, одобрено разработчиком 2026-10-02)

- **Детекция — варианты 2 + 3 + 5.** Обрыв WS хоста → комната **сразу**
  `migrating` (grace `hostReclaimGraceMs` больше не закрывает комнату;
  `reclaim_host` той же эпохи до регистрации преемника отменяет миграцию —
  клиентам `host_changed {epoch: N, mode: 'reclaimed'}`, они возобновляются
  к тому же хосту, как при `checkpoint`). `host_unreachable` при
  отсоединённом хосте — «хост потерян» без пробы. Комната не `online` или
  с отсоединённым хостом в `GET /servers` не отдаётся; `getPublic` отдаёт
  `status` (клиентская реакция на `migrating` — 7b). Вариант 4 не берём:
  миграция и так стартует сразу. Вариант 1 (`pagehide`) — этап 8.
- **Лавина — вариант «a»**: перед `autoCreate` быстрой игры клиент ждёт
  случайные 0.5–2 с и повторяет `GET /servers` (подэтап 7b).
- **Свежесть точки беты**: `checkpointMaxAgeMs` = **12000** (было 5000 —
  меньше двух периодов `standbyStatusIntervalMs` 5000, ложные `cold`);
  отсчёт по `receivedAt` мастера, не по часам хоста.

### Итог 7a (2026-10-02)

Сделано: `master/MigrationCoordinator.js`, `RoomRegistry` (`promoteHost`,
`setSettings`, `settings`/`pendingEpoch`/`migration`/`reports`, `sweep` →
`{ lost, removed }`, фильтр списка), `successor.js` (`allowHidden`),
`lib/roomSettings.js`, сигналинг (`host_unreachable`, `probe`/`probe_ack`,
`promote*`, `host_migrating`/`host_changed`/`host_revoked`), конфиг
`master.room.*`, главный поток хоста отвечает на `probe`, хост шлёт
`settings`; доки `master.md`, `configuration.md`; записи CHANGELOG мастера.
Уточнения при исполнении: `host_changed` получил режим `reclaimed` (отмена
миграции reclaim'ом — клиенты возобновляются к тому же хосту, как при
`checkpoint`; учесть в 7b); `promote_failed` узнаётся и по
`promotionToken` (после холодной перезагрузки страница кандидата — не
участник); при закрытии комнаты «нет кандидатов» сокет старого хоста не
закрывается кодом `4000` — он получает `room_closed` как участник (учесть в
7c/7.5). До 7b/7c клиенты на новые сообщения не реагируют: промоушен
истекает по дедлайнам, и комната закрывается `room_closed noHost`.

**Исправления после код-ревью 7a (одобрены разработчиком 2026-10-02):**
(1) `promotionToken` сравнивается только после проверки формата (32 hex) —
`timingSafeEqual` бросал на не-ASCII строке и ронял мастер через
синхронный `promote_failed`; (2) перед стартом миграции проверяется, есть ли
кандидат: при принудительной (`unresponsive`/`unreachable`) без кандидата
хост остаётся, кулдаун не тратится; (3) при `disconnected` без кандидата
комната остаётся `online` с отсоединённым хостом на `hostReclaimGraceMs`,
затем уборка мигрирует (если кандидат появился) или закрывает её
(`noHost`, сокету хоста — `4000`, если он ещё привязан); (4) уборка не
удаляет опустевшую мигрирующую комнату — её закрывает дедлайн промоушена;
(5) `cancelByReclaim` вызывается только после всех проверок reclaim
(`hostLimit` больше не рассылает ложное `reclaimed`).

### Уточнение 7b (одобрено разработчиком 2026-10-02)

- **Ссылка на комнату в `migrating`** — не быстрая игра (вариант 3
  буквально), а ожидание: `#tech-informer` «Switching host…», повтор
  `GET /rooms/:roomId` раз в `session.migrationPollMs` (1000) до
  `session.migrationWaitMs`; стала `online` → вход; пропала / не
  дождались → быстрая игра той же игры. Причина: F5 или переход по ссылке
  во время миграции не должны выбрасывать игрока из живой комнаты.
- Задержка перед `autoCreate` — `quickPlay.createDelayMinMs`/`MaxMs`
  (500/2000) в `config/lobby.js`.
- После возобновления отдельный `clientCore.resync?.()` не нужен:
  `handleSessionResumed` уже зовёт `clientCore.reset()`, а он — надмножество
  `resync` (`core/src/client/game.rs`).

**Исправления после код-ревью 7b (одобрены разработчиком 2026-10-02):**
(1) `session.migrationWaitMs` = **40000** (было 20000 в 7.2): мастер законно
ищет преемника до `promotionTimeoutMs` + `coldPromotionTimeoutMs` = 35 с, и
гости с 20 с уходили в быструю игру из живой комнаты; (2) ожидание по
ссылке уходит в быструю игру только при `404` (комнаты нет) — сетевая
ошибка или `5xx` считаются «ещё мигрирует» и повторяются до дедлайна;
(3) смена hash во время ожидания прерывает его — разбирается новый маршрут.

### Итог 7b (2026-10-02)

Сделано: `SessionSupervisor` — состояние `migrating`, `migrate()`,
`hostChanged({mode})`, колбэки `onHostLost` (→ `host_unreachable`) и
`onColdRestart`; `SignalingClient.hostUnreachable`; `main.js` — обработчики
`host_migrating`/`host_changed` (фильтр по `roomId`, эпохе, только гость),
оверлей «Switching host…», звук не включается на паузе, ожидание
мигрирующей комнаты по ссылке (`waitRoomOnline`), пауза перед `autoCreate`;
`roomLink.js` — `isMigrating`, `quickPlayCreateDelay`, действие `wait`;
конфиг `session.migrationWaitMs`/`migrationPollMs`,
`quickPlay.createDelayMinMs`/`MaxMs`; доки `client.md`, `configuration.md`;
запись CHANGELOG. `reclaimed` вне ожидания игнорируется (транспорт к тому же
хосту годен). Не входило (7c): `promote`, `host_revoked`, бета в ожидании
просто ждёт.

### Уточнение 7c (одобрено разработчиком 2026-10-02)

- **Системные сообщения — только кодами.** «Host changed» (7.4 п. 7) —
  движковый код `HOST_CHANGED: 's:7'`, его шлёт Worker всем после старта
  матча из точки; «You are no longer the host (connection lost)» (7.5) —
  движковый код `HOST_REVOKED: 's:8'`, клиент старого хоста добавляет его в
  чат локально по коду. Контракт B8: группа `s` зарезервирована до 8.
  Тексты — в клиентских конфигах игр: `../vimp-tanks`, `../vimp-snakes`,
  шаблон скаффолдера, фикстура `tests/fixtures/miniGame` (замороженные
  `generations/*` не трогаются).
- **Аудит сообщений, уходящих текстом вместо кода**: в движке, snakes и
  шаблоне таких нет; в tanks — `/mapname` (→ движковый `MAP_CURRENT`) и
  `/timeleft` (→ игровой код танков `TIME_LEFT: 't:0'`, «Time left: {0}»).
- Механика (детали исполнения): `start_after_restore {waitForResume: true}`
  — Worker стартует, когда возобновились все люди точки или прошло
  `resumeWaitMs`, затем заводит grace не вернувшимся
  (`PortMachine.startGraceFor`); без поля — немедленный старт, как раньше.
  Свой клиент преемника/старого хоста переключается
  `SessionSupervisor.resumeWith(transport, {reconnect, getToken})`;
  `LoopbackTransport` получает режим `resume`. Ошибка `staleEpoch` у хоста
  ведёт тем же путём, что `host_revoked` (снять роль, стать гостем).

### Итог 7c (2026-10-02)

Сделано: `client/network/Promotion.js` (точка → прогретый/новый Worker,
`savePendingPromotion`/`takePendingPromotion`), в `main.js` — общая роль
хоста (`adoptHostRole`/`startHostRegistration`/`teardownHostRole`,
обработчики сигналинга роли подписаны один раз в `bindHostSignaling`),
`promote`/`promote_cancelled`/`host_revoked`, холодный промоушен в
бутстрапе маршрута, `demoteHost`; `HostGame.startAfterResume`/
`detachedGameIds`, `PortMachine.startGraceFor`, Worker
`start_after_restore {waitForResume}`, `hostDefaults.resumeWaitMs`;
`HostController.initFromCheckpoint`, `HostPrewarm.take`,
`SessionSupervisor.resumeWith`, `LoopbackTransport {resume}`,
`SignalingClient.registerHost({promotion})`/`promoteFailed`; коды
`s:7`/`s:8` + тексты в tanks, snakes, шаблоне, фикстуре, docs/ai; tanks
`/timeleft` → `TIME_LEFT` (`t:0`), `/mapname` → `MAP_CURRENT`. Доки
`host.md`, `client.md`, `configuration.md` (en/ru), `docs/ai`; CHANGELOG
движка, скаффолдера, tanks, snakes. Вне подэтапа замечено: в tanks 6 тестов
эстафеты (`tests/host/HostGame.test.js`) красные и без правок 7c.
Причина — асинхронный `requestHandoff` и формат меты v4 (этап 5), а не
давний разрыв; исправлено в `plan/host-migration-review/stage_11.md`.

**Исправление после код-ревью 7c (одобрено разработчиком 2026-10-02):**
сбой возврата своего игрока преемника не должен гасить уже занятую комнату.
(1) Промоушен `checkpoint` без секрета места у своего супервизора
отклоняется сразу (`promote_failed`, мастер берёт следующего / `cold`);
(2) если после `host_registered` свой игрок не вернулся (нет секрета,
`RESUME_RESULT !ok`, закрытие/таймаут loopback'а), роль хоста сохраняется —
Worker, пиры, heartbeat, поток точек живут, гости играют; своему игроку —
«Your player could not be restored — the room keeps running for the
others.» без перезагрузки (`SessionSupervisor.resumeWith({ onFailed })`).
Плановая передача из этого состояния — этап 8.

### Итог 7d (2026-10-02)

Сделано: `PlayerDataSync` — запись результата получает номер в момент
отправки и уходит из `pendingPoints`/`pendingBest` в `inFlightWrite
{ writeSeq, points, best }`; `ok`/`4xx` (кроме 429) её закрывают, `5xx`/429/
сеть — оставляют, повтор идёт с тем же номером и суммой, накопленное за
сбой уходит следующим номером в той же серии flush; `serialize`/`restore`
везут `inFlightWrite` (после ревью — очередь `writes`; закрыт сценарий ревью этапа 5 — эстафета с зависшим
PUT); `writeSeq` больше не растёт на записи state. Мастер (`lobby.js`,
`PlayerDataProxy.putRank`) пробрасывает `writeSeq` (`readWriteSeq` в
`lib/validators.js`; мусор отбрасывается, не отклоняется). Auth: миграция
`016_rank_write_idempotency.sql`, `recordGameResult` — `ON CONFLICT DO
NOTHING`, агрегат только из вставки, возвращает `{ inserted }`; `PUT /rank`
на дубль — `{ ok: true, duplicate: true }`. SQL проверен на временной БД
Postgres (дубль отсеян, агрегат не удвоен). Доки `auth.md`, `master.md`,
`host.md` (en/ru); CHANGELOG движка — `### Fixed`.
**Уточнение при исполнении:** старт `writeSeq` — случайный (`random() *
2^48`) на запись профиля, а не 0: участник, вышедший и вернувшийся в ту же
комнату, получает новую запись, и счёт с нуля совпал бы с номерами
прошлого входа — auth выбросил бы честные очки как дубль. Не охвачены
записи без комнаты (`session_id NULL`: до `host_registered` или с секретом
прошлой эпохи) — `NULL` в уникальном индексе различны.

**Исправления после код-ревью 7d (одобрены разработчиком 2026-10-02):**
(1) ключ дубля — без комнаты: уникальный индекс `(user_id, game_id,
write_seq) WHERE write_seq IS NOT NULL` (с `session_id` копия, записанная
без атрибуции — секрет прошлой эпохи, до `setRoom`, — не совпадала с
повтором и засчитывалась дважды); уникальность номеров держит случайный
старт, теперь из `crypto.getRandomValues` (48 бит); (2) restore не
продолжает номера точки: летящая запись сохраняет свой номер N, накопленное
на момент точки сразу закрепляется под N+1 (номер, который дал бы ему старый
хост — его отправку auth отсеет), все последующие записи — из нового
случайного диапазона (иначе свежие очки нового хоста совпали бы с номерами,
которые старый хост успел занять после точки, и были бы выброшены как
дубль). Закреплённых записей может быть две — `inFlightWrite` становится
очередью `writes`. Остаточный риск: игры, законченные в откатываемом окне
(≤ 1 с), могут засчитаться повторно.

### Итог 7e (2026-10-02)

Сделано: `architecture.md` — абзац о миграции в «The host tab», «Connection
lifecycle» без «the host leaving kills the room», инвариант «комната живёт,
пока в ней есть люди» + эпохи; `network.md` — подраздел «Host migration»
(схема сообщений, семантика отката: окно ~0.5 с, `seq` + 30, отпущенные
команды и повтор удерживаемых клавиш, голосования, `writeSeq`); `host.md` —
обзорный раздел «Host migration», абзац регистрации и пункт ручного
чек-листа (обрыв хоста) обновлены; en/ru синхронно. `master.md`,
`client.md`, `auth.md` закрыты в 7a–7d. CHANGELOG движка: три записи
миграции (мастер, гости, преемник) сведены в одну `### Added` с
подпунктами; `### Changed` «комната закрывается, только когда некому
принять» уже была. **Ручная проверка (3 профиля, «Проверка») не
выполнялась исполнителем** — за разработчиком, пункт добавлен в
«Manual run checklist» `host.md`.

### Исправления после ручной проверки разработчиком (2026-10-02)

1. **Хост ушёл — у преемника пустой экран и падение парта карты**
   (`tileGrid.js` `reading 'x'`). Пакет входа `_sendResumeEntry` слал
   `CLEAR` без списка (клиент стирает и карту) без `MAP_DATA`; первый кадр
   создавал сущности карты из частичных данных. Теперь пакет —
   `KEYSET 0 → CLEAR → MAP_DATA → FIRST_SHOT …` (карта —
   `RoundManager.currentMapData`, без сброса `isReady`); клиент применяет
   `MAP_DATA` с меткой хоста `resume: true` без `MAP_READY` и `setLoading`
   (не по `supervisor.resuming` — после ревью: неготовому участнику в том
   же окне приходит обычная загрузка карты).
   Касалось и возобновления к тому же хосту (этап 4).
2. **Вход по ссылке — матч под лобби.** `LobbyAuthView.showLobby` на
   `authenticated` показывал `#lobby` до разбора маршрута, а маршрут
   комнаты лобби не создаёт (`lobby?.close()` — no-op). Лобби показывает
   только `main.js` (`initLobby`/`showLobby`); повторный логин при
   разобранном маршруте вне комнаты — `lobby.open()`.
3. **Хост и преемник закрыты разом — третьего «выкидывает в лобби».**
   Мастер ждал мёртвого `checkpoint`-кандидата `promotionTimeoutMs`;
   теперь закрытие его WS (`MigrationCoordinator.onMemberGone`) сразу
   передаёт промоушен следующему (`cold`-кандидата не трогает — он
   перезагружается). Видимая «выкидка» — тот же баг 2 после холодной
   перезагрузки.
4. «Hand over host» — по плану этап 8 (8.3).
5. «Copy link» убран из меню ☰ (ссылка и так в адресной строке); меню без
   пунктов скрыто. Кнопка на карточке лобби осталась.

## 7.0 (исходное). Наблюдение из код-ревью этапа 3

> Зафиксировано разработчиком 2026-10-01: решения ниже **не выбраны**.
> Исполнитель этапа (AI) выбирает сам, обосновывает выбор в отчёте и
> отражает его в 7.1–7.3.

**Проблема.** Мастер видит только обрыв WS хоста и не отличает «вкладка
хоста закрыта/упала» (матч мёртв) от «оборвался лишь сигналинг» (матч жив по
WebRTC). Поэтому комната с потерянным хостом живёт ещё
`hostReclaimGraceMs` (10 с) + до `sweepInterval` (10 с), и всё это время
отдаётся в `GET /servers` и `GET /rooms/:roomId` как живая. Следствия
(с этапа 3): гость после закрытия комнаты перезагружается в быструю игру
`#/<gameId>`, `pickQuickPlayRoom` выбирает ту же мёртвую комнату → оффер →
`unknownRoom` → снова перезагрузка — цикл до уборки реестра. Позиция
разработчика: хост не приоритетен — при сбое назначать нового, хоста нет —
закрывать; ждать 10–20 с незачем.

**Варианты детекции (можно сочетать):**

1. Явный уход хоста: `pagehide` → `host_leaving` (8.4) → мастер сразу
   переходит в `migrating` (или закрывает, если людей нет). Покрывает
   закрытие вкладки, F5, переход — основной случай.
2. Свидетельство гостей: оборвался WebRTC к хосту → `host_unreachable`
   (7.3); если сессия сигналинга хоста уже отсоединена — «хост потерян»
   немедленно, без grace; если хост на связи — проба (7.3).
3. Комната с отсоединённым хостом (`host.sessionId === null`) не выдаётся:
   фильтр в `RoomRegistry.getList`, а `getPublic` — либо 404, либо
   `status`, по которому `decideRouteAction` уходит в быструю игру. Нового
   публичного поля не требует.
4. Сократить `hostReclaimGraceMs` (например, до 2–3 с) и/или звать
   `sweep` таймером ровно на истечении grace (уже есть) без ожидания
   `sweepInterval`. Риск: короткий сбой сигналинга живого хоста запустит
   миграцию впустую (дешевле после этапа 7, т.к. комната не закрывается).
5. Оставить grace, но в `migrating` переходить сразу (как уже написано в
   7.1 п.1), а отмену — по `reclaim_host` до `promote`-регистрации.

**Лавина комнат при закрытии.** Когда комната всё же закрыта
(`room_closed`/«нет кандидатов»), все гости одновременно уходят в быструю
игру, не находят комнат и при `quickPlay.autoCreate` каждый создаёт свою —
N комнат по одному игроку. Варианты:

- a. Клиент: случайная задержка (например, 0.5–2 с) и повторный
  `GET /servers` перед созданием.
- b. Мастер-арбитр: сигнальное сообщение `quick_play {gameId}`; мастер
  отвечает `{roomId}` либо разрешает создание одному участнику, остальным —
  «ждите» и затем `{roomId}` новой комнаты.
- c. Бывшие участники закрытой комнаты не уходят в быструю игру, а один из
  них (назначенный мастером в `room_closed`) создаёт комнату, остальным
  мастер присылает её `roomId`.
- d. Принять как есть: после этапа 7 закрытие при живых людях — редкость
  («нет способных кандидатов»).

Попутно: тексты выхода в `client/main.js` после ревью этапа 3 уже говорят
«Finding another room…» (закрытие → быстрая игра); если выбранный путь
это меняет — поправить их.

## 7.1. Мастер: машина состояний комнаты

Новый модуль `master/MigrationCoordinator.js` (чтобы не раздувать
`SignalingServer.js`; сигналинг вызывает его и даёт ему `send(sessionId,
msg)`), данные — в `RoomRegistry`:

```
online(epoch N) ──host lost──► migrating(N → N+1) ──register ok──► online(N+1)
     ▲                              │ timeout → следующий кандидат (cold)
     └──────── нет живых людей ◄────┘ нет кандидатов → room_closed
```

**«Хост потерян»** — любое из:

1. закрылся WS хоста (с этапа 2 — после `hostReclaimGraceMs`; в
   `migrating` переходить **сразу**, но если хост успел `reclaim_host` той
   же эпохи до `promote`-регистрации беты — отменить миграцию
   (`promote_cancelled` бете), это обычный реконнект сигналинга);
2. heartbeat истёк / сессия хоста `terminate` по `wsDeadAfterMs` (этап 6);
3. `host_leaving` (этап 8, `pagehide`);
4. отчёты клиентов (7.3).

При «хост потерян»:

- живых людей кроме хоста нет → удалить комнату;
- `room.status = 'migrating'`, `pendingEpoch = epoch + 1`, разослать
  участникам `host_migrating {roomId, epoch: pendingEpoch, reason}`;
- выбрать преемника: назначенная бета с `standby_status` не старше
  `checkpointMaxAgeMs` (12000, см. 7.0) → режим `checkpoint`; иначе
  `pickSuccessor` (этап 6) без фильтра `hidden` (в аварии берём любого
  способного) → режим `cold`; способных нет → `room_closed {reason:
'noHost'}` и удалить;
- `promote {roomId, epoch: pendingEpoch, promotionToken, mode, reason,
settings}` преемнику (`promotionToken` — 128 бит, одноразовый;
  `settings` — сохранённые настройки комнаты для `cold`, см. 7.6);
- дедлайн `promotionTimeoutMs` (10000; для `cold` —
  `coldPromotionTimeoutMs` 25000, т.к. преемник перезагружает страницу) →
  следующий кандидат в режиме `cold`.

**`register_host {roomId, epoch, promotionToken, memberId, token, …}`** от
преемника: токен и эпоха совпадают → `room.host = {…}`, `epoch =
pendingEpoch`, `roomSecret = deriveRoomSecret(roomId, epoch,
newHostUserId)` (этап 2 — секрет старого хоста перестаёт подходить сам),
`status = 'online'`, лимит «IP не
хостит другую комнату» **не применяется** (промоушен — не создание);
ответ `host_registered`; всем остальным участникам `host_changed {roomId,
epoch, mode}`; старому хосту, если его сессия ещё жива,
`host_revoked {roomId, epoch}`.

**Ограждение эпохой**: `update_host`, `webrtc_answer`, `ice_candidate`
от сессии, которая не текущий хост комнаты, игнорируются;
`register_host`/`reclaim_host` с устаревшей эпохой → `error {code:
'staleEpoch'}`; клиенты отбрасывают сигнальные сообщения с чужой эпохой
(`WebRtcManager`, этап 4).

## 7.2. Клиент: детекция и ожидание

`SessionSupervisor` (этап 4) расширяется:

- обрыв транспорта или сторожок тишины в лобби-режиме → сначала
  `host_unreachable {roomId, epoch}` мастеру, затем состояние
  `reconnecting` (как в этапе 4: если хост жив и это был сетевой провал
  клиента — переподключение к тому же хосту просто сработает);
- `host_migrating` → состояние `migrating`, оверлей «Switching host…»,
  клавиши выключены. **Транспорт к старому хосту закрывается немедленно**
  (`WebRtcManager.destroy()` → `pc.close()`, не дожидаясь таймаутов ICE),
  а всё, что успело прийти от не-текущего транспорта, супервизор
  отбрасывает. Это защита от «зомби-хоста» (split-brain): старый хост,
  потерявший связь с мастером, может ещё крутить Worker и слать кадры
  эпохи N, пока бета начинает эпоху N+1 — у клиентов не должно быть двух
  источников кадров ни на миг. Для этого же старому хосту приходит
  `host_revoked`, а при возврате связи его `reclaim_host` получает
  `staleEpoch` (этап 2) → он снимает роль (7.5).
  **Самозаморозка хоста при потере WS мастера — сознательно не делается**:
  при деплое мастер перезапускается и рвёт WS всех хостов разом —
  заморозка остановила бы все матчи на каждый деплой. Изоляция зомби
  обеспечивается со стороны клиентов (закрытие соединений) и эпохой;
- рендер на паузе: цикл рендера **не** останавливается (кадр стоит,
  анимации партов, не зависящие от новых снапшотов, продолжаются), а
  **звук глушится** тем же путём, что при скрытой вкладке
  (`visibilitychange`-хендлер `main.js:1273-1312`: mute/unmute
  `soundManager`) — иначе зацикленные звуки (моторы и т.п.) гудят на одной
  ноте всю паузу; после возобновления — unmute и `clientCore.resync?.()`
  (тот же вызов, что после скрытой вкладки);
- `host_changed {epoch, mode}`:
  - `checkpoint`/`planned` → новый `WebRtcManager` к `roomId` с `resume:
true` и новой эпохой → `RESUME_REQUEST` (этап 4); `RESUME_RESULT !ok` →
    `reloadTo(ссылка на комнату)`;
  - `cold` → `reloadTo(ссылка на комнату)` (свежий матч, полное
    рукопожатие);
- ничего не пришло за `lobbyConfig.session.migrationWaitMs` (20000) или
  пришёл `room_closed` → комната закрыта: `reloadTo(formatGameLink(gameId))`
  — быстрая игра той же игры (правило выхода, README).

## 7.3. Мастер: отчёты клиентов и проба хоста

- `host_unreachable` принимается только от участника этой комнаты, с
  текущей эпохой, не чаще раза в 2 с на участника.
- Первый отчёт при живом WS хоста → `probe {nonce}` хосту; главный поток
  хоста отвечает `probe_ack {nonce}` сразу (обработчик в `main.js` рядом с
  `host_registered`). Нет ответа за `probeTimeoutMs` (2000) → «хост
  потерян» (причина `unresponsive`).
- Ответ есть, но за `reportWindowMs` (5000) отчиталось ≥ `max(1,
ceil(живые_гости / 2))` гостей → P2P-сторона хоста сломана →
  принудительная миграция (причина `unreachable`): старому хосту
  `host_revoked`. Анти-флаппинг: принудительные (не по закрытию WS)
  миграции — не чаще раза в `forcedMigrationCooldownMs` (30000) на
  комнату; внутри кулдауна — только проба.

## 7.4. Преемник: становление хостом (`client/network/Promotion.js`)

Вынести из `connectAsHost` (`main.js:1578-1776`) общую часть «запустить роль
хоста для готового `HostController`» (HostConnectionManager, heartbeat,
`set_room`, обработчики `host_registered`/`update_available`/`probe`) — её
зовут и `connectAsHost`, и промоушен.

Режим `checkpoint`:

1. точка — `StandbyReceiver.latest()`; прогретый `HostController`
   (этап 6) или новый, если прогрева нет;
2. Worker: `init { room: {…settings, game, roomId, epoch}, checkpoint,
seqFloor: lastSeenSeq }` → `ready` (матч на паузе);
3. `register_host {roomId, epoch, promotionToken, memberId, token, gameId,
gameVersion, mapName, maxPlayers, settings, caps}`;
4. `host_registered` → `HostConnectionManager` принимает офферы; heartbeat;
5. собственный клиент беты: супервизор отсоединяет `WebRtcManager` (к
   старому хосту) и подключает `LoopbackTransport(hostController, 'local')`
   с `resume` → `RESUME_REQUEST` со своим `resumeKey`/`gameId` → Worker
   привязывает `'local'` к участнику беты; `isHostPlayer` в мете
   переезжает на него (освобождение от киков, `HostGame.js:303-305`);
6. `start_after_restore` — когда возобновились все люди из точки или
   прошло `resumeWaitMs` (3000), что раньше; отсоединённые после
   `resumeGraceMs` (этап 4) удаляются — это и старый хост, если он не
   вернулся;
   > **Из ревью этапа 5 (подтверждено).** Таймер ожидания возврата сейчас
   > заводит только `PortMachine._startGrace` — на обрыве
   > (`disconnect` → `detachUser`). Люди, поднятые из точки
   > (`HostGame._restoreState`, `detachedAt = now`), таймера не получают:
   > не вернувшийся занимает слот (`isFull`) и держит актора в мире вечно —
   > idle/RTT-кики отсоединённых пропускают. Сделать: при `init` из точки
   > Worker заводит `resumeGraceMs`-таймер на каждого отсоединённого
   > восстановленного (например, `PortMachine.startGraceFor(gameIds)` по
   > списку из `HostGame`, отсчёт — от `start_after_restore`, чтобы пауза
   > переключения не съедала окно). Тест: точка → новый хост → один
   > участник не возобновился → по истечении снят (`removeUser`), слот
   > свободен, актора в ядре нет.
7. игрокам — информ «Host changed» (существующий `GAME_INFORM_DATA`/
   `TECH_INFORM_DATA` с новым кодом сообщения в реестре движка; найти
   реестр `systemMessages`/`gameCodes.js`).

Режим `cold`: сохранить `{roomId, epoch, promotionToken, gameId, settings}`
в `sessionStorage` (ключ `vimp.promotion`) → `reloadTo(ссылка на
комнату)`; бутстрап (этап 3) видит отложенный промоушен → `connectAsHost`
с этими настройками, но вместо создания комнаты — `register_host` с
`roomId/epoch/promotionToken` (занять комнату). Остальные участники в
`cold` перезагружаются по ссылке и входят с полным рукопожатием.
Ключ `sessionStorage` удалить после использования; читать в
`try/catch`.

Сбой на любом шаге (импорт плагина, wasm, `init` → `error`) → преемник
шлёт `promote_failed {roomId, epoch}` → мастер берёт следующего кандидата
(`cold`).

## 7.5. Старый хост, который «вернулся»

`host_revoked` (сеть вернулась, вкладка была заморожена, раздел сети):
остановить Worker, `HostConnectionManager.destroy()`, heartbeat,
`beforeunload` (этап 8); собственный клиент → супервизор переводит его в
гостя новой эпохи (`WebRtcManager` + RESUME под своим `gameId` — его
участник есть в точке беты как отсоединённый); `!ok` → `reloadTo(ссылка)`.
Сообщение игроку: «You are no longer the host (connection lost)».

## 7.6. Настройки комнаты для холодного старта

`register_host` (этап 2) получает поле `settings` — те же настройки, что
форма создания комнаты передаёт в `connectAsHost` (карта, лимит, таймеры,
friendly fire и т.п. — всё, что читает `lib/applyRoomOverrides.js`). Мастер
хранит их как есть после санитизации: только известные ключи (взять
список из `applyRoomOverrides`), числа клампятся, общий размер ≤ 4 КБ; в
`GET /servers` не отдаются.

## 7.7. Идемпотентность записей rank (откат не должен удваивать очки)

Сценарий: старый хост после последней точки записал результат матча →
упал → бета восстановилась из более ранней точки → раунд закончился снова
→ запись ушла второй раз. Защита — номер записи:

- `PlayerDataSync` (этап 5 уже хранит `writeSeq` в точке) добавляет в тело
  `PUT /auth/rank` поля `roomId` и `writeSeq` (монотонно на участника);
  > **Из ревью этапа 5 (подтверждено).** Второй путь двойного зачёта —
  > эстафета Worker'ов внутри вкладки: `flushAll` не уложился в
  > `handoffFlushTimeoutMs`, `_collectHandoff` сериализует `pendingPoints`
  > вместе с суммой летящего запроса (вычитается только по успеху), старый
  > Worker гасится — запрос мог дойти, новый Worker шлёт ту же сумму снова.
  > Сейчас `_sync` увеличивает `writeSeq` **до** отправки, и повтор ушёл бы
  > с другим номером — дедупликация его не поймает. Сделать: номер
  > закрепляется за конкретной записью (точка/эстафета несут
  > `inFlightWrite: { writeSeq, points, best }`), повтор после
  > восстановления шлёт **тот же** `writeSeq` и ту же сумму, а
  > `pendingPoints` в точке — без неё. Тест: эстафета с зависшим PUT →
  > новый Worker повторяет запись с тем же `writeSeq`; auth отвечает на
  > дубль 200 без второй строки.
- мастер (`master/PlayerDataProxy.js`, `lobby.js` PUT `/auth/rank`)
  пробрасывает их в auth;
- auth: миграция `packages/auth/src/db/migrations/016_rank_write_idempotency.sql`
  — `ALTER TABLE rank_events ADD COLUMN IF NOT EXISTS write_seq BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS rank_events_write_idx ON rank_events
(session_id, user_id, game_id, write_seq) WHERE write_seq IS NOT NULL;`;
  `UserRepository.recordGameResult` — `INSERT … ON CONFLICT DO NOTHING`, и
  все производные обновления (кэш `ratings.rank`, `game_results`, агрегаты
  периодов — миграции 007/008) — **только если строка вставилась**;
  дубль — `200` с `{duplicate: true}`.
- `PUT /auth/state` — последняя запись побеждает (абсолютное значение);
  оставить как есть, задокументировать.

## 7.8. Конфиг

`config/master.js` (`master.room.*`): `checkpointMaxAgeMs`,
`promotionTimeoutMs`, `coldPromotionTimeoutMs`, `probeTimeoutMs`,
`reportWindowMs`, `forcedMigrationCooldownMs`. `config/lobby.js`:
`session.migrationWaitMs`; `config/hostDefaults.js`: `resumeWaitMs`.
`docs/{en,ru}/configuration.md`.

## 7.9. Тесты

- `tests/master/MigrationCoordinator.test.js` (фейковые ws и часы):
  закрытие WS хоста → `host_migrating` → `promote(checkpoint)` бете →
  `register_host` → `host_changed` всем, `host_revoked` старому; таймаут
  промоушена → следующий кандидат `cold`; кандидатов нет →
  `room_closed`; людей нет → удаление; `reclaim_host` до регистрации беты
  отменяет миграцию; устаревшая эпоха; неверный `promotionToken`;
  обход IP-лимита; отчёты + проба (ответ есть/нет, кворум, кулдаун);
  `promote_failed`.
- `tests/client/network/SessionSupervisor.test.js` — `host_migrating` →
  `host_changed(checkpoint)` → RESUME; `cold` → `reloadTo`; таймаут
  ожидания; `host_revoked` для бывшего хоста; на `host_migrating` старый
  транспорт уничтожен сразу (`pc.close` вызван), сообщения, пришедшие
  от него позже, отброшены (зомби-хост); звук заглушён на время
  `migrating` и включён после возобновления.
- `tests/client/network/Promotion.test.js` — оба режима (моки
  `HostController`, сигналинга, `sessionStorage`, `location`).
- `tests/host/HostGame.checkpoint.test.js` — `start_after_restore` по всем
  возобновившимся / по таймауту, перенос `isHostPlayer`.
- `tests/auth/UserRepository.test.js` — повторная запись с тем же
  `write_seq` не меняет rank/агрегаты (если тесты auth ходят в реальный
  Postgres — посмотреть, как устроены существующие, и следовать им);
  `tests/master/PlayerDataProxy.test.js` — проброс полей.

## 7.10. Документация

`docs/{en,ru}/architecture.md` — «Connection lifecycle» и «Key invariants»
(убрать «the host leaving kills the room»; добавить «комната живёт, пока в
ней есть люди», эпохи); `host.md` — новый раздел «Host migration»
(аварийный путь целиком, откат к точке — что видит игрок, `seq`,
отпущенные клавиши), раздел «Main thread: router…» (промоушен);
`master.md` — машина состояний комнаты, все новые сообщения, проба,
кворум; `client.md` — супервизор в миграции, `cold`-перезагрузка;
`network.md` — «Connection lifecycle», семантика отката; `auth.md` —
`write_seq` и идемпотентность.

## 7.11. CHANGELOG

`### Added`: host migration on host loss — the master promotes the standby
successor, which restores the match from its last checkpoint; clients
reconnect and resume; a cold restart keeps the room when no checkpoint is
available; rank writes are idempotent (`writeSeq`). `### Changed`: a room
is closed only when no players remain.

## Проверка

Автотесты зелёные. Вручную (3 профиля, tanks с `midRound: true`):
закрыть вкладку хоста посреди раунда → у остальных оверлей на 1–3 с, мир
откатился максимум на ~0.5 с, тот же раунд и счёт продолжаются, новый хост
— бета; то же в snakes (длины змей сохранены); выдернуть сеть у хоста
(DevTools → offline) → то же через отчёты/пробу; вернуть сеть у старого
хоста → он стал гостем; убить одновременно хоста и бету → холодный
перезапуск комнаты с тем же `roomId` у третьего игрока.

## Готово, когда

Проверки зелёные, доки en/ru синхронны, CHANGELOG обновлён, release impact
в отчёте (npm `vimp-engine` minor; auth — миграция 016, порядок выката —
этап 11).
