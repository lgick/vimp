# Этап 2 (замечание № 1). Форма заявки: только npm-пакет и версия ✅ выполнен

Даёт примитивы `GameStore.inspectPackage`/`ensurePackage` и
`npmRegistry.fetchPackageMeta`, на которых стоит этап 3, — поэтому идёт
раньше него.

## Что подтвердилось

`packages/engine/src/client/views/includes/games.pug` рисует пять полей:
`Game id`, `npm package`, `Version`, `Repository URL`, `Title` (строки
14–30). При этом мастер и так скачивает пакет до записи в реестр
(`gameRoutes.js:97` → `store.inspect`), а `checkGamePackage` уже читает
`dist/manifest.json` и требует, чтобы `manifest.id` совпал с введённым id
(`gamePackageCheck.js:57`) и чтобы `manifest.title`/`manifest.version` были
непустыми строками (`gamePackageCheck.js:70`). То есть `id`, `title` и
`version` — данные, которые мастер уже держит в руках; спрашивать их у
человека и потом сверять с манифестом бессмысленно.

Репозиторий — отдельный случай. В тарболл едет только `package/dist/**`
(`npmRegistry.js`, `extractDist`, `strip: 2`), а `repository`/`homepage`
живут в `package.json` пакета, который до диска не доезжает. В пакументе их
тоже нет: `fetchPackument` просит «тощую» форму
(`ABBREVIATED = application/vnd.npm.install-v1+json`, `npmRegistry.js:22`),
где на версию отдаются только `dist`, `dependencies`, `engines` и т. п.
Значит репозиторий добыть **можно**, но нужен полный пакумент
(`accept: application/json`).

## Решение

Форма сводится к двум полям — `npm package` и `Version` (редактируемое,
предзаполняется последней опубликованной версией). Остальное мастер
показывает как результат разбора пакета и записывает сам.

Поток: пользователь вводит имя пакета → `blur` либо кнопка «Load» →
`GET /games/lookup?package=<name>` → мастер отдаёт
`{id, title, version, versions[], repoUrl, engineApi, compat, errors}` →
view печатает карточку предпросмотра и подставляет `version` →
`POST /games/submit` уходит только с `{packageName, version}`.

## Изменения по файлам

### 1. `packages/engine/src/master/npmRegistry.js`

Новая экспортируемая функция:

```js
export async function fetchPackageMeta(
  packageName,
  version,
  { registryUrl, fetchImpl = fetch, timeout } = {},
)  // → {repoUrl: string|null, homepage: string|null, description: string|null}
```

- URL строится тем же способом, что в `fetchPackument` (кодирование
  scoped-имени скопировать один в один), но заголовок —
  `accept: application/json`: «тощий» пакумент полей `repository`/`homepage`
  не отдаёт вовсе.
- Данные берутся из `packument.versions[version]`; версии нет или она не
  передана — из `packument.versions[packument['dist-tags'].latest]`; поля,
  которых нет в версии, — из корня пакумента.
- Нормализация `repository` (отдельная чистая функция, экспортировать для
  теста):
  - строка-шорткат `user/repo`, `github:user/repo` → `https://github.com/user/repo`;
  - объект `{type, url}`: снять префикс `git+`, схемы `git://`,
    `ssh://git@host/`, форму `git@host:user/repo`, суффикс `.git`;
  - всё, что после нормализации не подходит под `^https?://`, → `null`.
  Проверка нужна именно здесь: в `href` её уже делает
  `GamesView._appendRepo`, но значение едет ещё и в БД, и в `packageUrl`
  каталога.
- Инварианты модуля сохраняются: 404 → все поля `null`; реестр не ответил
  или ответил не 200/404 → `throw` (иначе сетевой сбой читается вызывающим
  как «репозитория нет»).
- Отдельная функция, а не флаг у `fetchPackument`: полный пакумент тяжёлый,
  и в `GameSync`/`ensure` он не нужен ни разу.

### 2. `packages/engine/src/master/GameStore.js`

- `_stage(gameId, packageName, version)` (строка ~296) научить работать с
  `gameId === null`: staging-каталог тогда `<dir>/.staging/<rand>` вместо
  `<dir>/<gameId>/.staging/<rand>`, а `checkGamePackage` вызывается без
  ожидаемого `id`.
- **Обязательный побочный эффект.** `listLocalVersions` (строка ~226) и
  `prune` (строка ~239) обходят верхний уровень `<dir>` как список игр.
  Корневой `.staging` обязан быть отфильтрован там же, где сейчас
  фильтруется `name !== STAGING` внутри игры (строки 229 и 247), иначе
  `prune` посчитает его игрой и удалит чужую идущую распаковку. Для
  корневого `.staging` вызвать существующий `_pruneStaging(this._dir)` —
  он уже уважает `STAGING_TTL`.
- Новый публичный метод:

  ```js
  /**
   * Скачать и проверить пакет, НЕ зная id заранее и НЕ делая версию
   * доступной: id читается из dist/manifest.json распакованного архива.
   */
  async inspectPackage(packageName, version)
    // → {ok, id, version, manifest, compat, errors}
  ```

  `id` из манифеста проверяется `GAME_ID_PATTERN` и `RESERVED_GAME_IDS`
  (`packages/engine/src/master/gameRefs.js`) — манифест недоверенный, а `id`
  становится сегментом URL и именем каталога. Staging удаляется всегда, как
  в `inspect`.
- Новый публичный метод (нужен этапу 3):

  ```js
  async ensurePackage(packageName, version)
    // → {ok, id, version, distDir, manifest, compat, errors}
  ```

  То же безымянное стейджирование, но после чтения `id` из манифеста —
  переезд в `<dir>/<id>/<version>` тем же одиночным `rename` и с той же
  обработкой гонки, что в `ensure` (строки 100–125).
- Контракт «`ensure`/`inspect` никогда не бросают» распространяется на оба
  новых метода: неверный `id` из манифеста — обычный элемент `errors[]`, а
  не исключение.

### 3. `packages/engine/src/master/gameRoutes.js`

Новый обработчик в объекте, возвращаемом `createGameRoutes`:

```js
// GET /games/lookup?package=<name>&version=<v|latest>
async lookup(req, res) { … }
```

- валидация: `PACKAGE_NAME_PATTERN` для пакета и, если версия пришла,
  `GAME_VERSION_PATTERN` либо литерал `'latest'`; иначе
  `400 {error: 'badRequest'}`;
- `Promise.all` из трёх: `store.inspectPackage(packageName, version)`,
  `store.publishedVersions(packageName)`, `fetchPackageMeta(...)`; последняя
  в `try/catch` — её отказ обнуляет `repoUrl`, а не роняет роут (как это уже
  сделано в `publishedVersions`);
- ответ: `{id, title, version, versions, repoUrl, engineApi, compat, errors}`,
  где `title`/`engineApi` — из `manifest`.

`submit` (строка ~81): `id`, `title`, `repoUrl` из тела больше **не
обязательны**.

- сначала валидация `packageName`/`version`;
- затем `const verdict = await store.inspectPackage(packageName, version)`;
- `id` — из вердикта (присланный клиентом остаётся запасным путём),
  `title` — из `verdict.manifest.title`, `repoUrl` — из `fetchPackageMeta`,
  присланный клиентом запасной;
- `GAME_ID_PATTERN` и `RESERVED_GAME_IDS` применяются к **итоговому** id
  независимо от того, откуда он взялся;
- тело со всеми пятью полями по-прежнему принимается — старый клиент и
  прямые вызовы не ломаются.

### 4. `packages/engine/src/master/lobby.js`

Рядом со строкой 605, в том же блоке «до версионных `/games/:id/...`»:

```js
app.get('/games/lookup', adminAuth.authenticated, limitSubmits, gameRoutes.lookup);
```

Тот же `requireAuth` и тот же лимитер, что у `POST /games/submit`: роут
ходит в сеть за чужим тарболлом, без лимита это усилитель трафика. Порядок
объявления критичен — иначе `lookup` уедет в `/games/:id`.

### 5. `packages/engine/src/config/lobby.js`

- `games.urls.lookup: '/games/lookup'`;
- в `games.elems.fieldIds` (строка ~250) остаются только `packageName` и
  `version`; ключи `id`, `title`, `repoUrl` **удалить** — иначе `GamesView`
  бросит в конструкторе (`view/Games.js:80-95` валидирует карту полей);
- новые `games.elems`: `lookupBtnId: 'games-lookup'`,
  `previewId: 'games-preview'`, `versionListId: 'games-version-list'`.

### 6. `packages/engine/src/client/views/includes/games.pug`

Форма `#games-submit-form` сводится к:

```pug
form#games-submit-form
  div.form-row
    label.form-label(for='games-field-package')= 'npm package'
    input#games-field-package.field-text(type='text', name='packageName', maxlength='214', autocomplete='off')
    input#games-lookup(type='button', value='Load')
  div.form-row
    label.form-label(for='games-field-version')= 'Version'
    input#games-field-version.field-text(type='text', name='version', maxlength='64', autocomplete='off', placeholder='latest', list='games-version-list')
    datalist#games-version-list
  div#games-preview.games-preview
  div#games-submit-error.form-error
  input#games-submit(type='submit', value='Submit for review')
```

Поля `#games-field-id`, `#games-field-repo`, `#games-field-title` удалить.

### 7. `packages/engine/src/client/components/{model,view,controller}/Games.js`

- **Модель:** `lookup(packageName, version)` → `GET urls.lookup` с
  query-параметрами; успех → событие `looked-up` с телом ответа; ошибки —
  через существующий `_fail('mine', …)`.
- **View:**
  - `renderPreview({id, title, version, versions, repoUrl, engineApi, compat, errors})`
    печатает строками `id`, `title`, `engineApi`, репозиторий (через
    существующий `_appendRepo`), подставляет `version` в поле, заполняет
    `datalist` из `versions`, показывает `errors` в `#games-submit-error`;
  - `Submit` заблокирован, пока предпросмотр не получен или пока в нём есть
    ошибки: заявка на заведомо нерабочий пакет реестру не нужна;
  - кнопка «Load» и `blur` поля пакета эмитят `lookup`;
  - правка поля пакета сбрасывает предпросмотр и снова блокирует `Submit`;
  - `_readForm` отдаёт только `{packageName, version}`;
  - подписка на `looked-up` рядом с существующими (`mp.on(...)` в
    конструкторе).
- **Контроллер:** подписка `lookup` → `model.lookup`.

## Тесты

- `tests/master/npmRegistry.test.js` — `fetchPackageMeta`: нормализация
  `repository` во всех формах (шорткат, `github:`, `git+ssh`, объект,
  `git@host:user/repo`, мусор → `null`); 404 → `null`; недоступный реестр →
  `throw`; заголовок запроса — не `ABBREVIATED`.
- `tests/master/gameStore.test.js` — `inspectPackage` на фикстурном
  тарболле: `id` из манифеста; отказ на `id`, не проходящем
  `GAME_ID_PATTERN`; отказ на зарезервированном `id`; корневой `.staging`
  удаляется; `prune` его не трогает и не считает игрой.
- `tests/master/gameRoutes.test.js` — `lookup` отдаёт манифестные поля и не
  падает при отказе `fetchPackageMeta`; `lookup` с кривым именем пакета →
  400; `submit` без `id`/`title`/`repoUrl` заводит игру с полями из пакета;
  `submit` со всеми полями по-прежнему работает.
- `tests/client/GamesView.test.js` — новая разметка, `renderPreview`,
  блокировка `Submit`, сброс предпросмотра при правке пакета.

## Документация и changelog

- `docs/en/master.md` + `docs/ru/master.md` — роут `GET /games/lookup`, новая
  форма заявки (два поля + предпросмотр), какие поля мастер заполняет сам.
- `packages/engine/CHANGELOG.md` → `### Added` (новый роут и автозаполнение
  формы). **Уровень: minor.**
