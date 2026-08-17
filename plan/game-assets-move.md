# План: перенос игровых ассетов из движка в игру

## Контекст

Картинки игры лежат в движке. `packages/engine/public/img/` — 6 файлов
(372 КБ): `tiles.png`, `tiles2.png`, `tiles3.png`, `b1.png`, `bob.jpg`,
`stalin.jpg`. **Движок не ссылается на них ни одной строкой** (`grep '/img/'`
по `src/`, `index.html`, `vite.config.js`, `scripts/` даёт единственный хит —
CSP-директиву `img-src` в `src/config/master.js:97`). Единственный потребитель
— `src/client/parts/Map.js` игры, который зашивает абсолютный путь:

```js
// vimp-tanks/src/client/parts/Map.js:20 и :39
this._assetUrl = `/img/${data.spriteSheet.img}`;   // static
this._assetUrl = `/img/${data.img}`;               // dynamic
```

Работает это только потому, что Vite отдаёт `public/` в корне сайта движка
(dev) и копирует его в `dist/` (prod). Последствия:

1. **`npm run dev` в `vimp-tanks` показывает карту без тайлов** — `public/` не
   входит в `files` пакета `vimp-engine`, отдавать `/img/tiles.png` в
   репозитории игры некому. Это отложенный пункт Этапа 6 закрываемого плана
   (`plan/standalone-sdk/stage_6.md:144-153`).
2. **Любая новая игра вынуждена брать тайлы движка.** Это прямо зафиксировано
   в спецификации для LLM как «ловушка»: `docs/ai/07-maps-and-assets.md:93-110`
   («Images — the location trap»), `docs/ai/10-pitfalls.md:157-159`,
   `docs/ai/12-questionnaire.md:186-187`.
3. Движок везёт ассеты чужой игры в git и в Docker-образ (`Dockerfile:69-70`
   копирует `public/` дважды — внутри `dist/` и сырым каталогом).

**Цель**: все зависимости игры живут в пакете игры и приезжают клиенту через
`assetsBase` — ровно тем же механизмом, что уже работает для звуков
(`packages/engine/src/client/main.js:311-313` → `${assetsBase}sounds/`). После
переноса движок не отдаёт ни одного игрового файла.

### Зафиксированные решения (согласованы)

| Развилка | Решение |
| --- | --- |
| Как игра узнаёт базу | Новый DI-сервис `assetsBase` в `availableServices` движка; игра объявляет его в `componentDependencies` |
| Порядок работ | Один шаг: оба репозитория правятся вместе через `npm link` |
| `tiles2.png`, `bob.jpg`, `stalin.jpg` (никем не используются) | Переносятся в игру вместе с остальными |
| Место в репозитории игры | `assets/img/` (под гитом) → `build/img/` (dev) и `dist/img/` (пакет) |

Дополнительно по прямому пожеланию: `docs/ai/` (спецификация для нейросети)
должна явно говорить, что **тайлы — часть пакета игры**; сейчас она учит
обратному.

---

## Блок 0. Закрыть текущий план ✅ выполнен

Направление `standalone-sdk` выполнено целиком (Этапы 1–6 + пять раундов
ревью, все `✅ выполнен`), запись в `plan/done/README.md:29-35` уже написана.

1. `plan/standalone-sdk/README.md` — в таблицу этапов добавить строку `R5`
   (`review-5.md`, ✅ выполнен): сейчас в таблице только `R`…`R4`, хотя файл
   пятого раунда закрыт полностью.
2. `plan/standalone-sdk/stage_6.md` — раздел «Отложено (отдельная задача, вне
   Этапа 6)» заменить ссылкой на новый план.
3. `git mv plan/standalone-sdk plan/done/standalone-sdk`.
4. Записать этот план в `plan/game-assets-move.md` (один файл, без разбиения
   на этапы — объём средний).

Коммит не делаем (правило 6 глобальных инструкций).

---

## Блок 1. Движок: доставка `assetsBase` в part'ы игры ✅ выполнен

Механизм внедрения зависимостей уже есть и полностью подходит:
`DependencyProvider.collectAll(availableServices, componentDependencies)`
(`packages/engine/src/client/providers/DependencyProvider.js`) кладёт любое
значение из пула сервисов в `dependencies` тех компонентов, которые его
объявили. Значение не обязано быть объектом — строка проходит без изменений.

### 1.1 `packages/engine/src/client/main.js:344-347`

```js
const availableServices = {
  renderer: app.renderer,
  soundManager,
  // база ассетов игры — тем же каналом, что и путь к звукам (:311-313):
  // картинки карт живут в пакете игры (dist/img/), движок их не раздаёт
  assetsBase: activeGameManifest.assetsBase,
};
```

Одна строка. `activeGameManifest` в этой точке уже разрешён — он используется
двадцатью строками выше для `soundData.path`. Работает во всех трёх контурах:
лобби (`assetsBase: '/games/tanks/'`, статика монтируется в
`src/master/lobby.js:361`), dedicated (`src/dedicated/main.js:221`), standalone
(манифест синтезируется в `src/standalone/index.js:106-117`, дефолт `'/'`).

`ENGINE_API_VERSION` **не меняется**: изменение аддитивное, ни один
существующий манифест или плагин не отвергается.

### 1.2 Тест — `tests/client/providers/DependencyProvider.test.js` (новый)

Провайдер сегодня не покрыт (есть только `tests/client/BakingProvider.test.js`).
Кейсы: сервис-не-функция (строка) доезжает до объявленного компонента; один
сервис на несколько компонентов; сервис, отсутствующий в пуле, молча
пропускается; повторный `collectAll` очищает коллекцию.

Сам `main.js` юнит-тестами не покрывается — в happy-dom он не поднимается
(`Application.init` требует WebGL), это задокументировано в
`tests/standalone/startStandaloneGame.test.js:14-20`. Связка «манифест → сервис
→ part» проверяется тестом игры (4.4) и ручным smoke (Верификация 7-8).

---

## Блок 2. Движок: удаление игровых картинок ✅ выполнен

### 2.1 `git rm packages/engine/public/img/` — все 6 файлов

После этого в `public/` остаётся `favicon.ico` (нужен, `index.html:5`) и
gitignored `vendor/pixi/` (генерируется `scripts/sync-pixi-vendor.mjs`).

### 2.2 `Dockerfile:69-70`

```dockerfile
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist
COPY --from=builder /app/packages/engine/public ./packages/engine/public
```

Вторая строка выглядит рудиментом: в проде отдаётся `dist/`, куда Vite уже
скопировал `public/`. **Сначала проверить** (`grep -rn "public" packages/engine/src`
+ прогон контейнера), что в рантайме никто не читает `packages/engine/public`;
если не читает — убрать строку. Если сомнение остаётся — оставить, это не
блокер.

### 2.3 `packages/engine/tests/fixtures/miniGame/config/game.js:48`

```js
spriteSheet: { img: 'tiles.png', frames: [[0, 0, 32, 32]] },
```

Фикстура host-only (рендера в ней нет, клиент — `fakeClientCore.js`), файл
физически не читается — но имя после удаления вводит в заблуждение.
Переименовать в нейтральное (`fixture-tiles.png`). Убедиться прогоном
`npm test` + `npm run sim`, что данные действительно инертны.

---

## Блок 3. Игра: картинки в пакете ✅ выполнен

Репозиторий `/Users/dmitry/Sites/my/vimp-tanks` (сейчас чистый, HEAD `fb9691e`).
Каталога картинок в нём сегодня нет вовсе.

### 3.1 `assets/img/` — новый каталог под гитом

Перенести все 6 файлов из `packages/engine/public/img/`. Между репозиториями
`git mv` не работает: `cp` в игру + `git add`, `git rm` в движке.

`assets/` не в `.gitignore` игры (там `build/`, `dist`, `core/pkg-*`,
`target/`, `.debug/`) — трекается автоматически, править игнор не нужно.

### 3.2 `scripts/copy-game-images.js` — новый, по образцу `copy-game-sounds.js`

```
assets/img/  ──→  build/img/   (dev-корень, gitignored)
             ──→  dist/img/    (npm-пакет)
```

Обработки у картинок нет (в отличие от звуков с их ffmpeg-шагом), поэтому
промежуточная стадия отсутствует и оба таргета пишутся за один прогон.
`fs.rmSync(target, {recursive:true, force:true})` + `fs.cpSync` — как в
`copy-game-sounds.js:25-26`. Отсутствие `assets/img/` — `process.exit(1)` с
внятным текстом.

Запись в `dist/img/` из `predev` безопасна: `npm run build` начинается с
`rm -rf dist`.

### 3.3 `scripts/build-game-manifest.js` — проверка целостности

Добавить гейт: каждое имя из `spriteSheet.img` и `physicsDynamic[].img` всех
карт `dist/maps/*.json` обязано существовать в `dist/img/`. Иначе — падение
сборки с перечислением недостающих. Это ровно тот класс молчаливых отказов
(пустое полотно без ошибки), из-за которого написан `docs/ai/10-pitfalls.md`.

Новых полей в манифесте **не заводим**: картинки находятся по соглашению
`${assetsBase}img/`, как звуки по `${assetsBase}sounds/`.

### 3.4 `package.json`

- `build:assets`: `... && node ./scripts/copy-game-images.js`
- `predev`: `node ./scripts/copy-game-images.js` (npm вызовет перед `dev`)
- `devDependencies.vimp-engine`: `^0.8.0` → новая minor (`^0.9.0`)
- `files` не меняется (публикуется `dist`)

### 3.5 `scripts/check-pack.js`

В `REQUIRED` добавить реально используемые тайлы:
`/^dist\/img\/tiles\.png$/`, `/^dist\/img\/tiles3\.png$/`, `/^dist\/img\/b1\.png$/`.
Скрипт существует именно из-за того, что npm применяет `.gitignore` внутри
каталогов из `files` (см. его шапку) — а `dist/` как раз gitignored.

---

## Блок 4. Игра: `Map.js` и конфиг клиента ✅ выполнен

### 4.1 `src/config/client.js:120-125`

```js
componentDependencies: {
  renderer: ['Map'],
  assetsBase: ['Map'],
  soundManager: ['ExplosionEffect', 'ShotEffect', 'Bomb', 'Tank'],
},
```

### 4.2 `src/client/parts/Map.js`

Конструктор уже принимает `dependencies` (использует `dependencies.renderer`).

- строка 20: `` this._assetUrl = `${base}img/${data.spriteSheet.img}` ``
- строка 39: `` this._assetUrl = `${base}img/${data.img}` ``
- базу взять один раз в конструкторе; `destroy()` (строки ~176-185) уже
  выгружает по сохранённому `this._assetUrl` — менять не нужно.
- **Явная ошибка вместо тихой поломки**: если `dependencies.assetsBase`
  не пришёл (плагин запущен на движке до 0.9.0), бросить с внятным текстом —
  иначе получится запрос на `undefinedimg/tiles.png` и пустое полотно без
  причины.

### 4.3 `src/standalone.js`

`assetsBase: '/build/'` остаётся. Обновить комментарий: база покрывает теперь
и `sounds/`, и `img/`; `build/img/` стейджит `predev`, поэтому тайлы видны
без ffmpeg (звуки по-прежнему требуют `npm run audio:process`).

### 4.4 Тест — `tests/client/parts/Map.test.js` (новый)

По образцу существующих `tests/client/parts/{Bomb,Tank}.test.js`. Кейсы: URL
статического тайла и URL динамического объекта строятся от
`dependencies.assetsBase`; смена базы меняет URL; отсутствие `assetsBase`
даёт ошибку с понятным текстом.

---

## Блок 5. Документация ✅ выполнен

### 5.1 Движок, парные `docs/en/` + `docs/ru/`

| Страница | Правка |
| --- | --- |
| `client.md` (en:670-671, ru:250) | В описании `DependencyProvider` — третий сервис `assetsBase` |
| `plugin-api.md` | В разделах GameManifest/ClientPlugin: `assetsBase` — база и для `sounds/`, и для `img/` |
| `architecture.md:40` | `public/` описан как «static assets (sounds, favicon)» — уже устарело (звуков там нет с переезда в плагин); стало: favicon + генерируемый `vendor/pixi/` |

### 5.2 `docs/ai/` (English-only) — главная часть работы

Сейчас спецификация учит новую игру брать тайлы у движка; после переноса это
неверно во всех перечисленных местах:

| Файл | Правка |
| --- | --- |
| `07-maps-and-assets.md:93-110` | Секция «Images — the location trap» переписывается по существу: тайлы поставляет **сам плагин**, `assets/img/` → `dist/img/`, URL `${assetsBase}img/<file>`, движок картинок не отдаёт вовсе. Ловушки больше нет — есть конвенция, симметричная звуковой |
| `README.md` | В таблице артефактов плагина (`manifest.json` + maps + sounds) и в шагах генерации явно назвать картинки частью пакета игры |
| `04-client-plugin.md:141-148` | Пул сервисов больше не «fixed: `renderer` and `soundManager`» — их три; пример `componentDependencies` с `assetsBase` |
| `02-packaging.md` | В раскладку `dist/` добавить `img/`; в описание сборки — шаг копирования |
| `10-pitfalls.md:157-159` | Пункт чек-листа утверждает обратное — переписать |
| `12-questionnaire.md:186-187` | Вопрос «берём готовые тайлы движка или нужны свои?» → «какие тайлы вы кладёте в свой пакет» |
| `09-reference-implementations.md:58` | Пример карты (`img: 'tiles.png'`) — сопроводить указанием, откуда файл берётся |
| `11-authoring-workflow.md` | В порядок работ и матрицу пересборок добавить ассеты-картинки |

### 5.3 Игра, парные `docs/en/` + `docs/ru/`

- `extending.md` («New map») — откуда берётся тайл-лист (`assets/img/`), как
  попадает в `dist/img/`, что имя из `spriteSheet.img` проверяется сборкой.
- `getting-started.md` — dev-цикл: `predev` стейджит картинки, ffmpeg нужен
  только ради звука; сборка и раскладка `dist/`.
- `architecture.md` / `configuration.md` — если там описан жизненный цикл
  текстур или раскладка карт, синхронизировать.
- `CLAUDE.md` игры — в таблицу «область → страница» добавить ассеты, если
  правка 5.3 её расширяет.

---

## Блок 6. Журналы и релиз ✅ выполнен

### `packages/engine/CHANGELOG.md` → `## [Unreleased]`

- `### ⚠️ Breaking` — движок больше не раздаёт `/img/*`; плагин, который
  запрашивал тайлы у движка, получит 404 и пустое полотно.
- `### Migration` — обязательный спутник: положить картинки в свой пакет
  (`dist/img/`), объявить `assetsBase` в `componentDependencies`, строить URL
  как `${dependencies.assetsBase}img/<file>`.
- `### Added` — `assetsBase` в пуле сервисов `DependencyProvider`.

Уровень — **minor** (в `0.x` `⚠️ Breaking` = minor, `Added` тоже minor).

`packages/engine/core/CHANGELOG.md` не трогается — Rust не меняется.

### `@vimp-games/tanks` `CHANGELOG.md` → `[Unreleased]`

`### Changed` — картинки карт переехали в пакет, URL строится от `assetsBase`;
требуется `vimp-engine ^0.9.0`.

### Release impact

- **npm `vimp-engine` — minor.** Задет публикуемый `src/client/` (в `files`).
- **Крейт `vimp-engine-core` — не тронут.**
- **`ENGINE_API_VERSION` не меняется** (3), но **репозиторий игры обязан
  следовать**: без правки `Map.js` карты станут пустыми.
- `version` не правим и не публикуем — это делает разработчик через
  `npm run release`.

### Порядок выкатки (однoшаговый вариант)

1. Оба репозитория правятся вместе, связанные `npm link` в обе стороны.
2. Публикация: сначала `vimp-engine` 0.9.0, затем `@vimp-games/tanks` 0.7.0.
3. В движке поднять `@vimp-games/tanks` до `^0.7.0` в **корневом**
   `package.json` (деплой-уровень; в `packages/engine/package.json` игры нет и
   быть не должно).
4. **Деплой мастера — только после обеих публикаций.** Между ними прод на
   старой игре покажет карты без тайлов.

---

## Верификация

**Движок:**

1. `npx eslint . && npm test` — зелёные (включая новый тест 1.2).
2. `npm run sim && npm run sim:check` — зелёные (проверка, что фикстура
   `miniGame` после переименования тайла жива).
3. `npm run build:app` → в `packages/engine/dist/` **нет** каталога `img/`.

**Игра (движок подключён `npm link`):**

4. `npm test && npx eslint .` — зелёные (включая новый `Map.test.js`).
5. `npm run core:build && npm run dev` → тайлы видны на стартовой `pool mini`
   (`tiles.png`); после смены карты голосованием на `canopy` и `garden` видны
   `tiles3.png` и ящики `b1.png`. В консоли нет `Failed to load` и нет
   `Failed to create static map`. В Network URL — `/build/img/tiles.png`.
6. `npm run build && npm run check:pack` → в `dist/img/` все 6 файлов,
   `check:pack` зелёный. Проверить, что гейт 3.3 срабатывает: временно убрать
   `b1.png` → сборка падает с перечислением.
7. `npm run sim && npm run sim:scenarios` — зелёные.

**Совместно (ручной smoke):**

8. Лобби: `npm run dev` в движке + связанный пакет игры → создать комнату,
   карта отрисована, в Network тайл приезжает по `/games/tanks/img/tiles.png`.
9. Dedicated: `npm run dedicated` (`VIMP_DEDICATED_GAME`) → второй клиент
   заходит, карта отрисована, тот же URL.
10. Firefox с `media.peerconnection.enabled = false` — standalone-контур игры
    по-прежнему поднимается (регресс приёмки Этапа 6).

## Статус выполнения (2026-08-18)

Все шесть блоков закрыты, код и документация в рабочем дереве обоих
репозиториев (коммитов нет — правило 6 глобальных инструкций).

Прогнано автоматически:

| Проверка | Результат |
| --- | --- |
| движок: `npx eslint .` | чисто |
| движок: `npm test` | **127 файлов / 1254 теста** зелёные |
| движок: `npm run sim` / `sim:check` | 9 passed, 0 failed, 3 skipped |
| движок: `npm run build:app` | `dist/img/` больше не создаётся; хэш importmap в CSP совпадает |
| игра: `npx eslint .` | чисто |
| игра: `npm test` | **14 файлов / 121 тест** зелёные |
| игра: `npm run build` | `dist/img/` собран, манифест перечислил `b1.png, tiles.png, tiles3.png` |
| игра: гейт манифеста | проверен на отрицательном кейсе: без `b1.png` сборка падает с перечислением |
| игра: `npm run check:pack` | `44 files, node core and map images included`; в тарболе все 6 картинок |
| игра: `npm run sim` / `sim:scenarios` | 8 passed, 0 failed, 4 skipped; `all 3 scenario(s) green` |

Осталось **вручную** (пункты 5, 8-10 Верификации — нужны браузер и `npm link`,
которого сейчас нет: в обоих репозиториях стоят npm-версии пакетов):

1. `npm link` в обе стороны, затем `npm run dev` в игре — тайлы на всех трёх
   картах, чистая консоль.
2. Smoke в лобби и на dedicated — тайл по `/games/tanks/img/tiles.png`.
3. Firefox без WebRTC — регресс приёмки Этапа 6.

После публикации обоих пакетов — поднять `@vimp-games/tanks` до `^0.7.0` в
**корневом** `package.json` движка (сейчас `^0.6.0`) и только затем
деплоить мастер.

## Что в объём не входит

- `.github/assets/images/*.png` и `video/game.gif` в движке — скриншоты игры
  для витринного root `README.md`; по CLAUDE.md это осознанная витрина, не
  рантайм-ассет.
- `packages/engine/src/config/master.js:29` (`games: [{ id:'tanks', … }]`) —
  деплой-уровневый дефолт, переопределяемый `GAMES_MATRIX`; поле `version:
  '0.1.0'` там уже устарело, но это отдельная задача.
- Звуки, карты, конфиги игры — уже целиком в пакете игры, переносить нечего.
