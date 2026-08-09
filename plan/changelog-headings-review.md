# Кодревью: коммит `84bad15` «release flow»

Предмет: контракт под-заголовков `## [Unreleased]` как источник уровня
релиза (`scripts/release/changelog.js`, `scripts/release/plan.js`,
`scripts/release.js`, тесты, `docs/{en,ru}/publishing.md`, `CLAUDE.md`).
План — `~/.claude/plans/docs-en-publishing-md-rustling-boole.md`.

## Вердикт

Задача решена, поведение соответствует плану и документации. Проверено
фактически:

- `npx eslint .` — чисто; `npm test` — 111 файлов / 1109 тестов зелёные;
- негативный прогон плана (п. 3): `### Improved` в журнале движка →
  `preflight не пройден: packages/engine/CHANGELOG.md: заголовок «### Improved»
  не из списка (…)`, ни одной изменяющей команды;
- негативный прогон плана (п. 4): `### ⚠️ Breaking` без `Migration` →
  `есть ### ⚠️ Breaking, но нет ### Migration`;
- инварианты, вынесенные из `CLAUDE.md`, действительно есть в документации:
  Dockerfile/`GameCatalog`/`engineApi` — `docs/en/deployment.md:15–27`,
  Worker-safe `meta/` — `docs/en/host.md:356` (подлежащее именно
  `## Meta modules`), Node-only devtools — новый абзац в
  `docs/{en,ru}/debugging.md`;
- `docs/en` ↔ `docs/ru`: набор `##`-заголовков совпадает построчно, таблица
  контракта в обеих версиях из восьми строк, якорь
  `#заголовки-changelog-задают-версию` корректен.

Сильные стороны: проверка fail-closed и стоит **до** необратимых действий;
`Map` вместо объекта (нет обращения к прототипу по данным из файла);
проблемы скоупятся по `publish`, так что опечатка в чужом журнале не
блокирует релиз; тест-страж на живых журналах превращает правило из
документации в проверяемое в CI.

Ниже — замечания. Ни одно не ломает текущий прогон релиза; B1 и B2 —
дыры в самом контракте, который коммит вводит.

---

## B1 ✅ выполнен (существенное). `parseUnreleased` не знает про блоки кода — контракт обходится молча

**Суть.** Разбор построчный: `NEXT_HEADING`, `ANY_LINK_REF` и `SUB_HEADING`
срабатывают и внутри ` ``` `. Секция `### Migration` по своей природе
содержит примеры, в том числе примеры журнала.

**Воспроизведение** (проверено на текущем коде):

| Что в `[Unreleased]` | Что видит скрипт |
| --- | --- |
| `### Fixed`, внутри блока кода строка `[0.5.0]: https://…`, затем `### ⚠️ Breaking` + `### Migration` | `sections: ["Fixed"]`, проблем нет, уровень **patch** — ломающий релиз уезжает как патч |
| `### Fixed`, внутри блока кода пример `### Added` | `sections: ["Fixed","Added"]`, уровень **minor** вместо patch |
| `### ⚠️ Breaking`, внутри блока кода строка `## [0.5.0] — 2026-08-01`, затем `### Migration` | секция обрывается, ложное `есть ### ⚠️ Breaking, но нет ### Migration` — релиз заблокирован без причины |

Первый случай — ровно то, что коммит призван исключить: занижение версии без
единого сообщения. Сейчас в обоих журналах блоков кода нет (`grep -c '```'`
→ 0), то есть это не сегодняшний баг, а ловушка на первый же `Migration` с
примером.

**Решение.** Вести состояние ограды в цикле разбора и заодно собирать
под-заголовки в том же проходе (сейчас проход по строкам делается дважды):

```js
// Строка-ограда блока кода: ``` или ~~~ (CommonMark допускает до трёх
// пробелов отступа и любую длину от трёх символов).
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const RELEASE_HEADING = /^##\s+\[/;

export function parseUnreleased(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => UNRELEASED_HEADING.test(line));

  if (start === -1) {
    return { present: false, sections: [], body: '', isEmpty: true };
  }

  const sections = [];
  let end = lines.length;
  let fence = null;
  let terminator = null;

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const fenced = FENCE.exec(line)?.[1];

    // внутри блока кода строки не разбираются: пример журнала в Migration
    // иначе читается как настоящие заголовки и меняет уровень релиза
    if (fence) {
      if (fenced && fenced[0] === fence[0] && fenced.length >= fence.length) {
        fence = null;
      }
      continue;
    }

    if (fenced) {
      fence = fenced;
      continue;
    }

    if (NEXT_HEADING.test(line) || ANY_LINK_REF.test(line)) {
      end = index;
      terminator = NEXT_HEADING.test(line) ? line.trim() : null;
      break;
    }

    const match = SUB_HEADING.exec(line);

    if (match) {
      sections.push(match[1].trim());
    }
  }

  const body = lines.slice(start + 1, end).join('\n').trim();

  return {
    present: true,
    sections,
    body,
    isEmpty: body === '',
    terminator,
    openFence: fence !== null,
  };
}
```

`openFence` (незакрытая ограда — опечатка автора: секция дочитывается до
конца файла) и `terminator` нужны для B2.

**Тесты.** Три случая из таблицы выше в `changelog.test.js`, плюс `~~~` как
ограда и ограда с инфо-строкой (` ```md `).

Код выше прогнан на всех перечисленных случаях: три ловушки закрываются
(`A` → `["Fixed","⚠️ Breaking …","Migration"]`, `B` → `["Fixed"]`, `C` → пара
на месте), а на живых `packages/engine/CHANGELOG.md` и
`core/CHANGELOG.md` разбор совпадает с текущим — регрессии нет.

---

## B2 ✅ выполнен (существенное). Записи без под-заголовка проходят как patch

**Суть.** `validateSections` проверяет только те заголовки, которые нашёл
парсер. Три способа не дать ему найти ничего — и все три молчат:

| Как написано | Что получается |
| --- | --- |
| `## Added` вместо `### Added` | секция обрывается на этой строке: `isEmpty: true`, `sections: []`. При `changed` → publish на **patch**; журнал не датируется (`steps.js:52`), записи остаются под `[Unreleased]` навсегда |
| записи списком без заголовка вовсе | `body` непустой, `sections: []` → **patch**, проблем нет |
| секции `## [Unreleased]` нет вовсе (переименовали/удалили) | `present: false` → тот же **patch** и то же молчание |

**Оговорка, чтобы не перетянуть проверку:** пустая `[Unreleased]` при
`changed: true` — законный случай (правка только фикстур или `bin/`, а тесты
записями не являются по `CLAUDE.md`). Ошибкой это считать нельзя.

**Решение.** Отдельный экспорт поверх `validateSections`, работающий с
разобранной секцией целиком; `plan.js` зовёт его вместо `validateSections`:

```js
export function validateUnreleased(unreleased) {
  if (!unreleased?.present) {
    return ['нет секции ## [Unreleased] — уровень релиза выводить не из чего'];
  }

  const problems = validateSections(unreleased.sections);

  if (unreleased.openFence) {
    problems.push('в [Unreleased] не закрыт блок кода — секция дочитана до конца файла');
  }

  // `## Added` вместо `### Added`: секция обрывается на нём, и записи молча
  // выпадают из разбора вместе с уровнем
  if (unreleased.terminator && !RELEASE_HEADING.test(unreleased.terminator)) {
    problems.push(
      `секция [Unreleased] оборвана заголовком «${unreleased.terminator}» — вероятно, ### написан как ##`,
    );
  }

  // текст есть, заголовка нет — уровень уехал бы в patch
  if (!unreleased.isEmpty && unreleased.sections.length === 0) {
    problems.push('в [Unreleased] есть записи, но нет ни одного ### под-заголовка');
  }

  return problems;
}
```

`plan.js:96`:

```js
const problems = validateUnreleased(artifact.unreleased);
```

**Тесты.** По случаю на каждую строку таблицы + «пустая `[Unreleased]` при
`changed: true` проблемой не считается».

---

## B3 ✅ выполнен (важное, отступление от плана). `SECTION_LEVELS`: значения не читаются

План (строки 114 и 127) требовал: «`SECTION_LEVELS` — `Map` из восьми имён
в уровень» и «`suggestLevel` переписывается поверх `sectionName`/**`SECTION_LEVELS`**».
Фактически `suggestLevel` использует только `sectionName`, а из карты берутся
`.has()` и `.keys()` — значения (`'breaking'`, `'minor'`, `'patch'`, `null`)
не читает никто (проверено `grep`: карта нигде не импортируется).

**Чем плохо.** Два источника правды в одном файле: карта заявляет уровни,
решает — цепочка `if`. Правка `['Changed', 'minor']` не изменит ничего, и
это не заметит ни тест, ни ревьюер. Добавление нового заголовка требует
правки в двух местах вместо одного.

**Решение** — сделать карту рабочей:

```js
const LEVEL_ORDER = ['patch', 'minor', 'breaking'];
const LEVEL_REASON = new Map([
  ['breaking', '### ⚠️ Breaking'],
  ['minor', '### Added'],
  ['patch', 'без ### Added и ### ⚠️ Breaking'],
]);

// Предложение инкремента: решает старший уровень среди заголовков секции.
// Неизвестные имена сюда не доходят — их снимает validateSections.
export function suggestLevel(sections, version) {
  let top = 'patch';

  for (const section of sections) {
    const level = SECTION_LEVELS.get(sectionName(section));

    if (level && LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(top)) {
      top = level;
    }
  }

  return {
    level: top === 'breaking' ? levelForBreaking(version) : top,
    reason: LEVEL_REASON.get(top),
  };
}
```

Тогда «добавить `### Performance` → minor» — одна строка в карте. Тест:
временная карта уровней не нужна, достаточно кейса «порядок заголовков не
влияет: `['Fixed','Added']` и `['Added','Fixed']` → minor».

Альтернатива, если превращать карту в движок не хочется, — честно свести её
к `Set` имён и убрать из комментария обещание уровней.

---

## B4 ✅ выполнен (важное). Проводка «проблема → preflight» не покрыта тестом, пути продублированы

`changelogProblems` (`release.js:170`) не экспортируется, а `preflight` и
`main` не экспортируются тоже, — то есть звено «`problems` артефакта →
строка preflight → `return 1`» проверяется только руками. Заодно имена
журналов записаны здесь строками, хотя `collect()` уже строит те же пути
(`plan.js:253–260`).

**Решение** — перенести сборку в чистый `decide()`, который уже покрыт
`plan.test.js`:

```js
// plan.js, collect()
crate: { …, changelogFile: 'packages/engine/core/CHANGELOG.md' },
engine: { …, changelogFile: 'packages/engine/CHANGELOG.md' },

// plan.js, decideArtifact()
const problems = validateUnreleased(artifact.unreleased).map(problem =>
  artifact.changelogFile ? `${artifact.changelogFile}: ${problem}` : problem,
);

// plan.js, decide()
return {
  crate,
  engine,
  games,
  // журнал непубликуемого артефакта релиз не блокирует
  problems: [crate, engine].filter(a => a.publish).flatMap(a => a.problems ?? []),
  prod: { … },
};
```

`release.js`: удалить `changelogProblems`, передать `changelog:
decision.problems`. Тест в `plan.test.js`: «problems непубликуемого
артефакта в общий список не попадают» — то, что сейчас не проверяет никто.

---

## B5 ✅ выполнен иначе (среднее). Порядок в `main()`: интерактив до самой дешёвой проверки

`selectGames` (опрос по каждой найденной игре) идёт до `decide` и
`preflight`, поэтому при опечатке в заголовке разработчик сперва отвечает на
все вопросы про игры и только потом читает про `### Improved`.
Решение крейта и движка от игр не зависит, так что проверку можно поднять
выше:

```js
const collected = await collect(root);

// журналы — самая дешёвая из проверок, а вопросов про игры бывает с десяток
const artifacts = decide({ ...collected, games: [] });

if (artifacts.problems.length) {
  ui.error('preflight не пройден:');
  artifacts.problems.forEach(problem => ui.raw(`  - ${problem}`));
  return 1;
}
```

`decide` — чистая и дешёвая, второй вызов с играми ничего не стоит.

---

## B6 ✅ выполнен (среднее). Тесты: фикстура противоречит новому контракту

`tests/scripts/release/plan.test.js:7`:

```js
const breaking = { isEmpty: false, sections: ['⚠️ Breaking — что-то'] };
```

Такой журнал новый preflight отвергает (проверено: `decide` возвращает
`problems: ['есть ### ⚠️ Breaking, но нет ### Migration']`). Тесты зелёные,
потому что смотрят только на `level`/`publish`, но фикстура описывает
состояние, из которого релиз невозможен, и учит читателя неверному образцу.
Починка — одна строка: `sections: ['⚠️ Breaking — что-то', 'Migration']`.

Там же по мелочи:

- `changelog.test.js` содержит два блока `describe('changelog')` (строки 59 и
  160): новые тесты вставлены в середину и разрезали исходный набор. Второй
  логично назвать `describe('releaseUnreleased')`;
- `changelog.test.js:161` — пустая строка сразу после открытия `describe`;
- нет кейса на `suggestLevel(['Migration'], …)` → patch (сейчас это следует
  из порядка `if`, а не из явного правила).

---

## B7 ✅ выполнен (мелкие)

1. **Сообщение об отбраковке не подсказывает исправление.** `### Added - x`
   (дефис вместо длинного тире) и `### added` дают одинаковое «не из списка»,
   хотя причина в разделителе и регистре. Предлагается дописать хвост:
   `«…; имя чувствительно к регистру, уточнение отделяется « — » или круглыми
   скобками»`.
2. **`String(heading)` в `sectionName`** (`changelog.js:76`) — защитное
   приведение типа, которое спрячет ошибку вызывающего: `sections` всегда
   строки из `parseUnreleased`. Можно убрать.
3. **Документация: «in brackets» / «в скобках»** — реализация снимает хвост
   только после `(`, квадратные скобки (`### Migration [game plugins]`) будут
   отвергнуты. Уточнить «в круглых скобках» в обеих версиях.
4. **Не задокументировано, что проверяются журналы только публикуемых
   артефактов** — в коде это осознанное решение с комментарием
   (`release.js:167`), в `publishing.md` фраза «What the script enforces, in
   preflight» читается как «оба журнала всегда». Одна строка в обе версии.
5. **Эмодзи необязателен**: `### Breaking` без `⚠️` принимается наравне с
   `### ⚠️ Breaking`. Поведение разумное (мягкость к вводу), но таблица в
   документации показывает только форму с эмодзи — стоит оговорить.

---

## B8 ⏭️ отклонено. `CLAUDE.md`: цель «≤1000 токенов» измерена заниженной эвристикой

Файл: 747 слов / 5232 символа. По метрике из плана (`wc -w` × 1.3) — 969,
цель формально достигнута. Но множитель 1.3 верен для сплошной английской
прозы; здесь плотные таблицы, пути (`packages/engine/src/config/`) и
`code`-вставки, которые токенизируются заметно хуже: по 4 символам на токен
выходит ≈1300. Стоит либо перемерить настоящим токенизатором, либо срезать
ещё ~20% (кандидаты — таблица «Change → Page» в пользу одной ссылки на
`docs/en/README.md` и список команд, дублирующий `getting-started.md`).

---

# Второй заход: коммит `eb1b27b` «release flow: review»

## Вердикт

B1–B4, B6, B7 закрыты, B5 сделан иначе и лучше, B8 сознательно отклонён.
Проверено фактически, а не по описанию:

- `npx eslint .` чисто, `npm test` — 111 файлов / **1123** теста;
- **мутационная проверка** — каждая новая проверка держится тестом, ни одна
  не «на честном слове»:

  | Мутация | Падает тестов |
  | --- | --- |
  | снят чек `terminator` (`## Added` вместо `### Added`) | 1 |
  | снят чек `openFence` | 1 |
  | снят чек «текст без `###`» | 1 |
  | `LEVEL_ORDER` перевёрнут | 6 |
  | снят префикс `changelogFile` в `plan.js` | 1 |
  | `problems` без фильтра по `publish` | 1 |

- сквозной прогон на полном наборе шагов (без `--only`): опечатка
  `## Added` останавливает релиз строкой
  `packages/engine/CHANGELOG.md: секция [Unreleased] оборвана заголовком
  «## Added» — вероятно, ### написан как ##` **вместе с** «рабочее дерево не
  чистое», и ни одного вопроса про игры до этого — то есть заявленный
  порядок `preflightRepo` → опрос → `preflightGames` работает и единый
  список отказа не разорван;
- живые журналы разбираются как прежде (тест-страж переведён на
  `validateUnreleased`, разбор `sections` не изменился).

По B5 возражение принято: разделение по реальной зависимости
(`preflightRepo` / `preflightGames`) точнее моего варианта с ранним выходом
только по журналам — оно не дробит список отказа там, где дробить не нужно.

Ниже — что осталось. Ничего блокирующего; C1 — последняя дыра того же
класса, остальное косметика.

---

## C1 ✅ выполнен (среднее). Дефект, ослепивший парсер, прячет сам себя

**Суть.** `decide()` кладёт в `problems` только артефакты с `publish: true`
(правильная политика: чужой журнал не должен мешать). Но два дефекта из B2 —
`## Added` вместо `### Added` и отсутствующая `[Unreleased]` — делают секцию
*пустой* с точки зрения парсера, а пустая секция при `changed: false` даёт
`publish: false`. То есть дефект гасит ровно тот флаг, по которому его
собирались показать.

**Воспроизведение** (текущий код, `decide` напрямую):

```
engine.publish : false | нет изменений с 0.6.0
engine.problems: [ 'packages/engine/CHANGELOG.md: секция [Unreleased] оборвана
                    заголовком «## Added» — вероятно, ### написан как ##' ]
plan.problems  : []            ← в preflight не попадает
```

Разработчик написал записи, скрипт молча отвечает «нет изменений с 0.6.0» и
не публикует ничего. Условие узкое (`changed: false` — код артефакта с
базовой точки не менялся), но это ровно тот класс «тихо недорелизили»,
против которого вводился контракт.

Для полноты — что **не** прячется: незнакомый заголовок и `Breaking` без
`Migration` оставляют тело секции непустым, `openFence` тем более, поэтому
там `publish: true` и проблема видна.

**Решение.** Проблемы непубликуемых артефактов не блокируют, но и не
исчезают — печатаются предупреждением. `plan.js`, рядом с `problems`:

```js
    // журнал непубликуемого артефакта релиз не блокирует, но и не
    // замалчивается: `## Added` вместо `### Added` сам делает секцию пустой,
    // а пустая секция и приводит к publish: false — дефект спрятал бы себя
    warnings: [crate, engine]
      .filter(artifact => !artifact.publish)
      .flatMap(artifact => artifact.problems ?? []),
```

`release.js`, сразу после `preflightRepo`, до опроса про игры:

```js
  artifacts.warnings.forEach(problem =>
    ui.error(`внимание: ${problem} (артефакт не публикуется — проверьте, не из-за этого ли)`),
  );
```

**Тест** (`plan.test.js`, рядом с «не тянет в общий список проблемы
непубликуемого артефакта»): тот же вход, но `expect(plan.warnings).toHaveLength(1)`.

---

## C2 ✅ выполнен (мелкое). `reason` врёт про новый заголовок — обещание «одна строка в карте» выполнено наполовину

`LEVEL_REASON` подписывает уровень фиксированной строкой, а не заголовком,
который его задал. Проверено: после `SECTION_LEVELS.set('Performance', 'minor')`

```
suggestLevel(['Performance'], '0.6.0') → { level: 'minor', reason: '### Added' }
```

Уровень уехал правильно, объяснение — нет. Строка `reason` видна
разработчику дважды: в таблице плана (`почему`) и в вопросе про версию
(`vimp-engine: 0.6.0 → 0.7.0 (### Added)`), то есть он пойдёт искать в
журнале секцию, которой там нет. Сегодня карта и `LEVEL_REASON` согласованы,
так что это не баг, а мина под тем самым сценарием, ради которого B3 делался.

**Решение** — запоминать победивший заголовок:

```js
export function suggestLevel(sections, version) {
  let top = 'patch';
  let winner = null;

  for (const section of sections) {
    const name = sectionName(section);
    const level = SECTION_LEVELS.get(name);

    if (level && LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(top)) {
      top = level;
      winner = name;
    }
  }

  return {
    level: top === 'breaking' ? levelForBreaking(version) : top,
    // ⚠️ не часть имени, но в журналах он есть — показываем каноничную форму
    reason: winner
      ? `### ${winner === 'Breaking' ? '⚠️ Breaking' : winner}`
      : 'без ### Added и ### ⚠️ Breaking',
  };
}
```

`LEVEL_REASON` после этого не нужна. Тест: `suggestLevel(['Fixed','Added']).reason`
= `'### Added'`, `suggestLevel(['⚠️ Breaking — x','Migration']).reason` =
`'### ⚠️ Breaking'`.

Код прогнан: сегодняшние выводы не меняются (`Changed` → patch с прежней
формулировкой, `Added` → `### Added`, `Breaking` → `### ⚠️ Breaking`, в
`1.2.0` — major), а `Performance` из карты теперь подписывается собой.

---

## C3 ✅ выполнен (мелкое). `parseUnreleased` возвращает две разные формы

Ранний выход (`present: false`, `changelog.js:27`) не кладёт `terminator` и
`openFence`, хотя комментарий над функцией объявляет их частью контракта.
Сейчас безвредно — `validateUnreleased` на `!present` выходит первой строкой,
— но любой следующий потребитель наступит на `undefined` там, где ожидал
`null`/`false`. Одна строка:

```js
    return {
      present: false,
      sections: [],
      body: '',
      isEmpty: true,
      terminator: null,
      openFence: false,
    };
```

---

## C4 ✅ выполнен (мелкое). Подсказка про регистр повторяется в каждой строке отказа

Хвост «имя чувствительно к регистру, уточнение отделяется « — » или круглыми
скобками» приклеен к каждому отбракованному заголовку. На одном заголовке
это помощь, на трёх — три одинаковых абзаца в списке отказа, в котором
рядом стоят короткие строки вроде «рабочее дерево не чистое».

Вариант: короткая проблема на каждый заголовок, подсказка — один раз в конце
списка `validateSections`:

```js
  let unknown = 0;

  for (const section of sections) {
    const name = sectionName(section);

    if (name === null || !SECTION_LEVELS.has(name)) {
      problems.push(`заголовок «### ${section}» не из списка`);
      unknown += 1;
      continue;
    }

    names.push(name);
  }

  if (unknown > 0) {
    problems.push(
      `допустимые заголовки: ${[...SECTION_LEVELS.keys()].join(', ')}; ` +
        'имя чувствительно к регистру, уточнение отделяется « — » или круглыми скобками',
    );
  }
```

Тесты на подсказку (`### added`, `### Added - x`) при этом переезжают на
проверку последней строки списка.

---

## C5 ✅ выполнен (стиль). Два вызова `reportProblems` оформлены по-разному

`release.js`: первый — вложенный вызов с комментарием внутри списка
аргументов, второй — через временную переменную. Одинаковые по смыслу места
читаются по-разному; вложенность прячет `await preflightRepo(...)` внутрь
условия:

```js
  const repoProblems = await preflightRepo(root, { changelog: artifacts.problems });

  if (reportProblems(repoProblems)) {
    return 1;
  }
```

Там же: параметр `{ changelog = [] }` в `preflightRepo` — значение по
умолчанию осталось от прежней сигнатуры, единственный вызывающий передаёт
список всегда.

---

## Порядок исправления

1. C1 — последняя дыра контракта, ~10 строк с тестом.
2. C2 — пока карта и `LEVEL_REASON` согласованы, но чинить дешевле сейчас.
3. C3, C4, C5 — косметика, одним заходом.

## Release impact

Затронуты `scripts/`, `docs/`, `CLAUDE.md`, `tests/` — ни одного пути из
`files` пакета `vimp-engine` (`src/lib`, `src/config`, `src/host`,
`src/devtools`, `tests/fixtures`, `bin`) и ничего из крейта. Ни публикация,
ни бампы, ни пересборка плагина не требуются; записей в журналы этот
инструментарий не порождает. То же верно и для правок по этому ревью.
