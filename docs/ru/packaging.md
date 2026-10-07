# Упаковка и сборка игрового плагина

Плагин — обычный npm-пакет, **единственное опубликованное содержимое которого
— `dist/`**. Движок не видит ваших исходников; он видит `dist/manifest.json` и
файлы, на которые тот указывает. Форма манифеста описана в
[plugin-api.md](plugin-api.md#gamemanifest); эта страница — обо всём, что его
производит: раскладка репозитория, `package.json`, две сборки Vite, сборка
Rust-ядра, скрипты ассетов и документация, которую поставляет готовый плагин.

## Раскладка репозитория

```
my-game/
├─ package.json
├─ vite.config.js            # три режима: serve (dev-стенд) | client | host
├─ vitest.config.js          # два проекта: unit (node) и integration (happy-dom)
├─ eslint.config.js
├─ Cargo.toml                # корень workspace для Rust-ядра
├─ core/                     # крейт на Rust (cdylib + rlib)
│  ├─ Cargo.toml
│  ├─ src/lib.rs
│  ├─ pkg-web/               # wasm-pack --target web    (генерируется, в .gitignore)
│  └─ pkg-node/              # wasm-pack --target nodejs (генерируется, в .gitignore)
├─ src/
│  ├─ host/index.js          # default-экспорт: HostPlugin
│  ├─ client/index.js        # default-экспорт: ClientPlugin
│  ├─ config/                # game.js, client.js, auth.js, snapshot.js, sounds.js
│  ├─ data/                  # models.js, weapons.js, maps/
│  └─ client/parts|bakers/   # классы отрисовки PixiJS и бейкеры текстур
├─ scripts/                  # build-game-manifest.js, export-maps.js, …
├─ dev/main.js, index.html   # dev-стенд: автономный матч против ботов
├─ assets/                   # авторские исходники: audio-raw/ (до обработки)
│                            # и img/ (тайлсеты, спрайты динамических тел)
├─ build/                    # промежуточное (обработанные звуки, подготовленные
│                            # картинки) — в .gitignore
└─ dist/                     # публикуемый результат — в репозитории в .gitignore
```

`npm create vimp-game <directory>` пишет ровно эту раскладку, заполненную и
зелёную: шаблон скаффолдера
(`packages/create-vimp-game/templates/default/`) — исполняемая форма этой
страницы, см. [scaffolding.md](scaffolding.md). Где проза ниже оставляет
выбор, шаблон показывает тот вариант, который заведомо собирается. Две
готовые игры для чтения рядом с ним:
[vimp-tanks](https://github.com/lgick/vimp-tanks) и
[vimp-snakes](https://github.com/lgick/vimp-snakes).

## `package.json`

```json
{
  "name": "@my-scope/my-game",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "files": ["dist"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "rm -rf dist && npm run build:client && npm run build:host && npm run build:assets && npm run build:manifest",
    "build:client": "vite build --mode client",
    "build:host": "vite build --mode host",
    "build:assets": "node ./scripts/export-maps.js && node ./scripts/copy-game-sounds.js && node ./scripts/copy-game-images.js",
    "build:manifest": "node ./scripts/build-game-manifest.js",
    "audio:process": "node ./scripts/process-audio.js",
    "core:build": "npm run core:build:web && npm run core:build:node",
    "core:build:web": "wasm-pack build core --release --target web --out-dir pkg-web",
    "core:build:node": "wasm-pack build core --release --target nodejs --out-dir pkg-node",
    "core:test": "cargo test --workspace",
    "check:contract": "vimp-contract --game .",
    "sim": "vimp-sim --game . --checkpoint-every 500",
    "test": "vitest run",
    "predev": "node ./scripts/copy-game-images.js && node ./scripts/copy-game-sounds.js",
    "dev": "vite"
  },
  "peerDependencies": { "pixi.js": "^8.14.0" },
  "devDependencies": {
    "vimp-engine": "<версия движка, под которую вы собираете>",
    "pixi.js": "^8.14.0",
    "vite": "^7.1.11",
    "vitest": "^4.1.9",
    "happy-dom": "^20.10.6",
    "eslint": "^9.37.0"
  }
}
```

Правила:

- `"type": "module"` — только ESM, везде.
- `pixi.js` — **peer-зависимость и dev-зависимость**, но не runtime-зависимость:
  в рантайме движок поставляет единственный общий экземпляр PixiJS через
  import map. Собственная копия даёт движку и плагину два независимых реестра
  PixiJS; объекты, перешедшие между экземплярами (бейкер отдаёт `Texture`
  рендереру движка), ломаются в рантайме.
- `vimp-engine` — **dev**-зависимость: всё, что вы из него импортируете
  (`config/opcodes.js`, `lib/math.js`, …), попадает в ваш `dist/`, а движок,
  который вас загружает, — тот, что уже запущен. Она же приносит бины
  `vimp-sim` и `vimp-contract` — закрепляйте версию движка, под которую
  собираете.
- `files: ["dist"]` — исходники не публикуются. `dist/` обычно в `.gitignore`,
  а npm применяет правила игнорирования и внутри каталогов из `files`:
  проверяйте тарбол через `npm pack --dry-run` перед публикацией (в списке
  должны быть все картинки, звуки, карты и каталог `core-node/`).
- Скрипты `build`, `build:client`, `build:host`, `build:assets`,
  `build:manifest`, `core:build:web`, `core:build:node`, `core:test` и `test`
  обязаны существовать — правило контракта `A2` проверяет их по именам.

### Что пакет движка экспортирует плагину

```json
"exports": {
  "./lib/*":      "./src/lib/*",
  "./config/*":   "./src/config/*",
  "./host/*":     "./src/host/*",
  "./client/*":   "./src/client/*",
  "./devtools/*": "./src/devtools/*",
  "./standalone": "./src/standalone/index.js",
  "./style.css":  "./src/client/style.css"
}
```

Поэтому плагин вправе импортировать, например:

```js
import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import hostDefaults from 'vimp-engine/config/hostDefaults.js';
import wsports from 'vimp-engine/config/wsports.js';
```

`src/master/**` **не** экспортируется: плагин не может импортировать код
мастера. `client/*`, `devtools/*`, `standalone` и `style.css` обслуживают
dev-стенд и standalone SDK ([standalone.md](standalone.md)); сами половины
плагина общаются с движком через контракт из [plugin-api.md](plugin-api.md).

## Генерация манифеста

`scripts/build-game-manifest.js` запускается после появления бандлов и пишет
`dist/manifest.json` (правила по полям:
[plugin-api.md](plugin-api.md#gamemanifest)). Что делает генератор такого,
чего страница манифеста не проговаривает:

- `version` — `sha256(sha256(client) ‖ sha256(host) ‖ sha256(wasm))`, первые
  16 hex-символов: клиенты сравнивают его, чтобы заметить устаревший бандл;
- `maps.version` — sha256 по отсортированным парам `name + байты файла`, 16
  hex-символов; `maps.list` — базовые имена файлов `dist/maps/` (пробелы
  допустимы);
- `engineApi` — всегда импортированный `ENGINE_API_VERSION`, не литерал;
- числовые поля формы комнаты получают `regExp` из `rangeToPattern(min, max)`,
  а собственные числа `min`/`max` — из тех же границ;
- каждая картинка, названная картой, **проверяется на наличие в
  `dist/img/`** — движок не может диагностировать отсутствующую;
- `core/pkg-node/` копируется в `dist/core-node/` (если собран), с удалением
  `.gitignore`, который оставляет `wasm-pack`, и сохранением его
  `package.json`; `entries.wasmNode` должен указывать туда, **внутрь
  `dist/`**.

## Две сборки Vite

Клиент и хост собираются **двумя независимыми запусками**, а не одним
multi-entry графом Rollup — общий чанк затащил бы DOM-код (PixiJS) в
Worker-безопасный бандл хоста. Тот же `vite.config.js` обслуживает и dev-стенд
(`vite` без `--mode`): там PixiJS дедуплицируется, а не выносится во внешние, и
движок исключён из пребандлинга, потому что поставляется ESM-исходниками.

```js
import { defineConfig } from 'vite';
import path from 'node:path';

const entries = {
  client: path.resolve(import.meta.dirname, 'src/client/index.js'),
  host: path.resolve(import.meta.dirname, 'src/host/index.js'),
};

export default defineConfig(({ mode }) => {
  const entry = entries[mode];

  if (!entry) {
    throw new Error(`build: unknown --mode "${mode}" (expected "client" or "host")`);
  }

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: false, // оба запуска пишут в один dist/
      assetsInlineLimit: 0, // .wasm должен остаться отдельным ассетом с URL
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: 'strict', // сохранить default-экспорт
        external: [/^pixi\.js(\/.*)?$/], // PixiJS остаётся внешним
        output: {
          format: 'es',
          entryFileNames: `${mode}-[hash].js`,
          assetFileNames: 'assets/[name]-[hash][extname]',
          inlineDynamicImports: true,
        },
      },
    },
  };
});
```

Почему каждая неочевидная опция обязательна (их проверяет правило контракта
`A4`):

- **`emptyOutDir: false`** — иначе второй запуск сотрёт результат первого.
- **`assetsInlineLimit: 0`** — `.wasm` весит ~2 МБ; инлайнинг в base64 стоит
  +33 %, ломает `instantiateStreaming` и дублирует бинарник в обоих бандлах
  вместо одной записи в HTTP-кэше.
- **Не используйте `build.lib`** — режим lib у Vite всегда инлайнит ассеты и
  игнорирует `assetsInlineLimit`.
- **`preserveEntrySignatures: 'strict'`** — без неё Vite считает
  `default`-экспорт входного модуля (ваш `HostPlugin` / `ClientPlugin`)
  неиспользуемым и выкидывает его.
- **`inlineDynamicImports: true`** — один файл на вход; движок импортирует
  единственный URL.
- **`external: pixi.js`** — см. правило синглтона PixiJS выше.

Оба запуска выдают одно и то же хешированное имя `.wasm`: glue-модуль
wasm-pack ссылается на него через `new URL('*.wasm', import.meta.url)`, а Vite
хеширует по содержимому.

## Сборка Rust-ядра

```bash
wasm-pack build core --release --target web    --out-dir pkg-web   # рантайм
wasm-pack build core --release --target nodejs --out-dir pkg-node  # Node: тесты, sim
```

- `pkg-web` импортируют бандлы (браузер + Worker).
- `pkg-node` грузят Vitest, headless-раннер (`npm run sim`) и
  [dedicated-сервер](dedicated.md) через `entries.wasmNode`.
- Ядро **не** пересобирается командой `npm run build`; собирайте его явно
  (`npm run core:build`) при любом изменении Rust — иначе уедет устаревший
  `.wasm`.
- Правило `A5` проверяет `core/Cargo.toml`: `crate-type = ["cdylib", "rlib"]`,
  `rapier2d` с фичей `enhanced-determinism` и актуальный пин крейта
  `vimp-engine-core` ([core.md](core.md)).

## Скрипты ассетов

| Скрипт                   | Что делает                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export-maps.js`         | сериализует `src/data/maps/*.js` в `dist/maps/<name>.json` (имя файла — имя карты; пробелы допустимы и URL-декодируются при записи)                                                                                                                                 |
| `process-audio.js`       | конвейер ffmpeg: нормализует громкость (EBU R128) и выдаёт **оба** формата `.webm` и `.mp3` для каждого звука в `build/sounds/`                                                                                                                                     |
| `copy-game-sounds.js`    | очищает и копирует `build/sounds/` → `dist/sounds/`                                                                                                                                                                                                                 |
| `copy-game-images.js`    | копирует `assets/img/` → `build/img/` (корень dev) и → `dist/img/` (упакованный ассет); картинкам обработка не нужна, поэтому стадии вроде ffmpeg между ними нет                                                                                                    |
| `build-game-manifest.js` | хеширует бандлы, собирает имена карт, **проверяет, что каждая картинка, названная картой, есть в `dist/img/`**, применяет `rangeToPattern` к числовым полям формы комнаты, копирует `core/pkg-node/` → `dist/core-node/` (если собран) и пишет `dist/manifest.json` |

Звуковые файлы обязаны существовать **парами `webm` + `mp3`**: список кодеков
клиента — `['webm', 'mp3']`, и он выбирает по поддержке браузера. Запускайте
скрипты копирования и из `predev`, и из `build:assets`: standalone-запуск
читает картинки и звуки из `build/`, а разработчик без ffmpeg всё равно
должен видеть карту. Сами конвейеры — в
[maps-and-assets.md](maps-and-assets.md).

## Состав `dist/`

```
dist/
├─ manifest.json
├─ client-<hash>.js
├─ host-<hash>.js
├─ assets/
│  └─ <crate>_bg-<hash>.wasm
├─ core-node/                 # необязательно: копия core/pkg-node (entries.wasmNode)
│  ├─ <crate>.js              # CommonJS-glue для Node — headless-раннер
│  ├─ <crate>_bg.wasm
│  └─ package.json            # пишет wasm-pack; без него Node прочтёт glue как ESM
├─ maps/
│  ├─ canopy.json
│  └─ pool mini.json
├─ img/                       # тайлсеты и спрайты динамических тел
│  ├─ tiles.png               # названы в spriteSheet.img / physicsDynamic[].img
│  └─ crate.png
└─ sounds/
   ├─ shot.webm
   └─ shot.mp3
```

## Как это отдаёт мастер

Мастер читает только собранные `manifest.json` и `dist/maps/*.json` и
проверяет пакет **структурно, не импортируя и не исполняя код плагина**.
Откуда берётся пакет (реестр игр центрального auth-сервиса и npm-реестр в
проде, `node_modules/<package>/dist` локально и на самостоятельном мастере),
маршруты и версионированное пространство URL описаны в [master.md](master.md)
(REST API → `GET /games/…`); переписывание URL манифеста — в
[plugin-api.md](plugin-api.md#gamemanifest).

Игра, которую мастер не может прочитать (нет `manifest.json`, `manifest.id` ≠
настроенному id), пропускается с `console.warn`, а не исключением — она
**невидима в лобби**, поэтому при пропаже игры сначала смотрите консоль
мастера. `engineApi` — не причина: игра, собранная под более старый движок,
отдаётся как есть. Игра, чей `requires` называет неизвестную движку
возможность, остаётся в каталоге и показывается в лобби как недоступная с
указанием причины.

## Dev-режим

В dev мастер переписывает `entries` на исходные пути Vite `/@fs/`, чтобы
плагин получал HMR:

```
entries.client → /@fs/<gameDir>/src/client/index.js
entries.host   → /@fs/<gameDir>/src/host/index.js
entries.wasm   → /@fs/<gameDir>/core/pkg-web/<crate>_bg.wasm
```

Эти пути **зашиты** — плагин обязан использовать ровно `src/client/index.js`
и `src/host/index.js` как входы (правило `A3`) и иметь собранный
`core/pkg-web/`. `maps`, `assetsBase`, `roomDefaults` и `version` по-прежнему
берутся из собранного `dist/manifest.json`, поэтому:

> **Плагин должен быть полностью собран хотя бы раз (`npm run core:build && npm run build`) до первого запуска мастера, даже в dev.**

Как связать плагин и чекаут движка друг с другом (`npm link` в **обе**
стороны) — в [getting-started.md](getting-started.md).

## Документация, которую обязан поставлять плагин

Документация движка описывает **контракт**. Готовый плагин обязан
документировать **сам себя** — свои правила, числа и решения, — потому что
документация движка сделать этого не может: она описывает все игры и потому
ни одну.

Пишите её так, как это делают поставляемые плагины
([vimp-tanks](https://github.com/lgick/vimp-tanks),
[vimp-snakes](https://github.com/lgick/vimp-snakes)): два зеркальных дерева,
`docs/en/` (канон) и `docs/ru/` (идентичная структура), в каждом —
`README.md` с оглавлением и страницы:

| Страница             | Содержимое                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getting-started.md` | Требования, установка, тулчейн Rust, скрипты сборки, самый быстрый локальный матч, связка с локальным чекаутом движка, тесты, статическая проверка контракта, headless-сценарии                 |
| `architecture.md`    | Раскладка репозитория, как плагин встраивается в движок (host/client/master), где проходит граница ядра, клиентское сглаживание этой игры, решения, от которых зависит код, ключевые инварианты |
| `gameplay.md`        | Правила, которые видит игрок: путь игрока, управление, очки, чат-команды, боты, кики — и явно те возможности движка, которые эта игра **не** использует                                         |
| `core.md`            | Крейт на Rust: раскладка, сборка, ABI, который он заполняет (команды, события, кадры, запросы состояния), модель симуляции, детерминизм, тесты                                                  |
| `configuration.md`   | Каждый файл `src/config/` и `src/data/` по параметрам, с ловушками каждого                                                                                                                      |
| `extending.md`       | Рецепты добавления контента — по одной нумерованной процедуре на артефакт, каждая заканчивается проверками                                                                                      |

Правила этой документации:

- **Не дублируйте движок.** Транспорт, мастер, инфраструктура Worker,
  универсальные трейты ядра и сам контракт плагина принадлежат собственному
  дереву `docs/en|ru` движка — давайте ссылки на
  `https://github.com/lgick/vimp-engine/blob/main/docs/ru/...`, а не пересказ.
- **Документируйте решения, а не только поля.** Ценность этих страниц — в
  «почему»: зачем нужен ключ конфига, что молча ломается без него, какова была
  альтернатива и почему её отвергли. Таблица значений по умолчанию, которые и
  так видны в коде, стоит мало.
- **Называйте то, чего намеренно нет.** Раунды, команды, голосования, оружие,
  наблюдатели — неиспользуемая игрой возможность движка есть решение, а
  читатель, не отличающий его от упущения, «починит» её.
- **Зафиксируйте правило в `CLAUDE.md` плагина**: любое функциональное
  изменение обновляет соответствующие страницы `docs/en/` и `docs/ru/` в том
  же изменении, с таблицей «область → страница», чтобы не было сомнений, какая
  именно.
- **Сошлитесь на документацию из `README.md` плагина** (короткий список и
  указатель на другой язык). README остаётся посадочной страницей, глубина
  живёт в `docs/`.

---

[← Предыдущая: Plugin API](plugin-api.md) · [Следующая: Карты и ассеты →](maps-and-assets.md)
