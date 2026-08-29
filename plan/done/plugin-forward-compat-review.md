# Кодревью `plugin-forward-compat` (второй проход)

Ревью коммитов `bf39103` (+ бампы `82de418`, `1d47ce4`, `ffe4e09`, `02c3fe7`),
`vimp-tanks 5bedcce→9e489e6`, `vimp-snakes 603174a→7967fc8`.
Предыдущее ревью — `~/.claude/plans/expressive-bubbling-seal.md`; его находки
перепроверены, статус каждой указан ниже.

## Состояние базы

- `npx eslint .` — 0 ошибок; `npm test` — 159 файлов / 1797 тестов, зелено.
- Слепок `contract/surface.json` актуален, 12 разделов, `manifestFields`
  содержит `requires`.
- Архитектура этапов 1–5 подтверждается: вердикт вместо `throw`, append-only
  реестры, `[0x00]`-маркер `dispatch_result`, накладка алиаса под
  дескриптором игры. Замечания ниже — про щели в механизации, а не про
  замысел.

## Находки

Порядок — по убыванию риска. Пометка **[новая]** — не было в первом ревью,
**[подтверждена]** — воспроизведена, **[усилена]** — оценка повышена.

---

### 1. Алиасы контролов не разрешаются в авторитетной валидации хоста — КРИТИЧЕСКАЯ [новая] — ✅ выполнен

`packages/engine/src/lib/validators.js:25,31,114,127,137`

```js
const OPTION_CONTROLS = ['select', 'radio'];
const isTextControl = control => control === 'text' || control === undefined;
```

Этап 3 научил разрешать выведенные имена контролов **только клиентский
билдер** (`client/lib/formBuilder.js` → `resolveDescriptor` в `buildField`,
`collectFormErrors`, `resolveForcedValue`). `lib/validators.js:validateAuth`
— это вторая, авторитетная половина той же проверки: её зовёт
`host/PortMachine.js` для клиента, который форму обошёл. Она читает
`options.control` сырым, реестра `formControls` не знает вовсе.

Собственный комментарий модуля формулирует инвариант, который теперь
нарушен: *«клиент, обошедший форму, не должен получать больше прав, чем
клиент, её заполнивший»*.

Воспроизведено на живом модуле:

```
authSchema: [{ name:'team', options:{ control:'segmented', options:['red','blue'] }}]
validateAuth({ team: 'hacked' }, schema) -> undefined          // ошибок нет
то же с control:'radio'                 -> [{name:'team', error:'not an option'}]

authSchema: [{ name:'nick', options:{ control:'number', regExp:'^[0-9]+$', maxlength:3 }}]
validateAuth({ nick: 'abcdefgh' }, schema) -> undefined        // ни regExp, ни maxlength
то же с control:'text'                     -> [{name:'nick', error:'too long'}]
```

Разбор по именам:

| `control` в схеме | Активный | Что теряется на хосте |
| --- | --- | --- |
| `segmented` | `radio` | проверка членства в `options` — принимается **любая строка** |
| `toggle` | `checkbox` | (нативно и не проверялось — влияния нет) |
| `number`, `range` | `text` + `numeric` | `regExp` и `maxlength`; вместо `maxlength` работает только `MAX_FIELD_LENGTH` |

**Почему это регрессия, а не старый дефект.** До этапа 3 игра с
`control: 'segmented'` не работала вовсе: `buildField` бросал
`unknown control "segmented"`, поле не строилось, до `validateAuth` дело не
доходило. Этап 3 сделал такую схему рабочей на клиенте — и ровно этим
открыл её недовалидированной на хосте. То есть щель создана этим планом.

**Почему это достижимо.** Смысл всего плана — принимать игры прошлых
поколений, а именно они и пишут `segmented`/`number` (v2, `retiredIn: 3`).
Своим играм (`tanks`, `snakes`) повезло: обе используют `select`. Правило
контракта C10 (`c10-auth-schema.js`) имя контрола не проверяет вообще, B5
проверяет только `roomForm`, — то есть чекер такую схему пропустит молча.

**Последствие.** Значение поля уезжает в игру как есть: `model` попадает в
поиск по `parts.models`, `team` — в `teams`. Место, которое движок считал
ограниченным перечислением, принимает произвольную строку от клиента,
поднявшего свой сокет.

**Решение**

1. `lib/validators.js` — резолвить дескриптор ровно так же, как билдер.
   `resolveDescriptor` живёт в `lib/formControls.js` (не в `client/`), так
   что импорт границ не нарушает:
   ```js
   import { resolveDescriptor } from './formControls.js';
   // ...
   for (const { name, options } of authParams) {
     const opts = resolveDescriptor(options);
     // дальше по коду читать opts, а не options
   }
   ```
   `resolveDescriptor` возвращает тот же объект, если контрол активен или
   неизвестен, — накладных расходов на горячем пути нет.
2. `numeric`-накладку валидатор должен уважать: числовое поле, приехавшее
   мимо формы, обязано проверяться по `min`/`max`, а не только по regExp.
   Сейчас комментарий модуля утверждает «числовых полей в `authSchema` не
   бывает вовсе» — с алиасами это перестало быть правдой. Либо ввести
   проверку `min`/`max` для `numeric`, либо явно отвергать такое поле как
   дефект схемы; молчаливый пропуск — худший из трёх вариантов.
3. Правило C10 — проверять `control` по реестру `formControls` тем же
   образом, что B5 делает для `roomForm` (неизвестное имя = нарушение,
   выведенное = совет объявить активное). Сейчас `authSchema` в этой части
   не проверяется вовсе.
4. Тесты: `tests/lib/validators.test.js` — `segmented` отвергает не-вариант
   так же, как `radio`; `number` применяет `regExp`/`maxlength` так же, как
   `text`. `tests/devtools/contract/rules.test.js` — C10 на схеме с
   неизвестным и с выведенным контролом.

**Уровень релиза**: `### Security` (patch) в `packages/engine/CHANGELOG.md`.
Плагин, который грузился раньше, продолжает грузиться — отвергается только
значение поля, пришедшее от клиента, поэтому `⚠️ Breaking` не требуется.

---

### 2. Битое поле `requires` в чужом манифесте роняет мастер целиком — ВЫСОКАЯ [подтверждена] — ✅ выполнен

`packages/engine/src/lib/gamePlugin.js:44`, `src/master/GameCatalog.js:70`

```js
const wanted = manifest.requires ?? [];
const missing = wanted.filter(name => !ENGINE_CAPABILITIES.has(name));
```

Воспроизведено:

```
requires: "accolades" -> TypeError: wanted.filter is not a function
requires: {}          -> TypeError
requires: 5           -> TypeError
```

Вызов в конструкторе `GameCatalog` стоит **вне** `try`, который накрывает
только `JSON.parse` (`GameCatalog.js:42-46`), — исключение уходит из
конструктора и мастер не стартует. До этапа 5 битый манифест максимум
выкидывал одну игру из каталога.

Два уточнения к первому ревью:

- **Второй пострадавший — правило контракта B2** (`b2-engine-api.js:60`):
  `for (const name of ctx.manifest?.requires ?? [])`. Строка проитерируется
  посимвольно (`'a', 'c', 'c'…` — каждый символ как неизвестная
  возможность), объект бросит `TypeError: not iterable` и уронит чекер.
- **Не-строковый элемент массива** даёт мусорный текст отказа:
  `requires: ['ok', null]` → `"…does not have: ok,  — update the engine"`.

**Решение**

1. `checkPluginCompatibility` — не доверять форме, отвечать вердиктом
   (не `throw`: у четырёх входов уже есть правильная реакция на `ok:false`,
   и битый манифест обязан вести себя как несовместимый, а не как краш):
   ```js
   const wanted = manifest.requires;

   if (wanted !== undefined && wanted !== null) {
     if (!Array.isArray(wanted) || wanted.some(n => typeof n !== 'string')) {
       return {
         ok: false,
         reason: 'bad-manifest',
         missing: [],
         text:
           `game "${manifest.id}": manifest.requires must be an array of ` +
           'capability names — rebuild the game package',
       };
     }
   }
   ```
2. `GameCatalog` — расширить `try` на весь разбор одной игры (`catch` →
   `console.warn` + `continue`). Инвариант «одна битая игра не уносит
   каталог» должен держаться механически, а не по доброй воле вызываемого
   кода: `_readPackageMeta`, `_readMaps`, `_toDevManifest` уже все
   защищены поодиночке — общий `try` закрывает и будущие вызовы.
3. B2 — нормализовать `requires` тем же способом до цикла и выдавать
   нарушение «`requires` is not an array of strings».
4. Тесты: `tests/lib/gamePlugin.test.js` (`requires` строкой / объектом /
   с не-строковым элементом → `ok:false, reason:'bad-manifest'`),
   `tests/master/gameCatalogCompat.test.js` (каталог с одной битой и одной
   здоровой игрой отдаёт здоровую), `tests/devtools/contract/rules.test.js`.

---

### 3. Проверка совместимости в standalone SDK не срабатывает — СРЕДНЯЯ [подтверждена] — ✅ выполнен

> **Уточнение по факту правки.** Формулировка «проверки мёртвые» была
> неточной: `checkPluginCompatibility(plugin)` читает `plugin.requires` и
> отрабатывает, если половина это поле объявила (тест на это в
> `startStandaloneGame.test.js` был и проходил). Дефект в том, что поле не
> было объявлено ни контрактом, ни шаблоном, ни одной из двух игр — а
> манифестный `requires` в solo-режиме не существует. Проверка была инертна
> на практике, а не мертва в коде; правка от этого не меняется.

`packages/engine/src/standalone/index.js:61-63,100-107`

```js
requireCompatible(hostPlugin);
requireCompatible(clientPlugin);
```

`requires` — поле **`GameManifest`**, а не половины плагина. Проверено:
поле есть только в `scripts/build-game-manifest.js` (шаблон и `snakes`),
у объектов `hostPlugin`/`clientPlugin` его нет ни в шаблоне, ни в одной из
двух игр. Значит `manifest.requires ?? []` всегда `[]`, вердикт всегда
`{ok: true}` — обе проверки не срабатывают никогда.

При этом `docs/en/plugin-api.md:871` обещает
`standalone SDK | throws for either plugin half` — документация описывает
поведение, которого нет.

Практическое следствие ровно то, ради чего заводили capability: `snakes` с
`requires: ['accolades']`, поднятая через SDK на движке без порта 18, тихо
недоиграет вместо честного отказа.

**Решение**

1. Объявить `requires` необязательным полем **обеих половин плагина** (это
   добавление, И1 не нарушает): описать в `docs/{en,ru}/plugin-api.md`
   рядом с `GameManifest.requires`, добавить `requires: []` в
   `templates/default/src/{host,client}/index.js` с тем же комментарием,
   что уже есть в шаблонном `build-game-manifest.js`.
2. `startStandaloneGame` — одна проверка вместо двух, с приоритетом у
   явной опции:
   ```js
   requireCompatible({
     id: hostPlugin.id,
     requires: requires ?? [
       ...(hostPlugin.requires ?? []),
       ...(clientPlugin.requires ?? []),
     ],
   });
   ```
   Сообщение об отказе адресовано разработчику встраивания — делить его по
   половинам незачем.
3. Слепок: `requires` появится в `hostPluginMembers`/`clientPluginMembers`
   (`collect.js` собирает члены разбором) — обновить `contract/surface.json`
   через `npm run surface:update`. Это добавление, не нарушение И1.
4. Тест: `tests/standalone/startStandaloneGame.test.js` — половина с
   `requires: ['no-such-capability']` бросает с текстом «update the engine».

---

### 4. Документация обещает отказ в регистрации комнаты, которого нет — СРЕДНЯЯ [усилена] — ✅ выполнен

`packages/engine/src/master/SignalingServer.js:164`, `docs/en/plugin-api.md:868`

Первое ревью отнесло это к «хардненингу» (ИНФО). Оценка повышена: это не
предложение усилить защиту, а **расхождение с задокументированным
контрактом**. `plugin-api.md:868` утверждает про недоступную игру:

> the lobby shows it disabled with the reason, **and no room can be created
> for it**

`_onRegisterHost` кладёт `gameId` в реестр, ни разу не заглянув в
`getManifest(gameId)?.compat`. Недоступность обеспечена **только клиентом**
(`option.disabled` в `client/main.js:2017`). Хост со своей сборкой или
просто с открытой консолью поднимет комнату по недоступной игре: она
попадёт в лобби живой строкой, присоединяющиеся упрутся в
`loadClientPlugin`.

Опасности нет (плагин одинаково недоступен всем), но лобби показывает
нерабочую комнату, а документация — поведение, которого нет.

**Решение**: в `_onRegisterHost` отклонять регистрацию
`this._sendError(session, 'gameUnavailable')`, если у манифеста
`compat.ok === false` (проверка ставится рядом с существующей проверкой
`gameId`, до `_verifyToken` — она дешевле). Тест —
`tests/master/SignalingServer.test.js`.

---

### 5. `_op()` не различает «не обработан» и «обработан без ответа» — СРЕДНЯЯ [подтверждена] — ✅ выполнен

`packages/engine/src/host/GameCoreAdapter.js:264-272`, `core/src/abi.rs:55`

Ядро отвечает тремя способами: пусто — «опкод не понят», `[0x00]` —
«понят, ответа нет», иначе — полезные байты. `_op` схлопывает первый случай
в `null`, а `[0x00]` отдаёт наверх сырыми байтами; JSDoc об этом молчит
(«null — ядро опкод не умеет **либо не обработало**» — это описание двух
разных исходов одним значением).

Пока опкод один и он всегда возвращает JSON, не стреляет. Первый же
опкод-команда (а ради них механизм и делался) даст вызывающему
`Uint8Array [0]`, который поедет в `TextDecoder` и `JSON.parse('\0')`.

**Решение**: вернуть из `_op` различимый результат —
`{ handled: boolean, bytes: Uint8Array|null }` (либо отдельный `_opAck(op)`
для команд без ответа), `debugJson()` перевести на `handled && bytes`.
JSDoc переписать под все три исхода со ссылкой на `abi::dispatch_result`.
Тест — `tests/host/gameCoreAdapterOps.test.js`: три исхода на фейковом ядре.

---

### 6. Реестр `abiOps` не участвует в рантайме, а ESLint-страж не покрывает клиент — СРЕДНЯЯ [новая] — ✅ выполнен

Этап 4 завёл append-only реестр опкодов (`src/config/abiOps.js`) и
ESLint-правило `no-restricted-syntax`, запрещающее прямой вызов метода на
`this._core`. Обе механизации протекают:

**а) реестр `abiOps` не читает никто, кроме слепка.** Единственные его
потребители — `devtools/surface/collect.js:55` и `contract/surface.json`.
Оба места вызова пишут литерал:

```
src/host/GameCoreAdapter.js:240   this._op('debug.json')
src/client/main.js:1208-1209      clientCoreAbi.ops.includes('debug.json')
                                  clientCore.dispatch('debug.json', …)
```

`_op` проверяет только `this._abi.ops.includes(op)` — то есть верит ядру,
а не реестру. Опкод, которого в реестре нет, вызовется без единого
возражения, и в слепок он не попадёт — ровно тот молчаливый рассинхрон,
против которого реестры и заводились. JSDoc `_op` при этом уже обещает
«Опкод из config/abiOps.js».

**б) правило `_core` охраняет только хостовую половину.** Селектор —
`MemberExpression[object.object.type="ThisExpression"][object.property.name="_core"]`.
Он ловит `this._core.foo()` и ничего больше. Клиентское ядро в
`client/main.js` живёт в модульной переменной `clientCore` и зовётся
напрямую (`core.abi_describe`, `clientCore.dispatch`, `clientCore.debug_json`)
— вне охраны. Клиентская таблица экспортов заморожена в
`contract/surface.json → abi.client` ровно так же, как игровая, но
механической защиты от «позвать новый метод напрямую» у неё нет. Заодно
правило не ловит и `const core = this._core; core.newMethod()`.

**Решение**

1. `_op` — сверяться с реестром, а не только с самоописанием ядра:
   ```js
   if (!abiOps.has(op)) {
     throw new Error(`GameCoreAdapter: unknown opcode "${op}" — declare it in config/abiOps.js`);
   }
   ```
   Опкод вне реестра — дефект движка, а не плагина: пусть падает сразу.
   Разрешение алиаса (`abiOps.resolve(op)`) заодно даст опкодам ту же
   append-only механику, что у контролов и сервисов.
2. Литералы `'debug.json'` в обоих местах заменить на именованную
   константу из `config/abiOps.js` (например `ABI_OP_DEBUG_JSON`).
3. Клиентскую половину привести к тому же виду: завести `_op`-аналог рядом
   с чтением ABI (см. находку 7) и расширить ESLint-селектор на имя
   `clientCore` — либо, чище, спрятать клиентское ядро за тонким адаптером
   с `this._core`, и правило начнёт действовать без правки селектора.
4. Тест: `tests/host/gameCoreAdapterOps.test.js` — опкод вне реестра
   бросает; `tests/client/*` — клиентский дамп идёт через опкод при
   непустом `ops` и через `debug_json` при пустом.

---

### 7. Чтение `abi_describe` продублировано трижды и не защищено — СРЕДНЯЯ [подтверждена] — ✅ выполнен

`host/GameCoreAdapter.js:31-34`, `client/main.js:296`, `client/main.js:333-336`

Один и тот же фрагмент в трёх местах, дефолт `{ abi: 0, core: null, ops: [] }`
написан руками трижды. Разъехавшись, они дадут `ops === undefined` и
`TypeError` в `_op`/`clientCoreDebug`.

`JSON.parse` не обёрнут: ядро, отдающее не-JSON (или JSON с `ops: null`),
роняет конструктор адаптера и — на клиенте — `async`-обработчик
`PS_CONFIG_DATA`, то есть отказ уходит невыловленным промисом и конфиг не
применяется вовсе. Это тот самый режим «получатель падает от того, что
отправитель другой», который план лечил на JSON-портах
(`client/lib/socketDispatch.js`) — на wasm-оси лечение не доехало.

**Решение**: `packages/engine/src/lib/coreAbi.js` —
`export function readCoreAbi(core)`: feature-detect, `try/catch` вокруг
`JSON.parse`, нормализация (`ops` всегда массив строк), единственное место
дефолта `ABI_UNKNOWN`. Битое самоописание = поколение 0 + `console.warn`.
Заменить все три места. Тест — `tests/lib/coreAbi.test.js`: нет метода /
валидный JSON / мусор / `ops` не массив / `ops` с не-строками.

---

### 8. Корпус совместимости не покрывает алиасы `authSchema` и сервисов — СРЕДНЯЯ [новая] — ✅ выполнен

> **Уточнение по факту правки.** Новое поколение фикстур не заводилось, и вот
> почему: headless-прогон корпуса идёт мимо `PortMachine` (`ScenarioRunner`
> зовёт `host.createUser` напрямую), то есть `validateAuth` он не задевает
> вовсе — новая фикстура на 84K ничего бы про находку 1 не доказала. Вместо
> этого в `conformance.test.js` добавлены СТАТИЧЕСКИЕ проверки поколения:
> каждое имя `control` резолвится реестром, выведенное имя валидируется
> хостом так же, как его резолв (`resolveDescriptor`), манифест поколения
> совместим, — плюс проверка свойства самого корпуса: хотя бы одно поколение
> обязано держать выведенный контрол, иначе алиасы не проверяются ничем.
> Алиас имени СЕРВИСА не покрыт: в `clientServices` алиасов пока нет вовсе,
> и выдумывать их ради теста было бы нарушением И1.

Фикстура `tests/fixtures/generations/gen-api3/` — сеть безопасности этапа 1,
и она честно ловит выведенный контрол **в `roomForm`**
(`config/game.js:84,89` — `control: 'range'`). Но:

- `gen-api3/config/auth.js` выведенных контролов не содержит — путь
  `authSchema` → `validateAuth` на хосте корпусом не проходится вовсе.
  Именно поэтому находка 1 зелена во всех 1797 тестах;
- `componentDependencies` фикстуры не просит выведенного имени сервиса —
  алиасная ветка `clientServices` в прогоне не участвует;
- ни одно поколение не объявляет `requires`, поэтому корпус не проверяет
  главный новый режим отказа этапа 5 в связке с реальным матчем.

Корпус проверяет то, что уже работает; щели этапов 3 и 5 он по построению
не задевает.

**Решение**: в `gen-api3` (или в новом `gen-api4-old`) добавить
`authSchema` с `control: 'segmented'` и `control: 'number'`,
`componentDependencies` с выведенным именем сервиса и манифест с
`requires: []`. Прогон обязан остаться зелёным — а после правки находки 1
ещё и отвергать не-вариант, пришедший мимо формы. Ассерт добавить в
`tests/devtools/conformance.test.js`.

---

### 9. Правило B2 не знает про алиасы возможностей — НИЗКАЯ [новая] — ✅ выполнен

`packages/engine/src/devtools/contract/rules/b2-engine-api.js:60`,
`packages/engine/src/lib/capabilities.js:31`

```js
if (!CAPABILITIES.includes(name)) { /* нарушение */ }
```

`CAPABILITIES = ENGINE_CAPABILITIES.values()` — это **только активные**
записи (`values()` фильтрует по `alias === undefined`). Рантайм при этом
проверяет `ENGINE_CAPABILITIES.has(name)`, то есть принимает и выведенное
имя. Разъезд: игра, объявившая возможность, которую движок позже вывел
алиасом, будет работать, но провалит собственный контракт-чек с текстом
«this engine does not provide» — прямо противоположным правде.

Сейчас алиасов в реестре возможностей нет, так что путь недостижим. Но
реестр заведён ради того, чтобы они появились, и B5 (`roomForm`) уже
делает это правильно: `has` → `isRetired` → совет объявить активное имя.

**Решение**: привести B2 к форме B5 — `ENGINE_CAPABILITIES.has(name)` для
нарушения, `isRetired`/`resolve` для совета. Тест —
`tests/devtools/contract/rules.test.js` с временным алиасом в реестре.

---

### 10. Съехавший doc-комментарий в `core/src/game.rs` — НИЗКАЯ [подтверждена] — ✅ выполнен

`packages/engine/core/src/game.rs:371-392`

`abi_describe`/`dispatch` вставлены **между** doc-комментарием
`serialize_state` и самой функцией. В итоге у `abi_describe` doc-блок из
двух абзацев, первый из которых («Сериализует состояние симуляции для
эстафетной передачи между инстансами WASM. Накопители снапшота должны быть
дренированы (`pack_body`) перед вызовом») к нему не относится, а
`serialize_state` осталась без документации — причём именно её
предупреждение о дренаже критично для эстафеты Worker'ов
(`docs/en/host.md`).

**Решение**: вернуть абзац к `serialize_state`, у `abi_describe` оставить
только его собственный. `cargo doc` смысл не проверяет — правится глазами.
Записи в `core/CHANGELOG.md` не требует.

---

### 11. Устаревшая документация: снятый гейт описан как действующий — НИЗКАЯ [подтверждена] — ✅ выполнен

Правило `CLAUDE.md` «любое функциональное изменение правит обе страницы» не
выполнено для трёх пар. Проверено `grep`-ом: строки `requires engine API vN`
нет ни в одном модуле движка.

| Файл | Что написано | Как есть |
| --- | --- | --- |
| `docs/en/standalone.md:213`, `docs/ru/standalone.md:212` | ошибка `game "<id>" requires engine API vN` | такого текста движок не производит |
| `docs/en/deployment.md:197`, `docs/ru/deployment.md:140` | «лобби-мастер её пропускает (`GameCatalog: skip …`)» | игра остаётся в каталоге с `compat`; по возрасту не отвергается вовсе |
| `docs/en/publishing.md:146`, `docs/ru/publishing.md:141` | «`assertEngineApiCompatible` refuses to load it» в настоящем времени | раздел снабжён исторической преамбулой («What follows describes how the script behaved»), но сама фраза читается как текущее поведение |

Плюс `docs/en/plugin-api.md:871` (standalone бросает) и `:868` (комнату не
поднять) — см. находки 3 и 4.

**Решение**: в `standalone.md` заменить пункт на действующий отказ
(«needs engine capabilities this build does not have»); в `deployment.md`
переписать абзац про устаревшую сборку (лобби принимает игру любого
возраста, фатален только неизвестный `requires` и только для dedicated);
в `publishing.md` перевести абзац в прошедшее время. Обе страницы каждой
пары — в одной правке.

---

### 12. Мёртвый гейт и ложное сообщение в релизном конвейере — НИЗКАЯ [подтверждена] — ✅ выполнен

`scripts/release/steps.js:215-231`

Пропускает `sim` при `installed !== engineApi`, а в strict-режиме бросает с
текстом «…в лобби её отвергнет `GameCatalog`» — `GameCatalog` больше не
отвергает. Преамбула выше (`steps.js:190-204`) тоже описывает снятый гейт:
«`assertEngineApiCompatible` отказывается её грузить».

Сам путь недостижим: `ENGINE_API_VERSION` заморожен, значит
`engineApiChanged` (`scripts/release/plan.js:377`) навсегда `false`, а
`checkManifest` (`steps.js:503`) сверяет `dist/manifest.json` с той же
вечной четвёркой.

**Решение**: проверку сохранить как страховку от рассинхрона сборки внутри
пакета (это по-прежнему осмысленно и совпадает с новой формулировкой B2),
но переписать сообщение и преамбулу: расхождение значит «пакет собран не
тем движком, которым пинуется», а не «лобби отвергнет».

---

### 13. Недоступная игра всё же может стать активной — НИЗКАЯ [новая] — ✅ выполнен

`packages/engine/src/client/main.js:157-163`

```js
activeGameManifest = boot.gameId
  ? gamesManifest.find(manifest => manifest.id === boot.gameId)
  : (gamesManifest.find(isGameAvailable) ?? gamesManifest[0]);
```

Комментарий рядом обещает, что недоступная игра «не годится в активные», но
`?? gamesManifest[0]` возвращает её обратно, когда доступных нет ни одной, а
ветка `boot.gameId` совместимость не смотрит вовсе (сохранённый выбор игры,
ставшей недоступной, ведёт туда же). Дальше `loadClientPlugin` бросает —
текст отказа осмысленный (`compat.text`), но вкладка встаёт на исключении, а
не показывает лобби с объяснением.

**Решение**: обе ветки провести через `isGameAvailable`; когда доступных игр
нет, показать экран с `compat.text` вместо `throw`. Тест —
`tests/client/*`: каталог из одной недоступной игры даёт сообщение, а не
необработанное исключение.

---

### 14. Мелочи стиля и поверхностная заморозка — НИЗКАЯ [подтверждена + дополнена] — ✅ выполнен

- `client/lib/formBuilder.js:8-11` — при вставке комментарий слился: строка
  «…`'segmented'`), продолжают строиться алиасами своих нативных замен (И1).
  Валидация — не нативная» выходит за 80 колонок, которых держится весь
  файл. Переразбить абзац.
- `bin/vimp-surface.js:46` — `catch (err)` с неиспользуемой переменной
  (проходит только потому, что `no-unused-vars` в конфиге не включает
  `caughtErrors`). Убрать биндинг. Заодно стоит включить
  `caughtErrors: 'all'` с `caughtErrorsIgnorePattern: '^_'` — в
  `GameCatalog.js` таких `catch (err)` ещё четыре.
- `lib/applyRoomOverrides.js:15` — дефолтный параметр
  `view = createGameConfigView(plugin.gameConfig, plugin.id)` строит
  **вторую** view, если вызывающий её не передал: `deriveSpectatorTeam`
  предупредит в консоль дважды за прогон. Не дефект (`createHostRuntime`
  передаёт готовую), но стоит комментария о том, что путь по умолчанию —
  тестовый.
- `lib/gameConfigView.js:createGameConfigView` и `lib/registry.js` —
  `Object.freeze` поверхностный. JSDoc обещает «Замороженный конфиг», а
  `view.parts`, `view.roomDefaults`, `entry.patch` правятся свободно.
  Либо `deepFreeze`, либо снять обещание из JSDoc; сейчас читатель верит
  гарантии, которой нет.

---

## Статус: ✅ выполнен целиком

Все 14 находок исправлены. Проверки после правок: `npx eslint .` — 0 ошибок;
`npm test` — 161 файл / 1851 тест; `npm run core:test` — 119 тестов;
`node packages/engine/bin/vimp-surface.js` — слепок совпадает;
`npm run sim -- --game node_modules/@vimp-games/tanks` — матч проходит.
Слепок поверхности изменился только ДОБАВЛЕНИЕМ (`requires` в
`hostPluginMembers`/`clientPluginMembers`) — удалений нет, И1 цел.

Новые модули: `src/lib/formUnit.js` (единица измерения числового поля, общая
для билдера и валидации), `src/lib/coreAbi.js` (чтение самоописания ядра и
вызов опкода — одна точка на обе половины),
`src/client/lib/pickActiveGame.js` (выбор активной игры, вынесен из `main.js`
ради тестируемости).

## Порядок исправления

Одним изменением, в порядке убывания риска: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 →
9 → 10 → 11 → 12 → 13 → 14. Каждая правка сопровождается тестом (правило
`CLAUDE.md`). После всех: `npx eslint .`, `npm test`, `npm run core:test`,
`node packages/engine/bin/vimp-surface.js`.

## Влияние на релиз

| Артефакт | Находки | Подзаголовок `[Unreleased]` | Уровень |
| --- | --- | --- | --- |
| npm `vimp-engine` | 1 | `### Security` | patch |
| npm `vimp-engine` | 2, 4, 5, 6, 7, 9, 13 | `### Fixed` | patch |
| npm `vimp-engine` | 3 (`requires` у половин плагина) | `### Added` | minor |
| npm `create-vimp-game` | 3 (шаблон) | `### Added` | minor |
| крейт `vimp-engine-core` | 10 | — (только комментарий) | нет записи |

`⚠️ Breaking` не требуется нигде: ни одна правка не отвергает плагин или
конфиг, который загружался раньше. Находка 1 ужесточает проверку **значения
поля от клиента**, а не плагина, — поэтому `### Security`, а не
`⚠️ Breaking` + `Migration`. Правка 3 добавляет строку в
`contract/surface.json` (`hostPluginMembers`/`clientPluginMembers`) —
добавление, а не удаление; удалений из слепка в плане нет.

Репозитории игр следовать не обязаны: поверхность не сокращается. Версии не
правятся руками и ничего не публикуется — этим занимается разработчик через
`npm run release`.

## Не найдено проблем

Проверено и признано корректным: `lib/registry.js` (цикл алиасов ловится на
загрузке модуля, `values()`/`list()` разделены осмысленно),
`lib/gameConfigView.js` (copy-on-write `setPath` не портит `gameConfig`
плагина, `assertConsistent` проверяет только объявленное игрой),
`client/lib/socketDispatch.js`, `lib/formControls.js:resolveDescriptor`
(накладка идёт под дескриптором — явный `numeric: false` остаётся за игрой,
накладки копятся по всей цепочке), `core/src/abi.rs:dispatch_result`,
раздел `abi` слепка (обе половины ядра разобраны из `macro_rules!`),
`GameCatalog._toDevManifest` (поле `compat` переживает подмену entries).
