# План: английские тексты движковых кодов чата по умолчанию (D1)

Основание — пункт **D1** раздела «На решение разработчика» в
`plan/done/host-migration-review/review.md`. Решения разработчика
(2026-10-07): делать; из шаблона скаффолдера и фикстуры miniGame тексты
движковых кодов **убрать**; `../vimp-tanks` и `../vimp-snakes` **не
трогать** (их тексты перекрывают умолчания).

> **Как исполнять.** План самодостаточен. Репозиторий
> `/Users/dmitry/Sites/my/vimp`, пути — от его корня; исходники движка —
> `packages/engine/src/`, тесты — `tests/` (зеркально `src/`). Коммитов не
> делать, `version` не трогать, файлы с префиксом `_` не читать. Шаг
> помечается «✅ выполнен» в своём заголовке. Всё, что меняет наблюдаемое
> поведение и не зафиксировано здесь, — согласовать с разработчиком **до**
> кода (вопрос по-русски, варианты, рекомендуемый помечен).

## Контекст

Системные сообщения чата ходят **только кодами** (решение разработчика,
не меняется): хост шлёт строку `'группа:индекс[:p0,p1…]'` (порт
`CHAT_DATA`, 15), часть кодов клиент добавляет себе сам. Текст подбирает
клиент из `modules.chat.params.messages` конфига игры (порт `CONFIG_DATA`),
а у движка своих текстов нет. Поэтому каждый новый код движка (`s:7…11`,
`v:6…15` в 0.36.0) требует правки обеих игр, шаблона и фикстуры, а игра
без свежего релиза **молча не показывает** сообщение.

Цель: движок держит английские тексты по умолчанию для **своих** кодов
(группы `s`, `v`, `m`, `c`, `n`); текст игры по тому же индексу их
перекрывает; пустая строка игры — осознанное «не показывать». Формат
провода, коды и правило B8 не меняются.

### Как устроено сейчас (проверено по коду 2026-10-07)

- Реестр кодов: `packages/engine/src/host/meta/modules/chat/systemMessages.js`,
  `MESSAGE_CODES` (строки 5–51; в комментариях — английские тексты),
  `registerCodes` (слепой `Object.assign`, игровые коды), `buildSystemMessage`.
  Модуль импортирует и клиент (`client/main.js`, `client/session/GuestSession.js`,
  `client/session/PromotionFlow.js`). Движковые коды: `s:0…s:11`,
  `v:0…v:15`, `m:0…m:1`, `c:0…c:1`, `n:0…n:1`.
- Клиент: `packages/engine/src/client/components/model/Chat.js`.
  Конструктор: `this._messages = data.messages || {}` (строка 19).
  `updateChat(arr)` (строки 56–75): строку режет по `':'`, ищет
  `this._messages[group][index]`; нет текста (или он «ложный», в т.ч. `''`)
  → `return` без вывода. Параметры — `formatMessage(text, params.split(','))`
  (`lib/formatters.js`, плейсхолдеры `{N}`).
- Конструирование: `client/main.js` (строки ~1144–1152)
  `new ChatModel({ listLimit, lineTime, cacheMin, cacheMax, messages: chatData.params.messages, sanitizeMessage, formatMessage })`.
- `config/clientDefaults.js` (строки ~67–78) не задаёт `chat.params.messages`,
  и `lib/buildClientConfig.js` заменяет массивы целиком — поэтому
  умолчания **нельзя** класть в `clientDefaults` (массив `s` игры стёр бы
  их целиком). Тест `tests/lib/buildClientConfig.test.js` (строка ~79)
  проверяет, что там `messages` нет, — так и остаётся.
- CONFIG_DATA едет JSON'ом: «дыра» в массиве и `undefined` приходят как
  `null`. Значит, «текста нет» = `null`/`undefined`/индекс вне массива, а
  `''` — единственный способ явно заглушить сообщение.
- Правило контракта B8:
  `packages/engine/src/devtools/contract/rules/b8-system-messages.js`,
  `const RESERVED = { s: 11, v: 15, m: 1, c: 1, n: 1 };` (строка 7, не
  экспортируется; комментарий на строке 6 ссылается на несуществующий путь
  «client/config/chat messages»). C9 (`rules/c9-chat-messages.js`)
  проверяет тексты только **игровых** кодов — не меняется.
- Где игры держат тексты: `../vimp-tanks/src/config/client.js` (блок
  `messages`, с эмодзи в `s:4…6`), `../vimp-snakes/src/config/client.js`
  (переформулированы `s:0…4`, `c:1` с тремя параметрами) — **не трогаем**;
  шаблон `packages/create-vimp-game/templates/default/src/config/client.js`
  (строки ~94–138) и фикстура
  `packages/engine/tests/fixtures/miniGame/config/client.js` (строки ~59–96)
  — чистим (шаг 4). Замороженные поколения
  `packages/engine/tests/fixtures/generations/gen-api3|gen-api4` не трогать
  (их заморозку проверяет `tests/devtools/conformance.test.js`).
- Устаревшие диапазоны в тесте шаблона:
  `packages/create-vimp-game/templates/default/tests/host/hostPlugin.test.js`
  (строка ~37) — `{ s: 6, v: 5, m: 1, c: 1, n: 1 }` вместо
  `{ s: 11, v: 15, … }`.

## Шаг 1. Таблица текстов по умолчанию (тест первым)

1. Новый файл `packages/engine/src/config/chatMessages.js` (изоморфный, без
   импортов): `export default { s: [...], v: [...], m: [...], c: [...], n: [...] }`
   — английские тексты, индекс = номер кода. Тексты — **ровно** из
   текущего шаблона (`templates/default/src/config/client.js`, блок
   `messages`, группы `s/v/m/c/n`):
   - `s`: `'Team {0} is full. Your current team: {1}'`, `'Your team: {0}'`,
     `'Your new team: {0}'`, `'Your new status: spectator'`,
     `'{0} killed {1}'`, `'{0} joined the game'`, `'{0} left the game'`,
     `'Host changed'`, `'You are no longer the host (connection lost)'`,
     `'Host changed: the previous host was lagging'`,
     `'Host changed: the previous host went inactive'`,
     `'Host changed: the previous host had a poor connection'`;
   - `v`: `'A vote has been created'`, `'Voting has started'`,
     `'Your vote has been accepted'`, `'Voting is temporarily unavailable'`,
     `'Vote passed'`, `'Vote failed'`, `'Usage: /changehost'`,
     `'You are the host — use “Hand over host” in the room menu'`,
     `'No connection to the master server'`, `'A host vote was held recently'`,
     `'No other player can host'`, `'A host vote is already in progress'`,
     `'A host vote is not possible right now'`,
     `'Vote to change host passed ({0}/{1})'`,
     `'Vote to change host failed ({0}/{1})'`, `'Host vote cancelled'`;
   - `m`: `'Current map: {0}'`, `'Next map: {0}'`;
   - `c`: `'Command not found'`, `'Your rank: {0}'`;
   - `n`: `'Invalid name'`, `'{0} changed name to {1}'`.

   Комментарий файла (по-русски): почему тексты здесь, а не в
   `clientDefaults` (замена массивов при слиянии), правило перекрытия
   (`строка` игры > умолчание; `''` — заглушить; `null`/нет — умолчание),
   и что новый код движка добавляется в `MESSAGE_CODES`, сюда и в
   `RESERVED` правила B8 **одним изменением** (за этим следит тест ниже).

2. `b8-system-messages.js`: `export const RESERVED = …` (именованный
   экспорт, значение то же); комментарий над ним — ссылка на
   `config/chatMessages.js` вместо несуществующего пути.
3. Новый тест `tests/config/chatMessages.test.js`:
   - каждый код из `MESSAGE_CODES` (импорт `systemMessages.js` в отдельном
     файле теста — vitest изолирует модули по файлам, игровые
     `registerCodes` сюда не попадут) имеет непустой текст в таблице;
   - каждый индекс таблицы имеет код в `MESSAGE_CODES` (взаимно-однозначно);
   - для каждой группы `RESERVED[g] === chatMessages[g].length - 1`;
   - в таблице только группы `s, v, m, c, n`.

## Шаг 2. Подбор текста в `ChatModel` (тест первым)

`packages/engine/src/client/components/model/Chat.js`:

1. Конструктор: `this._defaults = data.defaultMessages || {};`.
2. Приватный метод:

   ```js
   // текст шаблона: строка игры важнее умолчания движка; '' — игра
   // заглушила сообщение; null/нет индекса — английское умолчание
   _template(group, index) {
     const own = this._messages[group]?.[index];

     if (typeof own === 'string') {
       return own === '' ? null : own;
     }

     const fallback = this._defaults[group]?.[index];

     return typeof fallback === 'string' && fallback !== '' ? fallback : null;
   }
   ```

3. `updateChat`: вместо проверки `!this._messages[arr[0]] || !this._messages[arr[0]][arr[1]]`
   — `const template = this._template(arr[0], arr[1]); if (template === null) return;`
   и далее `let message = template;`. Остальное без изменений.

`packages/engine/src/client/main.js` (строки ~1144–1152): импорт
`import engineChatMessages from '../config/chatMessages.js';` (группа
internal-импортов по правилу порядка) и `defaultMessages: engineChatMessages`
в опциях `ChatModel`.

Тесты — `tests/client/ChatModel.test.js` (рядом с существующими на
строках ~66–83; модель — синглтон, следовать тому, как файл уже сбрасывает
экземпляр между тестами):

- игра без группы `s` → `'s:5:Alice'` печатает `'Alice joined the game'`;
- игра с `s[5] = '⚡ {0} joined'` → печатается текст игры;
- игра с `s[7] = ''` → `'s:7'` ничего не печатает;
- игра с `s = ['a', null]` (как после JSON) → `'s:1:X'` берёт умолчание;
- игровая группа без текста (`'g:3'`) и неизвестная группа → ничего;
- параметры подставляются и в умолчание (`'v:13:3,5'` → `'Vote to change host passed (3/5)'`).

## Шаг 3. Решение «без capability»

Новую capability в `packages/engine/src/lib/capabilities.js` **не
заводить**: игра без текстов движковых кодов на старом движке теряет только
косметику, а `GameManifest.requires` по правилу CLAUDE.md — для того, без
чего игра не может работать. В лобби тексты берутся из движка мастера
(всегда свежего); сгенерированная игра пинит `vimp-engine ^<текущая>`
(скаффолдер берёт версию на релизе, `docs/en/publishing.md`). Если при
исполнении окажется, что это не так, — остановиться и спросить.

## Шаг 4. Шаблон и фикстура

1. `packages/create-vimp-game/templates/default/src/config/client.js`:
   из `chat.params.messages` удалить группы `s, v, m, c, n`, оставить
   игровую `g`. Комментарий над `messages` (английский — язык шаблона):
   движковые группы `s/v/m/c/n` имеют английские тексты по умолчанию в
   движке; игра перекрывает любой из них, задав строку по тому же индексу
   (например `s: [null, null, null, null, '⚔️ {0} killed {1}']` — массив
   до нужного индекса, `null` = «оставить умолчание»; разреженный литерал
   `[, , …]` не писать — его запрещает ESLint `no-sparse-arrays`), `''` —
   не показывать сообщение; игровая группа (`g`) — целиком своя.
2. `packages/engine/tests/fixtures/miniGame/config/client.js` — то же
   (остаётся только `g`).
3. `packages/create-vimp-game/templates/default/tests/host/hostPlugin.test.js`
   (строка ~37): `const reserved = { s: 11, v: 15, m: 1, c: 1, n: 1 };`.
4. Проверить, не опираются ли на удалённые тексты тесты шаблона
   (`templates/default/tests/config/contract.test.js`, строки ~132–140 —
   проверка текстов **игровых** кодов, должна остаться зелёной) и тест
   фикстуры `packages/engine/tests/fixtures/miniGame.contract.test.js`.
5. `npm run test:scaffold` — E2E скаффолдера зелёный.

## Шаг 5. Документация

Найти абзацы по цитатам (номера строк сдвигаются). en и ru — одинаково.

- `docs/{en,ru}/plugin-api.md`: строка таблицы владения «Chat (host +
  client MVC) | … + ALL message texts; … `v:6`–`v:15` …, which the game
  must also give texts for» → движок держит английские умолчания своих
  кодов; игра даёт тексты своих групп и может перекрыть движковые по
  индексу (`''` — заглушить).
- `docs/{en,ru}/host.md`: «… live on the client, and a code without a text
  is dropped there silently» → умолчания движка для `s/v/m/c/n`, игровой
  код без текста по-прежнему отбрасывается молча.
- `docs/{en,ru}/client.md`: абзац о чате/`/changehost` (коды `v:6…v:15`) —
  тексты по умолчанию; упомянуть `config/chatMessages.js` и правило
  перекрытия в разделе о `ChatModel`.
- `docs/{en,ru}/configuration.md`: пункт `chat` («system message templates
  (`messages`, game) … `s` (status/commands), `v` (votes), `m` (maps), `c`
  (teams), `n` (names)») — исправить смыслы групп (`s` — статусы, `c` —
  команды) и описать умолчания; новый раздел/строка для
  `src/config/chatMessages.js`.
- `docs/{en,ru}/network.md`, «### Chat (port 15)»: убрать `b` из списка
  групп (это группа tanks, не движка), сказать, откуда берётся текст.
- `docs/ai/03-host-plugin.md`, раздел «## `systemMessages`»: абзац «The
  client must have a text for **every** engine code too — a code without a
  text is silently dropped …» → правило умолчаний и перекрытия (с полной
  таблицей английских текстов движковых кодов — docs/ai самодостаточен).
- `docs/ai/04-client-plugin.md`, «## Chat»: пример `messages` — только
  игровая группа + пример перекрытия одного движкового индекса.
- `docs/ai/09-reference-implementations.md`: копия блока `messages`
  miniGame — синхронизировать с шагом 4.
- `docs/ai/10-pitfalls.md`, «## System messages and votes»: строку «The
  client needs texts for `v:6`–`v:15` like for every engine code» заменить
  на «engine codes have English defaults; `''` silences one».
- `docs/ai/11-authoring-workflow.md` и `docs/ai/12-questionnaire.md` —
  упоминания «нужны тексты для всех движковых кодов», если есть (поиск по
  `messages`, `s:7`, `v:6`).
- `docs/{en,ru}/scaffolding.md` — если описывает блок `messages` шаблона.

## Шаг 6. CHANGELOG

- `packages/engine/CHANGELOG.md` → `## [Unreleased]` → `### Added`
  (minor): «The client has English default texts for the engine's chat
  codes (`s`, `v`, `m`, `c`, `n` groups, `src/config/chatMessages.js`): a
  game's own text at the same index overrides one, an empty string silences
  it, and a game without a text no longer drops the engine's message. New
  engine codes need no game update.»
- `packages/create-vimp-game/CHANGELOG.md` → `## [Unreleased]` →
  `### Changed` (patch): «The generated game no longer carries texts for
  the engine's chat codes — the engine's English defaults apply; the
  template shows how to override one. The template's reserved-range test
  uses the engine's current ranges (`s` up to 11, `v` up to 15).»

## Проверки

`npx prettier --write <изменённые файлы>`, `npx eslint .`,
`npx vitest run --reporter=dot`, `npm run test:scaffold`,
`node packages/engine/bin/vimp-contract.js --game packages/engine/tests/fixtures/miniGame`
(если фикстура так проверяется — см. `miniGame.contract.test.js`).
Ручная: локальный матч tanks (тексты игры, эмодзи) и сгенерированной игры
(`npm run create:game <dir>`, затем `dev`) — сообщения «joined the game»,
«Host changed» видны на английском.

## Release impact

- npm `vimp-engine` — `### Added` → minor.
- npm `create-vimp-game` — `### Changed` → patch; выпускать **после**
  движка (скаффолдер на релизе пинит текущую версию движка).
- `../vimp-tanks`, `../vimp-snakes` — не затрагиваются, обновлять не нужно.
- `contract/surface.json` не меняется; `ENGINE_API_VERSION` не меняется.

## Критерии готовности

- Код движка без текста в игре показывает английское умолчание; текст игры
  его перекрывает; `''` глушит.
- Тест таблицы ловит рассинхрон `MESSAGE_CODES` / таблицы / `RESERVED`.
- Шаблон и miniGame без движковых текстов; E2E скаффолдера зелёный.
- Доки en/ru и docs/ai, оба CHANGELOG обновлены.
