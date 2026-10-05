# План: исправления по код-ревью `5ba403eb` (host-migration-review-3/4)

Основание — код-ревью коммита `5ba403eb` (2026-10-05), находки F1–F7
(F8 — мелочи, вне плана). Общие правила — как в
`plan/done/host-migration-review-2/README.md`: тест первым (падает до
правки), доки en/ru в том же изменении, правится текст существующих записей
`[Unreleased]`, протоколы не меняются, `contract/surface.json` не трогается,
без коммитов. В конце — `npx prettier --write`, `npx eslint .`,
`npx vitest run --reporter=dot`.

## Находки

| #   | Уровень | Суть                                                                                                                                                                                       |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | 🟡      | `hidden` восстановленной комнаты считается по неполному каталогу (`isStaged` при пустом каталоге → `false`) и не пересчитывается: застейдженная комната после рестарта мастера — публичная |
| F2  | 🧪      | `_onJoinRoom` зовёт `joinMember` без `this._now()`: `joinedAt` по `Date.now()`, остальное — по инъектированным часам; харнесс голосования компенсирует сдвигами                            |
| F3  | 🧪      | Тест C3 недетерминирован (`if/else` по исходу); повторные проверки `session.roomId` в `_onRegisterHost` и `_onReclaimHost` не покрыты                                                      |
| F4  | 🧪      | Не покрыта ветка `_reviewSuccessor`, снимающая назначенную бету комнаты с помеченной версией, когда каталог перестал знать игру                                                            |
| F5  | 🔧      | Шесть одинаковых блоков `alreadyRegistered` до/после `await`                                                                                                                               |
| F6  | 📖      | Имена `_unverifiedGameVersion` / `_gameVersionUnverified` / `_verifyGameVersion` почти одинаковы при разных ролях                                                                          |
| F7  | 🔧      | `HostRole.canPreemptSwap()`: проверка `_swapStarted` избыточна                                                                                                                             |

## Согласовано

1. **F1.** Разработчик: «скрывать до проверки» (2026-10-05). При `restore`
   комната с помеченной версией, игру которой каталог ещё не знает,
   создаётся скрытой (`hidden: true`). Пока комната на помеченной версии и
   каталог знает игру, пересмотр (`_reviewSuccessor`, в том числе
   периодический) пересчитывает `hidden` через `isStaged` — в том числе в
   момент снятия пометки (одобренная версия становится видимой). Цена:
   обычная комната после рестарта мастера скрыта из списка до загрузки
   каталога (≤ первой синхронизации + `successorReviewMs`).
2. **F2.** `joinMember`, `detachHost`, `detachMember` получают
   `this._now()` (в проде те же `Date.now()`). Харнессы
   `HostVoteManager`/`MigrationCoordinator` — без сдвига часов на минуту:
   «стаж» участников задаёт помощник `ageMember`, `sweep` — по `clock.now`;
   `hostSince -= 60000` в `connectHost` остаётся (комната стареет вместе с
   участниками).
3. **F3, F4.** Порядок проверок токена в тесте C3 задаётся задержанным
   `_verifyToken` (как в тесте R4); добавляются тесты повторной проверки в
   `_onRegisterHost` и `_onReclaimHost` и тест снятия назначенной беты.
4. **F5–F7** (без наблюдаемого эффекта): помощник
   `_rejectIfRegistered(session, re, roomId) → boolean`; переименования
   `_restoreVersionMark`, `_isGameVersionUnverified`,
   `_reviewGameVersion` (сделаны вместе с этапом 1); `canPreemptSwap()` →
   `this._controller?.swapCarryingState !== true`.

## Этап 1. Видимость восстановленной комнаты (F1) ✅ выполнен

По решению п. 1. Тесты (`tests/master/SignalingServer.test.js`, блок
`reclaim_host`, каталог-заглушка с `isStaged` как у `GameCatalog`: пустой
каталог → `false`): каталог не знает игру → застейдженная комната скрыта
(падает до правки); обычная — скрыта, после загрузки каталога — видима
(падает до правки); застейдженная после загрузки — остаётся скрытой; доки `docs/{en,ru}/master.md` (строка
`reclaim_host`); CHANGELOG — запись о недоверенной версии.

## Этап 2. Часы `joinedAt` (F2) ✅ выполнен

`SignalingServer._onJoinRoom`; харнесс `tests/master/HostVoteManager.test.js`.

## Этап 3. Тесты (F3, F4) ✅ выполнен

`tests/master/MigrationCoordinator.test.js`,
`tests/master/SignalingServer.test.js`.

## Этап 4. Рефакторинг (F5–F7) ✅ выполнен

`SignalingServer.js`, `RoomRegistry.js` (комментарий к полю),
`HostRole.js`; доки — только если в них упомянуты переименованные методы.

## Этап 5. Финал ✅ выполнен

prettier, `npx eslint .`, `npx vitest run --reporter=dot`; план — в
`plan/done/`, строка в `plan/done/README.md`.

## Release impact

npm `vimp-engine` (мастер): уточнение `[Unreleased]`, уровень — minor из-за
уже существующего `### ⚠️ Breaking`. Протокол не меняется. Крейт,
`create-vimp-game`, auth, `surface.json`, репозитории игр не затронуты.
