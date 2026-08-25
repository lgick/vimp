# Кодревью: `aa3b049` (lobby/auth form ux. review), `2fa5317` (C4), `1b5bb44` (C6) + `vimp-tanks 7af57b2`

Прогон на срезе: `npx eslint .` — чисто, `npm test` — 139 файлов / 1457 тестов
зелёные, `vimp-contract` на tanks — `exit 0` (C4 → warn), `--strict` → `exit 1`,
на snakes — C6 `pass` («6 columns, laid out by the plugin's own styles»).
Заявленное поведение воспроизводится.

Ниже — то, что при этом осталось. Каждый пункт проверен прогоном, а не
рассуждением; текст проб — в теле пункта.

---

## Б1. Битый `regExp` в манифесте намертво запирает форму ✅ выполнен

**Где:** `packages/engine/src/client/lib/formBuilder.js:342` (`validateField`).

**Что не так.** `regExp` приезжает из манифеста игры **строкой** (JSON), и
теперь она компилируется на каждой валидации:

```js
if (isText && descriptor.regExp && !new RegExp(`^(?:${descriptor.regExp})$`).test(raw)) {
```

`new RegExp` на невалидном паттерне бросает `SyntaxError`. Перехвата нет ни в
`validateField`, ни в `collectFormErrors`, ни на обоих вызывающих сторонах
(`main.js:2064` — внутри `async` обработчика клика, `view/Auth.js:46` — внутри
`onclick`). Итог:

- лобби: клик по **Create server** не делает ничего, `hostBtn.disabled` даже не
  выставляется, в `#lobby-error` пусто, в консоли — unhandled rejection;
- auth: клик по **#auth-enter** не эмитит `'enter'`, игрок заперт на экране
  входа без единой строки объяснения.

Это ровно тот класс отказа («ошибка, которую игрок не видит и исправить не
может, запирает форму»), ради которого писался B1 из первой фазы, — только
теперь он приходит с другой стороны.

**Регресс относительно прежнего кода.** Раньше единственным потребителем
`descriptor.regExp` был `el.pattern` + нативный `reportValidity()`: браузер
невалидный паттерн просто игнорирует (поле считается валидным). Сейчас тот же
манифест убивает сабмит.

**Проба** (`happy-dom`, зелёная):

```js
const descriptors = [
  { name: 'color', control: 'text', label: 'Color', regExp: '^#[0-9a-f{6}$', default: 'x' },
];
const fields = buildForm(descriptors, container);
fields.get('color').el.value = 'zzz';
expect(() => collectFormErrors(descriptors, fields)).toThrow(); // проходит
```

**Решение.** Компилировать паттерн один раз и безопасно — заодно уходит
пересборка `RegExp` на каждое поле каждого сабмита:

```js
// regExp приезжает из манифеста игры строкой: невалидный паттерн — дефект
// схемы, а не повод убить сабмит. Без перехвата SyntaxError уходит из
// collectFormErrors в обработчик клика, и кнопка перестаёт делать что-либо,
// не показав игроку ни строки. Нативный `pattern` вёл себя ровно наоборот:
// браузер нечитаемый паттерн игнорирует
const patterns = new Map();

function fieldPattern(regExp) {
  if (!patterns.has(regExp)) {
    let pattern = null;

    try {
      // тот же якорь, что браузер вешает на атрибут pattern
      pattern = new RegExp(`^(?:${regExp})$`);
    } catch (e) {
      console.error(`formBuilder: invalid regExp "${regExp}" — ${e.message}`);
    }

    patterns.set(regExp, pattern);
  }

  return patterns.get(regExp);
}
```

и в `validateField`:

```js
if (isText && descriptor.regExp) {
  const pattern = fieldPattern(descriptor.regExp);

  // нечитаемый паттерн — не ограничение: поле проходит, дефект уже в консоли
  if (pattern && !pattern.test(raw)) {
    return 'invalid format';
  }
}
```

**Тесты:** битый `regExp` → `collectFormErrors` не бросает и не даёт ошибки на
поле, `console.error` вызван один раз на паттерн (кэш).

**Плюс (опционально) в контракт-чекер:** правило `B5` (`b5-room-form.js`) уже
ходит по `roomForm` — добавить туда проверку компилируемости `regExp`, чтобы
дефект ловился до раздачи манифеста клиентам, а не в браузере игрока.

---

## Б2. Единственный вариант с нестроковым `value` отбивается `validateAuth` — на невидимом поле ✅ выполнен

**Где:** `formBuilder.js:38` (`resolveForcedValue`) + `main.js:442`.

**Что не так.** В `aa3b049` из `forced` намеренно убран `String()`
(в отчёте — пункт S-серии), а `main.js` кладёт результат прямо в
`param.value`:

```js
const forced = resolveForcedValue(param.options);
if (forced !== undefined) { param.value = forced; }
```

Дальше `param.value` уходит в `AuthModel.add()` (через `AuthCtrl.init`) и в
`defaultsFrom(params)` на solo-пути — **минуя DOM**. А `validateAuth`
(`src/lib/validators.js:36`) режет всё нестроковое:

```js
if (typeof value !== 'string') {
  return [{ name, error: `Property must be a string` }];
}
```

Если у игры в `options` лежат не строки (`options: [1, 2]` или
`[{ value: 1, label: 'Solo' }]` — контракт `docs/en/plugin-api.md` это
разрешает: «`options` (`[value]` or `[{value,label}]`)»), и вариант остался
один, игрок получает `MODEL: Property must be a string` на поле, **строки
которого в DOM нет**. Форма заперта навсегда.

Раньше этого не было по двум причинам сразу: `AuthView` присваивал
`field.getValue()` (DOM-свойство `<option>.value` — всегда строка), а
`buildRadio` явно писал `String(options[0].value)`.

Заодно это единственное место, где значение поля с одним вариантом отличается
по типу от поля с двумя (там всегда строка из DOM) — асимметрия, которую
никто не ждёт.

**Проба** (зелёная):

```js
const forced = resolveForcedValue({ control: 'select', options: [{ value: 1, label: 'Solo' }] });
expect(forced).toBe(1);
expect(validateAuth({ team: forced }, [{ name: 'team', options: { control: 'select' } }]))
  .toEqual([{ name: 'team', error: 'Property must be a string' }]);
```

**Решение.** Вернуть приведение — но в `resolveForcedValue`, а не на вызывающей
стороне: у функции ровно тот контракт, что она обязана прийти к значению,
которое дала бы форма, а форма отдаёт DOM-строку.

```js
export function resolveForcedValue(descriptor, ctx = {}) {
  if (descriptor.control !== 'select' && descriptor.control !== 'radio') {
    return undefined;
  }

  const forced = forcedValue(resolveOptions(descriptor, ctx));

  // форма отдала бы строку: и <option>.value, и <input type=radio>.value —
  // DOM-свойства, они всегда строки. Нестроковое значение validateAuth
  // (lib/validators.js) отбивает «Property must be a string», а строки поля
  // в DOM нет — поправить нечем
  return forced === undefined ? undefined : String(forced);
}
```

**Тест:** `resolveForcedValue({ control: 'select', options: [{ value: 1 }] })`
→ `'1'`; и тот же кейс через `validateAuth` → `undefined` (нет ошибок).

---

## М1. Доки движка не догнали C4 и C6 ✅ выполнен

**Где:** `docs/en/debugging.md:78`, `docs/ru/debugging.md:77` (таблица групп
правил контракт-чекера).

Обе строки описывают старое поведение:

- en: `… known services, the t/time panel field, five stat columns (warning) …`
- ru: `… известные сервисы, поле панели t/time, пять колонок статистики (предупреждение) …`

C6 больше **не** проверяет число колонок, а C4 больше не безусловная ошибка.
`CLAUDE.md` проекта: `src/devtools/`, `bin/vimp-*.js` → `debugging.md`, обе
языковые страницы тем же изменением. `docs/ai/` обновлён, билингва — нет.

**Решение** — заменить оба фрагмента строки C1–C10:

- en: `… services the engine or the plugin's hooks.services() provides, the t/time panel field, stat columns past the engine layout being styled by the plugin (warning) …`
- ru: `… сервисы, которые даёт движок или hooks.services() плагина, поле панели t/time, колонки статистики за пределами движковой раскладки, покрытые стилями плагина (предупреждение) …`

Проверить заодно, не описан ли где-то ещё в `docs/en|ru` уровень C4 как
безусловный error.

---

## М2. C6: сообщение обещает проверку ширины, а проверяются только селекторы ✅ выполнен

**Где:** `packages/engine/src/devtools/contract/rules/c6-stat-columns.js:14`
(`styledColumns`).

Правило рубит CSS плагина по `split('}')`, берёт кусок до `{` как селектор и
дальше смотрит только на него. Тело правила не читается вовсе, а нарушение
при этом формулируется как «`gives no width to column(s) N`». Три следствия,
все три воспроизведены прогоном правила напрямую:

| Стиль плагина | Ожидание | Факт |
| --- | --- | --- |
| `#stat table td:nth-child(6) { color: red; }` | warn (ширины нет) | **pass** |
| `@media (min-width: 600px) { #stat table td:nth-child(6) { width: 10%; } }` | pass | **warn** |
| `#stat table th:nth-child(6) { width: 10%; }` | pass | **warn** |

Первый — ложный пропуск ровно того дефекта, ради которого правило и живёт
(колонка схлопывается в ноль). Второй и третий — ложные срабатывания на
рабочей вёрстке; они «всего лишь» warn, но под `--strict` валят прогон, а
автор игры получает совет, который нечего исполнять.

Причина `@media`: `split('}')` отдаёт кусок `@media (min-width: 600px) { #stat
table td:nth-child(6) `, у которого `split('{')[0]` — это `@media (…) `, где
`#stat` уже нет.

**Решение.** Разбирать не «до ближайшей `}`», а пары «селектор + тело», и
смотреть, что в теле:

```js
// внутренние правила, включая завёрнутые в @media/@supports: [^{}] не
// перешагивает вложенную скобку, поэтому matchAll ловит именно внутреннее
// правило, а не обёртку (split('}') видел обёртку и терял селектор)
const RULE = /([^{}]+)\{([^{}]*)\}/g;
// ячейка колонки: движковая раскладка адресует их как `#stat … td|span`
const CELL = /(?:^|[\s.#>+~])(?:td|th|span)(?=[\s.:#>+~,[]|$)/;
// правило про раскладку, а не про цвет: колонку «покрывает» только объявление
// ширины (или её грид/флекс-эквивалент)
const WIDTH = /(?:^|[\s;{])(?:width|min-width|max-width|flex|flex-basis|grid-template-columns)\s*:/;

function styledColumns(styles, total) {
  const covered = new Set();

  for (const [, selector, body] of String(styles || '').matchAll(RULE)) {
    if (!selector.includes('#stat') || !CELL.test(selector) || !WIDTH.test(body)) {
      continue;
    }

    const indexes = [...selector.matchAll(/nth-child\((\d+)\)/g)];

    // селектор ячеек без nth-child ('#stat table td') кроет всю таблицу
    if (indexes.length === 0) {
      for (let index = 1; index <= total; index += 1) {
        covered.add(index);
      }

      continue;
    }

    for (const [, index] of indexes) {
      covered.add(Number(index));
    }
  }

  return covered;
}
```

Это по-прежнему эвристика (правило не парсер CSS), и так и надо написать в
шапке модуля: покрывается «объявление ширины на селекторе с `#stat` и
ячейкой». Но она перестаёт врать в обе стороны на реальной вёрстке.

**Тесты:** три строки таблицы выше — ровно три кейса.

---

## М3. Ноль вариантов молча уезжает на хост, если у поля нет `required` ✅ выполнен

**Где:** `formBuilder.js:435` (`console.error` про `noOptions`) и
`validateField`.

Комментарий и доки утверждают: «Такое поле остаётся видимым (и валидируемым) —
молча спрятать его значит отправить на хост пустую строку». Но валидация
пустого `select` держится **только** на `descriptor.required`, а его никто не
ставит: у `vimp-tanks` поле `map` (`source: 'maps'`) объявлено без `required`
— при пустом каталоге карт форма отдаст `map: ''` и создаст комнату.

**Проба** (зелёная):

```js
const descriptors = [{ name: 'map', control: 'select', label: 'Map', source: 'maps' }];
const fields = buildForm(descriptors, container, { sources: { maps: [] } });
expect(collectFormErrors(descriptors, fields)).toEqual([]); // проходит
expect(fields.get('map').getValue()).toBe('');              // проходит
```

Второе: даже когда `required` стоит, игрок видит `MAP: required` — сообщение
про поле, которое нечем заполнить. Оно ведёт не туда.

**Решение.** Пустой резолв — собственная ошибка поля, независимо от
`required`; ставится первой, до проверки пустоты:

```js
function validateField(descriptor, field) {
  // резолв вариантов дал пустой список — у поля нет ни одного допустимого
  // значения: дефект схемы или каталога (buildForm уже написал console.error),
  // но отправлять на хост пустую строку нельзя, а «required» повёл бы игрока
  // заполнять то, что не заполняется
  if (field.noOptions) {
    return 'no options available';
  }

  const value = field.getValue();
  …
```

Обновить `docs/en|ru/plugin-api.md` («…validation applies» → «…the field
always reports `no options available`») и `docs/ai/02-packaging.md`, плюс
`### Changed` в журнале движка.

---

## М4. Первое же нажатие клавиши стирает **все** показанные ошибки ✅ выполнен

**Где:** `main.js:2028` и `view/Auth.js:38`.

Обе формы гасят блок ошибок целиком по любому `input` в контейнере полей.
Сценарий: игрок жмёт Create server, получает три строки, начинает править
первое поле — и оставшиеся две исчезают вместе с ним. Список того, что ещё не
починено, пропадает раньше, чем игрок до него добрался; чтобы увидеть его
снова, надо ещё раз ткнуть в кнопку. Это дешевле прежнего поведения (одна
браузерная плашка), но не то, ради чего заводили многострочный блок.

**Решение** (UX-полировка, не дефект корректности): не гасить, а
перевалидировать — и только после первого сабмита, чтобы «required» не
подсвечивалось игроку, который ещё печатает. Логика одна на обе формы, ей
место в `formBuilder.js`, а не в двух копиях:

```js
// повторная проверка по ходу правки: строки уходят по мере починки полей, а
// не все разом по первому нажатию клавиши. Вооружается первым сабмитом — до
// него игрок ещё заполняет форму, и «required» на пустом поле только шумит.
// 'input' — единственное событие по ходу ввода ('change' у text-инпута
// приходит на blur, то есть уже после клика по кнопке); слушатель
// делегированный: контейнер постоянен, пересобираются только поля
export function bindLiveErrors(container, errorContainer, getForm) {
  let armed = false;

  container?.addEventListener('input', () => {
    if (armed) {
      const { descriptors, fields } = getForm();

      renderFormErrors(errorContainer, collectFormErrors(descriptors, fields));
    }
  });

  return () => {
    armed = true;
  };
}
```

`main.js`: `const armErrors = bindLiveErrors(fieldsEl, errorEl, () => ({ descriptors: roomFormDescriptors, fields: roomFormFields }))`, вызов
`armErrors()` в обработчике клика рядом с `renderFormErrors`. В `AuthView` —
то же самое, `getForm` отдаёт `this._descriptors`/`this._fields`.

Внимание на один нюанс при переносе: сейчас `#lobby-fields` гасит и **не
формные** ошибки (`Failed to load <game>` из `selectActiveGame`). Их
перевалидация не вернёт, и это правильно — но тогда `armed`-ветка должна
писать в блок пустой список, а не пропускать рендер (иначе строка отказа
плагина останется висеть). Код выше это делает.

---

## Мелочи ✅ выполнены (S1–S8)

**S1. `" "` в числовом поле проходит как `0`.** `Number(' ') === 0`, и
`Number.isFinite` доволен. У tanks/snakes спасают `min`/`regExp` из
`build-game-manifest.js`, но у игры, объявившей `numeric: true` без обоих,
пробел создаст комнату с нулём. Лечится там же, где считается пустота:
`const raw = isText ? field.el.value.trim() : undefined` — заодно `«  8  »`
станет валидной восьмёркой, как и ждёт игрок. Проба зелёная:
`collectFormErrors` → `[]`, `getValue()` → `0`.

**S2. DRY в `validateField`.** `toDisplay(descriptor, value)` лежит в том же
файле (строка 47), но диапазон считается инлайном:
`descriptor.unit === 's' ? value / 1000 : value` (строка 317) — третья копия
одного правила. Так же `numeric = descriptor.numeric || descriptor.unit !== undefined`
живёт в двух местах (`buildText:97`, `validateField:297`) — просится
`function isNumeric(descriptor)` рядом с `toDisplay`.

**S3. `resolveForcedValue` дублирует знание о том, какие контролы имеют
варианты** (`control !== 'select' && control !== 'radio'`). Третье место
после `builders` и двух билдеров; при добавлении контрола с вариантами
разъедется молча. Дешёвая страховка — общий `const OPTION_CONTROLS = ['select', 'radio']`
рядом с `builders`.

**S4. Тестируемость валидации.** `validateField` лезет в `field.el.value`
напрямую — валидатор знает про DOM-устройство поля, хотя у поля есть свой
API. `buildText` мог бы отдавать `getRaw: () => el.value` (у остальных
билдеров — `undefined`), и `validateField` работал бы через контракт поля, а
не через его внутренности. Тогда же валидация становится проверяемой без
`happy-dom`.

**S5. Нормализация `PS_AUTH_DATA` не покрыта тестом.** Правка Б3 из первой
фазы (посев из `localStorage` + `resolveForcedValue` до ветки
`boot.autoAuth`) живёт в `main.js:430-447` — единственном модуле клиента без
единого теста (`tests/client/` покрывает все MVC-триплеты и `lib/`, `main.js`
там нет). Юнит-тестами накрыт только `resolveForcedValue`, то есть кирпич, а
не проводка — а сломалась в первой фазе именно проводка. Просится вынос в
`src/client/lib/authParams.js`:

```js
// значение поля до формы: память клиента, потом схема. Порядок важен —
// поле с единственным вариантом не показывается и правке не поддаётся,
// поэтому устаревший localStorage[storage] обязан быть перекрыт
export function normalizeAuthParams(params, storage = localStorage) { … }
```

с тестами на три случая: посев из storage, перекрытие forced-значением,
поле без `storage`.

**S6. `AuthView`: несогласованные защиты.** Новый слушатель написан как
`this._fieldsContainer?.addEventListener('input', () => { this._error.textContent = ''; })`
— контейнер под optional chaining, а `this._error` без. При кривом
`authSchema.elems.errorId` (правило `C10` проверяет только `fieldsId`) каждое
нажатие клавиши будет бросать `TypeError`. Либо `this._error?.textContent`,
либо — лучше — `renderFormErrors(this._error, [])`, у которого проверка
контейнера уже внутри.

**S7. `verdict(violations, note, level)` не валидирует уровень.** Опечатка
(`'warning'` вместо `WARN`) даст правилу уровень, которого нет: в отчёте он
напечатается как есть, а `hasBlockingFailure` (сравнение с `ERROR`) молча
перестанет блокировать. Дешевле всего — `level` вторым позиционным типом
не принимать вовсе, а в `runRules` привести: `level: level === WARN || level === ERROR ? level : rule.level`
с `console.error` на неизвестном.

**S8. C4 не видит обратную коллизию.** `main.js:375` строит пул как
`{ ...gameServices, renderer, soundManager, localPlayer, assetsBase }` —
движковые имена перекрывают игровые. Игра, вернувшая из `hooks.services()`
свой `renderer`, получит движковый и не узнает об этом: тот же молчаливый
подмен, ради которого правило написано, только с другой стороны. Статически
это ловится ровно так же плохо, но строчкой в `docs/ai/10-pitfalls.md`
(«не называйте свои сервисы движковыми именами — их перекроют») закрывается
бесплатно.

---

## Что сделано хорошо

- Б1/Б2/Б3 первой фазы действительно закрыты, и закрыты в правильных местах:
  нормализация forced-значения ушла в `main.js` **до** ветки `boot.autoAuth`,
  а не в форму, — solo-путь и форма теперь приходят к одному значению.
- `field.rendered` как явный флаг вместо повторного вывода «а рендерилось ли
  поле» на стороне валидатора — читается однозначно, и `=== false` (а не
  falsy) прокомментировано.
- Порядок проверок `min`/`max` → `regExp` и мотивировка в комментарии — то
  самое место, где через полгода спросят «почему не наоборот».
- Якорение `^(?:…)$` с объяснением, откуда взялась эта форма (браузерный
  `pattern`), — редкий случай, когда комментарий отвечает на вопрос, который
  реально возникнет.
- C4/C6: обе правки чинят правило, а не игру, и обе понижают уровень там, где
  доказательства неполны, вместо того чтобы отключить проверку. `verdict`
  с собственным `level` — минимальный механизм под это (см. S7 про валидацию).
- Журналы: `### Added` + `### Changed`/`### Fixed` расставлены верно, разрыв
  `0.1.5…0.1.13` в журнале scaffolder закрыт с честной пометкой «version
  bumps only», ссылка на релиз добавлена.
- Ни `ENGINE_API_VERSION`, ни крейт не тронуты — игры за этим изменением
  идти не обязаны.

## Влияние на релиз

Затронуты опубликованные пути npm-пакета `vimp-engine` (`src/client`,
`src/devtools`), уровень по под-заголовкам `[Unreleased]` — **minor**
(`### Added` есть) → `0.14.4 → 0.15.0`. Крейт `vimp-engine-core` не менялся,
`ENGINE_API_VERSION` не менялся — репозиториям игр подтягиваться не нужно.
`create-vimp-game`: в `[Unreleased]` только `### Changed` → patch; добавленная
секция `[0.1.13]` историческая, `parseUnreleased` её не читает — `npm run
release` не сломается. Пре-публикационно прогнаны `npx eslint .`, `npm test`,
`vimp-contract` по tanks и snakes (в т.ч. `--strict`).
