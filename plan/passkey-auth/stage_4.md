# Этап 4. auth: удаление неактивных аккаунтов (30 дней) и учёт активности

Зависит от этапов 1–3. Только `packages/auth/`, `tests/auth/`.

## Контекст

- Правило: при бездействии учётная запись игрока удаляется из БД через
  30 дней. Исключение (Р6): админы из `VIMP_ADMIN_USER_IDS` не удаляются.
  Авторы игр удаляются (авторство в `games` обнуляется `ON DELETE SET NULL`).
- Гостей в БД нет — удалять нечего; удаляются только участники.
- Удаление строки `users` каскадом уносит `sessions`,
  `webauthn_credentials`, `ratings`, `states`, `rank_events`,
  `rank_periods` и обнуляет `games.author_user_id`,
  `games.moderator_user_id`, `client_reports.status_by` (этап 1).
- Образец задачи — `src/db/gamesPurgeJob.js`: прогон по расписанию UTC
  (`msUntilNextRun`, таймер `.unref()`, перепланирование после каждого
  прогона), консультативная блокировка `pg_try_advisory_lock(LOCK_KEY)` на
  одном соединении `db.connect()`, ручной запуск при прямом исполнении
  файла, запуск из `main.js` (`startGamesPurgeJob(dbPool.getPool())`,
  ~строка 1020), тест `tests/auth/gamesPurgeJob.test.js`.
- `users.last_active_at` (этап 1) обновляет `touchActivity(userId,
minIntervalMs)` не чаще раза в `config.session.touchIntervalMs` (1 ч).

## 4.1 Что считается активностью

`touchActivity` вызывается (ошибка — только в лог, ответ не меняется):

1. `POST /token` по сессии участника — уже на этапе 2 (вкладка лобби
   продлевает JWT каждые ~3 ч, пока открыта);
2. вход по passkey и регистрация — этап 3;
3. **`PUT /rank` и `PUT /state`** — добавить здесь, после успешной записи
   (`req.user.id`): игрок, который играет долгую сессию, активен, даже
   если его JWT продлевает хост, а не он сам;
4. `POST /nick` — этап 3.

## 4.2 Конфиг

`src/config/auth.js`: `accounts: { inactiveDays: 30, purgeBatchSize: 500 }`
с комментарием (правило разработчика, исключение админов, каскад).

## 4.3 Репозиторий

`UserRepository.purgeInactive(before, exemptIds, batchSize)` → массив
удалённых id. Удаление **пачками**, чтобы каскад по большому
`rank_events` не держал длинную транзакцию:

```sql
DELETE FROM users
 WHERE id IN (
   SELECT id FROM users
    WHERE last_active_at < $1
      AND NOT (id = ANY($2::int[]))
    ORDER BY id
    LIMIT $3
 )
RETURNING id
```

Метод крутит запрос, пока пачка не пуста.

## 4.4 Задача — `src/db/inactiveUsersPurgeJob.js` (новый)

Копия структуры `gamesPurgeJob.js`: `RUN_AT_MINUTE = 25` (00:25 UTC —
после рейтингов 00:05 и игр 00:15), свой `LOCK_KEY` (например
`0x75707267` — 'uprg'; проверить, что не совпадает с ключами
`ratingsJob.js`, `gamesPurgeJob.js`, `clientReportsPurgeJob.js`);
`purgeInactiveUsers(db, { now })` → `before = now - inactiveDays·сутки`,
`exempt = config.admin.userIds`; лог `[users] purged N inactive account(s)`
(без ников — ник это персональные данные удалённого); `msUntilNextRun`;
`startInactiveUsersPurgeJob(db)`; ручной запуск при прямом исполнении.

- `main.js`: `startInactiveUsersPurgeJob(dbPool.getPool());` рядом с
  остальными задачами, с комментарием.
- `packages/auth/package.json` → `scripts`: `"db:users-purge": "node --env-file-if-exists=../../.env src/db/inactiveUsersPurgeJob.js"`.

## 4.5 Тесты

- `tests/auth/inactiveUsersPurgeJob.test.js` по образцу
  `gamesPurgeJob.test.js`: блокировка занята — пропуск; граница `before`
  (ровно 30 суток); `exempt` передаётся; `msUntilNextRun` → 00:25 UTC.
- `tests/auth/UserRepository.test.js`: `purgeInactive` крутит пачки до
  пустой и собирает id.
- Тест активности на `PUT /rank`/`PUT /state` — если обработчики вынесены
  в модуль; иначе вынести вызов в маленькую функцию (`touchAfterWrite`) и
  протестировать её.

## 4.6 Документация (en и ru одинаково)

- `docs/{en,ru}/auth.md`: раздел «## Inactive accounts» — правило 30 дней,
  что считается активностью (4.1), исключение админов, что удаляется
  каскадом (включая место в рейтинге), авторство игр обнуляется,
  расписание 00:25 UTC и ручной запуск `npm -w @vimp/auth run db:users-purge`.
- `docs/{en,ru}/configuration.md`: `accounts.inactiveDays`,
  `accounts.purgeBatchSize` (раздел конфига auth, если он там описан;
  иначе — в `auth.md`).

## Проверки

Prettier, eslint, `npx vitest run --reporter=dot`. Ручная на локальной
БД: участник с `last_active_at = now() - interval '31 days'` удаляется
`npm -w @vimp/auth run db:users-purge` вместе с его `rank_events`; админ
из `VIMP_ADMIN_USER_IDS` — нет.

## Критерии готовности

- Участники без активности 30 суток удаляются ежедневно, админы — нет.
- Активность обновляется на продлении, входе, записи rank/state, смене
  ника — не чаще раза в час.
- Release impact: auth-сервис (выкатывается со всем планом).
