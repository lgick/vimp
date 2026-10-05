# План: исправления по `/code-review` правок host-migration-review-3

Основание — фоновый `/code-review` правок
`plan/done/host-migration-review-3.md` (2026-10-05), пункты 1–7 разбора
(пункт 8 — окно в `RoomRegistry.isConfirmed` — оставлен как есть, пункт 9 —
кэш манифестов — отклонён). Общие правила — как в
`plan/done/host-migration-review-2/README.md`: тест первым (падает до
правки), доки en/ru в том же изменении, правится текст существующих записей
`[Unreleased]`, протоколы не меняются, без коммитов. В конце —
`npx prettier --write`, `npx eslint .`, `npx vitest run --reporter=dot`.

## Находки

| #   | Уровень | Суть                                                                                                                                                                                          |
| --- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 🔵      | Пометка непроверенной версии решается один раз при `restore`: мастер слушает порт с неполным каталогом (`FIRST_SYNC_DEADLINE` 15 с) — каталог не знает игру, заявленной версии верят навсегда |
| C2  | 🟡      | Пометка не снимается: одобренная позже версия после следующей публикации выпадает из `versions` — аварийная миграция до эстафеты идёт холодной                                                |
| C3  | 🟡      | `_onPromotedRegister`/`_onReclaimHost`/`_onRegisterHost` проверяют `session.roomId` только до `await _verifyToken`: две регистрации одной сессии подряд привязывают её к двум комнатам        |
| C4  | 🟡      | Окно ожидания `room_peers` в `HostVoteManager.start` проверяется раньше `host`/`notConnected`/`tooNew` — у хоста старше `room_peers` первые 20 с вместо точной причины `migrating`            |
| C5  | 📄      | `docs/{en,ru}/client.md`: «`preemptSwap()` снимает эстафету, ещё качающую манифесты» — уже не так                                                                                             |
| C6  | 🧪      | Нет теста этапа 2 прошлого плана: восстановление с версией каталога — как раньше                                                                                                              |
| C7  | 🟡      | `HandoffFlow.start` вытесняет эстафету до решения `PlannedHandoff.start`; безопасность держится на комментарии                                                                                |

## Согласовано

Разработчик: «исправь 1-7» (2026-10-05); решения внутри пунктов — по
разбору, изложенному ему:

1. **C1, C2.** При `restore` версия помечается непроверенной
   (`unverifiedGameVersion`), если у мастера есть каталог, игра указана, а
   каталог не раздаёт заявленную версию как текущую — в том числе когда
   игру ещё не знает. Без каталога вовсе (тесты, dev) — не помечается.
   Пока комната на помеченной версии:
   - `_roomGame` её не подтверждает (`versions` — только каталожная);
   - если каталог игру не знает — беты нет (`_reviewSuccessor` её не
     назначает, назначенную снимает): пустой список версий бета прочла бы
     как «любая», а разрешение, выданное до загрузки каталога, устарело бы.
     Каталог загрузится — периодический `reviewSuccessors` назначит бету.
   - Пометка снимается при пересмотре беты (`_reviewSuccessor`, в том
     числе периодическом), как только каталог раздаёт помеченную версию
     как текущую; дальше версия обычная.
2. **C3.** После `await _verifyToken` в `_onRegisterHost` (обе ветки, в том
   числе `_onPromotedRegister`) и `_onReclaimHost` — повторная проверка
   `session.roomId` → `alreadyRegistered`, как до `await`.
3. **C4.** Проверка окна `_awaitingPeersReport` переносится после проверок
   `host` и `_voterRejection`.
4. **C7.** `HandoffFlow.start`: сначала `HostRole.canPreemptSwap()` (false —
   своп уже переносит состояние, передача отклоняется), затем
   `PlannedHandoff.start`, и только начавшаяся передача вытесняет эстафету
   (`HostRole.preemptSwap()`). Для проверки — геттер
   `HostController.swapCarryingState`. Всё синхронно: состояние свопа между
   проверкой и вытеснением не меняется.

## Этап 1. Версия игры восстановленной комнаты (C1, C2, C6) ✅ выполнен

- `SignalingServer`: `_unverifiedGameVersion` (правило п. 1),
  `_gameVersionUnverified(room)`, `_verifyGameVersion(room)`;
  `_roomGame`, `_reviewSuccessor` — по п. 1.
- Тесты (`tests/master/SignalingServer.test.js`, блок `reclaim_host`):
  каталог ещё не знает игру → беты нет; каталог загрузился → бета с
  версией каталога (падает до правки); помеченную версию одобрили, затем
  опубликовали следующую → бете обе (падает до правки); восстановление с
  версией каталога → бете она (C6).
- Доки: `docs/{en,ru}/master.md` (строка `reclaim_host`). CHANGELOG —
  запись о недоверенной точке.

## Этап 2. Регистрация хоста после проверки токена (C3) ✅ выполнен

- `_onRegisterHost`, `_onPromotedRegister`, `_onReclaimHost`: повторная
  проверка `session.roomId` после `await`.
- Тест (`tests/master/MigrationCoordinator.test.js`): бета шлёт
  `register_host` преемника (проверка токена задержана), та же сессия
  успевает зарегистрировать свою комнату → преемнику `alreadyRegistered`,
  комната в миграции не привязана к сессии (падает до правки).
- Доки/CHANGELOG: `alreadyRegistered` уже описан — без правок.

## Этап 3. Порядок причин отказа голосования (C4) ✅ выполнен

- `HostVoteManager.start`: `_awaitingPeersReport` — после `host` и
  `_voterRejection`.
- Тест (`tests/master/HostVoteManager.test.js`): комната в окне ожидания,
  участник моложе `minVoterAgeMs` → `tooNew` (падает до правки).
- Доки: `docs/{en,ru}/master.md` («Старт»: окно проверяется последним).

## Этап 4. Вытеснение эстафеты только начавшейся передачей (C5, C7) ✅ выполнен

- `HostController.swapCarryingState`; `HostRole.canPreemptSwap()`,
  `preemptSwap()` без результата; `HandoffFlow.start` — по п. 4.
- Тесты: `HandoffFlow.test.js` — отказ `PlannedHandoff.start` эстафету не
  вытесняет (падает до правки), вытеснение — после старта передачи;
  `HostRole.test.js`, `HostController.test.js` — новые методы.
- Доки: `docs/{en,ru}/host.md`, `docs/{en,ru}/client.md` (C5).

## Этап 5. Финал ✅ выполнен

prettier, `npx eslint .`, `npx vitest run --reporter=dot`; план — в
`plan/done/`, строка в `plan/done/README.md`.

## Release impact

npm `vimp-engine` (мастер + клиент): уточнение `[Unreleased]`, уровень —
minor из-за уже существующего `### ⚠️ Breaking`. Протокол не меняется.
Крейт, `create-vimp-game`, auth, `surface.json`, репозитории игр не
затронуты.
