# Этап 2. Скачивание и хранилище пакетов на мастере ✅ выполнен

**Область:** `packages/engine/package.json`, `packages/engine/src/config/`,
`packages/engine/src/master/`, `tests/master/`, `.gitignore`.

**Цель:** мастер умеет по имени пакета и версии скачать игру из npm registry,
проверить её целостность, распаковать `dist/` на диск и вынести вердикт о
пригодности — **не исполняя ни строчки игрового кода**. Каталог и REST на этом
этапе не трогаются: получается изолированный, полностью юнит-тестируемый слой.

## Что нужно знать перед началом

- В движке **нет** ни одного места, где что-либо качается из npm в рантайме.
  Единственный код работы с реестром — `scripts/release/registry.js`, он
  дев-сайдный и вызывает `npm view` через оболочку. Переиспользовать его
  нельзя, но его принцип обязателен: **«пакета нет» (E404) обязано отличаться
  от «реестр не ответил»**, иначе сетевой сбой читается как «версии не
  существует».
- Прокси-классы мастера (`JwksProxy`, `PlayerDataProxy`, `HostRatingProxy`)
  принимают `fetchImpl` в конструкторе — именно так их тестируют без сети.
  Новый код обязан следовать этому же приёму.
- Инвариант `GameCatalog.js:41-46`: **одна битая игра не имеет права ронять
  мастер**. Всё, что здесь пишется, обязано возвращать вердикт, а не бросать
  наружу.

## 2.1 Зависимость и конфигурация

### `packages/engine/package.json`

Добавить в `dependencies`: `"tar": "^7.5.1"`.

Обоснование для комментария в коммите: `tar` — та библиотека, которую
использует сам npm; она сама защищает от path traversal, симлинков и
абсолютных путей внутри архива. Рукописный разбор USTAR в этом месте — это
security-чувствительный код без выигрыша. Зависимость нужна только мастеру,
который в `files` не публикуется, — ровно как уже лежащие рядом `express`,
`ws`, `vite-express`.

### `packages/engine/src/config/master.js`

Добавить новый блок (рядом с `games`, до `servers`):

```js
  // Хранилище игровых пакетов (направление master-game-registry): мастер
  // качает одобренные игры из npm registry и раздаёт их с диска, вместо того
  // чтобы получать их npm-зависимостью на этапе сборки образа.
  gameStore: {
    // корень хранилища; null → <repoRoot>/.games (локальная разработка).
    // В проде задаётся VIMP_GAMES_DIR и монтируется томом
    dir: null,
    registryUrl: 'https://registry.npmjs.org',
    // период опроса реестра auth за изменениями каталога
    refreshInterval: 60000,
    // потолки распаковки недоверенного архива
    maxTarballBytes: 64 * 1024 * 1024,
    maxFiles: 5000,
    // сколько версий одной игры держать на диске: активная + стейджевая
    keepVersions: 2,
    // потолок ожидания ответа реестра
    timeout: 30000,
  },
```

### `packages/engine/src/config/env.js`

В `applyMasterEnv` добавить, рядом с остальными:

```js
  // корень хранилища игровых пакетов (направление master-game-registry) —
  // в проде это смонтированный том, переживающий пересоздание контейнера
  if (env.VIMP_GAMES_DIR) {
    config.set('master:gameStore:dir', env.VIMP_GAMES_DIR);
  }
```

### `.gitignore`

Добавить `.games/`.

## 2.2 `packages/engine/src/master/npmRegistry.js` (новый)

Только чистые функции + инъекция `fetchImpl`. Никакого состояния, никаких
обращений к конфигу — параметры приходят аргументами.

```js
/**
 * Метаданные пакета из npm registry (packument).
 * @throws {Error} именованная ошибка, если реестр недоступен или ответил не 200/404
 * @returns {Object|null} null — пакета в реестре нет (404)
 */
export async function fetchPackument(packageName, { registryUrl, fetchImpl = fetch, timeout })

/**
 * Резолв версии. spec: точная версия | 'latest' | undefined (= latest).
 * @returns {{version, tarball, integrity, shasum}|null}
 */
export function resolveVersion(packument, spec)

/** Список опубликованных версий, новые в конце (для индикатора «есть обновление»). */
export function listVersions(packument)

/**
 * Скачивание с проверкой целостности.
 * @throws {Error} несовпадение integrity/shasum, превышение maxBytes
 */
export async function downloadTarball(url, { integrity, shasum, fetchImpl = fetch, maxBytes, timeout })

/**
 * Распаковка ТОЛЬКО package/dist/** в destDir.
 * @throws {Error} превышение maxFiles/maxBytes
 */
export async function extractDist(buffer, destDir, { maxBytes, maxFiles })
```

### Требования к реализации

- **Имя scoped-пакета в URL** кодируется целиком:
  `` `${registryUrl}/${packageName.replace('/', '%2F')}` ``. Без этого
  `@vimp-games/tanks` даст 404.
- `Accept: application/vnd.npm.install-v1+json` — «тощий» пакумент, в разы
  меньше полного; в нём есть всё нужное (`versions[v].dist.{tarball,integrity,shasum}`,
  `dist-tags.latest`).
- **404 → `null`**, любой другой не-`ok` статус и любой сетевой отказ →
  `throw new Error('npm registry не ответил (…): …')`. Это тот самый инвариант
  из `scripts/release/registry.js:14-38`.
- `integrity` (`sha512-…`, base64) проверяется обязательно; `shasum` (sha1
  hex) — запасной вариант для старых записей. Считать через
  `node:crypto.createHash`. Несовпадение → именованная ошибка с указанием
  ожидаемого и полученного дайджеста.
- `maxBytes` проверять **по ходу чтения** (`res.body` — поток), а не после:
  недоверенный сервер не должен уметь заставить мастер выделить гигабайт.
- `extractDist` — `tar.x` из потока над буфером:

  ```js
  await tar.x({
    cwd: destDir,
    strip: 2,                       // срезает 'package/dist'
    filter: (path, entry) => { /* см. ниже */ },
    preservePaths: false,           // (дефолт) — не доверять абсолютным путям
    onwarn: (code, message) => warnings.push(`${code}: ${message}`),
  });
  ```

  `filter` обязан:
  1. пропускать только `path.startsWith('package/dist/')`;
  2. отбрасывать `entry.type` не из `{'File', 'Directory'}` (симлинки,
     хардлинки, устройства);
  3. считать файлы и суммарный размер, бросать при превышении `maxFiles` /
     `maxBytes`.
- `destDir` создаётся `fs.mkdir(destDir, { recursive: true })` до вызова.

## 2.3 `packages/engine/src/master/gamePackageCheck.js` (новый)

```js
/**
 * Структурная проверка распакованного dist/ игрового пакета.
 * Игровой код НЕ импортируется и не исполняется — см. README направления.
 * @returns {{ok: boolean, manifest: Object|null, errors: string[]}}
 */
export function checkGamePackage(distDir, { id })
```

Проверки (каждая даёт отдельную строку в `errors`, проверки не прерываются на
первой — разработчику нужен полный список):

1. `dist/manifest.json` существует, читается и парсится;
2. `manifest.id === id` — иначе статик-маунт бьёт мимо
   (тот же инвариант, что `GameCatalog.js:70-76`);
3. `engineApi` — целое число; `title`, `version` — непустые строки;
4. `assetsBase` — строка, оканчивающаяся на `/`;
5. `entries.client`, `entries.host`, `entries.wasm` присутствуют и каждый
   после снятия префикса `assetsBase` резолвится **внутри** `distDir`.
   Эталон — `stripBase()` и проверка `../` в
   `packages/engine/src/devtools/contract/rules/a6-manifest.js:34-53`
   (реализацию скопировать по смыслу, а не импортировать: `devtools/` не
   копируется в prod-образ и не должен туда попасть);
6. `entries.wasmNode`, если объявлен, — относительный путь **внутри** `dist/`
   (не URL; см. `docs/ai/02-packaging.md:157`);
7. `maps.list` — непустой массив строк, и для каждого имени существует
   `dist/maps/<name>.json`;
8. каждому полю `roomForm` соответствует значение в `roomDefaults`, кроме
   полей с `source === 'maps'` (эталон — `a6-manifest.js:55-66`);
9. `checkPluginCompatibility(manifest)` из
   `packages/engine/src/lib/gamePlugin.js` — `requires` корректной формы и
   удовлетворён этим движком. **Несовместимость по `requires` — не ошибка
   пакета**, а признак «движок старый»: класть её в отдельное поле
   `compat`, а не в `errors`, чтобы админ видел разницу между «игра сломана»
   и «обновите движок».

## 2.4 `packages/engine/src/master/GameStore.js` (новый)

### Раскладка на диске

```
<gameStore.dir>/
  <gameId>/
    <npmVersion>/        ← содержимое package/dist
    .staging/<rand>/     ← временная распаковка
```

### API

```js
export default class GameStore {
  constructor({ dir, registryUrl, limits, fetchImpl = fetch })

  /** Гарантирует наличие версии на диске. Идемпотентно. */
  async ensure(gameId, packageName, version)
    // → { ok, distDir, manifest, compat, errors }

  /** Скачать и проверить, НЕ делая версию доступной. Для заявки и «Теста». */
  async inspect(gameId, packageName, version)
    // → { ok, version, manifest, compat, errors }

  has(gameId, version)
  distDir(gameId, version)
  listLocalVersions(gameId)

  /** Удалить всё, чего нет в keep. keep: Map<gameId, Set<version>> */
  async prune(keep)
}
```

### Требования к реализации

- **Атомарность.** Скачивание и распаковка идут в
  `<dir>/<gameId>/.staging/<random>`, и только после успешного
  `checkGamePackage` каталог переезжает в `<version>` через `fs.rename`.
  Недокачанная или непрошедшая проверку версия физически не может оказаться в
  раздаче. При любом отказе `.staging/<random>` удаляется (`finally`).
- **Идемпотентность.** Если `<version>` уже есть — не качать, а перепроверить
  `checkGamePackage` (дёшево, только чтение JSON) и вернуть вердикт. Это же
  даёт бесплатную защиту от порчи тома.
- **Права на запись.** В конструкторе (или в отдельном `init()`) выполнить
  `fs.mkdir(dir, { recursive: true })` и проверить запись
  (`fs.access(dir, fs.constants.W_OK)`). Отказ — **именованная ошибка на
  старте с указанием пути и переменной `VIMP_GAMES_DIR`**, а не невнятный
  `EACCES` из середины скачивания через час работы.
- **Ошибки не выбрасываются наружу.** `ensure`/`inspect` всегда возвращают
  объект вердикта; сетевой отказ, 404, битый архив — всё это `ok: false` +
  `errors`. Ронять мастер из-за одной игры нельзя.
- `prune` не трогает `.staging` чужих процессов по возрасту < 1 часа
  (два мастера могут делить том только по ошибке конфигурации, но удалять
  чужой каталог посреди распаковки всё равно не следует).
- Никакого кэша пакументов на этом этапе: `GameSync` из Этапа 3 опрашивает
  реестр auth, а не npm; npm дёргается только при появлении новой версии.

## 2.5 Тесты

### Фикстуры

`tests/fixtures/gamePackages.js` — хелпер, **собирающий тарболл в памяти**
через `tar.c` (бинарник в репозиторий не коммитить). Варианты:

| Фикстура | Что содержит |
| --- | --- |
| `valid` | `package/dist/` с корректным манифестом, одной картой, тремя entries |
| `wrongId` | `manifest.id` не совпадает с запрошенным |
| `brokenManifest` | невалидный JSON |
| `escapingEntry` | `entries.client` вида `../../etc/passwd` |
| `missingMap` | `maps.list` называет карту, которой нет в `dist/maps/` |
| `tooManyFiles` | файлов больше `maxFiles` |
| `withSymlink` | запись-симлинк внутри `package/dist/` |
| `extraFiles` | `package/src/`, `package/README.md` — обязаны быть отброшены |

### Файлы тестов

- `tests/master/npmRegistry.test.js` — кодирование scoped-имени в URL; резолв
  точной версии и `latest`; 404 → `null`; 500 и сетевой отказ → `throw`;
  `integrity` совпал / не совпал; `shasum` как запасной путь; превышение
  `maxBytes`; `extractDist` берёт только `dist/`, отбрасывает симлинки и
  соблюдает `maxFiles`.
- `tests/master/gamePackageCheck.test.js` — по кейсу на каждую из девяти
  проверок; `requires` от несуществующей возможности попадает в `compat`, а
  не в `errors`.
- `tests/master/GameStore.test.js` (временный каталог через
  `fs.mkdtempSync(os.tmpdir())`) — `ensure` качает один раз и второй раз не
  ходит в сеть; при отказе проверки `<version>` не создаётся, а `.staging`
  пустеет; `inspect` не делает версию видимой; `prune` удаляет лишнее и
  сохраняет то, что в `keep`; две версии одной игры сосуществуют;
  недоступный на запись `dir` даёт именованную ошибку.

## Критерии готовности

1. `npx eslint . && npm test -- --silent` — зелено.
2. Ручная проверка в Node REPL из корня репозитория:
   ```
   node -e "import('./packages/engine/src/master/GameStore.js').then(async ({default:S})=>{
     const s = new S({dir:'.games', registryUrl:'https://registry.npmjs.org',
       limits:{maxTarballBytes:67108864,maxFiles:5000,timeout:30000}});
     console.log(await s.ensure('tanks','@vimp-games/tanks','0.16.1'));
   })"
   ```
   → `ok: true`, на диске `.games/tanks/0.16.1/manifest.json`, внутри нет ни
   `src/`, ни `package.json` пакета.
3. Тот же вызов с несуществующей версией даёт `ok: false` и внятный `errors`,
   процесс не падает.
