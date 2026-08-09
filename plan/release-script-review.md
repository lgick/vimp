# Код-ревью релиз-скрипта (коммит `fb5068e`)

Разбор `scripts/release.js` + `scripts/release/*` (11 модулей, ~2000 строк),
тестов `tests/scripts/release/*` и правок документации.

Проверено фактически: `npx eslint .` — чисто, `npm test` — зелёный. Ошибки
ниже найдены чтением кода и подтверждены прогонами в песочнице (см. пометки
«проверено»).

## Что сделано хорошо

- **Разделение ответственности.** Чистая таблица решений `decide()`
  отделена от сбора данных `collect()`, `buildLinkPlan()` — от исполнения.
  Это ровно то, что делает модули тестируемыми, и тесты этим пользуются.
- **Тихие проверки с полным выводом при падении** (`shell.check` +
  `CommandError.format()`) — требование выполнено буквально.
- **Возврат линков через `finally` + `SIGINT`/`SIGTERM`** с флагом
  `restored` от двойного вызова.
- **Отказ от файла состояния** обоснован верно: источник истины — реестры.
- **Комментарии объясняют «почему»**, а не «что» — соответствует конвенции
  репозитория. `crateIndexPath`, `levelForBreaking`, `checkTarball` снабжены
  ровно нужным контекстом.
- **Безопасность вызовов**: везде `spawn` без `shell: true`, аргументы
  массивом — инъекция через путь к игре или имя пакета невозможна.

Ниже — то, что требует правки. Приоритет: **A** блокирует релиз, **B**
портит результат или опасен, **C** поддерживаемость.

---

## A1. Релиз только игры невозможен — самый частый сценарий не работает

**Где:** `scripts/release/plan.js:22-45`.

**Суть.** Решение о публикации игры не смотрит на саму игру:

```js
publish: required || engine.publish,   // required = crate.publish || engineApiChanged
```

Игра публикуется только как следствие релиза крейта или движка. Если
изменилась **только игра** (правила, карты, ассеты, игровое ядро) — а это
отдельная строка таблицы в `docs/en/publishing.md` («Game only … ✅ game …
✅ prod») — скрипт отвечает «публиковать нечего» и выходит с кодом 0.

Проверено:

```
game-only release:
  game.publish = false | reason: изменений в движке нет
  prod.push    = false
  => скрипт напечатает: публиковать нечего
```

Следствия:

- `--only=games` нефункционален полностью: `crate`/`engine` не
  рассматриваются → `publish:false` у всех игр → выход.
- Локальная версия игры, поднятая вручную и неопубликованная, игнорируется:
  `selectGames()` вычисляет `published` (`release.js:155`), кладёт его в
  объект игры — и `decide()` этим полем никогда не пользуется.
- Тест `tests/scripts/release/plan.test.js:118` («не трогает игры, когда
  движок и крейт не публикуются») **фиксирует ошибку как ожидаемое
  поведение**, поэтому регрессия не поймается.

**Решение.** Дать игре собственные сигналы — те же три, что у крейта и
движка.

1. В `games.js` добавить сбор изменений от базовой точки игры. Тегов вида
   `vX.Y.Z` в `vimp-tanks` семь, они аннотированные, так что база есть; для
   репозитория без тегов — коммит, установивший версию. `dist/` в игре под
   `.gitignore`, поэтому диффать по путям бессмысленно — честный и простой
   сигнал «есть ли коммиты после тега версии»:

```js
// games.js
export async function collectGameState(dir, version) {
  const tag = await capture(
    'git', ['rev-parse', '--verify', '--quiet', `v${version}^{commit}`],
    { cwd: dir, allowFailure: true },
  );

  if (tag.code !== 0) {
    // тега нет — считаем изменённой, но честно говорим об этом
    return { changed: true, base: null };
  }

  const since = await capture(
    'git', ['rev-list', '--count', `${tag.stdout.trim()}..HEAD`],
    { cwd: dir, allowFailure: true },
  );

  return {
    changed: since.code === 0 && Number(since.stdout.trim()) > 0,
    base: `тег v${version}`,
  };
}
```

2. В `decide()` учесть состояние игры:

```js
const games = (input.games ?? []).map(game => {
  const required = crate.publish || input.engineApiChanged === true;
  const ahead =
    game.published === null ||
    (game.published !== undefined && compareVersions(game.version, game.published) > 0);
  const ownChanges = game.changed === true;
  const reasons = [];

  if (crate.publish) {
    reasons.push('крейт публикуется → игру нужно пересобрать');
  }
  if (input.engineApiChanged) {
    reasons.push('изменился ENGINE_API_VERSION → публикация обязательна');
  }
  if (!required && engine.publish) {
    reasons.push('движок публикуется → можно обновить и игру');
  }
  if (!required && !engine.publish && ahead) {
    reasons.push(`локальная ${game.version} > опубликованной ${game.published}`);
  }
  if (!required && !engine.publish && !ahead && ownChanges) {
    reasons.push('есть коммиты после тега версии');
  }
  if (!required && !engine.publish && !ahead && !ownChanges) {
    reasons.push('изменений нет');
  }

  return {
    ...game,
    publish: required || engine.publish || ahead || ownChanges,
    bump: !ahead,               // версия уже поднята руками — публикуем как есть
    required,
    reason: reasons.join('; '),
  };
});
```

3. В `release.js` не спрашивать версию, когда `game.bump === false`
   (симметрично крейту и движку), а `publishGame` — не переписывать
   `package.json`.

4. Тест `plan.test.js:118` переписать: «не трогает игру, у которой нет ни
   изменений, ни неопубликованной версии», и добавить два новых —
   `ahead`-случай и `ownChanges`-случай.

---

## A2. `git commit` падает на пути «версия уже поднята вручную»

**Где:** `scripts/release/steps.js:42-45`, вызовы на `steps.js:75` и `:137`.

**Суть.** `commit()` вызывается безусловно, а `decision.bump === false`
означает, что ни `Cargo.toml`/`package.json`, ни CHANGELOG не правились.
`preflight` требует чистое дерево, `cargo build` при неизменной версии
ничего не меняет — значит индексировать нечего, и `git commit` завершается
с кодом 1.

Проверено:

```
$ git add -A; git commit -m "nothing"
нечего коммитить, нет изменений в рабочем каталоге
EXIT=1
```

`shell.write` вызывает `capture` без `allowFailure` → `CommandError` →
релиз обрывается. Ломается ровно тот сценарий, который документация
рекламирует как штатный: «повторный запуск после сбоя видит версию, которая
уже уехала» (`docs/en/publishing.md`, раздел про отсутствие файла
состояния) и ветка `decideArtifact` «версия уже поднята, но не
опубликована» (`plan.js:75-87`).

**Решение.** Коммитить только при наличии staged-изменений и сузить область
индексации — `git add -A` в корне затягивает всё подряд, включая побочные
файлы, созданные проверками:

```js
// steps.js
async function commit(shell, cwd, message, paths) {
  await shell.write('git', ['add', '--', ...paths], { cwd });

  // git diff --cached --quiet: 0 — нечего коммитить, 1 — есть staged-изменения
  const staged = await shell.read('git', ['diff', '--cached', '--quiet'], {
    cwd,
    allowFailure: true,
  });

  if (staged.code === 0) {
    ui.log('  · нечего коммитить, шаг пропущен');
    return false;
  }

  await shell.write('git', ['commit', '-m', message], { cwd });
  return true;
}
```

Вызовы с явными путями:

- крейт — `packages/engine/core/Cargo.toml`,
  `packages/engine/core/CHANGELOG.md`, `Cargo.lock`;
- движок — `packages/engine/package.json`, `packages/engine/CHANGELOG.md`,
  `package-lock.json`;
- игра — `package.json`, `core/Cargo.toml`, `Cargo.lock`;
- прод — `package.json`, `package-lock.json`.

В `--dry-run` поведение остаётся согласованным: `shell.write('git add')`
гасится, `--cached --quiet` вернёт 0, коммит пропустится.

---

## A3. Слияние stdout и stderr ломает разбор JSON

**Где:** `scripts/release/shell.js:47-54` (`output` = stdout + stderr),
потребители — `registry.js:23` (`JSON.parse(output)`) и `steps.js:172`
(`output.slice(output.indexOf('['))`).

**Суть.** `capture()` склеивает оба потока в одну строку. Любое
предупреждение npm попадает в тот же буфер и делает `JSON.parse`
невозможным. Порядок склейки к тому же недетерминирован — чанки приходят из
двух труб.

Проверено (одна опечатка в env-конфиге npm — и всё):

```
$ npm_config_some_typo=1 npm view vimp-engine version --json
stdout: "0.6.0"
stderr: npm warn Unknown env config "some-typo". …
merged: JSON.parse FAILED -> Unexpected token 'p', "npm warn Un"... is not valid JSON
```

**Чем это опасно именно здесь.** `npmVersion()` глотает исключение и
возвращает `null` (`registry.js:26-28`). `null` в `decideArtifact`
интерпретируется как «ещё не публиковался» → `ahead = true` →
`publish: true, bump: false`. То есть шум в stderr превращается в решение
«публикуем текущую версию поверх уже опубликованной»: сначала сработает
ошибка A2, а если её починить — `npm publish` упадёт с 403 уже после
коммита и тега. Отказ реестра по сети даёт ровно тот же тихий неверный
ответ.

`checkTarball` хрупок так же: `output.indexOf('[')` найдёт первую скобку в
любом предупреждении (`npm warn deprecated foo@1: use [bar]`).

**Решение — три части.**

1. Разделить потоки в `capture`, сохранив склейку только для отчёта об
   ошибке:

```js
let stdout = '';
let stderr = '';

child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });

// в close:
resolve({ code, stdout, stderr, output: stdout + stderr });
```

`CommandError` продолжает получать `output` — формат вывода при падении не
меняется.

2. Парсить только `stdout` и **отличать «не опубликован» от «реестр не
   ответил»**. С `--json` npm кладёт структурированную ошибку в stdout —
   проверено:

```
$ npm view @vimp-games/definitely-not-published-xyz version --json
rc=1
stdout: { "error": { "code": "E404", "summary": "Not Found …" } }
```

```js
// registry.js
export async function npmVersion(name) {
  const { code, stdout, stderr } = await capture(
    'npm', ['view', name, 'version', '--json'], { allowFailure: true },
  );

  let parsed = null;

  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = null;
  }

  if (code !== 0) {
    if (parsed?.error?.code === 'E404') {
      return null;                       // пакета нет — это валидный ответ
    }

    throw new Error(
      `npm view ${name} не ответил (код ${code}): ${stderr.trim() || stdout.trim()}`,
    );
  }

  const version = Array.isArray(parsed) ? parsed.at(-1) : parsed;

  return isVersion(version) ? version : null;
}
```

3. То же различение в `crateVersion`: сейчас любой сетевой сбой и любой не-OK
   ответ дают `null` (`registry.js:56-63`). 404 → `null`, всё остальное →
   исключение:

```js
if (response.status === 404) {
  return null;
}

if (!response.ok) {
  throw new Error(`index.crates.io ответил ${response.status} на ${name}`);
}
```

И в `checkTarball` — `JSON.parse(stdout)` целиком, без `indexOf('[')`.

---

## A4. Шаг движка гоняет `sim` по играм, которых нет в его `node_modules`

**Где:** `scripts/release/steps.js:110-119`.

```js
for (const game of games) {
  const installed = path.join('node_modules', game.name);
  await shell.check(`npm run sim -- --game ${installed}`, …);
}
```

`games` — это все подтверждённые игры, а не только установленные в `vimp`.
Проверено: в `node_modules/@vimp-games/` лежит один `tanks`;
`@vimp-games/street-fighters` — валидный локальный чекаут, но зависимостью
`vimp` не является. Стоит его подтвердить — и шаг A2 упадёт на
несуществующем пути уже после того, как отработали eslint, тесты, `core:test`
и `sim:check` (минуты впустую), но, к счастью, до `npm publish`.

**Решение.** Прогонять `sim` только по фактически установленным копиям, а
про остальные честно сообщать — их всё равно проверит шаг C после перепина:

```js
for (const game of games) {
  const installed = path.join(root, 'node_modules', game.name);

  if (!(await isDirectory(installed))) {
    ui.log(`  · sim пропущен: ${game.name} не установлен в vimp (проверим на шаге прода)`);
    continue;
  }

  await shell.check(
    `npm run sim -- --game node_modules/${game.name}`,
    'npm',
    ['run', 'sim', '--', '--game', path.join('node_modules', game.name), '--no-write'],
    { cwd: root },
  );
}
```

`isDirectory` уже есть в `games.js:20` — вынести в общий модуль, а не
дублировать (см. C4).

---

## B1. `--yes` публикует все найденные игры без единого подтверждения

**Где:** `scripts/release.js:169-174`, `:181`, `:362`.

`USAGE` обещает: «`--yes` — принять предложенные версии (пуш в main всё
равно спрашивается отдельно)». Фактически с `--yes`:

- `take = git.problems.length === 0` — каждая найденная валидная игра с
  чистым деревом включается в релиз молча;
- подтверждение плана целиком пропускается (`:362`).

То есть `npm run release -- --yes` на машине с двумя-тремя чекаутами
опубликует в npm всё, что нашлось, включая игру, которую разработчик и не
думал релизить. Это прямо противоречит заявленному в документации принципу
«каждая подтверждается отдельно» и обесценивает всю валидацию.

**Решение.** Развести два разных смысла:

- `--yes` — только про версии и про финальное «выполняем план?»;
- выбор игр в неинтерактивном режиме — через явный повторяемый флаг
  `--game=<путь>` (`parseArgs` поддерживает `multiple: true`).

```js
// parseFlags
game: { type: 'string', multiple: true, default: [] },

// selectGames
if (yes && explicitGames.length === 0) {
  ui.log('--yes без --game: игры в релиз не включаются');
  return [];
}
```

При интерактивном запуске поведение не меняется.

---

## B2. `[patch.crates-io]` не проверяется в репозиториях игр

**Где:** `scripts/release.js:116-126` — проверяются только корневой
`Cargo.toml` и `packages/engine/core/Cargo.toml`.

`docs/en/publishing.md`, Step 0: «neither `Cargo.toml` may carry a
`[patch.crates-io]` pointing at a local path». Скрипт собирает WASM-ядро
игры (`npm run core:build`) и публикует результат — локальный патч в игре
означает опубликованное ядро, собранное против крейта, которого нет ни у
кого. Это первый пункт раздела «Pitfalls» той же страницы, и именно его
скрипт обязан закрывать.

**Решение.** Вынести проверку в функцию и вызывать для всех участвующих
репозиториев после выбора игр:

```js
async function findCratePatches(dir, files) {
  const problems = [];

  for (const file of files) {
    try {
      const text = await readFile(path.join(dir, file), 'utf8');

      if (text.includes('[patch.crates-io]')) {
        problems.push(`${path.join(dir, file)} содержит [patch.crates-io]`);
      }
    } catch {
      // отсутствующий файл — не проблема этой проверки
    }
  }

  return problems;
}
```

Для `vimp` — `['Cargo.toml', 'packages/engine/core/Cargo.toml']`, для каждой
игры — `['Cargo.toml', 'core/Cargo.toml']`. Порядок в `main()` придётся
поменять: сейчас `preflight` вызывается после `selectGames` (`:274`), так
что игры уже известны — достаточно передать их внутрь.

---

## B3. Выбранная версия не проверяется на возрастание

**Где:** `scripts/release.js:198-221`.

`askVersion` принимает любую синтаксически валидную версию. Опечатка
(`0.6.0` вместо `0.7.0`, или `0.06.0`) проходит, и релиз доходит до
`npm publish`/`cargo publish`, где падает с 403 — но уже **после** правки
`package.json`, датирования CHANGELOG, коммита и тега. Откат — руками.

**Решение.** Валидировать сразу, в том же цикле, что и ввод:

```js
const target = ['patch', 'minor', 'major'].includes(answer)
  ? increment(current, answer)
  : answer;

if (!isVersion(target)) {
  throw new UsageError(`не версия и не уровень инкремента: ${answer}`);
}

if (compareVersions(target, current) <= 0) {
  throw new UsageError(`${target} не больше текущей ${current}`);
}

if (published && compareVersions(target, published) <= 0) {
  throw new UsageError(`${target} не больше опубликованной ${published}`);
}
```

`published` нужно прокинуть в `askVersion` — он уже есть в
`decision.*.published`/`game.published`.

---

## B4. После релиза в CHANGELOG не остаётся секции `## [Unreleased]`

**Где:** `scripts/release/changelog.js:87`.

```js
lines[headingIndex] = `## [${version}] ${EM_DASH} ${date}`;
```

Заголовок `## [Unreleased]` заменяется на версию — и больше не
восстанавливается. Это ломает конвенцию, зафиксированную в `CLAUDE.md`
(«Unreleased work under `## [Unreleased]`, dated at release») и в шапке
обоих журналов, а заодно выключает третий сигнал детекта: следующий запуск
получит `parseUnreleased → { present: false, isEmpty: true }` и будет
опираться только на дифф путей.

**Решение.**

```js
lines.splice(
  headingIndex,
  1,
  '## [Unreleased]',
  '',
  `## [${version}] ${EM_DASH} ${date}`,
);
```

И тест: после `releaseUnreleased` повторный `parseUnreleased` должен дать
`{ present: true, isEmpty: true }`.

---

## B5. При `bump: false` CHANGELOG не датируется

**Где:** `scripts/release/steps.js:61-72` и `:121-135` — датирование внутри
`if (decision.bump)`.

Если версия поднята вручную, а `[Unreleased]` заполнена (обычная ситуация:
руками правят версию, забывают журнал), релиз уедет, а секция останется
недатированной. Следующий релиз склеит записи двух версий в одну, а ссылка
`[X.Y.Z]: …/releases/tag/…` для уехавшей версии не появится вовсе — и
ссылки в журнале начнут вести в 404 (об этом прямо предупреждает
`docs/en/publishing.md`).

**Решение.** Разделить два условия: правку файла версии делать по
`decision.bump`, датирование — по «секция непуста»:

```js
if (decision.bump) {
  await edit(cargoPath, …);
}

const changelogPath = path.join(root, 'packages/engine/core/CHANGELOG.md');

if (!parseUnreleased(await readFile(changelogPath, 'utf8')).isEmpty) {
  await dateChangelog(changelogPath, { version: target, artifact: CRATE_NAME, dryRun: shell.dryRun });
}
```

---

## B6. `parseUnreleased` завершает секцию только на заголовке версии

**Где:** `scripts/release/changelog.js:9`, `:24-29`.

```js
const RELEASE_HEADING = /^##\s+\[\d+\.\d+\.\d+\]/;
```

Конец секции ищется только по заголовку релиза. В журнале, где `[Unreleased]`
пока единственная секция (новый пакет, новая игра), `end = lines.length` —
в тело попадёт блок ссылок и любой хвост файла, и пустая секция определится
как непустая. Тот же эффект даст любой промежуточный `## Заголовок`.

**Решение.**

```js
const NEXT_HEADING = /^##\s+/;
const LINK_REF = /^\[[^\]]+\]:\s/;
…
if (NEXT_HEADING.test(lines[index]) || LINK_REF.test(lines[index])) {
  end = index;
  break;
}
```

---

## B7. `git push` в репозитории игры может упасть уже после публикации

**Где:** `scripts/release/steps.js:282`, `games.js:191-195`.

`checkGitState` проверяет, что `git remote` не пуст, но не то, что у текущей
ветки есть upstream. `git push` без upstream завершается ошибкой — а к этому
моменту `npm publish` уже прошёл, то есть необратимый шаг сделан, а коммит и
тег остались только локально.

**Решение.** Добавить в `checkGitState` проверку upstream и заодно ветки:

```js
const upstream = await capture(
  'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
  { cwd: dir, allowFailure: true },
);

if (upstream.code !== 0) {
  problems.push('у текущей ветки нет upstream (git push не сработает)');
}
```

Того же класса проблема — существующий тег: `git tag v0.5.0` упадёт, если
тег уже есть (например, после прерванного прогона). Стоит проверять до
публикации: `git rev-parse --verify --quiet v<version>` и, если тег есть,
спрашивать явно.

---

## B8. Результат ожидания реестра игнорируется

**Где:** `scripts/release/registry.js:86-103`, вызовы `steps.js:89`, `:151`,
`:286`.

`waitFor` по таймауту (3 минуты) печатает `! … не появился в реестре` и
возвращает `false`. Возвращаемое значение нигде не проверяется — релиз
продолжается, и следующий шаг падает уже непонятно: `cargo update -p
vimp-engine-core --precise X.Y.Z` не найдёт версию, `npm i -D
vimp-engine@^X.Y.Z` поставит старую.

**Решение.** Считать таймаут развилкой, а не примечанием:

```js
if (!(await waitForCrate(CRATE_NAME, target, ui.log))) {
  report.remaining.push(`${CRATE_NAME}@${target} не виден в crates.io`);

  if (!(await ui.confirm('Крейт ещё не виден в индексе. Продолжать?', false))) {
    throw new Error('прервано: крейт не появился в crates.io');
  }
}
```

---

## C1. `report.tags` смешивает два формата, фильтр по `': '` — магия

**Где:** `steps.js:290` (`report.tags.push(`${game.name}: v${game.target}`)`)
и `release.js:442` (`report.tags.filter(name => !name.includes(': '))`).

Теги игр помечаются двоеточием, чтобы шаг прода их не пушил из `vimp`.
Работает, пока в имени пакета нет `': '`, но читателю это неочевидно, а
итоговый отчёт печатает `@vimp-games/tanks: v0.5.0` в списке тегов.

**Решение.** Структура вместо строки:

```js
report.tags.push({ repo: dir, name: `v${game.target}` });
…
tags: report.tags.filter(entry => entry.repo === root).map(entry => entry.name),
```

В отчёте — `${path.basename(entry.repo)}/${entry.name}`.

## C2. Мёртвый код в `createShell`

`shell.read` — тонкая обёртка ровно над `capture` без единого отличия;
`performed` заполняется и никогда не читается; `interactive` возвращается из
фабрики, но `auth.js` импортирует его напрямую из модуля, так что поле
фабрики не используется. Либо задействовать (`performed` пригодился бы в
финальном отчёте `--dry-run`), либо убрать.

## C3. `validateGame`: `core/Cargo.toml` то ли обязателен, то ли нет

`games.js:150-160` кладёт «нет core/Cargo.toml» в `problems` (→ `valid:
false`), но рядом возвращает `hasCargo`, а `steps.js:227` строит на нём
ветку `if (crateVersion && game.hasCargo)`. Ветка недостижима: игра без
Cargo не пройдёт валидацию. Плюс `checkTarball` жёстко требует
`dist/core-node/*.wasm` — то есть игра без Rust-ядра нерелизуема в принципе.

Определиться: если WASM обязателен — убрать `hasCargo` и условие; если нет —
убрать `нет core/Cargo.toml` из `problems` и смягчить `checkTarball`.

Там же: валидация не проверяет скрипты, которые скрипт реально запустит —
`test` и `core:test`. Игра без `test` (npm ответит «Missing script: test»)
обрушит релиз после сборки. Либо добавить их в обязательные, либо
пропускать по наличию, как уже сделано для `sim`/`sim:scenarios`
(`steps.js:258-262`).

## C4. Дублирование

- `isDirectory` (`games.js:20`) понадобится и в `steps.js` (см. A4) —
  просится в общий модуль.
- Вызов `npm run sim -- --game … --no-write` собирается дважды почти
  идентично: `steps.js:110-119` и `:306-315`. Одна функция `simGame(shell,
  root, game)`.
- Регулярка правки версии повторена для `package.json` в двух местах
  (`steps.js:126`, `:269`) и для `Cargo.toml` в двух (`:64`, `:232`) —
  четыре почти одинаковых `edit(...)`. Просятся `bumpJsonVersion(file,
  version)` и `bumpTomlVersion(file, version)`.

## C5. Мелкие замечания

- `changelog.js:51` — `/^(⚠️\s*)?Breaking/i.test(section.replace(/^⚠️?\s*/, ''))`
  чистит эмодзи дважды, в `replace` и в самой регулярке. Достаточно
  одного: `/^Breaking/i.test(section.replace(/^[⚠️\s]+/u, ''))`.
- `steps.js:206-212` — `manifest.entries?.wasmNode ?? ''` может оказаться не
  строкой (тогда `.replace` бросит `TypeError`), а шаблон
  `^\.?\/?(core-node|dist)\/` пропустит `.core-node/…`. Проще:
  `typeof wasmNode === 'string' && wasmNode.replace(/^\.\//, '').startsWith('core-node/')`.
- `plan.js:217` — `enginePkg.files.map(...)` бросит `TypeError`, если поле
  `files` пропало; для скрипта, чья корректность на нём держится, стоит дать
  внятную ошибку.
- `semver.js:4` — `PATTERN` допускает пререлизы (`1.2.3-rc.1`), а
  `compareVersions` их не различает: `1.2.3-rc.1` и `1.2.3` равны. Либо
  запретить пререлизы в `isVersion`, либо сравнивать честно.
- `shell.js:33` — `formatCommand` склеивает аргументы через пробел без
  экранирования, поэтому в отчёте `git commit -m chore: bump …` выглядит как
  несколько аргументов. Косметика, но это же строка в `CommandError`.
- `shell.js:109-121` — `log` вызывается **после** завершения команды, так
  что во время долгого `npm publish` консоль молчит. Строку статуса лучше
  печатать до запуска, а результат дописывать.
- `ui.js:44-54` — `confirm` принимает только `д/да/y/yes`; ввод `Y `/`ДА`
  обрабатывается (`trim` + `toLowerCase`), а вот `н`/`no` не отличается от
  мусора — любой неизвестный ввод молча значит «нет». Для вопроса про пуш в
  прод это безопасная сторона, но стоит переспрашивать, а не угадывать.

---

## Тесты

31 тест, чистая логика покрыта разумно. Пробелы:

1. **`plan.test.js:118` закрепляет ошибку A1** — переписать (см. A1.4).
2. **`steps.js` — 359 строк, самый рискованный модуль — не покрыт вовсе.**
   `checkTarball` и `checkManifest` экспортированы и тестируемы (нужен лишь
   fake `shell` с готовым `stdout` и временный каталог) — стоит покрыть
   хотя бы их: срез JSON, отсутствующий `dist/manifest.json`, несовпадение
   `engineApi`, `wasmNode` вне `dist/`.
3. **`registry.crateIndexPath`** — чистая функция с четырьмя ветками
   (1/2/3/остальные символа), не покрыта ни одним тестом. Дешёвый тест:
   `a`, `ab`, `abc`, `vimp-engine-core → vi/mp/vimp-engine-core`.
4. **`npmVersion`/`crateVersion`** — после правки A3 их разбор становится
   критичным; на fake `capture` легко проверить E404 → `null`, мусор в
   stderr → успех, сетевую ошибку → исключение.
5. `shell.test.js` стоит дополнить кейсом «stdout и stderr не смешиваются».

---

## Документация

Раздел «The short way» точен и хорошо написан, но два утверждения после
правок A1–A3 нужно синхронизировать:

- «a re-run after a failure sees the version that already made it out and
  does not publish it twice» — сейчас этот путь падает (A2). После правки
  утверждение станет верным.
- Таблица «What actually needs publishing» ниже по странице содержит строку
  «Game only … ✅», которой поведение скрипта противоречит (A1). После
  правки противоречие снимается — менять таблицу не нужно.
- Стоит добавить строку про `--game=<путь>` в таблицу флагов (B1) и
  уточнить формулировку `--yes`.

Правки нужны в обоих языках: `docs/en/publishing.md` и
`docs/ru/publishing.md`.

---

## Порядок работ

1. A3 (потоки и разбор JSON) — база, от неё зависит корректность детекта.
2. A2 (пустой коммит) — разблокирует путь «версия поднята вручную».
3. A1 (релиз игры) + переписать `plan.test.js:118`.
4. A4, B2, B7 — надёжность шагов игры и движка.
5. B1, B3 — безопасность неинтерактивного режима и ввода версии.
6. B4, B5, B6 — журналы.
7. B8, C1–C5 — поддерживаемость.
8. Тесты по списку и синхронизация документации в двух языках.

## Release impact

Все правки — в корневом `scripts/`, тестах и документации. Ничего из
`files` пакета `vimp-engine` и ничего из крейта не затрагивается:
публикация, бампы версий и пересборка плагина не требуются.
