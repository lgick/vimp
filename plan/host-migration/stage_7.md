# Этап 7. Аварийная миграция: детекция, промоушен, переключение клиентов, холодный фолбэк

Цель: хост пропал (вкладка закрыта, браузер упал, интернет оборвался,
P2P-сторона сломалась) → мастер переводит комнату в `migrating`, повышает
бету до хоста; бета поднимает матч из последней контрольной точки (откат
≤ ~0.5–1 с игрового времени), регистрируется хостом той же комнаты с эпохой
N+1; остальные клиенты переподключаются к ней через RESUME (этап 4). Без
беты с точкой — холодный перезапуск комнаты на любом способном участнике.
Комната закрывается, только когда в ней не осталось людей.

Зависит от этапов 4 и 6.

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
  `checkpointMaxAgeMs` (5000) → режим `checkpoint`; иначе
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
  пришёл `room_closed` → терминально (сообщение + лобби этой игры).

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
