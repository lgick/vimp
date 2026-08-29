# Plugin API (черновик)

> **Статус: черновик, частично в коде.** Контракты фиксируют целевую
> архитектуру отделения движка от игры (см. ADR в
> [architecture.md](architecture.md#adr-движок--приложение-игра--динамический-плагин)).
> Контракты реализуются поэтапно по плану миграции (`PLAN.md`). В коде уже
> есть: константа `ENGINE_API_VERSION`
> (`packages/engine/src/config/opcodes.js`), проверяется при загрузке
> плагина; объекты HostPlugin/ClientPlugin (`src/host/index.js`,
> `src/client/index.js` игры-плагина, например в `vimp-tanks`); сборка игры
> (её `vite.config.js`), выпускающая
> `dist/{client,host}-<hash>.js`, общий хешированный `.wasm`,
> `maps/*.json`, `sounds/*` и `manifest.json` (`npm run build` в репозитории игры), которую
> читает `GameCatalog` мастера (Этап 6.2, маршруты `/games/*`). Клиент (Этап
> 6.3) динамически грузит `ClientPlugin` из манифеста активной игры и зовёт
> `createClientCore`. Хост (Этап 6.4) динамически грузит `HostPlugin` по
> `entries.host` в `init` `host.worker.js` и зовёт `createCore` — движок
> больше не импортирует игру статически вовсе (`gameRegistry.static.js`
> удалён).

Движок — **приложение** (деплоится один раз: мастер, транспорт,
Worker-инфраструктура, мета-механизмы, MVC-каркас клиента, Rust-каркас).
Игра — **динамический плагин**: JS-бандлы (client/host), WASM-бинарь и
ассеты, загружаемые по манифесту с мастера. В перспективе один мастер
обслуживает несколько игр.

Четыре контракта, помеченные константой `ENGINE_API_VERSION` (владелец —
движок, `packages/engine/src/config/opcodes.js`, **заморожена на 4**). Метка
больше не гейт: за возраст плагин не отвергается никогда. Единственная
причина отказа — плагин просит через необязательное поле манифеста
[`requires`](#requires-и-возможности-движка) возможность, которой в этой
сборке движка нет, то есть он *новее* движка:

1. **GameManifest** — JSON-описание сборки игры (мастер → лобби/хост/клиент);
2. **HostPlugin API** — default export host-entry игры (worker-safe);
3. **ClientPlugin API** — default export client-entry игры;
4. **Wasm Host ABI** — обязательный набор методов WASM-классов игры.

## GameManifest

Генерируется сборкой игры в `dist/manifest.json` игры-плагина (например, в
`vimp-tanks`; мастер отдаёт его под `/games/<id>/`); версия — хеш
контента бандлов (по образцу `WorkerCatalog`). **Мастер не исполняет код
игры** — ему хватает манифеста и статических JSON карт (продукт
`maps:export` при сборке игры).

```jsonc
{
  "id": "tanks",
  "engineApi": 3,
  "version": "<hash>",                     // gameVersion (контент client+host+wasm)
  "title": "VIMP Tanks",                   // для лобби
  "entries": {
    "client": "/games/tanks/client-<hash>.js",  // ESM, default export = ClientPlugin
    "host":   "/games/tanks/host-<hash>.js",    // ESM worker-safe, default export = HostPlugin
    "wasm":   "/games/tanks/core-<hash>.wasm",  // единый hashed .wasm обоих entry (общий HTTP-кеш)
    "wasmNode": "./core-node/index.js"          // ОПЦИОНАЛЬНО: node-сборка ядра внутри dist/, для `npm run sim` и dedicated-сервера
  },
  "assetsBase": "/games/tanks/",           // база собственных ассетов пакета:
                                           // sounds/ и img/ (см. ниже)
  "requires": ["accolades"],               // ОПЦИОНАЛЬНО: возможности движка, без
                                           // которых игра не работает (см. ниже)
  "maps": { "version": "<hash>", "list": ["pool mini", "canopy", "garden"] },
  "roomDefaults": { "maxPlayers": 8, "roundTime": 120000, "mapTime": 600000,
                    "friendlyFire": false, "map": "pool mini" },
  "roomForm": [
    // regExp И min/max у maxPlayers/roundTime/mapTime генерирует
    // build-game-manifest.js из одних и тех же границ — точный диапазонный
    // паттерн (например, "^([1-8])$" для maxPlayers 1..roomDefaults.maxPlayers)
    // плюс сами два числа, из которых он собран, а не вручную в game.js;
    // здесь опущен для читаемости
    { "name": "maxPlayers", "control": "text", "label": "Max players", "numeric": true, "min": 1, "max": 8, "regExp": "<сгенерирован>" },
    { "name": "roundTime", "control": "text", "label": "Round time", "unit": "s", "numeric": true, "min": 10, "max": 3600, "regExp": "<сгенерирован>" },
    { "name": "mapTime", "control": "text", "label": "Map time", "unit": "s", "numeric": true, "min": 10, "max": 3600, "regExp": "<сгенерирован>" },
    { "name": "friendlyFire", "control": "checkbox", "label": "Friendly fire" },
    { "name": "map", "control": "select", "label": "Map", "source": "maps" }
  ]
}
```

`roomForm` — явный упорядоченный массив дескрипторов полей, из которого
рендерится форма «Create server» (см. [Схему формы](#схема-формы) ниже);
`roomDefaults` остаётся источником значений по умолчанию и начальным
набором ключей комнаты. Манифест без `roomForm` рендерит пустую форму
создания комнаты (с предупреждением в консоли) вместо вывода контролов из
типа значений `roomDefaults`.

`entries.wasmNode` **опционально** и браузером не используется: это путь
(относительно манифеста) к **node**-сборке того же WASM-ядра, которую берёт
headless-runner `npm run sim -- --game <пакет>` (см.
[debugging.md](debugging.md)) и [dedicated-сервер](dedicated.md), который
крутит авторитетный матч внутри процесса Node. Для игры, которую собираются
держать на dedicated-боксе, поле поэтому фактически обязательно: там нет
подмены через `--core`, и игра без него роняет сервер на старте. Путь
обязан вести **внутрь публикуемого
`dist/`** (конвенция — `./core-node/`, куда сборка копирует свой
`core/pkg-node/`): каталог wasm-pack'а обычно git-ignored, а npm применяет
ignore-правила и внутри каталогов из `files`, так что манифест с путём
наружу работает в чекауте и ломается в установленном пакете. Без него
игру всё ещё можно прогнать headless, передав `--core <путь>` явно; игра, у
которой нет ни того, ни другого, просто не симулируется на своём настоящем
ядре. Если поле объявлено, файл обязан быть в пакете **как опубликован** —
загрузчик проверяет это и называет нарушенный контракт; заодно обе половины
плагина сверяются с `engineApi` манифеста (пересобранный манифест рядом с
отставшим `dist/` — это отказ, а не зелёный прогон).

Из-за него `createCore`/`createClientCore` получают `wasmUrl` **в двух
видах**: браузер передаёт URL `.wasm`-ассета, headless-раннер — `file:`-URL
node-глюe (`wasmNode`). Плагин, которому нужны headless-прогоны, ветвится
по суффиксу — у сборки `--target nodejs` wasm подгружает сам модуль,
поэтому `init()` там нет:

```js
async createCore(coreConfigJson, { wasmUrl }) {
  if (wasmUrl?.endsWith('.js')) {
    const node = await import(/* @vite-ignore */ wasmUrl);

    return new node.GameCore(coreConfigJson);
  }

  await init({ module_or_path: wasmUrl });

  return new GameCore(coreConfigJson);
}
```

Проекции: **мастер** — весь манифест + раздача `/games/:id/maps/*`;
**хост** — `entries.host` (dynamic import в Worker'е) + `entries.wasm` +
карты с мастера; **клиент** — `entries.client` (dynamic import после выбора
комнаты) + `entries.wasm` + `assetsBase`. Богатые схемы (панель, тексты,
keysets) в манифест **не входят** — едут кодом плагинов и, как сейчас,
данными CONFIG_DATA (порт 0) от хоста: клиентские данные игры всегда
согласованы с хостом комнаты.

`assetsBase` — корень **всего, что пакет везёт файлами**; по соглашению это
два каталога внутри `dist/`:

| Путь | Содержимое | Кто разрешает |
| --- | --- | --- |
| `${assetsBase}sounds/` | пара `webm`+`mp3` на каждый звук | движок (`SoundManager`, он перезаписывает `sounds.path`) |
| `${assetsBase}img/` | тайл-листы и спрайты динамических тел карт | собственный part плагина, через сервис `assetsBase` |

Движок **не раздаёт ни одного игрового файла**: имя из `spriteSheet.img`
карты разрешается относительно пакета плагина, а не бандла движка. База
доезжает до part'а сервисом `assetsBase` — объявите его в
`componentDependencies` (см. [client.md](client.md), «Провайдеры»).

## Схема формы

Единый контракт дескриптора поля — общий для формы создания комнаты
(`roomForm`, выше) и формы игрока (`authSchema.params[].options`, ниже):
обе рендерятся одним и тем же модулем движка,
`packages/engine/src/client/lib/formBuilder.js`. Движок рендерит **только**
то, что описано в дескрипторе — вывода контрола из типа значения больше
нет. Каждый контрол — обычный **нативный** элемент формы, без тематической
кастомизации: форма плагина всегда выглядит как остальная страница.

Разграничение назначения (важно для контракта):
- **Room-форма** (главное лобби) — настройки *сервера*: лимит игроков,
  число команд, время раунда/карты, карта, огонь по своим.
- **Auth-форма** (`#auth`, показывается на комнату) — настройки *игрока*:
  цвет, модель, оружие и т.п.

Форма — **упорядоченный массив дескрипторов** (порядок массива = порядок
полей):

```js
{
  name:    'maxPlayers',      // ключ значения
  control: 'text',            // 'select'|'text'|'checkbox'|'radio'
  label:   'Max players',     // подпись (fallback — `name`)
  default: 8,                 // значение по умолчанию
  hidden:  true,               // поле строится и участвует в сабмите, но .form-row не рендерится
  // числовые text-поля (unit задан, или numeric:true): значение парсится
  // как Number и конвертируется через ту же единицу, что default/хранимое
  // значение (мс для unit:'s') — formBuilder сам конвертирует туда-обратно.
  // Чтение такого поля никогда не даёт 0 на пустом/невалидном вводе — оно
  // откатывается к `default`, — но до сабмита дело не доходит: числовое
  // поле неявно `required` («required» на пустом, «must be a number» на
  // непарсящемся), потому что молча создать комнату по дефолту — не то, о
  // чём просил игрок
  numeric: true,
  unit:    's',                // значение хранится в мс, показывается/редактируется в секундах
  // границы числового text-поля (в единице отображения, например в
  // секундах для unit:'s'): рендерятся суффиксом «(min–max)» в подписи
  // (вместе с unit — например «(s, 10–3600)»), и проверяются
  // collectFormErrors ниже. Любой из ключей можно опустить (в подсказке
  // покажется «…», в валидации не проверяется)
  min: 1,
  max: 8,
  // валидация (text): движок никогда не показывает нативные браузерные
  // попапы валидации — collectFormErrors()/renderFormErrors()
  // (formBuilder.js) проверяют каждый отрисованный контрол перед сабмитом
  // (room-форма — клик по «Create server»; auth-форма — клик по
  // «#auth-enter») и рисуют каждое невалидное поле строкой в
  // #lobby-error/#auth-error, заменяя reportValidity(); заголовок строки —
  // `label` этого поля
  regExp:    '^#[0-9a-f]{6}$', // сверяется со ВСЕЙ отображаемой строкой:
                              // движок оборачивает его в ^(?:…)$ ровно так
                              // же, как браузер применяет атрибут
                              // `pattern`, — пишите без якорей (свои ^/$
                              // безвредны). Некомпилируемый паттерн — не
                              // ограничение вовсе: поле проходит, движок
                              // пишет console.error, а `vimp-contract`
                              // (правило B5) ловит это до раздачи игры
  required:  true,
  maxlength: 32,
  // варианты (select/radio):
  options: [{ value, label }],// или простой массив, например ['a', 'b']
  source:  'maps',            // источник вариантов из каталога движка вместо `options` (сегодня только карты)
  // auth-специфика (настройки игрока):
  storage: 'playerColor',     // ключ localStorage для запоминания выбора между сессиями
}
```

`control` → разметка, всё рендерит `formBuilder.js` нативными элементами:
- `select` — `<select>` (из `options` или `source:'maps'`); дескриптор
  `select` (или `radio`), у которого после резолва **ровно один** вариант,
  строится и участвует в сабмите как любое другое поле, но его `.form-row`
  не рендерится — игроку нечего в нём выбирать. Этот единственный вариант
  становится **принудительным** значением: `setValue()` у поля — no-op,
  поэтому ни запомненное в `storage` значение, ни `default` для варианта,
  которого в списке больше нет, не могут рассинхронизировать скрытый
  контрол. **Ноль** вариантов — это дефект схемы или каталога, а не
  «нечего выбирать»: строка рендерится (пустой контрол), движок пишет
  `console.error`, а поле всегда валится с `no options available` — вне
  зависимости от `required`: отправлять нечего, а «required» повело бы
  игрока туда, где ничего нет.
- `text` — `<input type=text>`; числовые поля (`numeric`/`unit`)
  конвертируют туда-обратно единицу хранения. `regExp`/`required`
  проставляются на контрол как `pattern`/`required` только ради семантики
  (ни одна из форм не `<form>`, и `reportValidity()` движок не зовёт);
  реально работает сам по себе лишь `maxlength` — он ограничивает ввод.
- `checkbox` — `<input type=checkbox>` (булевые настройки).
- `radio` — группа `<input type=radio>` с общим сгенерированным `name`,
  по одному на вариант.

**Словарь `control` — append-only.** Он живёт в реестре движка
(`packages/engine/src/lib/formControls.js`), из которого строка не исчезает
никогда: имя, которое уже опубликованная игра написала в своём манифесте,
работает вечно (И1). Именно сокращение набора сломало v2 → v3 — выброшенные
тогда четыре контрола вернулись навсегда, алиасами своих нативных замен:

| Выведенный `control` | Строится как | Когда |
| --- | --- | --- |
| `range` | `text` + `numeric: true` | выведен в v3 |
| `number` | `text` + `numeric: true` | выведен в v3 |
| `toggle` | `checkbox` | выведен в v3 |
| `segmented` | `radio` | выведен в v3 |

Алиас разрешается до выбора билдера и до валидации, поэтому выведенное
числовое поле сохраняет проверки `min`/`max`/`regExp`, а не вырождается в
свободный текст. **Новая** игра должна писать нативный контрол сама:
`vimp-contract` (правило B5) сообщает о выведенном предупреждением, а не
ошибкой. Контрол, которого реестр не знает вовсе, — это плагин, попросивший
будущее: поле пропускается с `console.error`, остальная форма рендерится.

**Разделение валидации.** `roomForm` едет клиенту как JSON манифеста игры
(`/games/<id>/manifest.json`) — функции не переживают сериализацию в JSON,
поэтому room-форма получает только декларативные проверки выше, в таком
порядке: `no options available` (пустой `select`/`radio`) → пустота
(`required`, у числового поля включён всегда; текст перед проверкой
триммится, поэтому поле из одних пробелов считается пустым) → «must be a
number» → `min`/`max` → `maxlength` → `regExp`. Диапазон проверяется раньше
паттерна намеренно: сгенерированный `regExp` кодирует те же границы, но
«must be ≤ 32» повторяет подсказку из подписи поля, а «invalid format» не
говорит ничего — паттерну остаётся ловить то, чего диапазон не ловит
(дробное, ведущий ноль). **Поля без отрисованной строки** — `hidden: true` и
`select`/`radio` с единственным вариантом выше — валидация пропускает:
игрок такую ошибку не видит и исправить не может, показать её значит
запереть форму. Авторитетную границу значений
комнаты всё равно накладывает Worker хоста при создании комнаты (клампы
таймеров/лимита в `applyRoomOverrides.js`, которую вызывает
`host.worker.js`). Auth-форма приходит из кода плагина (`authSchema`),
поэтому у неё есть и те же декларативные проверки, и JS-валидаторы
(`authSchema.validators`, резолвятся через `validateAuth` на хосте и
зеркалятся на клиенте, рендерятся тем же `renderFormErrors`).

Для auth-формы декларативную часть повторяет и сам хост — чтобы клиент,
обошедший форму, не получал больше прав, чем заполнивший её. `validateAuth`
проверяет, в таком порядке и до JS-валидатора: длину (`too long`), членство
в объявленном списке `options` поля `select`/`radio` (`not an option` —
браузер другого значения и не отправит, значит не должен и обошедший форму
клиент; поле с пустым или отсутствующим `options` не принимает *ничего* —
ровно как форма, которая отказывает ему безусловно, `no options available`;
список из `source` не проверяется, каталоги хост не резолвит), затем
`regExp` (`invalid format`, якорится ровно так же, как в браузере).
`maxlength` и `regExp` применяются только к текстовым полям — ровно как в
форме.

Поле без `maxlength` всё равно ограничено потолком в **256 символов**:
`regExp` игры теперь исполняется на хосте — в Worker'е с авторитетным матчем
или в процессе `dedicated` целиком, — а катастрофический паттерн вроде
`(a+)+b` превращает несколько десятков символов в минуты заблокированного
event loop.

Три осознанных пробела. `required` на хосте **не** проверяется: solo-путь
(`boot.autoAuth`) отвечает дефолтами схемы, среди которых бывает `''`,
поэтому пустое значение проверки выше пропускают и оно остаётся делом
игрового валидатора. `min`/`max` не применяются и не могут пригодиться:
числовое поле отдаёт *число*, а нестроковое значение `validateAuth` отбивает
сразу (`Property must be a string`) — числовых полей в `authSchema` не
бывает. А `regExp`, который не компилируется, — дефект схемы, а не
ограничение, и поле проходит (как и на клиенте).

Имя `validator`, которого нет в `authSchema.validators` **как функции**,
оставляет поле непроверенным вовсе: хост молча пропускает его, а не зовёт
не-функцию. Статически об этом сообщает `C10`, а при сборке порт-машины —
`console.error` хоста, для тех, кто контракт-чекер не запускает.

Форма **проверяет себя по ходу ввода**: значение вне диапазона видно сразу,
как введено, а не по следующему клику, и строка уходит, когда починено
именно её поле, — список того, что ещё не так, переживает первое нажатие
клавиши. До первого сабмита говорить о себе могут только поля, которых
игрок уже касался: «required» на поле, которое ещё не открывали, — шум.
Сабмит снимает этот фильтр: клик — ответ за форму целиком. Пересборка формы
(смена игры в лобби) возвращает всё в исходное.

Ошибки от сервера (`AuthView.renderError`) — снимок последнего сабмита:
перепроверить их движок не может, поэтому любая правка формы их снимает, а
следующий сабмит принесёт заново те, что остались в силе. Текстовые
значения триммятся не только при проверке, но и при чтении — поле отдаёт ту
же строку, которую проверяли, и клиент не отправляет `"  Bob  "`, оставляя
отказ хосту.

Где живёт каждая половина контракта:
- **Room-форма**: `GameManifest.roomForm` (рядом с `roomDefaults`, который
  остаётся источником значений по умолчанию и начального набора ключей
  комнаты).
- **Auth-форма**: те же дескрипторы едут по проводу в
  `PS_AUTH_DATA.params[].options` — см.
  [network.md](network.md#авторизация-порт-1) — `params[i]` — это
  `{ name, value, options }`, где `options` несёт
  `control`/`label`/`unit`/`numeric`/`min`/`max`/`options`/`source`/`storage`/`regExp`/`required`/`maxlength`/`hidden`
  (плюс уже существующий ключ `validator`, резолвится через
  `authSchema.validators`).

Манифест/authSchema без схемы рендерит пустую форму (room-форма —
предупреждение в консоль; auth-форма — без полей, `#auth-enter` по-прежнему
работает) вместо тихого отката к выводу контрола из типа значения — плагин,
переезжающий на этот контракт, получает явный сигнал, а не тихую потерю
полей.

## HostPlugin API

Default export host-entry игры. Обязан быть worker-safe (без DOM и
Node-глобалов).

```js
export default {
  id: 'tanks',
  engineApi: 3,
  async createCore(coreConfigJson, { wasmUrl }) { /* init(wasmUrl); return new GameCore(...) */ },

  gameConfig: {                       // игровая половина бывшего config/game.js
    teams: { team1: 1, team2: 2, spectators: 3 },   // произвольное число команд — обязательное поле
    spectatorTeam: 'spectators',      // необязательное: по умолчанию ключ 'spectators' из teams
    // noSpectators: true,            // opt-in: наблюдателей нет вовсе — ровно одна команда,
    //                                // подключившийся входит в неё сразу, без голосования
    // endlessRound: true,            // opt-in: движок сам раунд не перезапускает
    parts: { models, weapons, friendlyFire },   // из src/data игры-плагина (например, vimp-tanks)
    snapshot,                         // снапшот-схема ключей (config/snapshot.js) — обязательное поле
    playerKeys, // spectatorKeys — движковые (наблюдение — механизм движка)
    panel: { fields: { health: {key:'h', value:100}, w1: {…}, w2: {…} }, activeKey: 'wa' },
    stat:  { columns: {name:{…}, status:{…}, score:{…}, deaths:{…}, latency:{…}} },
    scripted: { namePrefix: 'Bot', defaultModel: 'm1' },   // вместо хардкодов Bot${id}/'m1'
    mapScale: 0.3, mapSetId: 'c1', mapsInVote: 4, defaultMap: 'pool mini',
    chatMaxLength: 60,
    initialVote: 'teamChange',        // вместо хардкода SocketManager.sendFirstVote
    soundCues: { roundStart:'roundStart', victory:'victory', defeat:'defeat',
                 frag:'frag', death:'gameOver' },          // вместо хардкодов SocketManager
  },

  buildClientGameConfig(),            // game-секция CONFIG_DATA (см. ниже)
  // init-JSON ядра движок собирает сам из gameConfig
  // (packages/engine/src/lib/coreConfig.js) — плагин-хук не нужен
  authSchema: { elems: { authId:'auth', errorId:'auth-error',
                         enterId:'auth-enter', fieldsId:'auth-fields',
                         titleId:'auth-title', informsId:'auth-informs' },
                params: [
                  { name: 'model', value: 'm1', options: {
                      control: 'select', label: 'Model',
                      options: ['m1', 'm2'], storage: 'playerModel',
                      validator: 'isValidModel' } },
                ],
                validators: { isValidModel: v => v in models },
                texts: { title, sections } },   // тексты формы для нейтрального каркаса auth.pug

  onCoreEvent(data, { vimp, panel }),  // только 'custom'-события; стандартные роутит движок
  chatCommands: [{ name: '/bot', handler(ctx, gameId, args) {…} }],   // обязательное поле — регистрация в CommandProcessor
  systemMessages: { BOT_PLAYERS_ONLY: 'b:0', … },                     // merge в реестр кодов движка
  // статических определений голосований нет: игровые голосования создаются
  // динамически через ctx.voteCoordinator.createVote(...) из чат-команд

  createModules(ctx) { return { scripted: new MyBotManager(ctx) }; },
  // ctx = { participants, coreAdapter, panel, stat, chat, socketManager,
  //         scripted /* параметры gameConfig.scripted */ }
  // обработчики чат-команд получают другой, мета-уровневый ctx от
  // CommandProcessor: { participants, chat, scripted, roundManager,
  //   voteCoordinator, timerManager, teams, spectatorTeam, spectatorId,
  //   isDevMode }
  // Контракт scripted-модуля (дергает движок — RoundManager/HostGame):
  //   createMap(scaledMapData), createScripted(count, team?), removeScripted(team?),
  //   removeOneForHuman(team), getCount(), getCountsPerTeam()
};
```


### Поля `gameConfig` и их умолчания

Движок читает `gameConfig` через один модуль —
`packages/engine/src/lib/gameConfigView.js`. `createGameConfigView(gameConfig,
gameId)` проверяет обязательные пути, подставляет умолчание для всего
остального и возвращает замороженное представление; хост, конфиг ядра,
`applyRoomOverrides` и standalone SDK читают его, а не исходный объект
(следит ESLint-правило). Игра, которая о поле никогда не слышала, поэтому
остаётся валидной — инвариант И2 ниже.

**Обязательные — четыре пути, и список может только сокращаться:**

| Путь | Почему движку нечем его заменить |
| --- | --- |
| `parts.models` | из чего состоит участник; синтезировать нечем |
| `playerKeys` | без них ядро не знает ввода |
| `snapshot` | раскладка кадра; движок её не придумывает |
| `teams` | `ParticipantManager` выбирает команду входа |

**У всего остального есть умолчание:**

| Поле | Умолчание | Что будет, если не объявить |
| --- | --- | --- |
| `title` | `null` | лобби берёт `HostPlugin.id` |
| `maps` | `{}` | карты приезжают от мастера (`room.maps`) |
| `currentMap` | `null` | берётся первая карта каталога |
| `mapsInVote` | `1` | одна карта в голосовании |
| `mapScale` | `1` | ядро масштабирует геометрию 1:1 |
| `mapSetId` | `null` | нет id набора тайлов по умолчанию |
| `roomDefaults.maxPlayers` | `hostDefaults.maxPlayers` (30) | комнату ограничивает движковый лимит |
| `parts.weapons` | `{}` | игра без оружия (`@vimp-games/snakes`) |
| `parts.friendlyFire` | `false` | огонь по своим выключен, пока не включит комната |
| `panel.fields` | `{}` | пустая панель рисуется корректно |
| `panel.activeKey` | `null` | подсвеченной ячейки панели нет |
| `stat` | `{}` | своих колонок сверх движковых нет |
| `scripted` | `{}` | `ParticipantManager` именует участников сам |
| `playerState` | `{}` | стартового сохранённого состояния нет |
| `soundCues` | `{}` | движок не шлёт звуковых сигналов |
| `initialVote` | `null` | участник заходит без голосования |
| `statMode` | `'table'` | по Tab движок рисует таблицу комнаты |
| `noSpectators` | `false` | наблюдатели существуют как концепция |
| `endlessRound` | `false` | движок сам перезапускает раунд |
| `spectatorTeam` | выводится | `null` под `noSpectators`; иначе ключ `spectators` из `teams`, иначе `null` с `console.warn` |

Согласованность того, что игра прислала, по-прежнему проверяется и
по-прежнему бросает: объявленный `spectatorTeam` обязан быть ключом `teams`,
а `noSpectators` требует ровно одной команды. Правило контракта **B3**
сообщает предупреждением о каждом поле, оставленном на умолчание, — опора на
него остаётся осознанным выбором.

Через `participants` игра может задать и цвет ника в чате:
`participants.setChatColor(gameId, '#rrggbb')` (или `null` — цвет команды).
Ставится один раз, когда игра узнала цвет игрока, и применяется движком к
каждому его сообщению — см. [docs/ai/03-host-plugin.md](../ai/03-host-plugin.md).

Ботов в движке нет — только нейтральное понятие **«скриптовый участник»**
(геттер `isScripted`; слова «bot» в коде движка не остаётся). Движковая
политика «scripted уступают место людям» остаётся generic.

## ClientPlugin API

Default export client-entry игры.

```js
export default {
  id: 'tanks',
  engineApi: 3,
  async createClientCore(clientConfigJson, { wasmUrl }) { /* init(wasmUrl); return { core, memory } */ },
  parts:  { Map, MapRadar, Tank, TankRadar, Bomb, ExplosionEffect, Smoke, Tracks, ShotEffect },
  bakers: { explosionTexture, …, trackMarkTexture },
  styles: '…css…',                    // игровой CSS (спрайты оружия панели и т.п.)
  hooks: {
    onAuth(core, authData)   { core.set_model(authData.model); },
    onPanel(core, panelData) { core.sync_panel(JSON.stringify(panelData)); },
    onLocalAction(core, action, name, now) { /* try_fire / cycle_weapon; → JSON спавна | null */ },
    services(core) { return { mapDynamics: /* … */ }; },  // необязательный
  },
};
```

`hooks.services(core)` — **необязательный**: возвращает игровые сервисы,
которые подмешиваются в клиентский пул рядом с движковыми (`renderer`,
`soundManager`, `localPlayer`, `assetsBase`) и доходят до part'а по
`componentDependencies`. Так part говорит со своим игровым ядром, а движок не
знает, что именно ему отдают: плагин танков раздаёт так `mapDynamics`
(`toWorld(key, localX, localY)` поверх `ClientCore.map_dynamics_to_world`),
чтобы эффект выстрела привязал осколки к задетому ящику. При совпадении имён
побеждает движковый ключ.

**Ключевое: модули Stat/Panel/Vote/Chat — движковые, но вся их
параметризация — из конфига игры.** Следствия:

| Движковый модуль | Что поставляет игра (через CONFIG_DATA / gameConfig) |
| --- | --- |
| Panel (host + client MVC) | схема полей (`fields` + типы отображения: bar/число/время/иконка-оружия), `activeKey`; движковый PanelView **генерирует DOM по схеме** (замена хардкода `panel.pug` `#panel-health/-bullet/-bomb/-time`), внешний вид полей — CSS игры |
| Stat (host + client MVC) | колонки (имена/методы агрегации) и **список команд произвольной длины**; движковый StatView **генерирует таблицы по числу команд** (замена хардкода `stat.pug` `#team1/#team2/#spectators` и 5 фиксированных колонок) |
| Vote (host + client MVC) | игровые голосования создаются динамически (`voteCoordinator.createVote` из обработчиков чат-команд) + все шаблоны/меню (тексты); движковые голосования механизмов (teamChange, mapChangeByUser/BySystem) остаются в движке, их тексты — тоже у игры |
| Chat (host + client MVC) | игровые коды системных сообщений (группа `b:*` и будущие) + ВСЕ тексты сообщений; движок владеет механизмом и кодами своих механизмов (`s/v/m/c/n`) |
| CommandProcessor | ВСЕ чат-команды: движок своих не разбирает, реестр целиком наполняет игра (`/bot`, `/name`, `/nr`, `/timeleft`, `/mapname`, `/rank`) |
| RoundManager / ParticipantManager | `teams` (произвольные), `spectatorTeam`, respawns из карт, `scripted`-параметры; в движке — нейтральный «scripted participant» |
| SocketManager | `soundCues` (какой звук на какое движковое событие), `initialVote` |
| SoundManager (client) | список звуков + файлы (`assetsBase`) |
| Controls (client) | player-keyset и раскладка; спектаторский набор — движковый |
| Auth | схема формы (`authSchema`) + валидатор модели |

Обхода схемы через `views` не существует: у `ClientPlugin` нет поля для
своего Panel/Stat view-класса, и никакой код загрузки плагина его не
валидирует и не читает — сегодня единственная реализация — движковые
schema-generated PanelView/StatView. Радиальные/canvas-индикаторы возможны
и без этого: HUD-сущность на canvas — обычный `part`.

## Wasm Host ABI (v1)

Обёртки `#[wasm_bindgen] GameCore/ClientCore` живут в game-crate
(wasm-bindgen не экспортирует generics), но обязательный набор методов
фиксирует движок (часть `engineApi`) — их вызывает движковый JS. Принцип:
**горячий путь без JSON** (скаляры + zero-copy указатели); JSON —
конструктор/карта/события/редкие запросы.

Бойлерплейт делегации (40 методов на два класса) снимают движковые макросы
`export_game_core_abi!($Sim)` / `export_client_core_abi!($Client)`
(`macro_rules!` в `vimp-engine-core` — единственный источник истины
обязательного набора, дрейф исключён): game-crate вызывает их рядом со
своими дополнительными методами (`try_fire`, `set_model`, `sync_panel`,
кастомные аргументы `spawn_actor`). Раскрытие происходит в game-crate,
поэтому `#[wasm_bindgen]`/`JsError` резолвятся против его зависимостей —
engine-crate от wasm-bindgen не зависит вовсе.

**GameCore** — методы жизненного цикла участников:
`spawn_actor`/`remove_actor`/`reset_actor` (человек),
`spawn_scripted_actor`/`remove_scripted_actor` (scripted, было
`spawn_tank`/`remove_tank`/`reset_tank`/`add_bot`/`remove_bot`).
Без изменений: `new(configJson)` (формат
`{engine:{timeStep,seed,snapshot,mapScale,mapSetId}, game:{models,weapons,panel,playerKeys,friendlyFire}}`),
`load_map`, `map_info`, `apply_input`, `apply_aim` (ввод указателем),
`step`, `take_events`, `pack_body`,
`pack_frame`, `body_has_events`, `frame_ptr/frame_bytes`, `is_alive`,
`position_of`, `players_data`, `alive_players`, `last_input_seq`,
`reset_all_vitals`, `remove_players_and_shots`, `clear`,
`serialize_state/deserialize_state`, `debug_json` (курированный дамп мира
для отладки — см. [debugging.md](debugging.md); генерируется макросом, игра
не реализует ничего).

Стандартный словарь событий `take_events` (убирает игровой словарь из
`GameCoreAdapter._drainEvents`):

```jsonc
[{ "type": "panelSet",    "id": 3, "field": "health", "value": 55 },   // field — имя поля схемы панели
 { "type": "panelActive", "id": 3, "field": "w2" },
 { "type": "death",       "victim": 3, "killer": 1 },
 { "type": "shake",       "id": 3, "intensity": 20, "duration": 200 },
 { "type": "custom",      "data": {…} }]                                // → HostPlugin.onCoreEvent
```

**ClientCore** — движковый минимум: `new`, `push_frame`, `my_game_id`,
`offset`, `sample`, `hot_ptr/hot_values`, `take_frames`, `apply_input`,
`apply_aim` (ввод указателем),
`set_active`, `set_map`, `reset`, `resync` (чистит только сетевую половину —
буфер и очередь кадров — после долгой паузы вкладки, предикт и идентичность
сохраняются), `decode_frame` плюс отладочная пара
`debug_json` и `take_divergence` (тоже из макроса). Игровые методы
(`set_model`, `try_fire`, `cycle_weapon`, `sync_panel`) в минимум не
входят — их зовут только хуки ClientPlugin; до своей половины ядра игра
добирается через `ClientState::game()`, когда её обёртка ABI отдаёт наружу
что-то своё (так плагин танков отдаёт геометрию предсказанной динамики
карты).

Payload `set_map`, который движок передаёт ядру, — `{map, step, scale,
setId, physicsStatic, physicsDynamic}`: сырые поля MAP_DATA без масштаба
(ядро масштабирует их само). `setId` — ключ снапшота, которым едет динамика
этой карты (`c1`/`c2`): без него игра не отличит свой блок динамики от блока
чужого конструктора карт.

Два **опциональных** trait-метода `GameClientDef` уточняют детектор
рассинхрона предикта и имеют дефолт `None`, так что плагин вправе их
игнорировать: `predicted_state() -> Option<[f32; PLAYER_STATE_LEN]>`
(предсказанное состояние в раскладке player-блока, сравнивается
покомпонентно с авторитетным кадром) и
`replayed_inputs() -> Option<(f64, f64, usize)>` (окно истории ввода,
переигранное последним реконсилем). Без них движок сравнивает камеру
`render_overlay()` с `state[0]`/`state[1]` player-блока кадра — а это
контракт на раскладку: если первые два компонента не мировые x/y,
реализуйте `predicted_state()`, иначе фолбэк выдаёт бессмысленные
нарушения. См.
[debugging.md](debugging.md#детектор-рассинхрона-предикта).

### Таблица экспортов заморожена — новое приезжает опкодом

Набор методов выше **заморожен навсегда** (инвариант И3 плана
`plan/plugin-forward-compat`). `.wasm` игры компилируется один раз: таблица
экспортов фиксируется в момент `wasm-pack build`, и никакой шим на стороне
движка не синтезирует символ, которого в ней нет. Значит, движок, который
дописывает в таблицу метод, состаривает каждую опубликованную игру, — а
смена сигнатуры хуже отсутствия метода: glue-код wasm-bindgen в старом
`dist` молча выбросит лишний аргумент вместо того чтобы упасть. Метод можно
*удалить* (старое ядро его всё ещё экспортирует, движок перестаёт звать), но
не переименовать и не изменить. Страж — `tests/devtools/surface.test.js`,
раздел `abi`.

Рост идёт через два метода, которые генерирует макрос:

- `abi_describe() -> String` — самоописание ядра,
  `{"abi":1,"core":"0.9.0","ops":["debug.json"]}`: версия формата самого
  самоописания, версия `vimp-engine-core`, с которым собрано ядро, и опкоды,
  которые это ядро понимает (движковые, известные макросу, плюс объявленные
  игрой). Движок читает его один раз, при загрузке ядра, — и решения,
  принимаемые заранее (какую ветку упаковки выбрать, показывать ли поле
  формы, что сообщить лобби), больше не ждут вызова посреди матча. У ядра,
  собранного до появления механизма, метода нет: это поколение 0
  (`{abi: 0, core: null, ops: []}`), а не ошибка.
- `dispatch(op: &str, payload: &[u8]) -> Vec<u8>` — единственная точка входа
  для любой необязательной возможности. Пустой возврат означает «опкод не
  обработан» (вызывающий идёт по запасному пути), однобайтовый маркер
  `[0x00]` — «обработан, ответа нет». Нагрузка и ответ — сырые байты;
  кодировка каждого опкода записана в append-only реестре движка
  `src/config/abiOps.js` рядом с его именем вида `<область>.<действие>`
  (`debug.json`, `state.replaySeek`).

Игра расширяет `dispatch` двумя методами трейта `GameSim` с реализацией по
умолчанию (зеркало — в `GameClientDef`); игре, которой это не нужно, писать
нечего:

```rust
fn dispatch_op(&mut self, _op: &str, _payload: &[u8]) -> Option<Vec<u8>> { None }
fn dispatch_ops(&self) -> &'static [&'static str] { &[] }
```

`dispatch` сначала пробует движковые опкоды, затем игровой `dispatch_op`,
затем отвечает «не обработан». Макрос раскрывается **в крейте игры**,
поэтому игра, пересобранная с любым будущим движком, получает все опкоды,
которые тот к тому моменту умеет, — без единой правки своего исходника, а
таблица экспортов остаётся константной.

На стороне JS любая необязательная возможность ядра зовётся через одну
функцию — `dispatchCoreOp(core, abi, op, payload)` из `src/lib/coreAbi.js`:
хостовый адаптер добирается до неё как `GameCoreAdapter._op(op, payload)`,
клиент зовёт напрямую, а `readCoreAbi(core)` в том же модуле — единственное
место, где читается и нормализуется `abi_describe` (нечитаемое самоописание
деградирует до поколения 0 с предупреждением, а не в исключение). Она не
зовёт ни опкод, которого не объявило загруженное ядро, ни опкод, которого нет
в `config/abiOps.js`: имя вне реестра уехало бы в прод, не попав в diff
слепка поверхности. Обращение к `this._core.<имя>` и `clientCore.<имя>` вне
замороженных таблиц экспортов запрещено правилом ESLint.

Возвращаемое значение различает все три исхода `abi::dispatch_result`:
`{handled: false, bytes: null}` — ядро опкода не знает, вызывающий идёт по
запасному пути; `{handled: true, bytes: null}` — обработан, ответа нет
(маркер `[0x00]`, распакованный здесь же — наверх он полезными байтами не
уходит); `{handled: true, bytes}` — ответ. Первый опкод, `debug.json`,
дублирует замороженный метод `debug_json`: вызывающий пробует опкод и
откатывается на метод — так дамп получает ядро любого возраста. Обе половины
остаются навсегда: И1 ничего не удаляет.

### Snapshot-блоки — декларативная схема

Жёсткие раскладки блоков заменены схемой: `SnapshotConfig.keys`
сопоставляет каждому ключу `BlockSchema` из пяти полей: `id`
(опкод блока в кадре), `kind` (`BlockKind`: форма строки, из неё и следуют
ширины count/id и наличие null-маркера), `class` (`hot` — интерполируется /
`event` — только кадром), `fields` (у каждого тип `f32/u8/u16/u32` и
способ интерполяции `lerp`/`lerpAngle`/дискретное) и необязательный
`optionalFrom` (индекс первого поля опционального хвоста строки: эти поля
пишутся, только когда строка их несёт, а флаг-байт перед строкой сообщает,
следуют ли они — см. [network.md](network.md#блоки-сущностей-kind-из-снапшот-схемы-игры);
распаковка всегда отдаёт строку полной ширины, отсутствующий хвост читается
нулями). Префикс `d` у id блоков
`indexedNoNull8` — тоже не поле схемы, он захардкожен в распаковщиках. Пакер
(`snapshot.rs`), анпакер (`client/unpack.rs`), интерполятор и hot-буфер
движка — интерпретаторы схемы; game-crate поставляет строки как плоские
`Vec<FieldValue>`. Сама схема — данные игры: `src/config/snapshot.js` игры-плагина
(например, в `vimp-tanks`) (`HostPlugin.gameConfig.snapshot`, обязательное поле). Та же схема едет
клиентскому JS в CONFIG_DATA → generic `reconstructHot` в
`packages/engine/src/lib/reconstructHot.js` (ширина записи = 2 служебных поля +
число `fields` ключа); движковый бандл снапшот-ключей не содержит (схему
всегда даёт хост — скрытой связи «бандл клиента обязан совпадать с хостом»
нет). Player-блок схемой **не** описывается: его раскладка зафиксирована
движком (`PLAYER_STATE_LEN` = 8 `f32` + флаг `centering`) и захардкожена в
пакере и распаковщике. (`gameConfig.playerState` — не про это: это стартовый
профиль rank/state.) `SNAPSHOT_FORMAT_VERSION` остаётся 3 (фрейминг
движка; байтовая раскладка не менялась); байт-совместимость между деплоями
не требуется (хост и клиенты — один деплой; версия защищает только
фрейминг внутри комнаты).

Инварианты: `gameId` в кадре — u8 (≤255 участников); порядок ключей
`weapons` определяет weapon-index; соответствие полей `panel` ↔ ключей
`weapons` валидируется в `new GameCore`.

## CONFIG_DATA (порт 0)

Остаётся движковым механизмом; собирается `buildClientConfig` как merge:
движковые дефолты (`clientDefaults`: interpolation, controls.modes/cmds,
elems-структура, techInformList) + `HostPlugin.buildClientGameConfig()`
(parts.gameSets/entitiesOnCanvas/bakedAssets/componentDependencies/sounds,
keySetList, схемы panel/stat, тексты chat/vote/gameInform, prediction:
models/weapons/playerKeys/timeStep) + снапшот-схема + производные комнаты
(voteTime). `initIdList` и список канвасов — из конфига, не из хардкода.

## Rust-трейты (`vimp-engine-core`)

Engine-crate — чистый Rust без wasm-bindgen (ошибки `Result<_, String>`; в
`JsError` мапит game-crate). Статическая generic-диспетчеризация:
`EngineSim<TanksGame>` / `ClientState<TanksClient>` мономорфизируются —
ноль оверхеда на 120 Гц; `dyn` не нужен (один wasm-бандл = одна игра).

- `trait GameDef { type Config; type Sim: GameSim<Self>; }`
- `trait GameSim<G: GameDef>`: `new`, `spawn_actor`, `remove_actor`,
  `reset_actor`, `reset_all_vitals`, `spawn_scripted_actor`,
  `remove_scripted_actor`, `apply_input`, `apply_aim` (ввод указателем,
  дефолт пустой), `last_input_seq`, `is_alive`,
  `actor_position`, `prediction_state`, `alive_players_flat`,
  `players_json`, `on_fixed_step(ctx: &mut SimCtx, dt)`,
  `on_contacts(ctx: &mut SimCtx, pairs)`, `on_before_destroy`,
  `on_ai_tick(ctx: &mut SimCtx, dt)`, `refresh_cached`,
  `build_snapshot_blocks(&mut self) -> (Vec<(String, Block)>, has_events)`,
  `remove_players_and_shots`, `clear`, `serialize/deserialize` (mid-round
  handoff — сохраняется как задел), `rebuild_spatial_grid`.
- `SimCtx<'a>` (не generic по игре) — доступ игры к движковому, передаётся
  в тиковые callback'и: `world: &'a mut PhysicsWorld`,
  `cfg: &'a EngineConfig`, `map: &'a Option<GameMap>` (respawns),
  `nav`/`spatial: &'a Option<NavigationSystem>`/`&'a mut SpatialGrid`
  (A*/сетка — движковые утилиты в модуле `nav/`, без слова «bot»),
  `rng: &'a mut Rng`, `events: &'a mut Vec<CoreEvent>`,
  `bodies_to_destroy: &'a mut Vec<RigidBodyHandle>`. Поля `game_cfg` нет —
  игровой конфиг передаётся только в `GameSim::new`, дальше игра хранит
  нужное сама.
- Движок владеет: аккумулятор фикс-шага, сбор контактов, destroy-очередь,
  schema-driven `SnapshotPacker`, handoff-каркас, `CoreEvent`.
- Клиентская половина: `trait GameClientDef { type Config;
  fn new(cfg, engine_cfg); fn on_server_state(state, centering, server_time,
  offset, local_now); fn update(local_now);
  fn track_frame(my_game_id, frame); fn filter_frame_game(game, my_game_id,
  local_now); fn update_world(snapshot); fn update_world_interpolated(game);
  fn render_overlay(my_game_id) -> Option<RenderOverlay>; fn apply_input(...);
  fn apply_aim(...) (ввод указателем, дефолт пустой);
  fn set_model(...); fn set_active(...); fn set_map(...); fn sync_panel(...);
  fn reset(); fn cycle_item(back); fn try_action(...);
  fn begin_reconcile(snapshot) / fn finish_reconcile() (авторитетный кадр
  до replay и расхождение после — дефолт пустой);
  fn render_rows() -> Vec<PredictedRow> (строки тел, которые игра
  предсказывает сама, — дефолт пустой) }`, плюс два
  опциональных метода ниже. Движок даёт `Interpolator` (schema-driven),
  generic-оркестрацию `ClientState<G>` (сетевой буфер, очередь событийных
  кадров, hot-буфер рендер-тика), hot-буфер, raycast. Предикт актора,
  визуальный спавн и панель — целиком забота игры внутри её реализации
  `GameClientDef`.

Состоявшийся разъезд модулей бывшего монолитного `core/src/` (этап 4b):

| → `vimp-engine-core` | → `vimp-tanks-core` |
| --- | --- |
| `physics.rs` (мир, generic BodyTag, math), `rng.rs`, `map.rs`, `bots/pathfinder.rs`+`bots/spatial.rs` (→ `nav/`), фрейминг `snapshot.rs`, `client/{interpolator,predictor(generic),raycast,unpack(framing),hot}`, фикс-шаг/контакты из `game.rs`, handoff-каркас | `tank.rs`, `bomb.rs`, `motion.rs` (+parity-тесты), `events`-маппинг, `bots/{controller,navigation}.rs`, игровая логика `game.rs` (→ `sim.rs`), `client/shot.rs`, game-раскладки блоков (как схема + значения строк), `#[wasm_bindgen]`-обёртки, `tests/sim.rs` |

## Запись в профиль: rank и skills

Любая игра из каталога мастера (`config/master.js › games` — курируемый
онбординг, `gameId` выдаёт деплоер) может писать в общий профиль игрока в
центральном auth-сервисе. Каждая запись привязана к своему `game_id`; игра
трогает только собственный namespace, никогда — чужой.

- **rank** — единый формат для всех игр: один клампленный integer на пару
  `(user, game)`, отображаемый одинаково везде, где его показывает мастер
  (например, лобби). Это часть публичного SDK-контракта. `HostPlugin`
  сообщает **дельту матча** (`PlayerDataProxy`/`PlayerDataSync`,
  `PUT /rank { delta }`), а не абсолютное значение — леджер и клампинг
  (`config.rank.min/max`) владеет auth-сервис, см.
  [auth.md](auth.md#схема-бд).
- **skills** — непрозрачный JSONB `state`, формат целиком на усмотрение игры
  (`PUT /state { state }`). Движок никогда не читает и не валидирует его
  поля, только общий объём в байтах (`config.state.maxBytes`); SDK-контракт
  описывает только механизм namespace, не схему.
- Игра **никогда** не пишет ник или идентичность — они берутся из JWT
  игрока, не из игрового кода.
- Оба эндпоинта проксируются через хост (`PlayerDataProxy`) под собственным
  Bearer identity-токеном сообщающего игрока и атрибутируются к принимающему
  серверу (`hosterUserId`/`sessionId`). Если рейтинг этого сервера позже
  падает до `blockAt`, весь вклад rank/skills, отнесённый к нему,
  откатывается — см. [auth.md](auth.md#схема-бд) и
  [master.md](master.md#рейтинг-сервера-likeunlike). Игра не может отказаться
  от этого поведения: это свойство общего профиля, а не игровых данных.

## Инварианты совместимости

Опубликованная игра — это сборка, которую больше никогда не пересоберут: её
`.wasm`, её `gameConfig`, имена её партов заморожены моментом публикации.
Движок продолжает её запускать ровно потому, что ничего не отнимает. Правила
ниже проверяются механически — слепком поверхности
(`packages/engine/contract/surface.json`) и корпусом совместимости
(`packages/engine/tests/fixtures/generations/`), команды см. в
[Отладке](debugging.md).

- **И1. Ничто не удаляется и не переименовывается.** Любое имя, которое игра
  может написать или прочитать — поле `gameConfig`, имя сервиса в
  `componentDependencies`, значение `control` формы, метод wasm-ABI, номер
  порта, ключ блока снапшота — существует вечно. Вывод из эксплуатации — это
  алиас и адаптер, никогда не удаление.
- **И2. Ничто новое не обязательно.** Каждое чтение движком данных плагина
  идёт через аксессор со значением по умолчанию, каждый новый метод ядра —
  через feature-detect. Плагин любого возраста = все умолчания = валиден.
- **И3. Форма данных неизменна — рядом добавляется новая.** Сигнатура
  ABI-метода, раскладка байтов, форма объекта не меняются; другая форма — это
  новое имя.
- **И4. Правка движка не отвергает плагин, который загружался раньше.** Такая
  правка была бы `⚠️ Breaking` + `Migration` в changelog, но для плагинной
  поверхности это ошибка проектирования, а не уровень релиза.
- **И5. Rust-трейты расширяются только методами с реализацией по умолчанию.**
  Обязательный метод в `GameSim`/`GameClientDef` не даст скомпилироваться
  крейту игры.
- **И6. Исходная и бинарная совместимость разделены.** Исходный API крейта
  `vimp-engine-core` ломать по-прежнему можно — это затрагивает только игры,
  которые сами решили пересобраться. Неприкосновенна бинарная совместимость
  уже опубликованных `.wasm`.

Слепок — закоммиченный JSON: `npm run surface:update` пересобирает его, а
`npm test` падает, когда имя из него исчезло или изменилась сигнатура
ABI-метода, называя нарушенный инвариант. Добавление поверхности падением не
является — оно проходит с подсказкой, что слепок устарел.

**Реестры.** Каждый словарь, из которого игра выбирает значение, — append-only
реестр (`src/lib/registry.js`): контролы формы (`src/lib/formControls.js`),
пул клиентских сервисов (`src/config/clientServices.js`) и номера портов
(`src/config/wsports.js`). Строка не удаляется и не перенумеровывается; вывод
из эксплуатации — это `{ alias: '<активное имя>' }` плюс запись в changelog, и
выведенная строка остаётся в слепке поверхности рядом с активными: вывод — не
удаление.

**Схема снапшота — образцовое место контракта.** `gameConfig.snapshot`
приезжает от игры и путешествует всем клиентам в CONFIG_DATA
([network.md](network.md)), поэтому комната самоописываема: движок не держит
списка ключей блоков, под который игра обязана подстроиться, и добавление
блока — свойство сборки самой игры, а не версии движка. Устареть тут нечему.
`SNAPSHOT_FORMAT_VERSION` (`src/config/opcodes.js`) — это обрамление байтов,
**движковая** величина: её не читает ни один плагин, а хост и клиент внутри
одной комнаты всегда работают на одном бандле движка. В слепок она всё равно
записана — чтобы её изменение попадало в diff и было осознанным решением, а
не молчаливым.

## `requires` и возможности движка

`GameManifest.requires` — **необязательный** массив имён движковых
возможностей, без которых игра не работает:

```jsonc
{
  "id": "tanks",
  "requires": ["accolades"]      // необязательно; отсутствует = ничего сверх базового контракта
}
```

Движок отвечает вердиктом, а не сравнением версий
(`checkPluginCompatibility`, `src/lib/gamePlugin.js`): каждое имя ищется в
append-only реестре возможностей `src/lib/capabilities.js`, и неизвестное имя
означает, что игра новее движка. Сейчас зарегистрированы: `stat.leaderboard`
(срезы рейтинга), `accolades` (порт `ACCOLADES_DATA` и клиентский сервис) и
`dispatch` (`dispatch`/`abi_describe` в ядре). Зарегистрированное имя
поддерживается вечно — опубликованная игра могла его написать, и её `dist/`
больше никто не тронет.

Объявляйте возможность, только если без неё игра ломается. Игра, которая
деградирует штатно (не просит сервис, не подписана на порт), в `requires` не
нуждается: умолчания движка (`gameConfigView`) и append-only словари примут
её как есть.

`HostPlugin.requires` и `ClientPlugin.requires` — тот же необязательный
массив на половинах плагина. Его читает standalone SDK: в solo-режиме мастера
нет, а значит нет и манифеста, из которого можно взять `requires`. Три списка
держатся равными — шаблон объявляет `requires: []` во всех трёх местах.
`startStandaloneGame({ requires })` перекрывает обе половины, если
встраивающий код знает лучше.

`requires` обязан быть массивом строк. Любая другая форма (голая строка,
объект, не-строковый элемент) — **битый манифест**: вердикт
`{ok: false, reason: 'bad-manifest'}`, и он ведёт себя ровно как
несовместимая игра, а не роняет того, кто его прочитал.

Куда приходит вердикт:

| Вход | При отсутствующей возможности |
| --- | --- |
| каталог мастера (`GameCatalog`) | игра **остаётся** в `manifestList` с полем `compat: {ok: false, missing, text}`; лобби показывает её недоступной с причиной, а сигналинг отказывает в регистрации хоста (`gameUnavailable`) |
| `loadGamePackage` (dedicated, `vimp-sim`, inline-хост) | бросает — игра одна, подменить нечем |
| `loadClientPlugin` (браузер) | бросает ещё до импорта бандла плагина |
| standalone SDK | бросает — одна проверка по объединению `requires` обеих половин |

Текст всегда называет сторону, которую надо обновить: *«game "x" needs engine
capabilities this build does not have: … — update the engine»*.

## Версии и совместимость

| Константа | Владелец | Политика |
| --- | --- | --- |
| `ENGINE_API_VERSION` (=4) | движок | **заморожена на 4 и больше не бампается**; метка поколения, которую несут манифест и обе половины плагина, а не гейт совместимости. История: v2 ввела явную [схему формы](#схема-формы) (`roomForm`, `authSchema.params[].options`) вместо вывода контрола из типа значения; v3 сократила набор `control` до нативных элементов (`range`/`number`/`toggle`/`segmented` вернулись вечными алиасами); v4 добавила порт `ACCOLADES_DATA`, сервис `accolades` и режим `leaderboard` у модуля `stat`. Движок держит рабочим каждое выведенное имя (`plan/plugin-forward-compat`), поэтому игра, собранная под v2, идёт на сегодняшней сборке без правок. Правило контракта `B2` требует лишь, чтобы манифест и обе половины плагина совпадали между собой и чтобы значение было импортом, а не литералом |
| `SNAPSHOT_FORMAT_VERSION` (=3) | движок (фрейминг) | схема блоков едет в CONFIG_DATA → внутри комнаты всегда согласована |
| `HANDOFF_VERSION` (→3) | движок | v2: +`gameId`, `gameVersion` в мете эстафеты; v3: поле `bots` переименовано в `scripted`; несовпадение → штатный `resume` |
| `codeVersion` | мастер | составной: `{ engine: hash(host.worker-*.js), game: {id, version} }`; расхождение любой части → эстафета (новый Worker получает свежий `entries.host`) |
| `mapsVersion` | мастер | per-game: `/games/:id/maps/manifest.json` |

---

[← Предыдущая: Развертывание](deployment.md)
