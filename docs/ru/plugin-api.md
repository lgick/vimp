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

Четыре контракта, все версионируются единой константой `ENGINE_API_VERSION`
(владелец — движок, `packages/engine/src/config/opcodes.js`). Плагин с несовпадающим
`engineApi` отвергается при загрузке с внятной ошибкой — на мастере `GameCatalog`
полностью пропускает такой манифест (Этап A4, он не попадает в `manifestList`);
на клиенте/хосте `assertEngineApiCompatible` бросает исключение ещё до импорта
бандла плагина:

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
    "wasmNode": "core/pkg-node/index.js"        // ОПЦИОНАЛЬНО: node-сборка ядра для `npm run sim`
  },
  "assetsBase": "/games/tanks/",           // база звуков/ассетов
  "maps": { "version": "<hash>", "list": ["pool mini", "canopy", "garden"] },
  "roomDefaults": { "maxPlayers": 8, "roundTime": 120000, "mapTime": 600000,
                    "friendlyFire": false, "map": "pool mini" },
  "roomForm": [
    // regExp у maxPlayers/roundTime/mapTime генерирует build-game-manifest.js
    // — точный диапазонный паттерн (например, "^([1-8])$" для maxPlayers
    // 1..roomDefaults.maxPlayers), а не вручную в game.js; здесь опущен для
    // читаемости
    { "name": "maxPlayers", "control": "text", "label": "Max players", "numeric": true, "regExp": "<сгенерирован>" },
    { "name": "roundTime", "control": "text", "label": "Round time", "unit": "s", "numeric": true, "regExp": "<сгенерирован>" },
    { "name": "mapTime", "control": "text", "label": "Map time", "unit": "s", "numeric": true, "regExp": "<сгенерирован>" },
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
(относительно манифеста) к **node**-сборке того же WASM-ядра (по конвенции
`core/pkg-node/`), которую берёт headless-runner
`npm run sim -- --game <пакет>` — см. [debugging.md](debugging.md). Без него
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
  // Пустой/невалидный ввод откатывается к `default`, а не превращается в 0
  numeric: true,
  unit:    's',                // значение хранится в мс, показывается/редактируется в секундах
  // нативная валидация (text): стандартные HTML constraint-validation
  // атрибуты — движок вызывает reportValidity() на каждом контроле перед
  // сабмитом (room-форма — клик по «Create server»; auth-форма — клик по
  // «#auth-enter»)
  regExp:    '^#[0-9a-f]{6}$', // задаёт `pattern`
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
- `select` — `<select>` (из `options` или `source:'maps'`).
- `text` — `<input type=text>`; числовые поля (`numeric`/`unit`)
  конвертируют туда-обратно единицу хранения; `pattern`/`required`/
  `maxlength` — из дескриптора.
- `checkbox` — `<input type=checkbox>` (булевые настройки).
- `radio` — группа `<input type=radio>` с общим сгенерированным `name`,
  по одному на вариант.

**Разделение валидации.** `roomForm` едет клиенту как JSON манифеста игры
(`/games/<id>/manifest.json`) — функции не переживают сериализацию в JSON,
поэтому room-форма получает только нативную HTML-валидацию
(`pattern`/`required`); авторитетную границу значений комнаты всё равно
накладывает Worker хоста при создании комнаты (клампы таймеров/лимита в
`applyRoomOverrides.js`, которую вызывает `host.worker.js`). Auth-форма
приходит из кода плагина (`authSchema`),
поэтому у неё есть и нативная валидация, и JS-валидаторы
(`authSchema.validators`, резолвятся через `validateAuth` на хосте и
зеркалятся на клиенте).

Где живёт каждая половина контракта:
- **Room-форма**: `GameManifest.roomForm` (рядом с `roomDefaults`, который
  остаётся источником значений по умолчанию и начального набора ключей
  комнаты).
- **Auth-форма**: те же дескрипторы едут по проводу в
  `PS_AUTH_DATA.params[].options` — см.
  [network.md](network.md#авторизация-порт-1) — `params[i]` — это
  `{ name, value, options }`, где `options` несёт
  `control`/`label`/`unit`/`numeric`/`options`/`source`/`storage`/`regExp`/`required`/`maxlength`/`hidden`
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
    teams: { team1: 1, team2: 2, spectators: 3 },   // произвольное число команд
    spectatorTeam: 'spectators',
    models, weapons,                  // из src/data игры-плагина (например, vimp-tanks)
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

  onCoreEvent(ctx, event),            // только 'custom'-события; стандартные роутит движок
  chatCommands: [{ name: '/bot', handler(ctx, gameId, args) {…} }],   // регистрация в CommandProcessor
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
  views: { Panel: CustomPanelView },  // опционально: свои view вместо schema-генератора (см. ниже)
  hooks: {
    onAuth(core, authData)   { core.set_model(authData.model); },
    onPanel(core, panelData) { core.sync_panel(JSON.stringify(panelData)); },
    onLocalAction(core, action, name, now) { /* try_fire / cycle_weapon; → JSON спавна | null */ },
  },
};
```

**Ключевое: модули Stat/Panel/Vote/Chat — движковые, но вся их
параметризация — из конфига игры.** Следствия:

| Движковый модуль | Что поставляет игра (через CONFIG_DATA / gameConfig) |
| --- | --- |
| Panel (host + client MVC) | схема полей (`fields` + типы отображения: bar/число/время/иконка-оружия), `activeKey`; движковый PanelView **генерирует DOM по схеме** (замена хардкода `panel.pug` `#panel-health/-bullet/-bomb/-time`), внешний вид полей — CSS игры |
| Stat (host + client MVC) | колонки (имена/методы агрегации) и **список команд произвольной длины**; движковый StatView **генерирует таблицы по числу команд** (замена хардкода `stat.pug` `#team1/#team2/#spectators` и 5 фиксированных колонок) |
| Vote (host + client MVC) | игровые голосования создаются динамически (`voteCoordinator.createVote` из обработчиков чат-команд) + все шаблоны/меню (тексты); движковые голосования механизмов (teamChange, mapChangeByUser/BySystem) остаются в движке, их тексты — тоже у игры |
| Chat (host + client MVC) | игровые коды системных сообщений (группа `b:*` и будущие) + ВСЕ тексты сообщений; движок владеет механизмом и кодами своих механизмов (`s/v/m/c/n`) |
| CommandProcessor | регистрация игровых команд (`/bot`); движковые `/name`, `/nr`, `/timeleft`, `/mapname` остаются |
| RoundManager / ParticipantManager | `teams` (произвольные), `spectatorTeam`, respawns из карт, `scripted`-параметры; в движке — нейтральный «scripted participant» |
| SocketManager | `soundCues` (какой звук на какое движковое событие), `initialVote` |
| SoundManager (client) | список звуков + файлы (`assetsBase`) |
| Controls (client) | player-keyset и раскладка; спектаторский набор — движковый |
| Auth | схема формы (`authSchema`) + валидатор модели |

Опциональный обход схемы: `views: { Panel?, Stat? }` — кастомный view-класс
игры, реализующий view-интерфейс MVC-тройки (подписка на движковую модель
через `Publisher`; model/controller остаются движковыми). В v1 движок
реализует только schema-генератор — поле лишь валидируется при загрузке
плагина, подстановка добавится при первой необходимости.
Радиальные/canvas-индикаторы возможны и без этого: HUD-сущность на canvas —
обычный `part`.

## Wasm Host ABI (v1)

Обёртки `#[wasm_bindgen] GameCore/ClientCore` живут в game-crate
(wasm-bindgen не экспортирует generics), но обязательный набор методов
фиксирует движок (часть `engineApi`) — их вызывает движковый JS. Принцип:
**горячий путь без JSON** (скаляры + zero-copy указатели); JSON —
конструктор/карта/события/редкие запросы.

Бойлерплейт делегации (~45 методов на два класса) снимают движковые макросы
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
`load_map`, `map_info`, `apply_input`, `step`, `take_events`, `pack_body`,
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
`set_active`, `set_map`, `reset`, `decode_frame` плюс отладочная пара
`debug_json` и `take_divergence` (тоже из макроса). Игровые методы
(`set_model`, `try_fire`, `cycle_weapon`, `sync_panel`) в минимум не
входят — их зовут только хуки ClientPlugin.

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

### Snapshot-блоки — декларативная схема

Жёсткие раскладки блоков заменены схемой: `SnapshotConfig.keys` — полная
схема блока: `id`, ширины count/id, `nullMarker`, список полей с типом
(`f32/u8/u16/u32`) и способом интерполяции (`lerp`/`lerpAngle`/дискретное),
класс `hot` (интерполируется) / `event` (только кадром), `idPrefix`. Пакер
(`snapshot.rs`), анпакер (`client/unpack.rs`), интерполятор и hot-буфер
движка — интерпретаторы схемы; game-crate поставляет строки как плоские
`RowData`. Сама схема — данные игры: `src/config/snapshot.js` игры-плагина
(например, в `vimp-tanks`) (`HostPlugin.gameConfig.snapshot`, обязательное поле). Та же схема едет
клиентскому JS в CONFIG_DATA → generic `reconstructHot` в
`packages/engine/src/client/main.js` (ширина записи = 2 служебных поля +
число `fields` ключа); движковый бандл снапшот-ключей не содержит (схему
всегда даёт хост — скрытой связи «бандл клиента обязан совпадать с хостом»
нет). Player-блок описывается схемой `playerState` (сейчас
`[f32;8]+centering`). `SNAPSHOT_FORMAT_VERSION` остаётся 3 (фрейминг
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
`EngineSim<TanksGame>` / `EngineClient<TanksClient>` мономорфизируются —
ноль оверхеда на 120 Гц; `dyn` не нужен (один wasm-бандл = одна игра).

- `trait GameDef { type Config; type Sim: GameSim<Self>; }`
- `trait GameSim<G>`: `new`, `spawn_actor`, `spawn_scripted`,
  `remove_actor`, `reset_actor`, `reset_all_vitals`, `apply_input`,
  `on_fixed_step(ctx, dt)`, `on_contacts(ctx, pairs)`, `on_ai_tick(ctx, dt)`,
  `build_blocks(ctx) -> (Vec<(String, RowBlock)>, has_events)`,
  `prediction_state`, `players_json`, `alive`, `position`, `last_input_seq`,
  `clear`, `remove_players_and_shots`, `serialize/deserialize` (mid-round
  handoff — сохраняется как задел).
- `SimCtx<'a, G>` — доступ игры к движковому: `world` (Rapier), `map`
  (respawns — `IndexMap<String, Vec<[f32;3]>>`, произвольные команды),
  `nav`/`spatial` (A*/сетка — движковые утилиты в модуле `nav/`, без слова
  «bot»), `rng`, `events`, `game_cfg`, destroy-очередь.
- Движок владеет: аккумулятор фикс-шага, сбор контактов, destroy-очередь,
  schema-driven `SnapshotPacker`, handoff-каркас, `EngineEvent`.
- Клиентская половина: `trait GameClientDef { type Config; const STATE_LEN;
  fn motion_step(state, keys, model, dt, ctx: &PredictCtx);
  fn render_from_state(state) }`; `PredictCtx` даёт опциональный доступ к
  движковой сетке статических тайлов (та же, что у raycast) — задел под
  клиентское скольжение вдоль стен для жанров без инерции; танки контекст
  игнорируют (parity-тесты не меняются). Движок — `Interpolator`
  (schema-driven), `Predictor<G>` (история ввода, reconciliation,
  visual-error decay), hot-буфер, raycast. `ShotPredictor`
  (try_fire/cycle_weapon/sync_panel/клиентский спавн) — целиком в
  game-crate, зовёт движковый raycast.

Состоявшийся разъезд модулей бывшего монолитного `core/src/` (этап 4b):

| → `vimp-engine-core` | → `vimp-tanks-core` |
| --- | --- |
| `physics.rs` (мир, generic BodyTag, math), `rng.rs`, `map.rs`, `bots/pathfinder.rs`+`bots/spatial.rs` (→ `nav/`), фрейминг `snapshot.rs`, `client/{interpolator,predictor(generic),raycast,unpack(framing),hot}`, фикс-шаг/контакты из `game.rs`, handoff-каркас | `tank.rs`, `bomb.rs`, `motion.rs` (+parity-тесты), `events`-маппинг, `bots/{controller,navigation}.rs`, игровая логика `game.rs` (→ `sim.rs`), `client/shot.rs`, game-раскладки блоков (как схема+RowData), `#[wasm_bindgen]`-обёртки, `tests/sim.rs` |

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

## Версии и совместимость

| Константа | Владелец | Политика |
| --- | --- | --- |
| `ENGINE_API_VERSION` (=3) | движок | проверяется при import плагинов (host worker и клиент); ломающие изменения Plugin API / Wasm ABI → +1. v2: контракт [Form schema](#form-schema) (`roomForm`, `authSchema.params[].options`) заменил вывод контрола из типа значения. v3: набор `control` сокращён до нативных элементов (`select`/`text`/`checkbox`/`radio`, убраны `range`/`number`/`toggle`/`segmented`) — обязательное обновление для внешних репо игр (например, `vimp-tanks`) |
| `SNAPSHOT_FORMAT_VERSION` (=3) | движок (фрейминг) | схема блоков едет в CONFIG_DATA → внутри комнаты всегда согласована |
| `HANDOFF_VERSION` (→3) | движок | v2: +`gameId`, `gameVersion` в мете эстафеты; v3: поле `bots` переименовано в `scripted`; несовпадение → штатный `resume` |
| `codeVersion` | мастер | составной: `{ engine: hash(host.worker-*.js), game: {id, version} }`; расхождение любой части → эстафета (новый Worker получает свежий `entries.host`) |
| `mapsVersion` | мастер | per-game: `/games/:id/maps/manifest.json` |

---

[← Предыдущая: Развертывание](deployment.md)
