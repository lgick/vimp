# Этап 6 (замечание № 2). Авторство: заявитель — автор, админ переназначает ✅ выполнен

> Отступление от плана: разбор `authorNick` вынесен из маршрута в
> `packages/auth/src/lib/gameAuthor.js` (по образцу `lib/gameViews.js`) —
> `main.js` при импорте поднимает сервер и пул БД, и роутовых тестов в
> `tests/auth/` нет ни одного. Логика и коды ответов ровно те, что описаны
> ниже; `tests/auth/games.test.js` проверяет хелпер и репозиторий.

Независим от этапов 1–5 (auth-сервис + UI модерации), может делаться
параллельно.

## Что подтвердилось

Замечание распадается на две разные вещи.

«Автор не отображается в `#games-moderation`» — это **не** дефект вёрстки:
`packages/engine/src/client/components/view/Games.js:234` печатает
`Author: ${game.authorNick ?? game.authorUserId ?? '—'}`. Прочерк и виден,
потому что у строк нет автора.

Автора нет по устройству: миграция
`packages/auth/src/db/migrations/009_games.sql:33` засеивает `tanks` и
`snakes` с `author_user_id = NULL` — комментарий там прямо это фиксирует
(«игры платформы, автора нет»). А `listGamesByAuthor` выбирает строго
`WHERE g.author_user_id = $1` (`UserRepository.js:796`), поэтому «My games» у
любого пользователя пуст: единственные игры платформы ничьи. Обновить версию
своей игры автор тоже не может — `requestGameVersion` требует
`author_user_id = $4` либо админа (`UserRepository.js:865`).

То есть привязки авторства к живым играм в системе просто нет — есть только
её механика для игр, заведённых через форму.

## Решение (провайдер-агностичное)

Вход скоро будет доступен через google и apple, поэтому привязка к GitHub
отвергнута: у пользователя, зашедшего через google, аккаунта на GitHub может
не быть вовсе. Колонки `provider_login` и `author_verified` **не заводятся**,
роль `developer` **не заводится**, миграция **не нужна**.

- Кнопка «My games» видна всем; заявку может подать любой авторизованный.
- Заявитель автоматически становится автором — это уже так и работает.
- Авторство может изменить админ из панели модерации.

### Что уже работает и трогать не нужно

- `createGame` ставит `author_user_id` заявителя (`UserRepository.js:819`);
- `requestGameVersion` пускает автора или админа (`UserRepository.js:865`);
- `listGamesByAuthor` наполняет «My games» (`UserRepository.js:796`);
- проекция уже отдаёт ник автора: `GAME_FIELDS = g.*, a.nick AS author_nick`
  (`UserRepository.js:144`), `mapGame` кладёт его в `authorNick`
  (строка 109);
- `gameRoutes.moderate` (`packages/engine/src/master/gameRoutes.js:245`)
  проксирует тело `PATCH` как есть — правок нет;
- кнопка «My games» видна всем — правок нет (роль гейтит только
  `#games-moderation`, `view/Games.js:121`).

## Изменения по файлам

### 1. `packages/auth/src/UserRepository.js`

- Поиск пользователя по нику без учёта регистра (индекс из
  `002_nick_case_insensitive.sql`). Сначала проверить, нет ли уже такого
  метода:

  ```bash
  grep -n "lower(nick)\|findByNick\|nickTaken" packages/auth/src/UserRepository.js
  ```

  Нет — добавить `async findByNick(nick)`:

  ```sql
  SELECT * FROM users WHERE lower(nick) = lower($1)
  ```

  возвращает строку либо `null`.
- В белый список `MODERATABLE` (строка 162) добавить
  `authorUserId: 'author_user_id'`. Схему белого списка не менять: ключ,
  которого там нет, в `SET` не попадает вовсе — это и есть защита от того,
  чтобы значение из тела запроса стало куском SQL. `null` в этом поле
  означает «снять автора» (колонка nullable, `009_games.sql:14`).

### 2. `packages/auth/src/main.js`, `PATCH /admin/games/:id` (строка 474)

Принимать в теле `authorNick`:

- `undefined` — поле не трогаем;
- `null` или `''` — `patch.authorUserId = null` (снять автора);
- строка — проверить `isValidNick` (`packages/auth/src/lib/validators.js:9`);
  невалиден → `400 {error: 'badRequest'}`; затем `findByNick`; пользователя
  нет → `404 {error: 'unknownUser'}`; иначе
  `patch.authorUserId = user.id`.

Порядок как у остальных полей роута: все валидации до `getGame`, объект
`patch` собирается после (строка ~514).

### 3. `packages/engine/src/client/components/view/Games.js`

`_adminItem` (строка 220): рядом со строкой `Author:` добавить

- `input.field-text.games-author-input` с `placeholder='Author nick'`,
  предзаполненный текущим `game.authorNick ?? ''`;
- кнопку «Set author», которая эмитит `set-author` с
  `{id: game.id, nick: input.value.trim()}`. Пустое значение = снять автора.

Добавить `unknownUser` в `ERROR_MESSAGES` вьюхи (рядом с существующими
кодами ошибок).

### 4. `packages/engine/src/client/components/{controller,model}/Games.js`

- Контроллер: подписка на `set-author` → `model.setAuthor(id, nick)`.
- Модель: `setAuthor(id, nick)` → `PATCH urls.moderate(id)` с телом
  `{authorNick: nick === '' ? null : nick}`; после успеха перечитать
  админский список ровно тем же способом, каким это делает существующее
  решение модератора (найти в модели обработчик `moderate`/`decide` и
  повторить его хвост); ошибки — через существующий `_fail('admin', …)`.

## Что делает администратор после выката

`tanks` и `snakes` в «Moderation» → поле `Author` → свой ник → «Set author».
После этого обе игры появляются в «My games», и им доступна кнопка запроса
новой версии. Шаг ручной, автоматизировать его нечем: пользователя `lgick` в
момент миграции в БД может ещё не быть.

## Тесты

- `tests/auth/games.test.js`:
  - `PATCH /admin/games/:id` с `authorNick` назначает автора; регистр ника
    не важен;
  - `authorNick: null` и `authorNick: ''` снимают автора;
  - неизвестный ник → 404 `unknownUser`; невалидный ник → 400;
  - после назначения игра попадает в `listGamesByAuthor` этого
    пользователя, и он может запросить новую версию (`requestGameVersion`
    не бросает `GameForbiddenError`);
  - не-админ на этот роут по-прежнему не проходит.
- `tests/client/GamesView.test.js` — рендер поля автора и кнопки, эмит
  `set-author` с правильным телом (в том числе пустым ником).

## Документация и changelog

- `docs/en/auth.md` + `docs/ru/auth.md` — правило «заявитель становится
  автором», поле `authorNick` в `PATCH /admin/games/:id`, снятие автора
  через `null`.
- `docs/en/master.md` + `docs/ru/master.md` — что видит и делает модератор в
  панели.
- `packages/engine/CHANGELOG.md` → `### Added` (назначение автора из панели
  модерации). **Уровень движка: minor.** Правки auth-сервиса живут в своём
  деплое и в changelog движка не едут; миграция этому этапу не нужна.
