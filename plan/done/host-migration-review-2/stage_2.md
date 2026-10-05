# Этап 2. Версия игры из `reclaim_host`/`register_host` преемника — только текущая каталожная ✅ выполнен

Находка: **N2** ([review.md](review.md#n2--версия-игры-из-reclaim_host--register_host-преемника-не-сверяется-с-каталогом)).
Уровень: 🔵 безопасность. Критерии: безопасность.

## Проблема

Бета принимает точку только той игры и версии, что подтвердил мастер:
`SignalingServer._roomGame(room)` (`packages/engine/src/master/SignalingServer.js:469-481`)
отдаёт в `promote.game` / `standby_assigned.game`
`{ id: room.gameId, versions: [room.gameVersion, версия каталога] }`.

Но `room.gameVersion` задаёт хост, и после создания комнаты её меняют:

- `_onPromotedRegister` (строки ~678-691): `promoteHost(..., { gameVersion: msg.gameVersion })`;
- `_onReclaimHost` (строки ~793-798): `attachHost(roomId, { …, gameVersion })`;
- оба доходят до `setGameVersion` (`master/RoomRegistry.js:22-33`), который
  принимает **любую** непустую строку ≤ 64 символов; `hidden` при этом не
  пересчитывается.

Хост публичной комнаты (каталог `v1`) обрывает свой WS и шлёт
`reclaim_host { gameVersion: '<застейдженная vS>' }` → `room.gameVersion =
vS`, комната остаётся в общем списке → мастер подтверждает бетам
`versions: [vS, v1]` → бета прогревает и на промоушене исполняет
немодерированный host-бандл `/games/<id>/vS/…`.

Легальная смена версии одна — эстафета Worker'ов, и она всегда переходит
на **текущую** версию каталога (`HostRole.refreshWorker` →
`fetchGameManifest(id)`, `client/session/HostRole.js:558-621`). Преемник
поднимает версию из точки, прошедшей `isConfirmedGame`, — одну из
`[room.gameVersion, версия каталога]`.

## ⚠️ Подтвердить у разработчика до начала

1. **(рекомендуется)** Игра неизвестна каталогу (нет `gameCatalog`, нет
   `room.gameId` или `getManifest(gameId)` пуст) — принимается только та
   же версия, что уже у комнаты, то есть версия не меняется. Альтернатива:
   без каталога принимать любую строку, как сейчас (dev без каталога
   эстафету всё равно не запускает — манифест кода пуст, — так что
   рекомендуемый вариант ничего не ломает).

Согласованное вписать сюда в раздел «Согласовано» до правки кода.

## Согласовано

1. Игра неизвестна каталогу (нет `gameCatalog`, нет `room.gameId` или
   `getManifest(gameId)` пуст) — принимается только та же версия, что уже
   у комнаты; версия не меняется (рекомендуемый вариант, 2026-10-05).
2. `_onReclaimHost` тоже передаёт в `_sendRegistered` `room.gameVersion`,
   а не присланную версию: иначе без каталога `host_registered.codeVersion`
   подтвердил бы хосту отклонённую версию (решение разработчика,
   2026-10-05, после исполнения этапа).

## Решение

### 2.1 `SignalingServer._acceptedGameVersion`

Новый приватный метод рядом с `_roomGame`:

```js
// версия игры от хоста новой эпохи или вернувшегося хоста: та, что уже у
// комнаты, или текущая версия каталога (на неё переводит эстафета
// Worker'ов). Любую другую (например, застейдженную) мастер подтвердил бы
// бетам как версию комнаты, а hidden не пересчитывается — она не
// принимается: undefined, версия комнаты остаётся прежней
_acceptedGameVersion(room, gameVersion) {
  if (gameVersion === room.gameVersion) {
    return gameVersion;
  }

  const catalogVersion = room.gameId
    ? this._gameCatalog?.getManifest(room.gameId)?.version
    : undefined;

  return typeof catalogVersion === 'string' && gameVersion === catalogVersion
    ? gameVersion
    : undefined;
}
```

### 2.2 Применение

- `_onPromotedRegister`: в объекте для `this._registry.promoteHost(...)`
  `gameVersion: this._acceptedGameVersion(room, msg.gameVersion)`.
  Вызов `this._sendRegistered(session, room, msg.gameVersion ?? room.gameVersion)`
  заменить на `this._sendRegistered(session, room, room.gameVersion)`
  (после `promoteHost` в `room.gameVersion` уже принятая версия; в
  `_sendRegistered` она — только запасная половина `codeVersion`, когда
  каталог игру не знает).
- `_onReclaimHost`, ветка существующей комнаты: в `attachHost(roomId, {…})`
  `gameVersion: this._acceptedGameVersion(room, gameVersion)`.
- Ветка восстановления после рестарта мастера (`this._registry.restore(...)`
  через `_roomFields`) **не меняется**: это создание комнаты, `hidden`
  считается по `isStaged`, как у `register_host`.
- `RoomRegistry.setGameVersion` не меняется: `undefined` он уже
  игнорирует, проверка формата остаётся.

## Тесты (сначала падающие)

`tests/master/SignalingServer.test.js` (хелперы файла: `connect`,
`connectHost`, `signToken`, `memberIdOf`, `flushAsync`, `typed`; каталог
подменяется так же, как в тесте «standby_assigned несёт игру…» около
строки 1849: `signaling._gameCatalog = { getManifest: … }`):

1. «reclaim_host с застейдженной версией не меняет версию комнаты»:
   комната `gameId: 'tanks'`, `gameVersion: '1.0.0'`, каталог отдаёт
   `{ version: '1.0.0' }` → `reclaim_host { gameVersion: 'staged-9' }` →
   `room.gameVersion === '1.0.0'`; гость-бета, вошедший после, получает
   `standby_assigned.game.versions` без `'staged-9'`.
2. **Переписать** существующий «reclaim_host с gameVersion обновляет
   версию игры комнаты» (около строки 1887): задать каталог с
   `{ version: '2.0.0' }` — версия каталога принимается.
3. «без каталога reclaim_host версию не меняет» — по решению п. 1
   «Подтвердить».

`tests/master/MigrationCoordinator.test.js` (хелперы `setupRoom`,
`registerPromoted`; около строк 1883-1906):

4. **Переписать** «register_host преемника обновляет версию игры комнаты»:
   каталог мастера (`signaling._gameCatalog` или опция конструктора — как
   устроен `setupRoom`) отдаёт `{ version: '1.1.0' }` → версия принимается.
5. «register_host преемника с посторонней версией её не меняет»:
   каталог `'1.1.0'`, преемник шлёт `'9.9.9'` → `room.gameVersion ===
'1.0.0'`, `room.status === 'online'` (регистрация не отклоняется —
   отклоняется только смена версии).
6. «версия-мусор не затирает известную» — остаётся зелёным без правок.

Проверить, что тесты 1, 3, 5 падают до правки кода.

Примечание по исполнению: без живых участников обрыв хоста закрывает
комнату, и `reclaim_host` шёл бы в ветку восстановления. Поэтому в тестах
1–3 комнату держит гость (тест 1 — без `canHost`), тесты 2–3 лежат в
`describe('reclaim_host')`; фейковый каталог отдаёт и `maps.version`
(его читает `_sendRegistered`).

## Документация

`docs/en/master.md`, таблица сообщений (строки ~723 и ~724, строки
`register_host { roomId, epoch, promotionToken, … }` и `reclaim_host { … }`):
вместо «`gameVersion` (a non-empty string ≤ 64 chars) refreshes the room's
`gameVersion` …» — «`gameVersion` refreshes the room's `gameVersion` only
when it equals the room's version or the catalog's current version of the
game (a Worker handoff moves the match to it); any other is ignored — the
master confirms the room's version to successors (`promote.game`), and
`hidden` is not recomputed». Зеркально — `docs/ru/master.md`. Если в
разделе «Host migration»/«Successor» есть фраза о том, откуда берутся
`versions` в `promote.game`, дописать то же правило.

## CHANGELOG

`## [Unreleased]` → `### Added`, запись про контрольную точку как
недоверенную (фраза «`register_host` of the new epoch and `reclaim_host`
refresh the room's `gameVersion`»): заменить на «… refresh the room's
`gameVersion`, but only to the catalog's current version of the game».

## Критерии готовности

- Тесты этапа зелёные, новые до правки падали.
- prettier, `npx eslint .`, `npx vitest run --reporter=dot` — зелёные.
- Доки en/ru и CHANGELOG обновлены; раздел «Согласовано» заполнен.
- Этап помечен «✅ выполнен» здесь и в `README.md`.

## Release impact

npm `vimp-engine` (мастер), уточнение `[Unreleased]`. Протокол не меняется
(поле то же, меняется только то, что мастер из него принимает). Игры,
крейт, `create-vimp-game`, auth не затронуты.
