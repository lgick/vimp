# Этап 1. Роли и реестр игр в auth-сервисе ✅ выполнен

**Область:** `packages/auth/**`, `tests/auth/**`. Движок на этом этапе не
трогается.

**Цель:** в БД появляются роли пользователей и таблица игр; auth отдаёт REST
для каталога, заявок разработчика и модерации. Мастер начнёт этим
пользоваться на Этапе 3.

## Что нужно знать об этом пакете перед началом

- `packages/auth` — отдельный workspace-пакет `@vimp/auth` (Express 5 + `pg`),
  со своим Dockerfile и своим деплоем. Весь SQL живёт в одном файле —
  `src/UserRepository.js`; в `src/main.js` только роуты и middleware.
- **Миграции прогоняются все и каждый раз** (`src/db/migrate.js:11-12`:
  `readdirSync().filter(.sql).sort()`), журнала версий нет. Всё обязано быть
  идемпотентным: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
  `ON CONFLICT DO NOTHING`.
- `CHECK`-констрейнтов в схеме нет нигде — значения валидирует приложение.
  Не заводить их и здесь: это сломает стиль и усложнит будущие статусы.
- Тесты `tests/auth/UserRepository.test.js` работают **без БД**: `createDbStub`
  подменяет `query` и тесты проверяют текст SQL и массив `values`. Держаться
  этого стиля.
- Ник глобально уникален и регистронезависим
  (`002_nick_case_insensitive.sql:6` — `UNIQUE INDEX ON users (lower(nick))`),
  поэтому список админов по никам одинаково работает для github/google/apple.

## 1.1 Миграция `packages/auth/src/db/migrations/009_games.sql`

```sql
-- Роли пользователей (направление master-game-registry, этап 1).
-- Источник истины на этом этапе — переменная окружения VIMP_ADMIN_NICKS,
-- которая при каждом входе синхронизируется в эту колонку. Колонка заведена
-- сразу, чтобы будущее назначение модераторов из интерфейса не требовало
-- новой миграции.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

-- Реестр игр платформы. Один на все мастера (SERVERS_MATRIX), поэтому живёт
-- здесь, а не на мастере: модерация должна быть одна на платформу.
CREATE TABLE IF NOT EXISTS games (
  id                TEXT PRIMARY KEY,
  package_name      TEXT NOT NULL,
  title             TEXT,
  repo_url          TEXT,
  author_user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  version           TEXT,
  pending_version   TEXT,
  max_game_score    INTEGER,
  moderator_note    TEXT,
  moderator_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- имя пакета уникально независимо от регистра: две записи на один npm-пакет
-- означали бы две раздачи одного кода под разными id
CREATE UNIQUE INDEX IF NOT EXISTS games_package_lower_idx
  ON games (lower(package_name));
CREATE INDEX IF NOT EXISTS games_status_idx ON games (status);

-- Перенос уже живущих игр: без seed лобби опустеет между деплоем и первым
-- действием админа. author_user_id = NULL — игры платформы, автора нет.
INSERT INTO games (id, package_name, title, repo_url, status, version)
VALUES
  ('tanks',  '@vimp-games/tanks',  'VIMP Tanks',  'https://github.com/lgick/vimp-tanks',  'approved', '0.16.1'),
  ('snakes', '@vimp-games/snakes', 'VIMP Snakes', 'https://github.com/lgick/vimp-snakes', 'approved', '0.9.1')
ON CONFLICT (id) DO NOTHING;
```

### Семантика полей

| Поле | Смысл |
| --- | --- |
| `id` | сегмент URL `/games/<id>/`, обязан совпадать с `manifest.id` пакета |
| `status` | `pending` \| `approved` \| `rejected` \| `disabled` |
| `version` | одобренная версия, которую раздают мастера; `NULL` до первого одобрения |
| `pending_version` | версия на модерации; её мастер стейджит и показывает только админам |
| `max_game_score` | потолок результата ОДНОГО матча (клампит `PUT /auth/rank`); `NULL` → дефолт движка |
| `moderator_note` | текст отказа/замечания, который видит разработчик |

Отдельного статуса `testing` нет намеренно: «игра на тесте» — это наличие
`pending_version`. Так игра может быть одновременно опубликована (v1 играют
игроки) и на тесте (v2 гоняет админ), что и требуется.

## 1.2 `packages/auth/src/config/auth.js`

Добавить два блока в тот же экспортируемый объект:

```js
  // Админы платформы (направление master-game-registry). Список ников задаёт
  // деплой: VIMP_ADMIN_NICKS="lgick,Admin". Ник глобально уникален и
  // регистронезависим, поэтому список провайдеронезависим — работает и для
  // github, и для будущих google/apple.
  admin: {
    nicks: (process.env.VIMP_ADMIN_NICKS || '')
      .split(',')
      .map(nick => nick.trim().toLowerCase())
      .filter(Boolean),
  },

  games: {
    // сегмент URL: строчная латиница, цифры и дефис
    idPattern: /^[a-z][a-z0-9-]{1,30}$/,
    // имя npm-пакета, в т.ч. scoped
    packagePattern: /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
    versionPattern: /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/,
    maxPerUser: 20,
    maxNoteLength: 1000,
    maxTitleLength: 60,
    maxUrlLength: 200,
  },
```

`VIMP_ADMIN_NICKS` не обязателен: пустая строка = админов нет (в проде это
законное состояние до первой настройки, падать нельзя).

## 1.3 `packages/auth/src/UserRepository.js`

Стиль существующих методов: один SQL на операцию, отказ — именованным классом
ошибки, никакой бизнес-логики в `main.js`.

### Новые классы ошибок

Рядом с существующими `NickTakenError` / `NickAlreadySetError`:
`GameExistsError`, `GameNotFoundError`, `GameForbiddenError`, `GameLimitError`.

### Роли

```js
// Синхронизация роли по списку из окружения. Одним запросом и через CASE —
// чтобы не гасить роль, назначенную из БД (будущее назначение модераторов
// из админки): понижаем только того, кто получил superadmin из этого же
// списка и в нём больше не значится.
async syncRole(userId, isEnvAdmin) {
  const { rows } = await this._db.query(
    `UPDATE users
        SET role = CASE WHEN $2 THEN 'superadmin'
                        WHEN role = 'superadmin' THEN 'user'
                        ELSE role END
      WHERE id = $1
      RETURNING role`,
    [userId, isEnvAdmin],
  );

  return rows[0]?.role ?? 'user';
}

async getRole(userId) { /* SELECT role FROM users WHERE id = $1 */ }
```

### Игры

| Метод | SQL/поведение |
| --- | --- |
| `listApprovedGames()` | `status='approved' AND version IS NOT NULL`, `LEFT JOIN users` за ником автора; сортировка по `id` (порядок каталога обязан быть детерминированным — первая игра становится активной в лобби) |
| `listAllGames()` | всё, с ником автора и модератора, сортировка по `updated_at DESC` |
| `listGamesByAuthor(userId)` | `author_user_id = $1` |
| `getGame(id)` | одна строка + ник автора |
| `createGame({id, packageName, title, repoUrl, version, authorUserId})` | `INSERT … status='pending', pending_version = $version`; `err.code === '23505'` → `GameExistsError` (сработает и по PK `id`, и по `games_package_lower_idx`); перед вставкой проверить `COUNT(*) WHERE author_user_id=$1` против `config.games.maxPerUser` → `GameLimitError` |
| `requestGameVersion(id, version, {userId, isAdmin})` | `UPDATE games SET pending_version=$2, moderator_note=NULL, status = CASE WHEN status='rejected' THEN 'pending' ELSE status END, updated_at=now() WHERE id=$1 AND ($3 OR author_user_id=$4) RETURNING *`; 0 строк → различить `GameNotFoundError` / `GameForbiddenError` дополнительным `getGame` |
| `moderateGame(id, patch, moderatorUserId)` | частичное обновление `status`/`version`/`pending_version`/`moderator_note`/`max_game_score` + `moderator_user_id`, `updated_at=now()`; собирать `SET` динамически только из переданных ключей, значения — всегда через `$n` |

**Важно:** нигде не интерполировать значения в текст SQL. Единственное место в
этом файле, где литералы попадают в текст (`periodSlice`, строки 36-40),
специально задокументировано как «значения приходят только из кода» — новый
код так делать не должен.

## 1.4 `packages/auth/src/lib/jwt.js`

`signIdentityToken({ sub, nick, role })` кладёт `role` в payload:

```js
export function signIdentityToken({ sub, nick, role }) {
  return jwt.sign({ nick, role: role ?? 'user' }, /* … как сейчас … */);
}
```

Клеймы `iss`/`sub`/`exp`/`kid` не трогать. Движковый верификатор
(`packages/engine/src/lib/jwt.js:46-103`) проверяет `alg`, `iss`, `exp`,
непустой `nick` и подпись — новое поле для него аддитивно; токены без `role`
(уже выданные, лежат в `localStorage` у игроков) читаются как `'user'`.

## 1.5 `packages/auth/src/main.js`

### Синхронизация роли при выпуске токена

Роль должна попадать в токен в обоих местах, где он выпускается:

1. OAuth-callback, ветка `if (user.nick)` (~`:213-218`);
2. `POST /nick` после `setNick` (~`:271`).

Вынести в общий хелпер, чтобы ветки не разъезжались:

```js
async function issueIdentityToken(user) {
  const isEnvAdmin = config.admin.nicks.includes(user.nick.toLowerCase());
  const role = await userRepo.syncRole(user.id, isEnvAdmin);

  return jwtLib.signIdentityToken({ sub: user.id, nick: user.nick, role });
}
```

### `requireAdmin`

Обёртка над существующим `requireAuth` (`:102-131`), читающая роль **из БД**:

```js
// Роль берётся из БД, а не из клейма токена: identity-токен живёт 4 часа, и
// разжалование обязано действовать немедленно. Клейм в токене нужен только
// клиенту — показать вкладку «Модерация».
function requireAdmin(req, res, next) {
  requireAuth(req, res, async () => {
    const role = await userRepo.getRole(req.user.id);

    if (role !== 'admin' && role !== 'superadmin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    req.user.role = role;
    next();
  });
}
```

(Отказ `getRole` должен уходить в 500 через общий обработчик, а не в
`next()` — обернуть в `try/catch`.)

### Новые роуты

| Метод | Путь | Доступ | Тело / ответ |
| --- | --- | --- | --- |
| `GET` | `/games` | публично | `{ games: [{id, packageName, title, repoUrl, version, maxGameScore, authorNick}] }` — только одобренные |
| `GET` | `/games/mine` | `requireAuth` | все игры вызывающего, со `status`, `pendingVersion`, `moderatorNote` |
| `POST` | `/games` | `requireAuth`, 5/60с на IP | `{id, packageName, repoUrl, title, version}` → 201 + строка |
| `POST` | `/games/:id/version` | `requireAuth` (автор или админ) | `{version}` → строка |
| `GET` | `/admin/games` | `requireAdmin` | все игры со статусами |
| `PATCH` | `/admin/games/:id` | `requireAdmin` | `{status?, version?, pendingVersion?, note?, maxGameScore?}` |

- Лимитер завести рядом с существующими (`:95-96`):
  `const gamesLimiter = new RateLimiter({ limit: 5, windowMs: 60000 })`,
  применить через уже готовый `byIp(...)`.
- Валидация входа — по `config.games.*Pattern` и длинам; невалидное поле даёт
  свой код ошибки, а не общий `badRequest`.
- CORS **не добавлять**: браузер в эти ручки не ходит напрямую, всё идёт через
  прокси мастера (как rank/state/jwks). CORS в этом сервисе есть только у
  `/nick` и это осознанно (`main.js:134-136`).
- `PATCH /admin/games/:id` со `status='approved'` должен, если `version` не
  передан явно, поднять `version = pending_version` и обнулить
  `pending_version` — это самый частый путь и он не должен требовать от
  клиента двух полей.

### Расширение словаря ошибок

`forbidden`, `gameExists`, `unknownGame`, `invalidGameId`,
`invalidPackageName`, `invalidVersion`, `invalidTitle`, `invalidRepoUrl`,
`tooManyGames`.

## 1.6 Тесты

`tests/auth/UserRepository.test.js` — дописать в существующем стиле
(`createDbStub`, проверки текста SQL и `values`):

- `syncRole`: все три ветки `CASE` (назначение, понижение, сохранение чужой
  роли), возврат роли по умолчанию при пустом результате;
- `createGame`: успешная вставка, `23505` → `GameExistsError`, превышение
  `maxPerUser` → `GameLimitError` (и что при этом `INSERT` не выполнялся);
- `requestGameVersion`: автор, чужой (`GameForbiddenError`), админ,
  несуществующая игра, снятие `rejected` → `pending`;
- `moderateGame`: частичный `SET` только из переданных ключей, все значения
  через плейсхолдеры;
- `listApprovedGames` / `listAllGames` / `listGamesByAuthor` / `getGame`.

`tests/auth/jwt.test.js` — `role` попадает в payload; отсутствие `role` в
аргументах даёт `'user'`.

Новый `tests/auth/adminNicks.test.js` — чистая функция разбора
`VIMP_ADMIN_NICKS`: регистр, пробелы, пустая строка, одиночный ник, хвостовая
запятая. (Разбор вынести в маленькую экспортируемую функцию в
`src/config/auth.js` или в `src/lib/validators.js`, чтобы его можно было
позвать из теста без импорта всего конфига.)

Интеграционных тестов на `main.js` в этом пакете нет и заводить не нужно:
`main.js` при импорте поднимает сервер и пул БД (причина зафиксирована в
`tests/auth/rateLimit.test.js:5-7`). Логику держать в `UserRepository` и в
чистых функциях.

## Критерии готовности

1. `npm run auth:db:migrate` проходит **дважды подряд** без ошибок; в `games`
   ровно две строки, у `users` появилась колонка `role` со значением `'user'`.
2. `npx eslint . && npm test -- --silent` — зелено.
3. Вход в лобби с `VIMP_ADMIN_NICKS=<свой ник>` выдаёт токен, в payload
   которого `role: 'superadmin'` (проверить `atob` второго сегмента JWT);
   с пустой переменной — `role: 'user'`.
4. Повторный вход после удаления ника из `VIMP_ADMIN_NICKS` возвращает
   `role: 'user'` (проверка ветки понижения).
