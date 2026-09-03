# Этап 4. `VIMP_ADMIN_NICKS`: привязка админа к личности провайдера ✅ выполнен

**Задача заказчика № 3.** Находки F12 и F13 в [review.md](review.md).

## Ответ на вопрос «нельзя ли зайти под ником админа»

**Под ником уже зарегистрированного админа — нельзя.** Ник глобально
уникален без учёта регистра (`002_nick_case_insensitive.sql`), `setNick`
(`UserRepository.js:216`) пишет ник только при `nick IS NULL` (то есть
переименования не существует), а сравнение со списком идёт в нижнем
регистре с обеих сторон (`parseAdminNicks` + `user.nick.toLowerCase()`).
Занять чужой ник другим регистром или через другого OAuth-провайдера
нельзя.

**Уязвим свободный ник.** Права привязаны к *строке*, а не к личности:
если ник из `VIMP_ADMIN_NICKS` в `users` ещё не занят — новая БД, ник
внесён в список до первого входа человека, опечатка в списке, — то
первый, кто под ним зарегистрируется, получит `role = 'admin'`.
OAuth-вход открыт всем, `POST /nick` тоже, гонка выигрывается одним
запросом.

Dev-вход (`devLogin.js`) даёт админа под любым ником, но регистрируется
только при `NODE_ENV !== 'production'` — в проде маршрута нет. Это в
порядке и правки не требует.

## 4.1. Новый источник прав: `VIMP_ADMIN_IDENTITIES`

Опциональная переменная окружения, CSV из `провайдер:uid`, например
`github:1234567,github:7654321`. `uid` — это `provider_uid` строки
`users` (для GitHub — числовой id аккаунта, он не меняется при
переименовании аккаунта).

Правило разрешения (закрепить комментарием в коде):

- переменная **задана** → админские права даёт только она;
  `VIMP_ADMIN_NICKS` при этом игнорируется, и при старте печатается
  предупреждение, если он тоже непуст;
- переменная **не задана** → прежнее поведение по `VIMP_ADMIN_NICKS`
  (совместимость с текущим продом обязательна: ни один деплой не должен
  потерять админа при выкате этого этапа).

### Файлы

**`packages/auth/src/config/auth.js`** — рядом с `parseAdminNicks`:

```js
// Разбор VIMP_ADMIN_IDENTITIES: CSV из "провайдер:uid" (github:1234567).
// Отдельная экспортируемая функция по той же причине, что и
// parseAdminNicks: поведение (регистр, пробелы, мусорный элемент)
// проверяется юнит-тестом без импорта всего конфига
export const parseAdminIdentities = raw =>
  String(raw || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(item => /^[a-z0-9_-]+:[^:\s]+$/.test(item));
```

и в объекте конфига, рядом с `admin.nicks`:

```js
    // личности админов (провайдер:uid) — приоритетный источник прав:
    // ник может оказаться ещё не занятым, и тогда его захватывает кто
    // угодно, а provider_uid принадлежит конкретному аккаунту
    identities: parseAdminIdentities(process.env.VIMP_ADMIN_IDENTITIES),
```

**`packages/auth/src/lib/adminRights.js`** (новый) — вся развилка,
вынесенная из `main.js` по той же причине, что и `gameAuthor.js`:
`main.js` при импорте поднимает сервер и пул БД, и иначе это не
протестировать.

```js
/**
 * Кто считается админом. VIMP_ADMIN_IDENTITIES (провайдер:uid) важнее
 * VIMP_ADMIN_NICKS: ник — строка, которую до первой регистрации может
 * занять кто угодно, а provider_uid принадлежит конкретному аккаунту
 * провайдера и не меняется при переименовании.
 *
 * @param {Object} admin - Блок config.admin ({nicks, identities}).
 * @param {Object} user - Кто входит.
 * @param {string} user.nick - Ник.
 * @param {string} [user.provider] - OAuth-провайдер строки users.
 * @param {string} [user.providerUid] - provider_uid строки users.
 * @returns {boolean} Давать ли роль admin.
 */
export default function isEnvAdmin(admin, { nick, provider, providerUid }) {
  const identities = admin?.identities ?? [];

  if (identities.length > 0) {
    if (!provider || providerUid === undefined || providerUid === null) {
      return false;
    }

    return identities.includes(
      `${String(provider).toLowerCase()}:${String(providerUid).toLowerCase()}`,
    );
  }

  return (admin?.nicks ?? []).includes(String(nick ?? '').toLowerCase());
}
```

**`packages/auth/src/UserRepository.js`** — метод для личности (если
подходящего ещё нет; проверить `findOrCreateByProvider`/`getRole`
рядом):

```js
  // провайдер и его uid — по ним, а не по нику, определяется админ
  // (VIMP_ADMIN_IDENTITIES)
  async getIdentity(userId) {
    const result = await this._db.query(
      'SELECT provider, provider_uid FROM users WHERE id = $1',
      [userId],
    );

    return result.rows[0] ?? null;
  }
```

**`packages/auth/src/main.js`**, `issueIdentityToken`:

```js
async function issueIdentityToken(user) {
  // личность читается из БД: обе точки выпуска токена (OAuth-колбэк и
  // POST /nick) знают id и ник, но не провайдера
  const identity = config.admin.identities.length
    ? await userRepo.getIdentity(user.id)
    : null;
  const envAdmin = isEnvAdmin(config.admin, {
    nick: user.nick,
    provider: identity?.provider,
    providerUid: identity?.provider_uid,
  });
  const role = await userRepo.syncRole(user.id, envAdmin);

  return jwtLib.signIdentityToken({ sub: user.id, nick: user.nick, role });
}
```

Лишнего запроса в БД в конфигурациях без `VIMP_ADMIN_IDENTITIES` не
появляется — он делается только когда список непуст.

## 4.2. Предупреждение при старте

В `main.js`, там же, где печатается dev-подсказка (около строки 794),
добавить **для всех режимов, включая прод**, проверку при старте:

```js
// Незанятый админский ник — это открытая дверь: права привязаны к
// строке, и первый, кто зарегистрируется под ней, получит admin.
// Печатается один раз при старте; VIMP_ADMIN_IDENTITIES снимает вопрос
async function warnOnFreeAdminNicks() {
  if (config.admin.identities.length > 0 || config.admin.nicks.length === 0) {
    return;
  }

  for (const nick of config.admin.nicks) {
    const user = await userRepo.findByNick(nick).catch(() => null);

    if (!user) {
      console.warn(
        `[admin] nick "${nick}" from VIMP_ADMIN_NICKS is not registered yet — ` +
          'whoever signs up with it first becomes an admin. Pin the account ' +
          'with VIMP_ADMIN_IDENTITIES=<provider>:<uid> once it exists',
      );
      continue;
    }

    console.log(
      `[admin] "${nick}" -> ${user.provider}:${user.provider_uid} ` +
        '(value for VIMP_ADMIN_IDENTITIES)',
    );
  }
}
```

Вызывать после успешного подключения к БД и до/сразу после `listen` —
рядом с тем местом, где сейчас печатается стартовый баннер. Отказ БД не
должен мешать старту (`.catch(() => null)` уже есть на каждый ник, всю
функцию тоже обернуть в `.catch`).

Вторая строка (`nick -> provider:uid`) — не украшение: она даёт админу
готовое значение переменной, иначе его пришлось бы доставать SQL-ом из
прода.

`findByNick` уже существует (`UserRepository.js:262`, добавлен этапом 6
предыдущего плана) — новый метод не нужен.

## 4.3. Тесты

- `tests/auth/adminNicks.test.js` — дописать `parseAdminIdentities`:
  пусто → `[]`; регистр приводится к нижнему; пробелы срезаются; мусор
  без двоеточия и с лишним двоеточием отбрасывается.
- `tests/auth/adminRights.test.js` (новый) — `isEnvAdmin`:
  - `identities` пуст → решает ник (в том числе в другом регистре);
  - `identities` непуст → ник игнорируется полностью (админский ник без
    совпадающей личности прав **не** даёт — это и есть закрытие дыры);
  - совпадение `provider:uid` даёт права, чужой uid — нет;
  - отсутствующие `provider`/`providerUid` при непустом `identities` →
    `false` (fail-closed).
- `tests/auth/UserRepository.test.js` — `getIdentity` отдаёт строку и
  `null` для несуществующего id.

## 4.4. Закрепить F13: `stage` не трогает диск разжалованному админу

`tests/master/lobbyGamesRoutes.test.js`, к существующим тестам `stage`:
случай, где `registry.listAll` отвечает `403` — обработчик обязан
вернуть 403 и **не вызвать** ни `store.ensure`, ни `catalog.upsert`.
Комментарий в тесте: рассуждение
`master/adminAuth.js` («клейма `role` из токена достаточно») держится
именно на этом порядке действий, и тест не даёт переставить их местами
при рефакторинге.

## 4.5. Документация

- `docs/en/auth.md` и `docs/ru/auth.md`, раздел про роли:
  - как определяется админ сейчас (список + `syncRole`, единственный
    источник);
  - новая `VIMP_ADMIN_IDENTITIES`: формат, приоритет, поведение при
    обеих заданных переменных;
  - **явно** описать риск свободного ника и рекомендацию: на новой
    установке либо занять админские ники до открытия регистрации, либо
    сразу заполнить `VIMP_ADMIN_IDENTITIES`;
  - где взять `provider:uid` — из стартового лога сервиса.
- `docs/en/deployment.md` и `docs/ru/deployment.md`, раздел «Who is an
  admin»: новая переменная репозитория, тот же приоритет, та же
  рекомендация.
- `docs/en/configuration.md` / `docs/ru/configuration.md` — если там
  есть таблица переменных auth-сервиса, добавить строку.

Changelog движка **не трогать**: правка целиком в auth-сервисе, который
не входит в публикуемые npm-артефакты. Если по ходу выяснится, что
меняется и движок (не должно), запись пойдёт в `### Security`.

## 4.6. Ручная проверка

1. Поднять auth без `VIMP_ADMIN_IDENTITIES`, с
   `VIMP_ADMIN_NICKS=<свободный ник>` → в логе предупреждение о
   незанятом нике.
2. Войти этим ником → в логе появляется строка
   `[admin] "<ник>" -> github:<uid>`; панель «Moderation» видна.
3. Задать `VIMP_ADMIN_IDENTITIES=github:<чужой uid>`, перезапустить,
   перевойти тем же ником → роль `user`, «Moderation» исчезла,
   `/admin/games` отвечает 403.
4. Вернуть свой `provider:uid` → права вернулись.
