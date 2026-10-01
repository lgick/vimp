# Этап 3. Прямые ссылки `#/<gameId>[/<roomId>]`, логин без потери ссылки ✅ выполнен

Цель: ссылка `https://<домен>/#/tanks/k7m2qx3a` ведёт сразу в комнату,
минуя страницу лобби (если не залогинен — сначала OAuth, затем сразу в
комнату, игрок видит экран авторизации игры `#auth`); ссылка
`#/tanks` — «быстрая игра» в эту игру. Ссылка стабильна, потому что
`roomId` стабилен (этап 2) и переживает смену хоста (этапы 7–8).

Ответ на вопрос «легко ли?» — да: это один этап, основная работа уже
сделана стабильным `roomId`.

Зависит от этапа 2.

## URL-модель и правила выхода (уточнено разработчиком при исполнении)

| URL                   | Что открывается                                        |
| --------------------- | ------------------------------------------------------ |
| без hash              | лобби (все игры)                                       |
| `#/<gameId>`          | быстрая игра: оптимальная комната игры, иначе создание |
| `#/<gameId>/<roomId>` | прямой вход в комнату                                  |

Не залогинен — окно авторизации поверх страницы (своего URL нет), после
входа — тот же URL. Когда показывается лобби, адрес — без hash.

Выход из комнаты — чистая функция `decideExitRoute` (`roomLink.js`):

| Причина                                                             | Действие                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| кик: простой / латентность / пинги (tech-ключи 3–5, коды 4003–4005) | без перезагрузки: `setRoute('')`, причина в `#tech-informer`; клик по нему или F5 → лобби |
| закрытие комнаты (уход хоста, `room_closed`, `unknownRoom`)         | `reloadTo(formatGameLink(gameId))` — быстрая игра той же игры                             |
| отказы политики (`roomFull`, `invalidOrigin`, …)                    | как раньше, без перезагрузки                                                              |

## 3.1. Роутер (`packages/engine/src/client/lib/roomLink.js`)

Чистые функции (тестируемые без DOM):

- `parseRoute(hash)` → `{ kind: 'room', gameId, roomId } | { kind: 'game',
gameId } | { kind: 'none' }`. Формат: `#/<gameId>` и
  `#/<gameId>/<roomId>`; `gameId` — по тем же правилам, что
  `master/gameRefs.js` (вынести регэксп id игры в изоморфный модуль, если он
  сейчас только в мастере); `roomId` — `isValidRoomId` из `lib/roomId.js`.
  Всё остальное — `none` (не ломаем чужие hash вроде `#auth`).
- `formatRoomLink(gameId, roomId)`, `formatGameLink(gameId)` →
  `#/…`; `absoluteLink(hashPart)` → `location.origin + location.pathname +
hashPart`.
- `setRoute(hashPart)` — `history.replaceState(null, '', pathname +
hashPart)` (без перезагрузки и без записи в историю);
  `reloadTo(hashPart)` — `location.replace(pathname + hashPart)` +
  `location.reload()` там, где сейчас голый `location.reload()`.

## 3.2. Сохранение ссылки через OAuth

- `components/model/LobbyAuth.js:65-67` (`loginUrl`): `returnUrl =
origin + pathname + location.hash`. Auth-сервис уже корректно ставит
  `token`/`pendingToken` в `searchParams`, hash сохраняется
  (`packages/auth/src/main.js:402-409`; allowlist проверяет только origin —
  `:159-168`). Проверить, что `devLogin.js:47-57` ведёт себя так же.
- `main.js:2503-2504`: `history.replaceState(null, '', location.pathname +
location.hash)` — чистим только query.
- Токен из `localStorage` (уже залогинен) редиректа не делает — hash и так
  на месте.

## 3.3. Бутстрап по маршруту (`client/main.js`)

Сейчас `initLobby()` вызывается после `welcome` + `authenticated`
(`main.js:2479`). Добавить развилку перед показом лобби (только режим
`lobby`; `solo`/`dedicated` маршрут игнорируют):

1. `route.kind === 'room'`:
   - `GET /rooms/:roomId` (3.4) → нет комнаты → быстрая игра этой игры
     (п. 2);
   - комната другой игры, чем в ссылке → верить комнате (ссылка могла быть
     отредактирована руками), `gameId` из ответа;
   - игры нет в каталоге клиента → `setRoute('')`, лобби + `#tech-informer`
     с причиной (закрывается кликом);
   - полная (`currentPlayers >= maxPlayers`) → быстрая игра этой игры
     (полные она отбрасывает; сама проверка есть и на хосте — `roomFull`);
   - иначе `selectActiveGame(gameId)` (как обработчик `join`,
     `main.js:2269-2283`) → `connectToHost(roomId)`; UI лобби не
     показывается вовсе (`lobby` не создаётся или сразу `close()`), игрок
     видит экран авторизации игры (`AUTH_DATA` → `#auth`).
2. `route.kind === 'game'`: «быстрая игра» —
   `GET /servers?search=<gameId>` → отфильтровать по `gameId` строго, не
   полные; выбрать с максимумом `currentPlayers`, при равенстве — первую;
   нашлась → как п. 1; нет → если `lobbyConfig.quickPlay.autoCreate`
   (дефолт `true`) — создать комнату этой игры с настройками по умолчанию
   (тот же путь, что кнопка Create, с дефолтной формой); иначе — лобби с
   выбранной игрой (`setRoute('')`).
3. `none` → как сейчас.

Пока игрок в комнате, адресная строка показывает ссылку на неё:
гость — сразу после `connectToHost`, хост — после `host_registered`
(`setRoute(formatRoomLink(gameId, roomId))`). Это и есть «URL сервера» —
его можно скопировать из адресной строки.

**Перезагрузки.** Нынешний `setTimeout(location.reload, 3000)`
(`handleDisconnect`) идёт по `decideExitRoute` (таблица выше): кик — без
перезагрузки, на главную с причиной; закрытие комнаты — в быструю игру.
Повторный вход в ту же комнату — только там, где это задумано (этапы 4, 7).

`hashchange`: вне матча — пройти бутстрап по новому маршруту; в матче —
игнорировать, если маршрут указывает на текущую комнату, иначе
`reloadTo(новый hash)`.

## 3.4. Мастер: `GET /rooms/:roomId`

`master/lobby.js` (рядом с `GET /servers`, `:443-450`): невалидный id →
`400`; нет комнаты → `404 {error: 'unknownRoom'}`; иначе публичная форма
`_toPublic` + `status`. Скрытые (`hidden`) комнаты по прямому id отдавать
(прямой вход по id в скрытую комнату и сейчас возможен через
`webrtc_offer`). Rate-limit per IP — переиспользовать
`lib/rateLimiter.js` (конфиг `master.room.lookupRateLimit`, 20/с — в
существующей секции `room`).

## 3.5. UI: «Copy link»

- Карточка лобби (`components/view/Lobby.js`): кнопка «Copy link» →
  `navigator.clipboard.writeText(absoluteLink(formatRoomLink(...)))`,
  короткий фидбэк «Copied».
- Внутри игры — новое маленькое **меню комнаты** (MVC-тройка
  `components/{model,view,controller}/RoomMenu.js` по образцу
  существующих, разметка `views/includes/roomMenu.pug`, подключить в
  `views/index.pug`, стили в `style.css`, z-index — по таблице «UI
  hierarchy» в `docs/en/client.md`): кнопка-иконка в углу, раскрывает
  список; на этом этапе один пункт «Copy link». Этап 8 добавит «Leave
  server» и «Hand over host». Меню есть только в лобби-режиме.

## 3.6. Тесты

- `tests/client/lib/roomLink.test.js` — разбор/формат всех форм, мусорные
  hash, регистр, `#auth` → `none`; `pickQuickPlayRoom`, `decideExitRoute`.
- `tests/client/LobbyAuthModel.test.js` — `loginUrl` сохраняет hash.
- `tests/master/…` — `GET /rooms/:roomId` (400/404/200, hidden, rate-limit)
  — по образцу тестов `GET /servers`.
- Бутстрап по маршруту: вынести решение «что делать с маршрутом» в чистую
  функцию (`decideRouteAction(route, roomInfo, catalog)` →
  `{action: 'join'|'lobby'|'create', informer?}`) и покрыть таблично.
- `tests/client/RoomMenu*.test.js` — по образцу `PanelCtrl/Model/View`.

## 3.7. Документация

`docs/{en,ru}/client.md` — раздел «Boot modes» (маршруты, OAuth-возврат,
перезагрузки), «UI hierarchy» (меню комнаты); `master.md` —
`GET /rooms/:roomId`; `getting-started.md` — как открыть ссылку на комнату в
dev; `configuration.md` — `quickPlay.autoCreate`, `room.lookupRateLimit`.

## 3.8. CHANGELOG

`### Added`: direct room links `#/<gameId>/<roomId>` and quick-play links
`#/<gameId>` that survive the login redirect; `GET /rooms/:roomId`;
«Copy link» in the lobby card and the in-game room menu. `### Changed`: kick
— no reload, lobby address + reason on screen; closed room — reload into
quick play.

## Проверка

Автотесты зелёные. Вручную: незалогиненный профиль открывает ссылку на
комнату → GitHub/dev-логин → сразу экран авторизации игры в этой комнате;
залогиненный — сразу туда же; ссылка на несуществующую комнату → быстрая
игра; `#/tanks` при пустом лобби создаёт комнату, при непустом — входит;
кик за простой — без перезагрузки, адрес без hash, «Kicked for inactivity.»,
клик → лобби; уход хоста → быстрая игра той же игры.

## Готово, когда

Проверки зелёные, доки en/ru синхронны, CHANGELOG обновлён, release impact
в отчёте.
