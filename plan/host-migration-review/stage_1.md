# Этап 1. Преемник не доверяет настройкам и версии игры из контрольной точки ✅ выполнен

Находка: **F1** ([review.md](review.md), раздел F1).
Уровень: 🔵 безопасность. Критерии: безопасность, работоспособность.

## Проблема

Контрольную точку бете присылает хост — другой игрок, которому нельзя
доверять. Бета поднимает из неё Worker и разворачивает
`meta.room.settings` **целиком** поверх собственной конфигурации комнаты.

- `packages/engine/src/client/network/Promotion.js:305` —
  `const settings = { ...(meta.room.settings ?? {}) };`
- `Promotion.js:331-337` —
  `const room = { ...prepared.room, ...settings, hostSocketId, roomId, epoch };`
  В прогретом пути (`warm.prepared`, `Promotion.js:309-321`) объект
  `prepared.room` создан раньше и другой, поэтому ключи точки перекрывают
  его: `game` (`hostEntryUrl`, `wasmUrl` — Worker делает
  `import(room.game.hostEntryUrl)`, `lib/createHostRuntime.js:188-192`),
  `isDevMode` (`lib/applyRoomOverrides.js:59-60` → dev-команды игр, например
  `/nr` в tanks; рекордер; CONSOLE всем игрокам), `maps`, `seed`,
  `mapsVersion`.
- `packages/engine/src/client/network/HostPrewarm.js:111-114` — то же для
  прогрева.
- `packages/engine/src/lib/createHostRuntime.js:166-185` —
  `ROOM_SETTING_KEYS` включает `isDevMode`, поэтому даже честный хост кладёт
  dev-флаг своей сборки в точку.
- Версия игры, которую поднимает бета, берётся из точки
  (`meta.room.game`, `Promotion.js:294-299`, `HostPrewarm.js:96-103`) и
  мастером не подтверждается: хост может заставить бету загрузить другую
  версию той же игры, лежащую на мастере (например, застейдженную).

Для холодного пути мастер уже санирует настройки
(`packages/engine/src/lib/roomSettings.js` → `sanitizeRoomSettings`,
вызывается в `master/RoomRegistry.js:170, 373`), для пути через точку —
нет.

## Решение

### 1.1 Dev-режим — свойство сборки, а не комнаты

`packages/engine/src/lib/createHostRuntime.js`: убрать `'isDevMode'` из
`ROOM_SETTING_KEYS` (строки 166-173). Комментарий над массивом дополнить:
dev-режим решает сборка вкладки, которая поднимает Worker
(`client/main.js:2205` `room.isDevMode = isDevBuild`), в точку он не едет.

Проверить тесты, которые ждут `isDevMode` в `meta.room.settings`
(`grep -rn "isDevMode" tests/`), и поправить ожидания.

### 1.2 Promotion берёт из точки только известные ключи

`packages/engine/src/client/network/Promotion.js`:

1. Импорт: `import { sanitizeRoomSettings } from '../../lib/roomSettings.js';`
2. Строку 305 заменить на
   `const settings = sanitizeRoomSettings(meta.room?.settings);`
   (возвращает только `maxPlayers`, `map`, `roundTime`, `mapTime`,
   `friendlyFire`, числа клампятся).
3. В `prepareRoom` передавать копию: `this._prepareRoom({ ...settings }, gameRef)`
   — `prepareHostRoom` (`client/main.js:2200`) мутирует аргумент
   (`isDevMode`, `game`, `maps`).
4. Сборку `room` (строки 331-337) оставить в той же форме — после
   санитизации `settings` не содержит `game`, `isDevMode`, `maps`, `seed`.
   Над ней — комментарий: точка недоверенная, из неё берутся только
   настройки комнаты, а игра, карты и dev-режим — свои.

### 1.3 HostPrewarm — то же

`packages/engine/src/client/network/HostPrewarm.js:111-114`:
`this._prepareRoom(sanitizeRoomSettings(meta.room?.settings), gameRef)`.

### 1.4 Версию игры подтверждает мастер

Мастер — источник истины об игре комнаты. Он сообщает бете допустимые
`{ id, versions }`, и бета отказывается от точки другой игры или версии.

**Мастер** (`packages/engine/src/master/`):

1. `SignalingServer.js`: метод
   ```js
   // игра комнаты для проверки точки бетой: id и допустимые версии —
   // зарегистрированная хостом и текущая в каталоге (эстафета Worker'ов
   // могла поднять комнату на новую). null — игра неизвестна мастеру
   _roomGame(room) {
     if (!room?.gameId) return null;
     const catalogVersion = this._gameCatalog?.getManifest(room.gameId)?.version ?? null;
     const versions = [...new Set([room.gameVersion, catalogVersion])].filter(
       v => typeof v === 'string' && v !== '',
     );
     return { id: room.gameId, versions };
   }
   ```
2. Передать в `MigrationCoordinator` зависимость `gameOf: room => this._roomGame(room)`
   (конструктор `SignalingServer`, строки 84-109) и добавить поле
   `game: this._gameOf(room)` во **все** сообщения `promote`:
   `MigrationCoordinator.js` `_promoteNext` (строки 256-264), `beginHandoff`
   (619-627), `_degradeHandoff` (825-833). В конструкторе координатора —
   `this._gameOf = deps.gameOf ?? (() => null);` и строка в JSDoc.
3. `SignalingServer.js`: поле `game: this._roomGame(room)` в оба
   `standby_assigned` — `_assignSuccessor` (строки 446-450) и `_onJoinRoom`
   (926-930).
4. `RoomRegistry.js`: версия игры комнаты актуализируется хостом новой
   эпохи и вернувшимся хостом — в `promoteHost` (строки 328-365) и
   `attachHost` (279-312) принять необязательное `gameVersion` и, если это
   непустая строка до 64 символов, записать в `room.gameVersion`.
   `SignalingServer._onPromotedRegister` (строка 597) передаёт
   `gameVersion: msg.gameVersion`, `_onReclaimHost` (строка 704) —
   `gameVersion`. Флаг `hidden` не пересчитывать.

**Клиент:**

1. `Promotion.js`: опция конструктора не нужна — проверка по
   `this._promote.game`. После получения `gameRef` (строка 295):
   ```js
   // игру и её версию подтверждает мастер: точка от хоста — недоверенная
   const allowed = this._promote.game;
   if (
     allowed &&
     (gameRef.id !== allowed.id ||
       (Array.isArray(allowed.versions) &&
         allowed.versions.length > 0 &&
         !allowed.versions.includes(gameRef.version)))
   ) {
     throw new Error('checkpoint game is not the room game');
   }
   ```
   Мастер старше этого этапа поля не шлёт — проверка пропускается.
2. `HostPrewarm.warm(bytes, { allowedGame = null } = {})`: та же проверка
   после чтения `gameRef`; несовпадение — `this._onError?.(new Error(...))`
   и `return` **без** изменения состояния (это проблема точки, а не версии:
   `_failedKey` не трогать, прогретый Worker не гасить).
3. `client/main.js`: в обработчике `standby_assigned` (строки 2070-2082)
   сохранять `game: msg.game ?? null` в `standbyRole`; в
   `startStandbyDuties` (строка 2028) —
   `hostPrewarm.warm(latest.bytes, { allowedGame: standbyRole.game })`.
   `handlePromote` ничего не меняет: `msg` уже несёт `game`.

## Тесты (сначала падающие)

- `tests/client/network/Promotion.test.js`:
  - холодный путь (без прогрева): `meta.room.settings =
{ map: 'm2', isDevMode: true, game: { id: 'evil', hostEntryUrl: 'https://evil.test/x.js' }, maps: { evil: {} }, seed: 7 }`
    → `prepareRoom` получил `{ map: 'm2' }` (только известные ключи), а
    `createController` — `room`, где `isDevMode`, `game`, `maps` равны
    значениям, которые выставил `prepareRoom`, `seed` нет, `map === 'm2'`;
  - прогретый путь: то же для `initFromCheckpoint(room, …)`;
  - `promote.game = { id: 'tanks', versions: ['1.0.0'] }`, в точке
    `room.game = { id: 'tanks', version: '9.9.9' }` → `onFailed`,
    контроллер не создан; чужой `id` → `onFailed`; без `promote.game` →
    промоушен идёт как раньше.
- `tests/client/network/HostPrewarm.test.js`: `prepareRoom` получает
  санированные настройки; `allowedGame` с другой версией → `onError`,
  `state` не меняется, прогретый ранее Worker не уничтожен.
- `tests/lib/createHostRuntime.test.js` (или `tests/host/HostGame.checkpoint.test.js`,
  где проверяется `meta.room.settings`): в настройках точки нет
  `isDevMode`.
- `tests/master/MigrationCoordinator.test.js`: при `deps.gameOf` все три
  вида `promote` несут `game`; без зависимости — `game: null`.
- `tests/master/SignalingServer.test.js`: `standby_assigned` несёт `game`
  (`id`, `versions` из `room.gameVersion` и версии каталога);
  `register_host` преемника с `gameVersion` обновляет `room.gameVersion`.

## Документация (en и ru одинаково)

- `docs/{en,ru}/host.md`, раздел «Successor promotion» / «Промоушен
  преемника»: контрольная точка — недоверенные данные; из
  `meta.room.settings` берутся только ключи `sanitizeRoomSettings`; игра,
  карты мастера и dev-режим — собственные; игра и версия точки сверяются
  с `promote.game` / `standby_assigned.game`.
- `docs/{en,ru}/master.md`: поле `game { id, versions }` в `promote` и
  `standby_assigned`; `room.gameVersion` обновляется промоушеном и
  `reclaim_host`.
- `docs/{en,ru}/network.md`: те же поля в таблице сообщений миграции.

## CHANGELOG

`packages/engine/CHANGELOG.md`, `[Unreleased]` → `### Added`, запись про
миграцию хоста (подпункт о преемнике): дописать, что преемник берёт из
контрольной точки только известные настройки комнаты (map, maxPlayers,
roundTime, mapTime, friendlyFire), а игру и её версию — те, что
подтвердил мастер (`promote.game`). Новой записи не заводить.

## Критерии готовности

- Ни одна точка не может изменить `isDevMode`, `game`, `maps`, `seed`
  Worker'а преемника — ни в прогретом, ни в холодном пути.
- Точка другой игры или неподтверждённой версии отклоняется
  (`promote_failed`), прогрев её игнорирует.
- Prettier, `npx eslint .`, `npx vitest run --reporter=dot` — зелёные.
- Release impact: npm `vimp-engine`, уточнение `[Unreleased]`, minor не
  меняется; игры и `surface.json` не затронуты.
