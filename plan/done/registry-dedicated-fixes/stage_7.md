# Этап 7. Убрать роль `superadmin` ✅ выполнен

В исходный список замечаний не входит — выделен по ходу разбора замечания
№ 2. Независим от этапов 1–6, порядок любой.

## Что подтвердилось

Разницы **в правах** между `admin` и `superadmin` в коде нет ни одной: обе
роли всюду проверяются вместе.

```
packages/engine/src/master/adminAuth.js:22    const ADMIN_ROLES = ['admin', 'superadmin'];
packages/engine/src/client/main.js:1984       const ADMIN_ROLES = ['admin', 'superadmin'];
packages/auth/src/main.js:165                 if (role !== 'admin' && role !== 'superadmin')
packages/auth/src/main.js:182                 return role === 'admin' || role === 'superadmin';
```

Два имени кодируют **происхождение** роли, а не объём прав.
`packages/auth/src/UserRepository.js:733`:

```sql
SET role = CASE WHEN $2 THEN 'superadmin'           -- ник есть в VIMP_ADMIN_NICKS
                WHEN role = 'superadmin' THEN 'user' -- выпал из списка → разжаловать
                ELSE role END                        -- 'admin' из БД не трогаем
```

`superadmin` выдаёт `VIMP_ADMIN_NICKS` и `syncRole` разжалует его при
выпадении из списка; `admin` — назначение в БД, которое `CASE` намеренно не
трогает. UI назначения `admin` не существует: сегодня его можно поставить
только руками в SQL. То есть второе имя обслуживает только гипотетическое
будущее.

## Решение

Роли — `user` | `admin`. `VIMP_ADMIN_NICKS` становится единственным
источником админских прав; любой `admin` вне списка разжалуется при
следующем входе. Назначение админа в обход списка перестаёт быть возможным —
это осознанный размен, зафиксировать его комментарием над `syncRole` и в
документации.

## Изменения по файлам

### 1. `packages/auth/src/db/migrations/011_drop_superadmin.sql` (новая)

Номер — следующий за `010_drop_anonymous_users.sql`; перед созданием
сверить:

```bash
ls packages/auth/src/db/migrations/
```

Содержимое (идемпотентна и перезапускаема, как остальные миграции):

```sql
-- Роль superadmin упразднена: прав, отличных от admin, у неё не было ни
-- одной проверки, а различие «выдана окружением / назначена в БД» больше не
-- используется — источник админских прав теперь только VIMP_ADMIN_NICKS.
UPDATE users SET role = 'admin' WHERE role = 'superadmin';
```

### 2. `packages/auth/src/UserRepository.js`, `syncRole` (строка 733)

```sql
SET role = CASE WHEN $2 THEN 'admin'
                WHEN role = 'admin' THEN 'user'
                ELSE role END
```

Комментарий над методом (строки 729–732) переписать: список окружения —
единственный источник админской роли, любой `admin` вне списка разжалуется
при следующем входе.

### 3. `packages/auth/src/main.js`

- строка 165: `if (role !== 'admin')`;
- строка 182: `return role === 'admin';`.

### 4. `packages/engine/src/master/adminAuth.js` и `packages/engine/src/client/main.js`

Константу `ADMIN_ROLES` заменить проверкой `role === 'admin'`
(`adminAuth.js:22,66,99`; `client/main.js:1984,2243`). Константу удалить,
если после этого она больше нигде не нужна:

```bash
grep -rn "ADMIN_ROLES" packages/engine/src
```

### 5. `packages/auth/src/lib/jwt.js`

Правок нет: клейм `role` остаётся подсказкой клиенту, значение просто
меняется с `superadmin` на `admin`.

## Тесты

- `tests/auth/UserRepository.test.js:935-951` — оба случая переписать на
  `'admin'`: назначение по списку окружения и разжалование выпавшего из
  списка; проверки текста SQL (`CASE WHEN $2 THEN 'admin'`,
  `WHEN role = 'admin' THEN 'user'`) обновить.
- `tests/auth/jwt.test.js:42-46` — роль в токене `'admin'`.
- `tests/master/adminAuth.test.js:111` — случай `superadmin` заменить на
  `admin`; добавить случай, что произвольная неизвестная роль отвергается.
- После этапа `grep -rn "superadmin" packages tests docs` не должен находить
  ничего, кроме, возможно, записи в changelog.

## Документация и changelog

- `docs/en/auth.md` (строки ~69 и ~119) и `docs/ru/auth.md` (строки ~70 и
  ~119) — `VIMP_ADMIN_NICKS` выдаёт `role = 'admin'`; роли всего две;
  описание разжалования без оговорки про «роль, назначенную в БД».
- `docs/en/deployment.md` (строка ~473) и зеркальная строка в
  `docs/ru/deployment.md` — та же замена слова.
- `packages/engine/CHANGELOG.md` → `### Changed` (движок перестал признавать
  роль `superadmin`). **Уровень: patch.** Формально это ужесточение: токен
  со старой ролью после выката перестанет считаться админским — но такой
  токен живёт 4 часа и выпускается тем же auth-сервисом, который в том же
  деплое переходит на `admin`, поэтому `⚠️ Breaking` не требуется.

## Порядок выката

Сначала auth-сервис с миграцией (`npm run auth:db:migrate`), затем мастера —
иначе выданные до миграции токены с ролью `superadmin` перестанут
признаваться раньше, чем auth начнёт выдавать `admin`.

## Ручная проверка

После миграции войти ником из `VIMP_ADMIN_NICKS` — панель «Moderation»
видна, `/admin/games` отвечает 200. Убрать ник из списка, перевойти — панель
исчезает, `/admin/games` отвечает 403.
