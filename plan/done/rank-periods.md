# Рейтинг по периодам: Daily / Monthly / All-Time

Задача: таблица рекордов должна показываться в трёх срезах — за сегодня,
за месяц и за всё время (как «Top scores» в slither.io). Сейчас
`GET /leaderboard` отдаёт единственный срез — денормализованный кэш
`ratings.rank` (всё время).

## Что уже есть

- `rank_events` — append-only леджер дельт с `created_at TIMESTAMPTZ` и
  флагом `voided`. Периоды выводятся из него без новых записей;
- `ratings.rank` — кэш `SUM(delta) WHERE NOT voided`, это и есть all-time;
- `GET /leaderboard?game=&limit=` и `GET /placement?game=` в auth,
  прокси + TTL-кэш на мастере, вкладка лидерборда в лобби.

## Решения

- **Границы периодов — календарные, UTC**: day = `date_trunc('day', now())`,
  month = `date_trunc('month', now())`. Не скользящее окно: игроку понятно
  «сегодняшний топ», и кэш мастера на минуту не врёт на границе.
- **Считаем на лету из `rank_events`** (агрегатных таблиц не заводим):
  нужен индекс `(game_id, created_at)`. All-time продолжает читаться из
  `ratings` — этот путь не трогаем вовсе.
- **Совместимость**: `period` — необязательный параметр, значение по
  умолчанию `all`. Старый клиент (vimp-tanks, любой сторонний) и старый
  мастер продолжают работать без изменений.

## Этап 1. auth: запрос и эндпоинт ✅ выполнен

1. Миграция `006_rank_events_period_idx.sql`: индекс
   `rank_events (game_id, created_at)` под оконный запрос периода.
2. `UserRepository.getLeaderboard(gameId, limit, period)` и
   `getPlacement(userId, gameId, period)`: при `period === 'all'` — текущий
   SQL по `ratings`; иначе агрегат по `rank_events`
   (`SUM(delta) WHERE NOT voided AND created_at >= date_trunc(...)`,
   `HAVING SUM(delta) > 0`), те же поля и та же competition-ranking
   семантика `place`/`placement`.
3. `main.js`: валидация `period ∈ {day, month, all}`, 400 на прочем.
4. Тесты `packages/auth/tests/*`: срез дня/месяца, событие вне окна,
   `voided` не считается, ничей `period` по умолчанию = `all`.

## Этап 2. master: прокси и кэш ✅ выполнен

1. `PlayerDataProxy.getLeaderboard(game, limit, period)` /
   `getPlacement(userId, game, period)` — прокидывают параметр дальше.
2. `LeaderboardCache`: ключ кэша `(game, limit, period)`, TTL тот же.
3. `lobby.js`: `GET /auth/leaderboard` и `/auth/placement` читают и
   валидируют `period` (дефолт `all`).
4. Тесты мастера: три периода не смешиваются в кэше, мусорный `period` — 400.

## Этап 3. лобби: три вкладки ✅ выполнен

1. `config/lobby.js`: id элементов вкладок и список периодов.
2. `Lobby` model/view/controller: активный период, перезапрос при
   переключении, спиннер/пустое состояние на вкладку.
3. `client/main.js`: `period` в fetch'ах leaderboard/placement.
4. Тесты клиента лобби: переключение вкладки перезапрашивает и
   перерисовывает, активная вкладка подсвечена.

## Этап 4. документация ✅ выполнен

`docs/en|ru`: `auth.md` (эндпоинты и семантика периодов), `master.md`
(прокси, кэш), `client.md` (вкладки лобби), `configuration.md` (новые
ключи), CHANGELOG движка и auth.
