# Этап 1. auth: схема БД, ник гостя, подписанные токены

Зависит от этапа 0 (ответ **У1** — формат ника гостя). Только
`packages/auth/` и `tests/auth/`; движок не трогается.

## Контекст (проверено по коду 2026-10-07)

- Миграции — `packages/auth/src/db/migrations/*.sql`; `src/db/migrate.js`
  прогоняет **все** файлы по порядку имён на **каждом** деплое, таблицы
  версий нет. Значит, каждый файл обязан быть безопасен при повторе, и
  старый файл, ссылающийся на удаляемую колонку, после её удаления
  **упадёт** — такие файлы «выводятся» (тело заменяется комментарием, номер
  не переиспользуется; прецедент — `004_host_ratings.sql`).
- Таблица `users` (`001_init.sql`): `id SERIAL`, `provider TEXT NOT NULL`,
  `provider_uid TEXT NOT NULL`, `nick TEXT UNIQUE` (может быть `NULL` —
  шаг между OAuth-колбэком и `POST /nick`), `created_at`,
  `UNIQUE (provider, provider_uid)`; `002` — уникальный индекс
  `users_nick_lower_unique_idx ON users (lower(nick))`; `009` — `ALTER TABLE
users ADD COLUMN IF NOT EXISTS role …` (+ таблица `games`, FK
  `author_user_id`, `moderator_user_id` → `ON DELETE SET NULL`); `010` —
  `DELETE FROM users WHERE nick IS NULL AND provider = 'dev' …`; `011` —
  `UPDATE users SET role = 'admin' WHERE role = 'superadmin'`.
- FK на `users(id)`: `ratings`, `states`, `rank_events`, `rank_periods` —
  `ON DELETE CASCADE`; `games.author_user_id`, `games.moderator_user_id`,
  `client_reports.status_by` — `ON DELETE SET NULL`. Удаление строки
  пользователя уносит все его игровые данные и обнуляет ссылки — это и
  нужно чистому старту (Р2) и удалению по неактивности (этап 4).
- `src/UserRepository.js` (1011 строк — читать фрагментами): методы
  пользователя `findOrCreateByProvider` (~224), `setNick` (~245, только
  `WHERE nick IS NULL`), `deleteIfAnonymous` (~278), `findByNick` (~291,
  без учёта регистра — остаётся, им пользуется `lib/gameAuthor.js`),
  `getIdentity` (~302), `syncRole` (~663), `getRole` (~679); ошибки
  `NickTakenError`, `NickAlreadySetError` (строки 7–25). Тесты —
  `tests/auth/UserRepository.test.js` с заглушкой
  `createDbStub(handlers) → { query: vi.fn(...) }`.
- `src/lib/oauthState.js` — HMAC-подписанный state
  (`payload.signature`, base64url, сравнение `crypto.timingSafeEqual`),
  секрет `VIMP_AUTH_STATE_SECRET` (dev-запасной `'dev-oauth-state-secret'`).
  На его основе делается общий модуль подписанных токенов.

## 1.1 Миграции

1. **Вывести** `010_drop_anonymous_users.sql` и
   `011_drop_superadmin.sql`: тело заменить комментарием «retired:
   ссылается на колонки users.provider/role, удалённые в 017; номер не
   переиспользуется» (как `004_host_ratings.sql`).
2. `009_games.sql`: строку `ALTER TABLE users ADD COLUMN IF NOT EXISTS
role TEXT NOT NULL DEFAULT 'user';` и абзац комментария о ролях
   заменить комментарием «роль больше не хранится в БД (017): админы —
   `VIMP_ADMIN_USER_IDS`». Иначе каждый деплой заново добавлял бы колонку,
   а 017 снова её удалял.
3. Новый `017_passkey_accounts.sql` (комментарий-шапка по-русски: зачем —
   замена авторизации, чистый старт Р2, гостей в БД нет Р8):

   ```sql
   -- чистый старт: прежние OAuth-аккаунты удаляются ОДИН раз — пока есть
   -- колонка provider; повторный прогон (migrate.js гоняет всё) уже её не
   -- видит и ничего не удаляет. CASCADE уносит ratings/states/rank_events/
   -- rank_periods, у games и client_reports ссылки обнуляются
   DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'provider'
     ) THEN
       DELETE FROM users;
       ALTER TABLE users DROP COLUMN provider;
       ALTER TABLE users DROP COLUMN provider_uid;
     END IF;
   END $$;

   ALTER TABLE users DROP COLUMN IF EXISTS role;
   ALTER TABLE users ALTER COLUMN nick SET NOT NULL;
   ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT now();
   ALTER TABLE users ADD COLUMN IF NOT EXISTS webauthn_user_id BYTEA;
   CREATE UNIQUE INDEX IF NOT EXISTS users_webauthn_user_id_idx ON users (webauthn_user_id);
   CREATE INDEX IF NOT EXISTS users_last_active_idx ON users (last_active_at);

   CREATE TABLE IF NOT EXISTS webauthn_credentials (
     id           TEXT PRIMARY KEY,                -- credential id, base64url
     user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     public_key   BYTEA NOT NULL,
     counter      BIGINT NOT NULL DEFAULT 0,
     transports   TEXT[] NOT NULL DEFAULT '{}',
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx ON webauthn_credentials (user_id);

   -- сессия устройства участника: секрет живёт только в браузере, здесь —
   -- его sha256 (утечка БД не даёт войти). Срока нет (правило «без срока
   -- действия»); уходит с аккаунтом (CASCADE) или по «Sign out»
   CREATE TABLE IF NOT EXISTS sessions (
     id           BIGSERIAL PRIMARY KEY,
     user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
     secret_hash  CHAR(64) NOT NULL UNIQUE,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

   -- номер гостя: единственное касание БД гостем — счётчик, не строка о
   -- нём. Ник гостя — перестановка номера (lib/guestNick.js), поэтому
   -- уникален по построению
   CREATE SEQUENCE IF NOT EXISTS guest_nick_seq;
   ```

   Проверить порядок на **чистой** БД: `001` создаёт `users` с
   `provider`, `017` их удаляет (таблица пуста) — должно пройти; и на
   **существующей**: первый прогон чистит, второй (повторный деплой) —
   ничего не меняет и не падает. Обе проверки — вручную на локальном
   Postgres (`npm run auth:db:migrate` дважды; перед этим сделать
   `pg_dump` локальной БД, если она дорога). После 017 старый `main.js`
   (до этапа 2) на этой БД не работает (нет `role`) — между этапами 1 и 2
   локальный auth не запускать.

## 1.2 `UserRepository`

`packages/auth/src/UserRepository.js`:

1. Старые методы (`findOrCreateByProvider`, `setNick`, `deleteIfAnonymous`,
   `getIdentity`, `syncRole`, `getRole`, класс `NickAlreadySetError`) на
   этом этапе **не удалять**: ими ещё пользуются `main.js` и `devLogin.js`,
   и `npx eslint .` конца этапа должен быть зелёным. Их удаляет этап 2
   вместе с переписыванием `main.js` (там это шаг 2.9).
2. **Добавить** (каждый — один SQL-запрос через `this._db.query`, JSDoc
   по-русски):
   - `nextGuestNumber()` → `SELECT nextval('guest_nick_seq') AS n` →
     `Number(row.n)` (до 2⁵³ — безопасно).
   - `findById(userId)` → `{ id, nick } | null`.
   - `createMember({ nick, webauthnUserId, credential, sessionHash })` —
     **одним** запросом с изменяющими CTE (атомарно без транзакции на
     пуле):

     ```sql
     WITH u AS (
       INSERT INTO users (nick, webauthn_user_id) VALUES ($1, $2)
       RETURNING id, nick
     ), c AS (
       INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports)
       SELECT $3, u.id, $4, $5, $6 FROM u
     ), s AS (
       INSERT INTO sessions (user_id, secret_hash) SELECT u.id, $7 FROM u
     )
     SELECT id, nick FROM u
     ```

     `credential` — `{ id, publicKey (Uint8Array → Buffer), counter,
transports (string[]) }`. Нарушение уникальности (`err.code ===
'23505'`): по `err.constraint` — индекс ника
     (`users_nick_lower_unique_idx` или `users_nick_key`) →
     `NickTakenError`; ключ credential (`webauthn_credentials_pkey`) → новый
     `CredentialExistsError`; иное — пробросить.

   - `createDevMember(nick)` (только для dev-логина этапа 2) →
     `INSERT INTO users (nick) VALUES ($1) RETURNING id, nick`; 23505 →
     `NickTakenError`.
   - `findCredential(credentialId)` → `{ id, userId, nick, publicKey
(Buffer), counter (Number), transports }` (JOIN users) или `null`.
   - `updateCredentialUse(credentialId, counter)` → `counter`,
     `last_used_at = now()`.
   - `createSession(userId, secretHash)`.
   - `findSessionUser(secretHash)` → `{ id, nick } | null` (JOIN users).
   - `deleteSession(secretHash)` → `boolean`.
   - `touchSession(secretHash, minIntervalMs)` и
     `touchActivity(userId, minIntervalMs)` — обновляют
     `sessions.last_used_at` / `users.last_active_at`, **только если**
     прошло больше `minIntervalMs`:
     `… SET last_active_at = now() WHERE id = $1 AND last_active_at < now() - ($2 * interval '1 millisecond')`
     (запись на каждый запрос токена не нужна — запись раз в час).
   - `renameNick(userId, nick)` → `{ id, nick }`; 23505 → `NickTakenError`;
     нет строки → `null`.
3. `findByNick` оставить; убрать из его комментария упоминания OAuth.

## 1.3 Подписанные токены — `src/lib/signedToken.js`

Обобщение `lib/oauthState.js` (сам `oauthState.js` удаляется на этапе 2
вместе с OAuth):

```js
/**
 * @param {string} secret - HMAC-ключ (VIMP_AUTH_STATE_SECRET).
 * @returns {{ sign(payload: Object): string, verify(token: string, typ: string, now?: number): Object }}
 */
export function createSigner(secret) { … }
```

- `sign(payload)` → `base64url(JSON) + '.' + base64url(HMAC-SHA256)`;
  `payload.typ` обязателен.
- `verify(token, typ, now = Date.now())`: формат, подпись (постоянное
  время, как `signaturesMatch` в `oauthState.js`), `payload.typ === typ`,
  если есть `payload.exp` (мс) — `now < exp`; иначе бросает `Error`.
- Секрет — из `config.session.secret` (ключ появится на этапе 2; здесь
  модуль принимает секрет параметром и от конфига не зависит).

Тесты `tests/auth/signedToken.test.js`: круг sign→verify; чужая подпись;
испорченный payload; другой `typ`; истёкший `exp`; токен без точки.

## 1.4 Ник гостя — `src/lib/guestNick.js` (зависит от У1)

Чистые функции без БД:

- `formatGuestNick(n)` — номер `n ≥ 1` из `guest_nick_seq` → ник.
  Перестановка — **аффинная по модулю домена** (обратима, проще сети
  Фейстеля): `v = (BigInt(n) * A + B) % D`, где `D` — размер домена
  формата, `A` взаимно просто с `D`, `B` — смещение. `A` и `B` —
  **константы в коде, менять нельзя никогда** (смена отображения выдала бы
  уже выданный ник второй раз) — так и написать в комментарии; они не
  секрет, задача — чтобы ники не шли подряд.
  - **У1 = A:** `D = 36n ** 9n`; `v` → 9 символов `[0-9A-Z]`
    (`v.toString(36).toUpperCase().padStart(9, '0')`) → `'Guest' + …`
    (14 символов). `A` — простое, не делящее 2 и 3 (`D = 2¹⁸·3¹⁸`),
    например `A = 1_000_000_007n`.
  - **У1 = B:** списки `ADJECTIVES` и `NOUNS` по 64 английских слова длиной
    3–5 букв с заглавной (составить при исполнении, без двусмысленных и
    оскорбительных), `D = 64·64·10000`; `v` раскладывается на
    `(adj, noun, digits)`; ник `Adj + Noun + digits.padStart(4,'0')`.
    `A` взаимно прост с `D = 2¹⁶·5⁴` (нечётный и не делится на 5) —
    проверить `gcd(A, D) === 1n` в тесте. При `n > D` — запасной формат `'Player' + 8 символов [0-9A-Z]`
    (своя аффинная перестановка над `36⁸`).
- `isReservedNick(nick)` — занят ли ник гостевым шаблоном (смена ника
  такой ник не принимает): A — `/^guest/i`; B — совпадение с шаблоном
  «слово из ADJECTIVES + слово из NOUNS + 4 цифры» (без учёта регистра)
  или `/^player[0-9a-z]{8}$/i`.
- Каждый выданный ник обязан проходить `isValidNick` (`lib/validators.js`:
  `^[a-zA-Z][\w #]{0,13}\w$`) и `isReservedNick`.

Тесты `tests/auth/guestNick.test.js`: первые 10 000 номеров дают разные
ники; все проходят `isValidNick` и `isReservedNick`; детерминизм (тот же
`n` → тот же ник); `gcd(A, D) === 1`; длина ≤ 14; вариант B — запасной
формат после `D`.

## 1.5 Тесты репозитория

`tests/auth/UserRepository.test.js`: добавить на каждый новый метод (SQL и параметры через заглушку
`createDbStub`): `createMember` разбирает 23505 по `constraint` в
`NickTakenError`/`CredentialExistsError`; `touchActivity` передаёт
интервал; `findSessionUser` возвращает `null` на пустой выборке и т. д.

## 1.6 Документация

`docs/{en,ru}/auth.md`, раздел «## Schema»: таблица `users` (без
`provider`/`provider_uid`/`role`; `last_active_at`, `webauthn_user_id`,
`nick NOT NULL`), новые `webauthn_credentials`, `sessions`, последовательность
`guest_nick_seq`; абзац «Clean start (017)» — что удаляется один раз и
почему повтор безопасен; выведенные `010`, `011` и строка роли в `009`.
Формат ника гостя и резерв шаблона — короткий подраздел (ссылка на
`lib/guestNick.js`).

## Проверки

Prettier, eslint, `npx vitest run --reporter=dot` (проект `auth` тоже),
двойной прогон миграций на локальной БД (1.1).

## Критерии готовности

- 017 на существующей БД один раз удаляет всех пользователей и колонки,
  повтор ничего не делает; на чистой БД проходит.
- Выведенные 010/011 и правка 009 не ломают повторный прогон.
- Новые методы репозитория, `signedToken`, `guestNick` покрыты тестами.
- `auth.md` (en/ru) описывает новую схему.
- Release impact: только auth-сервис (выкатывается вместе со всем планом).
