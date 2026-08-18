# Этап 3. Шаблон: инфраструктура сборки и dev-харнес ✅ выполнен

Первый из трёх этапов, наполняющих `templates/default`. После него
сгенерированный проект собирается (пустое ядро + заглушки), но матч ещё не
идёт.

## Дизайн минимальной игры (общий для этапов 3–5)

Фиксируется здесь, действует до конца направления. **Ничего из tanks не
переносится** — ни конфигов, ни ассетов, ни имён сущностей.

- Рабочее имя внутри шаблона — нейтральное: `actor`, `arena`, `blaster`.
- Две играющие команды (`team1`, `team2`) + `spectators`. Две команды
  нужны, чтобы отрабатывал раунд-лайфцикл движка (раунд заканчивается
  выбиванием команды) и проходил инвариант `roundLifecycle` раннера.
- Один класс актора: круглое тело в Rapier, движение импульсами по 4
  направлениям, поворот к цели.
- Одно оружие — hitscan с `fireRate`; боезапас показывается ячейкой панели.
- Одна карта `arena`: сетка стен `physicsStatic`, без `spriteSheet`, без
  `layers`, по 8 респаунов на каждую играющую команду.
- Вся графика процедурная: `PixiJS.Graphics` в партах + один baker на
  текстуру актора. **Бинарных картинок в пакете нет.**
- Звук: две плейсхолдер-пары `webm`+`mp3` (`shot`, `death`), синтезированные
  специально для шаблона.
- Снапшот: `a1` (`indexed8`, `class: 'hot'` — акторы) и `e1` (`list16`,
  `class: 'event'` — выстрелы).
- Бюджет предикции `PLAYER_STATE_LEN = 8`: `[x, y, angle, vx, vy, hp, ammo,
  0]`.
- Панель: `hp` (`bar`), `am` (`value`), `t` (`time`, ключ движка).
- Боты: `ScriptedManager` + чат-команда `/spawn <n>`.

## 3.1. Манифест и конфиги инструментов

- `package.json.tpl` — по `docs/ai/02-packaging.md`: `type: "module"`,
  `files: ["dist"]`, `publishConfig.access: "public"`, `pixi.js` в
  `peerDependencies` **и** `devDependencies`, `vimp-engine` — только
  `devDependencies` (`{{ENGINE_VERSION}}`), `dependencies` отсутствует.
  Скрипты: `build`, `build:client`, `build:host`, `build:assets`,
  `build:manifest`, `audio:process`, `core:build`, `core:build:web`,
  `core:build:node`, `core:test`, `test`, `test:watch`, `dev`,
  `check:contract` (`vimp-contract --game .` из devDependency движка),
  `sim` (`vimp-sim --game .`).
- `vite.config.js` — три режима в одном файле: `serve` (dev-харнес:
  `resolve.dedupe: ['pixi.js']`, `optimizeDeps.exclude: ['vimp-engine']`,
  `optimizeDeps.include: ['pixi.js', 'pixi.js/unsafe-eval', 'howler']`,
  `server.fs.allow: ['..']` для `npm link`) и две сборки `--mode
  client|host` с обязательными опциями: `outDir: 'dist'`, `emptyOutDir:
  false`, `assetsInlineLimit: 0`, `preserveEntrySignatures: 'strict'`,
  `external: [/^pixi\.js(\/.*)?$/]`, `format: 'es'`, `entryFileNames:
  '[mode]-[hash].js'`, `assetFileNames: 'assets/[name]-[hash][extname]'`,
  `inlineDynamicImports: true`. Режим `build.lib` не используется — он
  инлайнит 2 МБ wasm вопреки `assetsInlineLimit`.
- `vitest.config.js` — два проекта, как предписывает `docs/ai/11`:
  `unit` (`happy-dom`: `tests/config`, `tests/client`, `tests/host`) и
  `integration` (`node`: `tests/core`, требует собранного `core/pkg-node`,
  иначе `skip`).
- `eslint.config.js` — минимальный, на `@eslint/js` + `globals`, с
  разделением окружений `src/host` (worker) / `src/client` (browser) /
  `scripts` (node).
- `Cargo.toml.tpl` (корень) — workspace `members = ["core"]`,
  `[workspace.dependencies]` с `rapier2d 0.34` + `enhanced-determinism` и
  `serde-serialize`, `[profile.release] opt-level = 3, lto = true`.
- `core/Cargo.toml.tpl` — `name = "{{CRATE_NAME}}"`, `edition = "2024"`,
  `crate-type = ["cdylib", "rlib"]`, `vimp-engine-core = "{{CORE_VERSION}}"`.
- `_gitignore` → `.gitignore`: `node_modules`, `dist`, `build`, `target`,
  `core/pkg-web`, `core/pkg-node`, `.debug`.
- `LICENSE`, `README.md.tpl` — первым блоком, до всякой прозы, идёт
  последовательность запуска с явным предупреждением:

  ```bash
  npm install
  npm run core:build   # ОБЯЗАТЕЛЬНО перед npm run dev
  npm run dev
  ```

  Причина — в 3.3: `dev/main.js` импортирует wasm из `core/pkg-web/`, и до
  первой сборки ядра Vite падает на резолве отсутствующего файла.

## 3.2. Скрипты сборки (`scripts/`)

Пишутся заново по `docs/ai/02-packaging.md` и `07-maps-and-assets.md`:

| Скрипт | Что делает |
| --- | --- |
| `build-game-manifest.js` | `dist/manifest.json`: `id`, `engineApi` (импорт `ENGINE_API_VERSION`, не литерал), `version` = первые 16 hex от `sha256(sha256(client)‖sha256(host)‖sha256(wasm))`, `entries.{client,host,wasm}`, `assetsBase`, `maps.{version,list}`, `roomDefaults`, `roomForm` (границы через `lib/rangeToPattern.js`); копирует `core/pkg-node/` в `dist/core-node/` с сохранением его `package.json` и удалением `.gitignore` от wasm-pack, затем проставляет `entries.wasmNode` |
| `export-maps.js` | `src/data/maps/*.js` → `dist/maps/<name>.json` |
| `copy-game-sounds.js` | `build/sounds/` → `dist/sounds/`; если `build/sounds/` нет — фолбэк на готовые плейсхолдеры `assets/sounds/` |
| `copy-game-images.js` | `assets/img/` → `build/img/` и `dist/img/`; no-op, пока картинок нет |
| `process-audio.js` | ffmpeg + EBU R128 → `assets/audio-raw/*` в `build/sounds/*.{mp3,webm}` |
| `lib/rangeToPattern.js` | числовой диапазон → regExp для `roomForm` |

Фолбэк в `copy-game-sounds.js` — осознанное отклонение от конвейера tanks:
первая сборка сгенерированной игры обязана быть зелёной **без ffmpeg**,
поэтому пара готовых плейсхолдеров лежит в `assets/sounds/`, а
`assets/audio-raw/*.wav` (синтезированные тем же способом) остаются
демонстрацией полного конвейера. Отличие описывается в README игры.

`build-game-manifest.js` обязан корректно работать с картой **без**
`spriteSheet` — минимальная игра рисует стены процедурно.

## 3.3. Dev-харнес

По `docs/en/standalone.md` и `docs/ai/11-authoring-workflow.md` (шаг 8):

- `index.html` — полноэкранный `#game` + `<script type="module"
  src="/dev/main.js">`;
- `dev/main.js` — `startStandaloneGame` из `vimp-engine/standalone` с
  живыми `hostPlugin`/`clientPlugin`, `wasmUrl` через `?url`-импорт
  `core/pkg-web/{{CRATE_SNAKE}}_bg.wasm` (над импортом — комментарий, что
  файла не существует до `npm run core:build`, и это первая причина
  падения `npm run dev` у новичка), `assetsBase: '/build/'`,
  `startupVotes: [['teamChange', 'team1']]` (сначала выход из зрителей),
  затем `startupCommands: ['/spawn 3']`, `devMode: true`.

## 3.4. `CLAUDE.md` игры

Компактный (до ~600 токенов), английский — как требует гигиена проектных
`CLAUDE.md`:

- границы потоков: `src/host/` — Web Worker (никакого DOM и PixiJS),
  `src/client/` — главный поток;
- вся физика, урон и движение — в Rust (`core/src/game.rs`,
  `core/src/motion.rs`), движок этого не делает;
- контрактные константы: `ENGINE_API_VERSION` только импортом,
  `PLAYER_STATE_LEN = 8`, hot-буфер только `indexed8`/`indexedNoNull8`;
- команды проверки: `npm run check:contract`, `npm run core:test`,
  `npm run sim`, `npm run dev`;
- порядок работ: схема снапшота и конфиги → Rust-симуляция → контракт и
  sim → рендер;
- ссылка на `docs/ai/` движка как на источник контракта (в шаблон он не
  копируется).

## Готовность этапа

- [x] Генерация во временный каталог + `npm install` проходит.
- [x] `npm run build` даёт `dist/` с `manifest.json`, обоими бандлами,
      `maps/`, `sounds/` (ядро на этом этапе — заглушка).
- [x] `npm run check:contract` проходит группы A и E без `fail`.
- [x] `npx eslint .` внутри сгенерированной игры зелёный.

## Отклонения от плана (зафиксированы по факту)

1. **Заглушки JS-слоя.** Чтобы `npm run build` был зелёным уже здесь,
   добавлены помеченные `PLACEHOLDER` минимумы: `src/host/index.js`,
   `src/client/index.js`, `src/config/{game,client,sounds}.js`,
   `src/data/maps/{index,arena}.js` и `core/src/lib.rs` (пустой `GameCore`
   ради `.wasm` в манифесте). Этапы 4–5 заменяют их содержимым.
2. **`copy-game-sounds.js` при фолбэке пишет и в `build/sounds/`** — это
   dev-корень ассетов (`assetsBase: '/build/'`), иначе `npm run dev` без
   ffmpeg играет матч без звука. `predev` поэтому зовёт и звуки, и картинки.
3. **Гейт картинок карт оставлен в `build-game-manifest.js`** (инлайном, без
   отдельного `lib/collectMissingImages.js`) — требование
   `docs/ai/02-packaging.md`, на процедурной карте это no-op.
4. **Стартовый тест `tests/config/game.test.js`** — иначе `npm test` в
   свежесгенерированной игре красный («No test files found»).
