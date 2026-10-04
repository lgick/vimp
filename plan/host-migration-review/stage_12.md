# Этап 12. Производительность беты и масштабируемость мастера ✅ выполнен

Находки: **F15**, **F16**, **F20** ([review.md](review.md), разделы F15,
F16, F20). Уровень: 🟡 качество. Критерии: производительность,
масштабируемость.

Делать после этапа 1 (прогрев перестаёт зависеть от настроек точки).
Подэтапы независимы — каждый закрывается зелёным прогоном.

## 12.1 Бета не распаковывает каждую точку ради версии игры (F15)

**Проблема.** `client/main.js:2003-2029` `startStandbyDuties` на каждую
точку (2 раза в секунду) зовёт `hostPrewarm.warm(latest.bytes)`;
`client/network/HostPrewarm.js:70-114` распаковывает её целиком (gunzip
~420 КБ у tanks) и парсит мету — на главном потоке играющей вкладки —
только чтобы прочитать `meta.room.game`.

**Решение.** Везти игру в дескрипторе точки (протокол канала `standby`
только дополняется: старый приёмник незнакомое поле игнорирует).

1. `packages/engine/src/host/host.worker.js` `postCheckpoint` (строки
   85-115): в сообщение `checkpoint` добавить
   `game: meta.room?.game ?? null`.
2. `packages/engine/src/client/network/standbyChunks.js`:
   `encodeStandbyChunks` кладёт в дескриптор `game` (`{ id, version }`
   или `null`); `parseStandbyStream` возвращает `game`, если это объект
   со строковыми непустыми `id` и `version` (≤ 64 символов), иначе `null`.
   Обновить комментарий формата в шапке файла.
3. `client/network/StandbyReceiver.js`: `latest()` несёт `game`.
4. `client/network/HostPrewarm.js`: `warm(checkpoint, { allowedGame })`
   принимает запись приёмника (`{ bytes, game, … }`). Если `game` есть —
   распаковки нет: `gameRef = checkpoint.game`. Если нет (хост старше
   этапа) — прежний путь через `decode`. Настройки для `prepareRoom` —
   `{}`: игра, карты и dev-режим комнаты беты — свои, а настройки комнаты
   промоушен берёт из самой точки (этап 1).
5. `client/main.js` `startStandbyDuties`:
   `hostPrewarm.warm(latest, { allowedGame: standbyRole.game })`.

**Тесты.** `tests/client/network/standbyChunks.test.js` (если файла нет —
создать рядом с `StandbySender.test.js`): `game` проходит туда и обратно,
мусор → `null`. `tests/client/network/HostPrewarm.test.js`: с `game` в
записи `decode` не вызывается; без — вызывается.

## 12.2 Индексы реестра комнат (F16)

**Проблема.** `master/RoomRegistry.js:223-231` `getByIp` — проход по всем
комнатам на каждую регистрацию/возврат; `:413-422` `detachMember` —
проход по всем комнатам и всем участникам на каждое закрытие WS.

**Решение** (поведение не меняется):

1. `_hostIpIndex: Map<ip, roomId>` — поддерживать в `_create`,
   `attachHost`, `promoteHost` (старый ip хоста → удалить, новый →
   записать), `remove`, удалении пустых комнат в `sweep`. `getByIp` →
   `this._rooms.get(this._hostIpIndex.get(ip))`.
2. `_sessionIndex: Map<sessionId, Set<"roomId\u0000memberId">>` —
   записывать в `joinMember` (снять прежнюю привязку участника, если
   сессия сменилась), чистить в `detachMember`, `leaveMember`, удалении
   участников и комнат в `sweep`, `remove`, `promoteHost` (удалённый
   `previousMemberId`). `detachMember(sessionId)` обходит только
   индекс.
3. В `sweep` — чистить истёкшие записи `room.demotedUsers`
   (`until <= now`).

**Тесты.** `tests/master/RoomRegistry.test.js`: после create / attach /
promote / remove / sweep `getByIp` согласован с полным проходом;
`detachMember` трогает ровно участников этой сессии; истёкшие
`demotedUsers` удаляются.

## 12.3 Быстрая игра не тянет весь список комнат (F16)

**Проблема.** `client/main.js:3822-3826` `findQuickPlayRoom` запрашивает
`GET /servers?search=<gameId>` — все комнаты игры без пагинации
(`master/RoomRegistry.js:542-563`), и на закрытии комнаты это делают все
её гости, дважды (до и после паузы `quickPlayCreateDelay`).

**Решение.**

1. `RoomRegistry.bestRoom(gameId, now)`: среди видимых комнат (то же
   условие, что в `getList`: не `hidden`, `status === 'online'`, хост
   привязан) со строго равным `gameId` и `currentPlayers < maxPlayers` —
   комната с максимумом `currentPlayers` (при равенстве — первая).
   Публичная форма — `_toPublic`.
2. `master/roomRoutes.js`: обработчик `quickPlay(req, res)` — валидация
   `gameId` (`isValidGameId`), тот же лимитер, что у `lookup`, ответ
   `{ room: <public> | null }`.
3. `master/lobby.js`: `app.get('/quickplay/:gameId', roomRoutes.quickPlay)`.
4. Клиент: в `config/lobby.js` новый ключ рядом с `roomUrl`:

   ```js
   quickPlayUrl: gameId => `/quickplay/${encodeURIComponent(gameId)}`,
   ```

   `findQuickPlayRoom` берёт `room` из ответа; на сетевую ошибку или
   не-2xx — прежний путь через `fetchServers({ search })` и
   `pickQuickPlayRoom`.

**Тесты.** `tests/master/RoomRegistry.test.js` — `bestRoom`;
`tests/master/roomRoutes.test.js` — валидация, лимит, ответ.

**Документация.** `docs/{en,ru}/master.md` — роут `GET /quickplay/:gameId`;
`docs/{en,ru}/client.md` — быстрая игра. **CHANGELOG** — дописать в
запись `[Unreleased]` → `### Added` о прямых ссылках/быстрой игре: роут
`GET /quickplay/:gameId`.

## 12.4 Прогрев и повторная компиляция wasm (F20) — только документация

Передать скомпилированный `WebAssembly.Module` из прогрева в
`hostPlugin.createCore` нельзя без изменения контракта плагина
(`createCore` принимает `wasmUrl`) — это под запретом плана (контракт
только дополняется, а здесь нужен новый параметр у функции игры). Не
делать без отдельного решения разработчика.

В `docs/{en,ru}/host.md` (раздел о прогреве) одной фразой записать: прогрев
даёт HTTP-кэш и кэш кода wasm браузера (`compileStreaming`), сам
`WebAssembly.Module` не переиспользуется.

## Общие проверки этапа

Prettier, eslint, vitest — зелёные после каждого подэтапа. Release impact:
npm `vimp-engine`; 12.1 и 12.2 — без записи в changelog (внутреннее),
12.3 — уточнение `[Unreleased]`.
