# B4. Состояние игрока (скиллы) + rank: загрузка и синхронизация ✅критично ✅ выполнен

## Реализация

Auth-сервис получил `PUT /rank` (зеркало уже существовавшего `PUT /state`).
Мастер — новый `PlayerDataProxy.js` (та же DI-форма, что `JwksProxy`, но без
кэша: данные per-user) и роуты `GET/PUT /auth/rank`, `GET/PUT /auth/state`
(`forwardPlayerData` в `main.js` достаёт Bearer-токен и `?game=` из входящего
запроса и пробрасывает 1:1); `config/lobby.js` — `auth.rankUrl`/`auth.stateUrl`.
Хост — новый `meta/modules/PlayerDataSync.js`: `load()` на join тянет
`GET /auth/rank`+`GET /auth/state` (сбой auth-сервиса не блокирует вход —
остаются дефолты, rank 0 и `playerState.defaultState` игры), `addRank()`
вызывается из `RoundManager.reportKill` тем же чокпоинтом, что и `Stat`-score
(+1/-1, с той же победа/тимкилл-веткой), `flush()`/`flushAll()`
(`Promise.allSettled`, best-effort) вызываются в `RoundManager.createMap()` и
`_checkTeamWipe()`, и финально в `HostGame.removeUser()` перед удалением
участника. Токен участника теперь хранится (`HumanParticipant.token`,
проброшен через `ParticipantManager.createHuman`), чтобы `PlayerDataSync`
могла авторизовать PUT тем же JWT, каким был проверен вход. `HostGame`
даёт `getPlayerRank/getPlayerState/setPlayerState` для игровых плагинов.
`games/tanks/src/config/game.js` — новый ключ `playerState: { defaultState }`.
Документация — `docs/en/auth.md`+`docs/ru/auth.md`, `docs/en/master.md`+
`docs/ru/master.md`, `docs/en/host.md`+`docs/ru/host.md`. Тесты —
`tests/master/PlayerDataProxy.test.js`, `tests/host/PlayerDataSync.test.js`,
плюс дополнения в `RoundManager.test.js`/`ParticipantManager.test.js`.

Не реализовано на этом этапе (B5–B6): чат-команда `/rank`, отдельный проход
по конфиг/деплой-докам сверх перечисленного выше. Rank — простой
аккумулятор +1/-1 по убийствам, не ELO/матчмейкинг-алгоритм. Rust/WASM-ядро
о rank/state ничего не знает — это чисто engine/JS-слой.

- **Что такое «скиллы»/rank.** Rank — числовой рейтинг per (user, game). State —
  непрозрачный для движка JSON-блоб per (user, game); его *схему определяет игра*
  (как сегодня игра определяет `stat.columns` в `games/tanks/src/config/game.js`).
  Движок предоставляет только транспорт и хранение; игра — смысл полей.
- **Авто-загрузка на join.** Когда игрок присоединяется, хост (после верификации
  токена) запрашивает у мастера `GET /rank` и `GET /state` для (nick, gameId) и
  инжектит их в игру (в участника / игровое ядро). Мастер проксирует запрос в
  auth-сервис.
- **Синхронизация обратно.** Единый чокпоинт подсчёта — `RoundManager.reportKill`
  → `Stat`. По окончании раунда/смены карты/матча (естественные хуки в
  `RoundManager`) хост сериализует обновлённые rank+state и `POST`-ит на мастер
  аутентифицированным запросом (Bearer тем же JWT игрока или сервер-токеном
  хоста); мастер валидирует и пишет в auth-сервис.
- Расширить/ввести аккумулятор поверх эфемерного `Stat`
  (`packages/engine/src/host/meta/modules/Stat.js` уже имеет
  `serialize()/restore()` для handoff — переиспользовать форму для выгрузки на
  лобби). Возможно новое движковое meta-модуль-«PlayerStateSync».

## Критические файлы

`packages/engine/src/host/meta/modules/Stat.js` + `meta/core/RoundManager.js`
(аккумуляция и выгрузка rank/state); `games/tanks/src/config/game.js` (схема
state/rank).

## Предусловие

B3 (нужен верифицированный ник, чтобы связать rank/state с игроком).
