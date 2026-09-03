# Этап 3 (замечания № 4 и № 5). dedicated не должен зависеть от `approved` ✅ выполнен

Опирается на `GameStore.ensurePackage` из этапа 2.

## Что подтвердилось

Диагноз в замечании № 5 верен и объясняет ошибку № 4 полностью.

`fetchRegistryGame` зовёт `registry.list()`
(`packages/engine/src/dedicated/main.js:180`), это `GET /games`
(`GameRegistryProxy.js:38`), а на стороне auth — выборка
`WHERE g.status = 'approved' AND g.version IS NOT NULL`
(`packages/auth/src/UserRepository.js:763`). Игры нет в этой выборке —
`dedicated/main.js:196` бросает
`dedicated: game "@vimp-games/tanks" is not in the registry catalog`.

Требование `approved` здесь лишнее. Одобрение — это допуск игры в **каталог
платформы**, то есть право быть раздаваемой лобби-мастерами всем игрокам.
Dedicated-сервер поднимает оператор на своём железе для одной конкретной
игры; спрашивать у чужого модератора разрешение запустить у себя пакет из
публичного npm — не то ограничение, которое кто-то закладывал осознанно:
реестр просто оказался единственным известным способом узнать `packageName`
по `id` игры.

## Решение

Реестр становится **подсказкой, а не воротами**. Порядок разрешения игры:

1. Прилинкованный пакет в `node_modules` — как сейчас, dev-путь, приоритет
   не меняется (`startDedicatedServer`, строки 282–320).
2. Ссылка — **имя npm-пакета** (проходит `PACKAGE_NAME_PATTERN`) → сразу
   `store.ensurePackage(ref, version)`; реестр не спрашивается вовсе,
   `VIMP_AUTH_SERVICE_URL` не нужен.
3. Ссылка — **id игры** (`tanks`) → имя пакета взять неоткуда, кроме
   реестра: спрашиваем `GET /games`, дальше
   `store.ensure(game.id, game.packageName, version ?? game.version)`.

Пункт 2 — ключевой: он снимает зависимость от `approved` и делает
`VIMP_AUTH_SERVICE_URL` действительно необязательным (этап 4).

Проверки пакета не ослабевают ни на шаг: `checkGamePackage` отрабатывает так
же, код игры при проверке по-прежнему не исполняется, а
`ENGINE_API_VERSION`/`requires` проверяются в `loadGamePackage`. Меняется
только источник ответа на вопрос «какой пакет качать», а не «можно ли его
запускать».

## Изменения по файлам

### 1. `packages/engine/src/dedicated/main.js`

- `fetchRegistryGame` → `fetchGameFromNpm` (строка ~174). Логика:

  ```
  if (PACKAGE_NAME_PATTERN.test(ref)) {
    → store.ensurePackage(ref, version)
    → {id: result.id, version, distDir, manifest, packageUrl: null, maxGameScore: null}
  }
  if (!env.VIMP_AUTH_SERVICE_URL) → отказ (текст ниже)
  → registry.list() → найти по item.id === ref || item.packageName === ref
  → нет строки → отказ (текст ниже)
  → store.ensure(game.id, game.packageName, version ?? game.version)
  → {…, packageUrl: game.repoUrl ?? null, maxGameScore: game.maxGameScore}
  ```

  `GameStore` создаётся один раз в начале функции — как сейчас (строки
  200–210), с теми же `dir`/`registryUrl`/`limits`.
- Ссылку на функцию в `needsPackageDir` (строка ~287,
  `fetchGame !== fetchRegistryGame`) переименовать вместе с функцией — иначе
  тестовая инъекция перестанет распознаваться.
- Пин из `VIMP_DEDICATED_GAME` по-прежнему важнее раздаваемой версии.
- Текст отказа для случая «названо id, а реестра нет либо игры в нём нет»
  переписать. Сейчас это `is not in the registry catalog` — тупик. Должно
  быть примерно так:

  ```
  dedicated: game "<ref>" is not resolved — name the game by its npm package
  (@scope/name) and no registry is needed, or set VIMP_AUTH_SERVICE_URL and
  get the game approved in the catalog
  ```

  Отказ, когда `ensurePackage` вернул `{ok: false}`, остаётся прежним по
  форме: `dedicated: game "<id>"@<version> is not usable — <errors>`.

### 2. `packages/engine/src/config/env.js`

Правок нет: `VIMP_AUTH_SERVICE_URL` и сейчас необязателен (`env.js:25` —
под `if`).

## Тесты

`tests/dedicated/dedicatedServer.test.js`:

- старт по имени пакета **без** `VIMP_AUTH_SERVICE_URL` — реестр не
  вызывается (проверяется инъекцией `fetchImpl`, который бросает на любой
  вызов к auth);
- старт по id с реестром — прежнее поведение сохраняется;
- отказ по id без реестра содержит подсказку про имя npm-пакета;
- отказ по id, которого нет в каталоге, содержит ту же подсказку (а не
  прежнее `is not in the registry catalog`).

`tests/master/gameStore.test.js` — `ensurePackage` кладёт версию в
`<dir>/<manifest.id>/<version>` и идемпотентен на повторном вызове.

## Документация и changelog

- `docs/en/dedicated.md` + `docs/ru/dedicated.md` — порядок разрешения игры
  (node_modules → имя пакета → id через реестр), реестр опционален, статус
  `approved` больше не требуется.
- `docs/en/configuration.md` + `docs/ru/configuration.md` — уточнение по
  `VIMP_DEDICATED_GAME`: имя пакета снимает потребность в
  `VIMP_AUTH_SERVICE_URL`.
- `packages/engine/CHANGELOG.md` → `### Changed` (dedicated тянет пакет из
  npm напрямую, реестр стал опциональным). Ничего, что принималось раньше,
  теперь не отвергается — `⚠️ Breaking` не нужен. **Уровень: patch.**

Проверка этапа дополнительно включает `npm run sim:check`.
