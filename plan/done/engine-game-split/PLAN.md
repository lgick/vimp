# План отделения движка от игры (VIMP Engine ↔ игра-плагин)

## 1. Контекст и цель

VIMP P2P сейчас — монолит: движковая инфраструктура (мастер-сервер, WebRTC-транспорт, Worker-хост, мета-модули, MVC-каркас клиента, Rust-ядро) переплетена с игровым контентом (танки, оружие, бомбы, боты, карты, звуки, текстуры, тексты). Цель — превратить проект в **движок-приложение**, которое загружает **игру как внешний динамический плагин**. В будущем на движке появятся другие игры; игра со временем может переехать в отдельный репозиторий. Ботов в движке быть не должно — только нейтральная абстракция «скриптовый участник».

К игре относятся: персонажи (модели), карты и их названия, оружие, звуки, боты (ИИ и реестр), рендеры сущностей (parts), процедурные текстуры (bakers), тексты чата/голосований/информеров, раскладки клавиш игрока, схемы панели и статистики, баланс.

К движку относятся: мастер (лобби/сигналинг/каталоги), P2P-транспорт, Worker-инфраструктура и эстафета, мета-МЕХАНИЗМЫ (Panel/Stat/Chat/Vote/Timer/RTT/Participant/Round/CommandProcessor), MVC-каркас клиента, рендер-инфраструктура (CanvasManager/Factory/провайдеры), SoundManager, InputListener, Rust-каркас (Rapier-обвязка, фикс-шаг, кодек кадров, интерполяция, каркас предикта, raycast, PRNG, A*, spatial-grid).

Принятые решения:

1. **Композиция**: движок — приложение (деплоится один раз); игра — динамический плагин (JS-бандлы client/host, WASM, ассеты), загружаемый по манифесту с мастера. В перспективе один мастер обслуживает несколько игр.
2. **Rust-ядро**: пилится сразу на два crate — `vimp-engine-core` (rlib, каркас) и `vimp-tanks-core` (cdylib, игра + wasm-bindgen-обёртки), связь через трейты со статической мономорфизацией.
3. **Мета-модули**: Stat, Panel, Vote, Chat (и Round/Timer/RTT/Participant/CommandProcessor) — часть движка; **вся их параметризация — из конфига игры**: поля панели, колонки и количество команд статистики, определения и шаблоны голосований, чат-команды, тексты сообщений. DOM панели/статистики движок генерирует по схеме игры (сейчас захардкожен в pug).
4. **Структура**: npm workspaces `packages/engine` (`@vimp/engine`) + `games/tanks` (`@vimp/tanks`); cargo workspace `packages/engine/core` + `games/tanks/core`.

Следующий шаг разработки (НЕ входит в этот план, но учитывается в архитектуре): полноценные игровые слои карт и графический редактор тайловых карт как страница движка. Поэтому **формат карт и загрузчик — движковые**, контент карт — игровой; schema-friendly решения (respawns как словарь произвольных команд) закладываются сейчас.

## 2. Целевая структура репозитория

```
vimp-p2p/
├─ package.json                  # workspaces: packages/engine, games/tanks; корневые скрипты-прокси
├─ Cargo.toml                    # cargo workspace: packages/engine/core, games/tanks/core
├─ packages/engine/              # @vimp/engine — ДВИЖОК (приложение)
│  ├─ core/                      # Rust rlib vimp-engine-core (без wasm-bindgen)
│  ├─ src/master/                # мастер: HostRegistry, SignalingServer, WorkerCatalog,
│  │                             #   GameCatalog (новый), MapCatalog (per-game)
│  ├─ src/host/                  # HostGame, GameCoreAdapter (generic), meta/** (механизмы),
│  │                             #   host.worker.js (динамич. загрузка HostPlugin)
│  ├─ src/client/                # bootstrap (GameRuntime), MVC-компоненты, network/,
│  │                             #   SoundManager, InputListener, providers/*Provider
│  ├─ src/lib/                   # утилиты + сборщики конфигов (generic)
│  ├─ src/config/                # ДВИЖКОВЫЕ конфиги: wsports, opcodes (framing+HOT_FLAGS,
│  │                             #   ENGINE_API_VERSION), master, lobby, hostDefaults, clientDefaults
│  ├─ index.html                 # нейтральный shell (без игровых DOM-id)
│  └─ vite.config.js
├─ games/tanks/                  # @vimp/tanks — ИГРА (плагин)
│  ├─ core/                      # Rust cdylib vimp-tanks-core → pkg-web/pkg-node
│  ├─ src/host/                  # HostPlugin: createCore, event-router, TanksBotManager,
│  │                             #   /bot-команда, системные коды 'b:*'
│  ├─ src/client/                # ClientPlugin: parts/ (9 классов), bakers/ (8 текстур),
│  │                             #   хуки (onAuth/onPanel/onLocalAction), игровой CSS
│  ├─ src/config/                # игровые половины game.js/client.js, auth.js, sounds.js,
│  │                             #   snapshot-схема (ключи m1/w1/w2/w2e/c1/c2)
│  ├─ src/data/                  # maps/, models.js, weapons.js
│  ├─ assets/audio-raw/          # исходники звуков
│  └─ vite.config.js             # сборка бандлов плагина + manifest.json
└─ scripts/                      # общие скрипты сборки
```

## 3. Контракты движок ↔ игра

Четыре контракта, версионируются константой `ENGINE_API_VERSION` (движок, `packages/engine/src/config/opcodes.js`); несовпадение `plugin.engineApi` при загрузке → отказ с внятной ошибкой.

### 3.1. GameManifest (JSON, мастер → лобби/хост/клиент)

Генерируется сборкой игры в `dist/games/<id>/manifest.json` (версия — хеш контента бандлов, по образцу `WorkerCatalog`). **Мастер не исполняет код игры** — ему хватает манифеста и статических JSON карт (продукт `maps:export` при сборке игры).

```jsonc
{
  "id": "tanks",
  "engineApi": 1,
  "version": "<hash>",                     // gameVersion (контент client+host+wasm)
  "title": "VIMP Tanks",                   // для лобби
  "entries": {
    "client": "/games/tanks/client-<hash>.js",  // ESM, default export = ClientPlugin
    "host":   "/games/tanks/host-<hash>.js",    // ESM worker-safe, default export = HostPlugin
    "wasm":   "/games/tanks/core-<hash>.wasm"   // единый hashed .wasm обоих entry (общий HTTP-кеш)
  },
  "assetsBase": "/games/tanks/",           // база звуков/ассетов
  "maps": { "version": "<hash>", "list": ["pool mini", "canopy", "garden"] },
  "roomDefaults": { "maxPlayers": 8, "roundTime": 120000, "mapTime": 600000,
                    "friendlyFire": false, "map": "pool mini" }
}
```

Проекции: **мастер** — весь манифест + раздача `/games/:id/maps/*`; **хост** — `entries.host` (dynamic import в Worker'е) + `entries.wasm` + карты с мастера; **клиент** — `entries.client` (dynamic import после выбора комнаты) + `entries.wasm` + `assetsBase`. Богатые схемы (панель, тексты, keysets) в манифест НЕ входят — едут кодом плагинов и, как сейчас, данными CONFIG_DATA (порт 0) от хоста: клиентские данные игры всегда согласованы с хостом комнаты.

### 3.2. HostPlugin API (default export host-entry игры, worker-safe)

```js
export default {
  id: 'tanks',
  engineApi: 1,
  async createCore(coreConfigJson, { wasmUrl }) { /* init(wasmUrl); return new GameCore(...) */ },

  gameConfig: {                       // игровая половина бывшего config/game.js
    teams: { team1: 1, team2: 2, spectators: 3 },   // произвольное число команд
    spectatorTeam: 'spectators',
    models, weapons,                  // из games/tanks/src/data
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

  buildCoreGameConfig(overrides),     // game-секция init-JSON ядра
  buildClientGameConfig(),            // game-секция CONFIG_DATA (см. 3.5)
  authSchema: { params: [...], validators: { isValidModel: v => v in models } },

  onCoreEvent(ctx, event),            // только 'custom'-события; стандартные роутит движок
  chatCommands: [{ name: '/bot', handler(ctx, gameId, args) {…} }],   // регистрация в CommandProcessor
  systemMessages: { BOT_PLAYERS_ONLY: 'b:0', … },                     // merge в реестр кодов движка
  voteDefs: ['createBots', 'createBotsForTeam', 'removeBots', 'removeBotsForTeam'],

  createModules(ctx) { return { bots: new TanksBotManager(ctx) }; },
  // ctx = { participants, coreAdapter, panel, stat, chat, roundManager,
  //         voteCoordinator, timerManager, socketManager }
  // Контракт scripted-модуля (дергает движок — RoundManager/HostGame):
  //   createMap(scaledMapData), createBots(count, team?), removeBots(team?),
  //   removeOneBotForPlayer(team), getBots(), getBotCount(), getBotCountsPerTeam()
};
```

### 3.3. ClientPlugin API (default export client-entry игры)

```js
export default {
  id: 'tanks',
  engineApi: 1,
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

**Ключевое: модули Stat/Panel/Vote/Chat — движковые, но настраиваются конфигом игры.** Следствия:

| Движковый модуль | Что поставляет игра (через CONFIG_DATA / gameConfig) |
| --- | --- |
| Panel (host + client MVC) | схема полей (`fields` + типы отображения: bar/число/время/иконка-оружия), `activeKey`; движковый PanelView **генерирует DOM по схеме** (замена хардкода `panel.pug` `#panel-health/-bullet/-bomb/-time`), внешний вид полей — CSS игры |
| Stat (host + client MVC) | колонки (имена/методы агрегации) и **список команд произвольной длины**; движковый StatView **генерирует таблицы по числу команд** (замена хардкода `stat.pug` `#team1/#team2/#spectators` и 5 фиксированных колонок) |
| Vote (host + client MVC) | определения игровых голосований (`voteDefs`) + все шаблоны/меню (тексты); движковые голосования механизмов (teamChange, mapChangeByUser/BySystem) остаются в движке, их тексты — тоже у игры |
| Chat (host + client MVC) | игровые коды системных сообщений (группа `b:*` и будущие) + ВСЕ тексты сообщений; движок владеет механизмом и кодами своих механизмов (`s/v/m/c/n`) |
| CommandProcessor | регистрация игровых команд (`/bot`); движковые `/name`, `/nr`, `/timeleft`, `/mapname` остаются |
| RoundManager / ParticipantManager | `teams` (произвольные), `spectatorTeam`, respawns из карт, `scripted`-параметры; в движке — нейтральное понятие «scripted participant» (геттер `isScripted`; слова «bot» в движке не остаётся) |
| SocketManager | `soundCues` (какой звук на какое движковое событие), `initialVote` |
| SoundManager (client) | список звуков + файлы (`assetsBase`) |
| Controls (client) | player-keyset и раскладка; спектаторский набор — движковый |
| Auth | схема формы (`authSchema`) + валидатор модели |

Опциональный обход схемы: `views: { Panel?, Stat? }` — кастомный view-класс игры, реализующий view-интерфейс MVC-тройки (подписка на движковую модель через `Publisher`; model/controller остаются движковыми). В v1 движок реализует только schema-генератор — поле лишь валидируется при загрузке плагина, подстановка добавится при первой необходимости. Радиальные/canvas-индикаторы возможны и без этого: HUD-сущность на canvas — обычный `part`.

### 3.4. Generic WASM ABI (Wasm Host ABI v1)

Обёртки `#[wasm_bindgen] GameCore/ClientCore` живут в game-crate (wasm-bindgen не экспортирует generics), но обязательный набор методов фиксирует движок (часть `engineApi`) — их вызывает движковый JS. Принцип: **горячий путь без JSON** (скаляры + zero-copy указатели); JSON — конструктор/карта/события/редкие запросы.

Бойлерплейт делегации (~45 методов на два класса) снимают движковые макросы `export_game_core_abi!($Sim)` / `export_client_core_abi!($Client)` (`macro_rules!` в `vimp-engine-core` — единственный источник истины обязательного набора, дрейф исключён): game-crate вызывает их рядом со своими дополнительными методами (`try_fire`, `set_model`, `sync_panel`, кастомные аргументы `spawn_actor`). Раскрытие происходит в game-crate, поэтому `#[wasm_bindgen]`/`JsError` резолвятся против его зависимостей — engine-crate от wasm-bindgen по-прежнему не зависит. Procedural macro не нужен: список методов фиксирован.

GameCore — переименования: `spawn_tank`→`spawn_actor`, `remove_tank`→`remove_actor`, `reset_tank`→`reset_actor`, `add_bot`→`spawn_scripted_actor`, `remove_bot`→`remove_scripted_actor`. Без изменений: `new(configJson)` (формат `{engine:{timeStep,seed,snapshot,mapScale,mapSetId}, game:{models,weapons,panel,playerKeys,friendlyFire}}`), `load_map`, `map_info`, `apply_input`, `step`, `take_events`, `pack_body`, `pack_frame`, `body_has_events`, `frame_ptr/frame_bytes`, `is_alive`, `position_of`, `players_data`, `alive_players`, `last_input_seq`, `reset_all_vitals`, `remove_players_and_shots`, `clear`, `serialize_state/deserialize_state`.

Стандартный словарь событий `take_events` (убирает игровой словарь из `GameCoreAdapter._drainEvents`, src/host/GameCoreAdapter.js:114-144):

```jsonc
[{ "type": "panelSet",    "id": 3, "field": "health", "value": 55 },   // field — имя поля схемы панели
 { "type": "panelActive", "id": 3, "field": "w2" },
 { "type": "death",       "victim": 3, "killer": 1 },
 { "type": "shake",       "id": 3, "intensity": 20, "duration": 200 },
 { "type": "custom",      "data": {…} }]                                // → HostPlugin.onCoreEvent
```

ClientCore — движковый минимум: `new`, `push_frame`, `my_game_id`, `offset`, `sample`, `hot_ptr/hot_values`, `take_frames`, `apply_input`, `set_active`, `set_map`, `reset`, `decode_frame`. Игровые методы (`set_model`, `try_fire`, `cycle_weapon`, `sync_panel`) в минимум не входят — их зовут только хуки ClientPlugin.

**Snapshot-блоки — декларативная схема вместо жёстких раскладок.** `SnapshotConfig.keys` расширяется до полной схемы блока: `id`, ширины count/id, `nullMarker`, список полей с типом (`f32/u8/u16/u32`) и способом интерполяции (`lerp`/`lerpAngle`/дискретное), класс `hot` (интерполируется) / `event` (только кадром), `idPrefix`. Пакер (`snapshot.rs`), анпакер (`client/unpack.rs`), интерполятор и hot-буфер движка становятся интерпретаторами схемы; game-crate поставляет строки как плоские `RowData`. Та же схема едет клиентскому JS в CONFIG_DATA → generic `reconstructHot` (замена захардкоженной «12-польной» раскладки танка в `src/client/main.js:505-551`); `SNAPSHOT_KEYS` из клиентского бандла исчезает (схему всегда даёт хост — устраняется скрытая связь «бандл клиента обязан совпадать с хостом»). Player-блок описывается схемой `playerState` (сейчас `[f32;8]+centering`). `SNAPSHOT_FORMAT_VERSION` → 4 (фрейминг движка); байт-совместимость между деплоями не требуется (хост и клиенты — один деплой; версия защищает только фрейминг внутри комнаты).
**Отклонено при реализации (см. 4b, стр. 252):** generic `reconstructHot` не сделан — `clientCoreConfig.js` продолжает брать `SNAPSHOT_KEYS` из локального бандла движка, а не из CONFIG_DATA хоста; скрытая связь «бандл клиента обязан совпадать с хостом» сохраняется как осознанный риск (безопасно, пока хост+клиент — один деплой). `SNAPSHOT_FORMAT_VERSION` остаётся 3 — байтовая раскладка не менялась.

### 3.5. CONFIG_DATA (порт 0)

Остаётся движковым механизмом; собирается `buildClientConfig` как merge: движковые дефолты (`clientDefaults`: interpolation, controls.modes/cmds, elems-структура, techInformList) + `HostPlugin.buildClientGameConfig()` (parts.gameSets/entitiesOnCanvas/bakedAssets/componentDependencies/sounds, keySetList, схемы panel/stat, тексты chat/vote/gameInform, prediction: models/weapons/playerKeys/timeStep) + снапшот-схема + производные комнаты (voteTime). `initIdList`/список канвасов — из конфига, не из хардкода.

### 3.6. Rust-трейты `vimp-engine-core`

Engine-crate — чистый Rust без wasm-bindgen (ошибки `Result<_, String>`; в `JsError` мапит game-crate). Статическая generic-диспетчеризация: `EngineSim<TanksGame>` / `EngineClient<TanksClient>` мономорфизируются — ноль оверхеда на 120 Гц; `dyn` не нужен (один wasm-бандл = одна игра).

- `trait GameDef { type Config; type Sim: GameSim<Self>; }`
- `trait GameSim<G>`: `new`, `spawn_actor`, `spawn_scripted`, `remove_actor`, `reset_actor`, `reset_all_vitals`, `apply_input`, `on_fixed_step(ctx, dt)`, `on_contacts(ctx, pairs)`, `on_ai_tick(ctx, dt)`, `build_blocks(ctx) -> (Vec<(String, RowBlock)>, has_events)`, `prediction_state`, `players_json`, `alive`, `position`, `last_input_seq`, `clear`, `remove_players_and_shots`, `serialize/deserialize` (mid-round handoff — задел, сохраняется).
- `SimCtx<'a, G>` — доступ игры к движковому: `world` (Rapier), `map` (respawns — `IndexMap<String, Vec<[f32;3]>>`, произвольные команды), `nav`/`spatial` (A*/сетка — движковые утилиты в модуле `nav/`, без слова «bot»), `rng`, `events`, `game_cfg`, destroy-очередь.
- Движок владеет: аккумулятор фикс-шага, сбор контактов, destroy-очередь, schema-driven `SnapshotPacker`, handoff-каркас, `EngineEvent`.
- Клиентская половина: `trait GameClientDef { type Config; const STATE_LEN; fn motion_step(state, keys, model, dt, ctx: &PredictCtx); fn render_from_state(state) }`; `PredictCtx` даёт опциональный доступ к движковой сетке статических тайлов (та же, что у raycast — клиентское ядро уже владеет картой через `set_map`) — задел под клиентское скольжение вдоль стен для жанров без инерции; танки контекст игнорируют (parity-тесты не меняются). Движок — `Interpolator` (schema-driven), `Predictor<G>` (история ввода, reconciliation, visual-error decay), hot-буфер, raycast. `ShotPredictor` (try_fire/cycle_weapon/sync_panel/filter_frame_game/клиентский спавн) — целиком в game-crate, зовёт движковый raycast.

Разъезд модулей текущего `core/src/`:

| → `vimp-engine-core` | → `vimp-tanks-core` |
| --- | --- |
| `physics.rs` (мир, generic BodyTag, math), `rng.rs`, `map.rs`, `bots/pathfinder.rs`+`bots/spatial.rs` (→ `nav/`), фрейминг `snapshot.rs`, `client/{interpolator,predictor(generic),raycast,unpack(framing),hot}`, фикс-шаг/контакты из `game.rs`, handoff-каркас | `tank.rs`, `bomb.rs`, `motion.rs` (+parity-тесты), `events`-маппинг, `bots/{controller,navigation}.rs`, игровая логика `game.rs` (→ `sim.rs`), `client/shot.rs`, game-раскладки блоков (как схема+RowData), `#[wasm_bindgen]`-обёртки, `tests/sim.rs` |

### 3.7. Версии и совместимость

| Константа | Владелец | Политика |
| --- | --- | --- |
| `ENGINE_API_VERSION` (=1) | движок | проверяется при import плагинов (host worker и клиент); ломающие изменения Plugin API / Wasm ABI → +1 |
| `SNAPSHOT_FORMAT_VERSION` (=3, план предполагал →4 — отклонено, см. 3.4/4b) | движок (фрейминг) | байтовая раскладка не менялась → версия не поднята; защищает фрейминг внутри комнаты |
| `HANDOFF_VERSION` (→2) | движок | +`gameId`, `gameVersion` в мете эстафеты; несовпадение → штатный `resume` |
| `codeVersion` | мастер | составной: `{ engine: hash(host.worker-*.js), game: {id, version} }`; расхождение любой части → эстафета (новый Worker получает свежий `entries.host`) |
| `mapsVersion` | мастер | per-game: `/games/:id/maps/manifest.json` |

## 4. Этапы

Сквозные правила каждого этапа: `npx eslint .` + `npm test` + `npm run core:test` зелёные; `npm run dev` живой (две вкладки играют); тесты правятся в том же PR, что и код; **docs/{en,ru} актуализируются в том же изменении** (правило CLAUDE.md). Размеры: S≈день, M≈2–4 дня, L≈неделя, XL≈2+ недели.

### Этап 1. Фиксация контрактов (S, 1 PR) — ✅ выполнен

- `docs/{en,ru}/plugin-api.md` — черновик контрактов из раздела 3 (GameManifest, HostPlugin, ClientPlugin, Wasm ABI, снапшот-схема, версии).
- В `docs/{en,ru}/architecture.md` — ADR: «движок — приложение, игра — динамический плагин»; таблица распила файлов (полная разметка ENGINE/GAME/MIXED из аудита).
- `ENGINE_API_VERSION` в `src/config/opcodes.js` (номинально).
- Готово: документы есть, код не менялся.

### Этап 2. Каркас монорепо + листовые данные (M, 1–2 PR) — ✅ выполнен

- Корневой `package.json` → `workspaces: ["packages/engine", "games/tanks"]`; создать `games/tanks/package.json` (`@vimp/tanks`, exports `./data/*`, `./config/*`). Движковый код пока остаётся в `src/` корня.
- Перенести: `src/data/{models.js,weapons.js,maps/}` → `games/tanks/src/data/`; `src/config/sounds.js` и `src/assets/audio-raw` → `games/tanks/`.
- Поправить все точки входа игровых данных (их ровно три): `src/config/game.js:1-3`, `src/lib/coreConfig.js:7-8`, `src/master/main.js:11`; плюс `scripts/export-maps.js`, `scripts/process-audio.js`, пути coverage в `vitest.config.js`, nodemon watch (`games/tanks/src`).
- `vite.config.js`: `server.fs.allow` расширить до корня репо — Vite dev должен читать воркспейс-симлинк `node_modules/@vimp/tanks` и файлы `games/` вне будущего Vite-root `packages/engine`.
- Готово: тесты/линт/dev/`maps:export`/`audio:process` работают; smoke: Vite и бандл worker'а переваривают workspace-симлинк `node_modules/@vimp/tanks`.

### Этап 3. JS-инверсия на месте (XL, 8–10 мелких PR) — ✅ выполнен

Новые игровые модули сразу создаются в `games/tanks/src/`; движок временно импортирует их статически (композиция рвётся в этапе 6).

| PR | Задача | Ключевые файлы |
| --- | --- | --- |
| 3.1 ✅ | `GameCoreAdapter._drainEvents`: игровой словарь → инъецируемый `eventRouter` (временный мост до стандартных событий этапа 4a) | `src/host/GameCoreAdapter.js`, новый `games/tanks/src/host/coreEventRouter.js` |
| 3.2 ✅ | `SocketManager`: `sendRoundStart/Victory/Defeat/FragSound/GameOverSound` → generic `sendSoundCue(cue)` по `soundCues`; `sendFirstVote` → `initialVote` из конфига | `src/host/meta/SocketManager.js`, `src/host/HostGame.js`, `src/host/meta/core/RoundManager.js` |
| 3.3 ✅ | `CommandProcessor`: движковое ядро (`/name`,`/nr`,`/timeleft`,`/mapname`) + `registerCommand()`; `/bot` со всей логикой и голосованиями → игра | `src/host/meta/core/CommandProcessor.js`, `games/tanks/src/host/botCommand.js` |
| 3.4 ✅ | `systemMessages.js`: движковый реестр (группы s/v/m/c/n) + `registerCodes()`; группа `b:*` → игра | `src/host/meta/modules/chat/systemMessages.js`, `games/tanks/src/host/systemMessages.js` |
| 3.5 ✅ | Разрез `config/game.js`: движковое (`maxPlayers`, `timers`, `rtt`, `idleKickTimeout`, `isDevMode`, `chatMaxLength`?) → `src/config/hostDefaults.js`; игровое (`teams`, `spectatorTeam`, `panel`, `stat`, `playerKeys`, `mapScale`, `mapSetId`, `mapsInVote`, `currentMap`, `parts.*`) → `games/tanks/src/config/game.js`; спектаторский keyset — движковый | `src/config/game.js`, `src/lib/coreConfig.js`, `src/host/host.worker.js` (включая `MAX_ROOM_PLAYERS=8` → roomDefaults) |
| 3.6 ✅ | Разрез `config/client.js`: движковое (`interpolation`, controls.modes/cmds, elems-структуры, `techInformList`, `initIdList`-механика) → `src/config/clientDefaults.js`; игровое (`parts.*`, `keySetList`, схемы panel/stat, тексты chat/vote/gameInform, канвасы) → `games/tanks/src/config/client.js`; merge в `buildClientConfig` | `src/config/client.js`, `src/lib/buildClientConfig.js` |
| 3.7 ✅ | Auth: `config/auth.js` → игра; `isValidModel` (хардкод `'m1'`, `src/lib/validators.js:16`) → валидатор из `authSchema` | `src/lib/validators.js`, `src/host/host.worker.js` |
| 3.8 ✅ | Panel: ключ `'wa'` (`src/host/meta/modules/Panel.js:99`) → `activeKey` из схемы | `src/host/meta/modules/Panel.js` |
| 3.9 ✅ | Боты: `HostBotManager` → `games/tanks/src/host/TanksBotManager.js` (контракт scripted-модуля, `createModules(ctx)`); в движке `Participant`/`ParticipantManager` — нейтральный `isScripted` (алиас `isBot` до конца этапа 5), имя `Bot${id}` → `scripted.namePrefix`, модель `'m1'` → `scripted.defaultModel` | `src/host/HostBotManager.js`, `src/host/meta/player/*`, `src/host/HostGame.js` (`_freeSlotForHuman` — generic политика «scripted уступают людям») |
| 3.10 ✅ | Клиент: собрать HostPlugin/ClientPlugin-объекты (пока статический импорт); из `main.js` вынести хуки (set_model/sync_panel/try_fire/cycle_weapon — строки 242, 358-361, 721-731); **PanelView/StatView движка генерируют DOM по схеме игры** (замена `panel.pug`/`stat.pug`; произвольное число команд и полей); канвасы — из конфига; игровой CSS отделить от движкового `style.css` | `src/client/main.js`, `index.html`, `src/client/views/includes/{panel,stat}.pug`, `src/client/components/view/{Panel,Stat}.js`, `games/tanks/src/client/index.js` |

Готово: после каждого PR тесты зелёные и поведение в dev идентично; после 3.10 — ручной smoke двух вкладок (движение/выстрелы/панель/стата/чат/голосования/боты).

### Этап 4. Rust: генерализация и распил ядра (XL, параллелен этапу 3; 4a — до этапа 5) — ✅ выполнен

**4a. Генерализация в одном crate (XL, 3 PR).**
1. ABI-переименования (`spawn_actor`/`spawn_scripted_actor`/`remove_actor`/`remove_scripted_actor`/`reset_actor`) ✅ выполнено; зеркально `GameCoreAdapter`. Трейты `GameDef`/`GameSim` + `EngineSim<TanksGame>` ✅ выполнено (внутри одного crate, физический распил на `packages/engine/core`/`games/tanks/core` — ещё впереди, см. 4b): `core/src/sim.rs` — `GameDef`/`GameSim<G>`/`SimCtx`; `core/src/game.rs` — `EngineSim<G>` (мир, карта, нав-граф/сетка, PRNG, аккумулятор фикс-шага, destroy-очередь, `pub type GameState = EngineSim<TanksGame>`); `core/src/tanks.rs` — `TanksSim` (участники/оружие/боты/снапшот-блоки) через `on_fixed_step`/`on_contacts`/`on_before_destroy`/`on_ai_tick`; `BotBrain` (`core/src/bots/controller.rs`) переведён на адаптер `BotView` (те же имена полей/методов, что были у монолитного `GameState`, — тело бота не менялось). `on_before_destroy` — дополнение к сигнатурам из PLAN.md §3.6 (движок зовёт перед `world.remove_body`, чтобы игра обновила свою бухгалтерию по тегу тела, напр. null-маркер бомбы); `BodyTag`-варианты и `CoreConfig` пока не разделены на движковую/игровую половины (это отдельный шаг, актуален к 4b). `cargo test` (95, включая parity и `state_dump_restores_identical_simulation`) и `npm test`/`npx eslint .` зелёные на пересобранном `pkg-node`/`pkg-web`.
2. Schema-driven снапшот ✅ выполнено: расширенный `SnapshotConfig` (`BlockSchema{id,kind,class,fields}` + `PLAYER_STATE_LEN`), интерпретаторы в `snapshot.rs`/`unpack.rs`/интерполяторе; зеркально `src/config/opcodes.js`. Байтовая раскладка не изменилась → `SNAPSHOT_FORMAT_VERSION` не поднят; `reconstructHot` в `main.js` сознательно не переписан (raскладка hot-записи не изменилась, см. PLAN_4_details.md).
3. Стандартные события (`panelSet/panelActive/death/shake/custom`) ✅ выполнено: `CoreEvent` (`core/src/events.rs`) переведён на генерик-словарь; `GameCoreAdapter._drainEvents` роутит его сам (снят временный eventRouter из 3.1, `games/tanks/src/host/coreEventRouter.js` удалён), `custom` → опциональный `HostPlugin.onCoreEvent`. Конфиг `{engine, game}`, generic `Predictor`/`ShotPredictor` — остаются в работе.
- Готово: `cargo test` (~90) зелёный, `tests/core/*` + `tests/host/HostGame.test.js` зелёные на пересобранном `pkg-node`, бенчмарк-гейт `step+pack_body` без деградации, ручной smoke.

**4b. Физический распил на два crate (L, 1–2 PR) — ✅ выполнен.**
- `packages/engine/core` (`vimp-engine-core`, rlib, БЕЗ wasm-bindgen) + `games/tanks/core` (`vimp-tanks-core`, cdylib+rlib, обёртки `GameCore/ClientCore`); корневой cargo workspace (`Cargo.toml`, `resolver = "2"`, `workspace.dependencies`).
- `CoreConfig`/`ClientConfig` разделены: `EngineConfig{timeStep,mapScale,mapSetId,snapshot,seed}` + `EngineClientConfig{timeStepMs,snapshot,interpolation}` (движок, `packages/engine/core/src/config.rs`) vs `TanksConfig{friendlyFire,models,weapons,playerKeys,panel}` + `TanksClientConfig{models,weapons,playerKeys,seed}` (игра, `games/tanks/core/src/config.rs`); `GameDef::Config` — ассоциированный тип, `GameSim::new(cfg: &G::Config, engine_cfg: &EngineConfig)` — игровой конфиг передаётся один раз в конструктор, `TanksSim` хранит свою копию (models/weapons/panel/friendly_fire/player_keys), остальные методы трейта `cfg`-параметр не принимают. Wire-формат `GameCore`/`ClientCore::new` — `{engine: {...}, game: {...}}` (JS-сборщики `coreConfig.js`/`clientCoreConfig.js` собирают плоский конфиг и раскладывают по обеим половинам).
- `BodyTag` разделён: движок (`packages/engine/core/src/physics.rs`) владеет только зарезервированным `MAP_OBJECT_TAG`/`encode_map_object`/`is_map_object`; весь enum `BodyTag` (`Player`/`Shot`) — целиком в игровом `games/tanks/core/src/body_tag.rs`, с тестом round-trip против движковой кодировки.
- `snapshot.rs` (`SnapshotPacker`/`Block`) уже описывает содержимое blocks через generic-абстракцию: варианты `Block` названы по байтовой форме (`Indexed8`/`Indexed32`/`List16`/`IndexedNoNull8`), а не по игровым сущностям, контент — `Vec<FieldValue>` по схеме `SnapshotConfig`. Полностью generic `RowData` (типизированные под конкретную игру строки) не потребовался — форма уже покрывает нужды и движка, и игры без игровых имён в самом типе.
- `client/predictor.rs`, `client/shot.rs`, `motion.rs` — в game-crate (`predictor.rs` зовёт `crate::motion`, формулы танка). Generic-оркестрация вынесена в движок отдельным шагом (после 4b, см. ниже): `GameClientDef`-трейт + `ClientState<G>` (`packages/engine/core/src/client/game.rs`), `TanksClient` (`games/tanks/core/src/client/mod.rs`) — реализует трейт, оборачивая `Predictor`/`ShotPredictor`. Форма трейта провалидирована фикстурным вторым клиентом (`TestClient`, тесты в `client/game.rs`) до миграции танков. Движок владеет сетевым буфером/hot-буфером/очередью кадров; predicted-хвост hot-буфера — непрозрачный `Vec<f32>` от игры (`GameClientDef::render_overlay` → `RenderOverlay{camera, tail}`), байты не изменились.
- `bots/navigation.rs` перенесён в движок (`nav/navigation.rs`) вопреки табличной разметке §3.6/PLAN_4_details.md (`игра ← ... navigation`): на практике файл не имел ни одной игровой зависимости (только `pathfinder`/`rng`), а `EngineSim`/`SimCtx` уже хранят `Option<NavigationSystem>` как движковое поле — перенос в игру потребовал бы generic-параметра нав-типа в движковом каркасе. `bots/controller.rs` (`BotBrain`, реально игровой ИИ) остался в игре.
- Макросы `export_game_core_abi!`/`export_client_core_abi!` (§3.4) — реализованы (последний — отдельным шагом после 4b, вместе с `GameClientDef`, см. выше); `lib.rs` в game-crate зовёт оба макроса рядом со своими дополнительными методами (`set_model`/`try_fire`/`cycle_weapon`/`sync_panel`).
- npm-скрипты: `core:build:web/node` → `wasm-pack build games/tanks/core ...` (`pkg-web`/`pkg-node` теперь под `games/tanks/core/`, JS-имя пакета `vimp_tanks_core`); `core:test` → `cargo test --workspace`; харнессы `tests/core/helpers.js`, `tests/host/harness.js`, ESLint-игнор и движок↔игра ESLint-граница (единственное исключение — `gameRegistry.static.js`, реэкспортирует wasm-glue статически для `GameCore`/динамически для `ClientCore`), CI `test.yml` — обновлены.
- Готово: `cargo test --workspace` — 95/95 (50 engine + 33 tanks-lib + 12 integration, то же число, что и до распила); `npm test` — 664/664; `npx eslint .` чисто; `npm run build` (полная сборка, включая `core:build:web`) проходит.

**4c. Клиентский трейт `GameClientDef` + `export_client_core_abi!` (после 4b) — ✅ выполнен.**
- `packages/engine/core/src/client/game.rs`: `trait GameClientDef` (зеркало `GameSim<G>`) + generic `ClientState<G>` — сетевой буфер (`Interpolator`), очередь событийных кадров, запись hot-буфера; орбитальный порядок вызовов (`on_server_state`/`set_server_offset`/`track_frame`/`filter_frame_game`/`update_world[_interpolated]`/`update`/`render_overlay`) идентичен прежней монолитной `ClientState`.
- Форма трейта провалидирована фикстурой ДО миграции танков: `TestClient` (`#[cfg(test)]`, тот же файл) — тривиальная линейная интеграция, `render_overlay`/`try_fire`/т.д.; тесты `push_frame_and_sample_writes_hot_layout`/`render_overlay_appends_opaque_tail_and_sets_flag`/`reset_clears_predictor_and_frame_queue` прогоняют `ClientState<TestClient>` тем же путём, что и настоящую игру — сигнатуры трейта не потребовали правок по итогам.
- `games/tanks/core/src/client/mod.rs`: `TanksClient` (impl `GameClientDef`) оборачивает `Predictor`+`ShotPredictor`+`my_model_key(_id)`+`my_tank_meta`; тела `Predictor`/`ShotPredictor`/`motion.rs` не менялись. `render_overlay` собирает прежний 12-f32 predicted-хвост через новый generic `RenderOverlay{camera, tail}` (движок знает только камеру и непрозрачный хвост). Старые тесты `client::tests::*` перенесены на `ClientState<TanksClient>` без изменения байтовых ассертов.
- `export_client_core_abi!` (`packages/engine/core/src/abi.rs`) — движковый минимум (`push_frame/my_game_id/offset/sample/hot_ptr/hot_values/take_frames/apply_input/set_active/set_map/reset/decode_frame`); `games/tanks/core/src/lib.rs::ClientCore` зовёт макрос, рукописными остаются `new`/`set_model`/`try_fire`/`cycle_weapon`/`sync_panel`.
- Готово: `cargo test --workspace` — 102/102 (52 engine [+3 фикстуры] + 38 tanks-lib [+3 panel/weapons валидации из A3] + 12 integration); `npm run core:build` (web+node) собирается с макросом; `npm test` — 664/664; `npx eslint .` чисто.

### Этап 5. Физический переезд JS (L, 2–3 PR; после 3 и 4a) — ✅ выполнен

Примечание: выполнен до этапа 4 (решение разработчика) — этап 5 не зависит от Rust-генерализации; этап 4a при выполнении будет править файлы уже по путям `packages/engine/`.

- `src/{master,host,client,lib,config}` + `index.html` + `vite.config.js` → `packages/engine/`; корень — только оркестрация (`npm run dev` → `npm -w @vimp/engine run dev`). Игровые остатки (parts/, bakers/, игровой CSS, конфиги) → `games/tanks/src/client/`.
- Временная статическая композиция — единственный файл `packages/engine/src/gameRegistry.static.js` (импортирует `@vimp/tanks/host` и `@vimp/tanks/client`), помечен к удалению в этапе 6.
- ESLint-граница: `no-restricted-imports` — `packages/engine/**` (кроме gameRegistry.static.js) не импортирует `@vimp/tanks/**`/`games/**`; `games/tanks/**` импортирует только публичные entry `@vimp/engine`. Нарушение = ошибка CI.
- `vitest.config.js` → projects: `engine-node`, `engine-client`, `tanks`, `integration` (`tests/host/HostGame.test.js` и tests/core — integration: реальное ядро танков).
- Финал этапа: снять алиас `isBot` в движке (остаётся `isScripted`).
- Готово: граница чиста, тесты зелёные, dev и сборка работают.

### Этап 6. Динамическая загрузка игры (XL, 4–5 PR)

| PR | Задача |
| --- | --- |
| 6.1 ✅ | **Сборка игры**: `games/tanks/vite.config.js` — два независимых build-прогона (client-entry, host-entry worker-safe) в общий `dist/games/tanks/`; wasm — hashed asset (общий у обоих entry; URL — `entries.wasm` манифеста); пост-шаги: `maps:export` → `dist/games/tanks/maps/*.json`, звуки → `dist/games/tanks/sounds/`, генерация `manifest.json` (хеш-версии). Проверка: host-бандл не содержит DOM-кода |
| 6.2 ✅ | **Мастер**: `GameCatalog` (`packages/engine/src/master/GameCatalog.js`, по образцу `WorkerCatalog`) — сканирует `dist/games/*/manifest.json`; REST `/games/manifest.json`, `/games/:id/manifest.json`, `/games/:id/maps/*` (per-game `MapCatalog`); `HostRegistry` + `GET /servers` + `register_host`/`host_registered` — поля `gameId`/`gameVersion`. Dev-режим: манифест с Vite-URL исходников (`/@fs/…/games/tanks/src/client/index.js` — трансформация и HMR штатные), `entries.wasm` — Vite-URL `.wasm` из `pkg-web`; ассеты (звуки, карты из `games/tanks/src/data`) — `express.static`-mount `/games/:id/` на мастере |
| 6.3 ✅ | **Клиент**: лобби — `roomDefaults` из манифеста в форму создания комнаты (селект игры скрыт, пока игра одна); «Создать сервер» — фича-детект module worker + dynamic import с внятной ошибкой («браузер не может быть хостом»; join не блокируется); join: `GET /games/:id/manifest.json` → `import(entries.client)` → проверка `engineApi` → подключение; `sounds.path` от `assetsBase`; удалить клиентскую половину `gameRegistry.static.js` |
| 6.4 ✅ | **Worker**: `init`-сообщение несёт `room.game = {id, version, hostEntryUrl, wasmUrl}`; `host.worker.js` → `await import(hostEntryUrl)` → `plugin.createCore(coreConfigJson, { wasmUrl })`; `applyRoomOverrides` валидирует по `roomDefaults`; удалить `gameRegistry.static.js` целиком |
| 6.5 ✅ | **Эстафета**: составной `codeVersion` (движок+игра), `HANDOFF_VERSION=2` (+gameId/gameVersion), при свопе новый Worker получает свежий `hostEntryUrl`; сбой → существующий `resume`-путь |

**6.3 — заметки реализации.** Новый модуль
`packages/engine/src/lib/gamePlugin.js` (`fetchGamesManifest`,
`assertEngineApiCompatible`, `loadClientPlugin`) заменяет клиентскую половину
`gameRegistry.static.js`: `main.js` при бутстрапе фетчит
`GET /games/manifest.json` (массив манифестов `GameCatalog`), берёт первую
запись как активную игру (селектор в лобби скрыт, пока игра одна — §6
PLAN.md) и грузит её `ClientPlugin` через `import(manifest.entries.client)`
(`/* @vite-ignore */` — URL целиком рантаймовый, что и требуется:
ESLint-граница движок↔игра проверяет только статические пути импорта).
Сбой каталога/несовпадение `engineApi` — фатальная ошибка на этом этапе (без
игры показывать нечего), сообщение прямо в `document.body`. Клиентское ядро
теперь создаётся через `ClientPlugin.createClientCore(configJson, { wasmUrl:
activeGameManifest.entries.wasm })` (уже был реализован в 6.1, просто не
вызывался) вместо `loadClientCore()`/`new glue.ClientCore(...)` —
возвращает `{ core, memory }`, `wasm.memory.buffer` в рендер-тике не
изменился. Фича-детект модульных Worker'ов —
`packages/engine/src/client/network/workerSupport.js`
(`supportsModuleWorker`, классический трюк с геттером опции `type`);
`connectAsHost` проверяет его первым делом и возвращает честную ошибку без
побочных эффектов — `ensureWebRtcAvailable`/join не затронуты. Форма
создания комнаты (`lobby.pug`: `#lobby-game` скрытый селект,
`#lobby-max-players/-round-time/-map-time/-friendly-fire/-map`) заполняется
из `GameManifest.roomDefaults` (`populateRoomForm`); `connectAsHost`
собирает из неё `room.{maxPlayers,roundTime,mapTime,friendlyFire,map}` —
поля, которые `host.worker.js`'s `applyRoomOverrides` уже умел принимать
(добавлены раньше, независимо от 6.3), так что оверрайды работают без
изменений хоста. `sounds.path` переопределяется клиентом на
`${activeGameManifest.assetsBase}sounds/` сразу при получении `CONFIG_DATA`
(вместо бандловой `/sounds/` из `games/tanks/src/config/sounds.js` — хост
эту часть конфига не трогает, это осталась задача 6.4/сам конфиг). Клиентская
пре-валидация `isValidModel` (была через `authSchema.validators` из
`gameRegistry.static.js`) убрана: `authSchema` контрактно принадлежит
`HostPlugin` (§3.2), которого клиент теперь не подгружает — авторитетная
проверка на хосте (`host.worker.js` уже валидирует `hostPlugin.authSchema`)
осталась единственной; рассинхрон вернётся `AUTH_RESULT`. Хостовая половина
`gameRegistry.static.js` (`hostPlugin`, `gameMaps`, `initGameCore`/`GameCore`)
не тронута — используется `host.worker.js`/`HostGame.js`/`coreConfig.js` до
Этапа 6.4. Не входило в объём 6.3 (осталось для 6.4, вне текста плана для
этого PR): `host.worker.js`/`connectAsHost` продолжают брать карты и
worker-бандл комнаты со старых одноигровых маршрутов
(`/maps/manifest.json`, `/worker/manifest.json`) — переезд на
`/games/:id/maps/*`/`entries.host` вместе с `applyRoomOverrides`,
валидирующим по `roomDefaults`, это задача «Worker» (6.4); `SignalingClient
.registerHost` по-прежнему не шлёт `gameId`/`gameVersion` (задокументировано
в master.md как Этап 6.4) — лобби со списком серверов, соответственно, пока
не фильтрует по игре (нечего фильтровать при одной игре). Новые тесты (8):
`tests/lib/gamePlugin.test.js`, `tests/client/network/workerSupport.test.js`.
`npx eslint .` и `npm test` — 683/683 зелёные.

**6.4 — заметки реализации.** `gameRegistry.static.js` удалён целиком —
движок с этого PR не импортирует игру статически ни в одном файле (ESLint
`no-restricted-imports` в `eslint.config.js` теперь безусловный, без
исключения для этого файла). Хостовая половина статической композиции была
у трёх потребителей — все переведены на параметр вместо статического
импорта: `lib/coreConfig.js::buildCoreConfig(gameConfig, overrides)` берёт
`HostPlugin.gameConfig` первым аргументом вместо top-level импорта;
`host/HostGame.js` принимает `hostPlugin` четвёртым позиционным параметром
конструктора (`onCoreEvent`/`createModules`/`chatCommands`/`systemMessages`);
`master/main.js` лишился одноигрового `mapCatalog`/`gameMaps` и маршрутов
`GET /maps/manifest.json`/`GET /maps/:name` — с 6.4 их полностью заменяют
per-game маршруты `GET /games/:id/maps/*` (были готовы уже в 6.2).
`host.worker.js::onInit` теперь начинается с `await
import(room.game.hostEntryUrl)` (`/* @vite-ignore */`, тот же приём, что и у
клиента в 6.3 — URL целиком рантаймовый) и зовёт
`hostPlugin.createCore(coreConfigJson, { wasmUrl: room.game.wasmUrl })`
вместо статического `init()`+`new GameCore(...)`; `applyRoomOverrides`
принимает загруженный `hostPlugin` вторым параметром — валидация по
`roomDefaults` (`game.roomDefaults.maxPlayers`) не изменилась, источник
`gameConfig` стал динамическим. `room.game = { id, version, hostEntryUrl,
wasmUrl }` собирает `connectAsHost` (`packages/engine/src/client/main.js`) из
`activeGameManifest.entries` — тот же манифест, что уже грузит
`ClientPlugin` с 6.3; `fetchMasterMaps` переведён на
`lobbyConfig.maps.manifestUrl(gameId)`/`baseUrl(gameId)` (были статичными
URL одноигрового `/maps/*`, стали функциями от `activeGameManifest.id`).
`SignalingClient.registerHost`/`connectAsHost` теперь всегда шлют
`gameId`/`gameVersion` (задел 6.2 в `SignalingServer`/`HostRegistry` уже
был готов принимать их — не менялся); `SignalingServer`'овский
одноигровой `options.mapsVersion`-fallback оставлен как есть (не выпилен) —
безвредный резерв на случай отсутствия записи в `GameCatalog`, тестами
`SignalingServer.test.js` уже покрыт. Тестовые харнессы:
`tests/core/helpers.js::makeCore` передаёт `tanksGameConfig` (уже
импортировался для другого) в `buildCoreConfig`; `tests/host/harness.js`
динамически импортирует `@vimp/tanks/host/index.js` и передаёт в `new
HostGame(...)` — тесты для игры по-прежнему вправе импортировать
`@vimp/tanks` напрямую (граница ESLint касается только `packages/engine/**`).
Ручная проверка: `npm run dev` + `curl` — `GET /games/manifest.json` отдаёт
dev-манифест с `entries.host`/`entries.wasm` на `/@fs/`-путях исходников,
оба пути отдаются мастером и резолвятся Vite (import игры в Worker'е
сработает); `GET /games/tanks/maps/manifest.json` отвечает per-game
каталогом. `npx eslint .` и `npm test` — 683/683 зелёные (тот же счётчик,
что и после 6.3 — распил не добавил и не убрал тестов, только сместил
точку внедрения зависимости).

**6.5 — заметки реализации.** Составной `codeVersion` собирается на мастере
(`SignalingServer._onRegisterHost`) как `{ engine, game: { id, version } }`:
`engine` — прежний `WorkerCatalog.version`, `game.version` — источник
истины `GameCatalog.getManifest(gameId).version` (fallback на
самоприсланный хостом `gameVersion`, только если игра неизвестна каталогу,
как и у `mapsVersion`); `main.js`/`WorkerCatalog` не менялись — композиция
целиком в `SignalingServer`. Клиент (`packages/engine/src/client/main.js`)
хранит `hostCodeVersion`/`failedCodeVersion` тем же составным объектом,
сравнивает через `codeVersionKey()` (строковый ключ `engine:gameId:gameVersion`
— расхождение любой части триггерит `refreshHostWorker`, как и раньше
триггерило только расхождение движка). `refreshHostWorker()` теперь фетчит
не только `/worker/manifest.json`, но и свежий `GET /games/:id/manifest.json`
активной игры (`fetchGameManifest`, новый метод `lobbyConfig.game.manifestUrl`)
— из него собирается новый `room.game` (`{id, version, hostEntryUrl,
wasmUrl}`), который едет в `HostController.swapWorker(url, game)` вторым
аргументом. `HostController._onHandoffState` подменяет `this._room.game`
этим свежим объектом непосредственно перед `init` нового Worker'а (тот же
приём, что и `updateMaps` для `room.maps`) — деплой только игры (без деплоя
движка) теперь тоже запускает релокацию и новый Worker не подхватывает
протухший `hostEntryUrl` из момента создания комнаты. `HANDOFF_VERSION`
(`host/HostGame.js`) поднят до 2: `_collectHandoff`/`_restoreFromHandoff`
несут `gameId` (из `hostPlugin.id`, загруженного при `onInit`) и
`gameVersion` (проброшен новым опциональным параметром конструктора
`HostGame`, `host.worker.js` передаёт `room.game.version`); рассинхрон
`gameId` при восстановлении — та же ошибка init, что и раньше валила
несовместимую версию формата, штатный `resume`-путь не менялся. Новые/правленные
тесты: `tests/master/SignalingServer.test.js` (составной `codeVersion` в
`host_registered`, `game.version` из каталога против `gameVersion` хоста),
`tests/host/HostGame.test.js` (`meta.version === 2`, `meta.gameId`, новый
тест на рассинхрон `gameId`). `npx eslint .` и `npm test` — 684/684 зелёные
(+1 к счётчику 6.4 — новый тест на game-mismatch).

**6.2 — заметки реализации.** Реальный выход сборки игры (6.1) —
`games/tanks/dist/`, а не `dist/games/tanks/` из §2/6.1 — `GameCatalog` сканирует
`<gamesDir>/*/dist/manifest.json` (`gamesDir` = `games/`, вычисляется от cwd
мастера `path.resolve('..', '..', 'games')`, симметрично `WorkerCatalog`'овскому
`path.resolve('dist', 'assets')`), а не `dist/games/*/manifest.json`. Мастер
по-прежнему не исполняет код игры: `GameCatalog` читает только уже собранный
JSON (`dist/manifest.json` + `dist/maps/*.json`), никаких `import` игровых
модулей. Старые одноигровые `/maps/manifest.json`/`/maps/:name` (на
`gameMaps` из `gameRegistry.static.js`) на момент 6.2 оставлены как есть —
совместимость для ещё статической композиции движок↔игра; удалены в 6.4
вместе с `gameRegistry.static.js`, когда клиент/хост целиком перешли на
`GameManifest`/`/games/:id/maps/*`. Dev-режим — не
отдельная генерация манифеста «на лету» из исходников (как в первом чтении
пункта плана), а тот же собранный `dist/manifest.json` с точечной подменой
`entries.client`/`entries.host`/`entries.wasm` на `/@fs/`-пути (Vite отдаёт
их из исходников с HMR, `wasm` — из уже собранного `core/pkg-web/*_bg.wasm`,
поиск по суффиксу); `maps`/`assetsBase`/`roomDefaults`/`version` остаются
из dist — по аналогии с `WorkerCatalog`, `npm run game:build` нужен один раз
перед первым dev-запуском (как `core:build` для WASM-ядра). Все `dist/`-ассеты
(звуки/карты/хешированные бандлы) раздаются одним `express.static`-mount'ом
на `/games/:id/` (общий для dev и prod — в dev его использует только
`assetsBase`-контент, entries идут напрямую через Vite). `HostRegistry`/
`SignalingServer`: `register_host`/`host_registered`/публичный `GET /servers`
несут `gameId` (и внутренний `gameVersion` в реестре, наружу не отдаётся);
`mapsVersion` в `host_registered` — per-game (`GameCatalog.getManifest(gameId).maps.version`),
если хост объявил `gameId`, иначе прежний одноигровой fallback (с Этапа 6.4
хосты всегда шлют `gameId` — fallback остаётся резервом на случай
неизвестной игры в каталоге). Полный составной `codeVersion` `{engine, game}`
и `HANDOFF_VERSION=2` — по плану остаются задачей 6.5, не трогались.

**6.1 — заметки реализации.** `games/tanks/vite.config.js` собирает `--mode client|host` двумя прогонами `vite build` в общий `games/tanks/dist/` (`emptyOutDir: false`); верхнеуровневый `npm -w @vimp/tanks run build` чистит `dist/` один раз перед обоими прогонами. Обнаружено два грабля Vite при генерации плагинового ESM без `index.html`: (1) для non-lib билда Vite ставит `preserveEntrySignatures: false` и выбрасывает `export default` entry-модуля как "неиспользуемый" — фикс: `rollupOptions.preserveEntrySignatures: 'strict'`; (2) `build.lib` (альтернатива для (1)) инлайнит ЛЮБОЙ ассет как base64 независимо от `assetsInlineLimit` (`shouldInline()`: `if (build.lib) return true`) — вернули бы 2MB base64 wasm в JS вместо hashed-ассета (риск #3), поэтому lib-режим не используется вовсе. `assetsInlineLimit: 0` + `inlineDynamicImports: true` — по одному файлу на entry, `.wasm` остаётся отдельным hashed-ассетом (общий у client/host: контент идентичен → Rollup даёт одинаковое имя в обоих прогонах). `HostPlugin.createCore`/`ClientPlugin.createClientCore` (контракт §3.2/3.3) добавлены в `games/tanks/src/host/index.js`/`client/index.js` — иначе entry не ссылался бы на wasm-glue и ассет не попал бы в сборку; вызовы `plugin.createCore/createClientCore` в `host.worker.js`/`main.js` — ещё впереди (6.3/6.4), сейчас подключение статическое через `gameRegistry.static.js` (Этап 5), как и раньше для остальных полей контракта. `ClientPlugin.styles` — `tanks.css?inline` (строка вместо auto-inject `<link>`, которого не будет без `index.html`). Новые скрипты: `scripts/copy-game-sounds.js` (копия уже обработанных `audio:process`-звуков в `dist/games/tanks/sounds/` — повторный ffmpeg не нужен), `scripts/build-game-manifest.js` (хеш-версии `client`/`host`/`wasm`/`maps`, `roomDefaults` из `hostDefaults.timers` + `games/tanks/src/config/game.js`). `maps:export` переехал на `dist/games/tanks/maps/` (старое `games/tanks/src/data/maps/json/` ничем не потреблялось). Корневой `npm run game:build` = `audio:process` + `npm -w @vimp/tanks run build`; в общий `npm run build` пока не встроен (мастер не читает `dist/games/tanks/` до Этапа 6.2) — движковый build/dev не затронуты.

Готово: `npm run build` даёт dist движка + `dist/games/tanks/`; ручной сценарий эстафеты с подменой версии игры; dev-режим без пересборки работает; тесты зелёные.

### Этап 7. Фикстурная мини-игра и CI-матрица (M, 2 PR; можно после 5) — ✅ выполнен

- JS-фикстура `packages/engine/tests/fixtures/miniGame/`: HostPlugin с fake-core (JS-объект, реализующий Wasm Host ABI — благодаря generic ABI это ~150 строк) + ClientPlugin с 1–2 заглушечными parts и минимальными схемами panel/stat (1 команда! — проверка настраиваемости). Тесты движковой меты/HostGame переводятся на фикстуру; интеграционные на реальном `@vimp/tanks` остаются в `integration`.
- Rust: расширить сценарии `TestGame` в engine-crate (схемы снапшота, предиктор).
- CI-матрица: `lint` → `engine` (cargo engine + vitest engine-*) / `tanks` (cargo tanks + vitest tanks) / `integration` (core:build:node + сборка игры + integration).
- Готово: движковые тесты проходят без Rust-артефактов игры; матрица зелёная. Фикстура — фактическое доказательство «второй игры».

**Заметки реализации.** `packages/engine/tests/fixtures/miniGame/` — самостоятельный
HostPlugin/ClientPlugin (`id: 'miniGame'`), структурно отличный от танков: одна
играющая команда (`team1` + `spectators`, вместо `team1`/`team2`), без оружия
(`parts.weapons: {}`), один флаг панели, `/spawn` вместо `/bot` (генерик
`ScriptedManager` — зеркало `TanksBotManager`, тот же контракт scripted-модуля).
`host/fakeCore.js` — `FakeGameCore`: актёры — плоские JS-объекты (`x/y/vx/vy`),
без Rapier/WASM; реализует полную поверхность методов, которые вызывает
`GameCoreAdapter` (`load_map`/`spawn_actor`/`apply_input`/`step`/`take_events`/
`pack_body`/`pack_frame`/`serialize_state`/… — 23 метода). Обнаружено, что
движковый `RoundManager`/`RTTManager` безусловно пишут в Stat поля
`status`/`score`/`deaths`/`latency` (не через схему) — стат-схема фикстуры
поэтому несёт тот же набор колонок, что и танки; отличие — только число
играющих команд (1 вместо 2), это и есть проверяемая ось настраиваемости, а
не произвольность самих колонок. `camelcase` ESLint-правило выключено точечно
для `fakeCore.js`/`fakeClientCore.js` (имена методов зеркалят Wasm Host ABI —
snake_case, как у настоящих wasm-bindgen-биндингов).

Тесты: `tests/host/fixtureHarness.js` (переиспользует `onboarding`-хелперы
`tests/host/harness.js` — они не завязаны на конкретное ядро; `createHost`
не переиспользуется — тот дергает реальный `@vimp/tanks`) +
`tests/host/HostGame.fixture.test.js` (8 сценариев: карта, онбординг, вход в
команду, движение, `/spawn`, стат с одной командой, `removeUser`, эстафета
`requestHandoff`/восстановление) — в проекте `engine-node` (без гейта). Плюс
`packages/engine/tests/fixtures/miniGame.contract.test.js` (6 тестов) —
проверяет форму контракта (ABI-поверхность fake-core, `assertGameConfigShape`,
совместимость с `buildCoreConfig`, `engineApi`, число parts). Проверено вручную
(временным удалением `pkg-node`/`pkg-web`): весь `engine-node`+`engine-client`
(618 тестов) проходит без единого собранного Rust-артефакта игры.

Rust: `packages/engine/core/src/game.rs` — фикстура `TestGame`/`TestSim`
(`#[cfg(test)] mod fixture`), актёры без Rapier-тел (тот же принцип, что у
клиентской фикстуры `TestClient`, `client/game.rs`, — форма ABI важнее
физики); 5 тестов (`spawn_actor`+`on_fixed_step` движение, `remove_actor`,
`on_ai_tick` для scripted-актёра, упаковка `build_snapshot_blocks` через
реальный `SnapshotPacker`, `serialize`/`deserialize` round-trip). В
`client/game.rs` добавлен 4-й тест к существующей фикстуре `TestClient`:
второй ключ схемы другого `BlockKind` (`indexedNoNull8` рядом с `indexed8`) —
доказывает, что hot-буфер остаётся schema-driven для произвольного набора
ключей. `cargo test --workspace` — 59 (engine, было 52) + 38 (tanks) + 12
(integration) = 109, зелёные.

CI (`.github/workflows/test.yml`) — четыре независимых job вместо одного:
`lint` (только eslint), `engine` (`cargo test -p vimp-engine-core` +
`vitest run --project engine-node --project engine-client`, без сборки WASM
вообще), `tanks` (`cargo test -p vimp-tanks-core` + `core:build:web` +
`vitest run --project tanks`), `integration` (`core:build` — оба таргета —
+ `vitest run --project integration`). При построении матрицы обнаружен
скрытый пробел прежнего единого пайплайна: он собирал только
`core:build:node`, а `tests/host/harness.js` (используется
`HostGame.test.js`) и весь проект `tanks` (`hostPlugin.test.js` и др.)
статически импортируют `@vimp/tanks/host|client/index.js`, которые грузят
именно `pkg-web`, а не `pkg-node` — на чистом чекауте (без локально
собранных артефактов на диске) прежний CI упал бы на этих тестах; починено
явной сборкой обоих таргетов там, где они нужны (проверено локально —
временным перемещением `pkg-node`/`pkg-web`).

### Этап 8. Сборка, деплой, документация, финал (L, 2–3 PR) — частично выполнен

- Dockerfile: rust-стадия — `wasm-pack build games/*/core`; node-стадия — движок + игры (`dist/` + `dist/games/*`); runner — `dist/`, `public/`, `packages/engine/src/{config,lib,master}` (каталог `src/data` из runner-а исчезает — карты в `dist/games/*/maps`). `deploy.yml` — без сущностных изменений.
- Документация `docs/{en,ru}`: реструктуризация — движковые страницы (architecture, master, host, client, core, network, configuration, deployment) + `plugin-api.md` + страница игры (`games/tanks.md`: правила, баланс, карты/оружие/звуки из текущих gameplay/extending); переписать CLAUDE.md (структура, команды, границы, таблица актуализации доков).
- Чек-лист выноса `games/tanks` в отдельный репозиторий: публикация `@vimp/engine` (npm/архив) + `vimp-engine-core` (git/crates-зависимость), CI игры, политика `engineApi`.
- Финальный ручной smoke: две вкладки (движение/выстрелы/респаун/смена карты/боты/голосования/чат/панель/стата), эстафета Worker'ов, `/ban`, прод-развёртывание на VPS.

**Заметки реализации.** `Dockerfile` был фактически сломан относительно
текущей структуры репозитория (написан ещё для монолита до Этапа 5/6) —
`core-builder` собирал несуществующий `core/` вместо `games/tanks/core`
(cdylib, тянет `packages/engine/core` как path-зависимость через корневой
`Cargo.toml`), а runner копировал уже удалённый в 6.4
`packages/engine/src/gameRegistry.static.js` и статические данные
`games/tanks/src` — на текущем коде образ вообще не собрался бы. Починено:
`core-builder` копирует корневой `Cargo.toml` + оба crate и собирает
`wasm-pack build games/tanks/core --release --target web --out-dir
pkg-web`; node-стадия `builder` после `npm ci` и копирования `pkg-web`
выполняет `npm run game:build && npm run build:app` (сборка
игры-плагина — client/host-бандлы, wasm-ассет, карты, звуки,
`manifest.json`, в `games/tanks/dist/` — и следом движка); `runner`
копирует `packages/engine/{dist,public,src/config,src/lib,src/master}` +
целиком `games/tanks/dist` (мастер читает плагин только через
`GameCatalog`, т.е. уже собранный `dist/manifest.json` +
`dist/maps/*.json` — исходники `games/tanks/src` раннеру не нужны, как и
`gameRegistry.static.js`, которого больше не существует).
`.dockerignore` синхронизирован с новыми путями Rust-артефактов
(`packages/engine/core/target`, `games/tanks/core/{target,pkg-web,pkg-node}`
вместо старого `core/*`). `deploy.yml` изменений не потребовал — уже был
game-агностичен. `docs/{en,ru}/deployment.md` — снят устаревший коллбэк
«Docker-образ пока не собирает игру (отложено на Этап 8)», описана
реальная сборка; `docs/{en,ru}/extending.md` — поправлены осиротевшие
пути `core/src/*` (остались от единого crate до 4b) на
`packages/engine/core/src/*` (движковое: `snapshot.rs`,
`client/unpack.rs`) и `games/tanks/core/src/*` (игровое: `tanks.rs`,
`tank.rs`, `bomb.rs`, `client/shot.rs`); туда же добавлен раздел «Вынос
`games/tanks` в отдельный репозиторий» — чек-лист из 6 пунктов (публикация
`@vimp/engine`, `git`-зависимость на `vimp-engine-core` вместо
`path`-зависимости, отдельный CI по образцу job'ов `tanks`/`integration`,
отдельная сборка/доставка `dist/` для `GameCatalog`, `ENGINE_API_VERSION`
как semver-контракт между релизными линиями, снятие `games/tanks` из
корневого workspace/`Cargo.toml` members). `CLAUDE.md` уже был
реструктурирован по требуемому формату (движок/игра, таблица докстраниц,
границы) в одном из предыдущих PR — правок не потребовалось; страница
`games/tanks.md` (объединение gameplay.md/extending.md в одну
игровую страницу) не создавалась — `gameplay.md`/`extending.md` уже
целиком про игру и перечислены как таковые в README ToC, реструктуризация
ToC признана некритичной и оставлена вне объёма этого прохода.
`npx eslint .` и `npm test` — 72 файла / 702 теста, зелёные.

**Не выполнено в этом проходе (осталось человеку):** реальная сборка
Docker-образа (`docker build`) — недоступен Docker в среде выполнения,
проверено только логическим разбором путей/скриптов; финальный ручной
smoke (два реальных браузерных таба: движение/выстрелы/респаун/смена
карты/боты/голосования/чат/панель/стата, эстафета Worker'ов, `/ban`) и
прод-развёртывание на VPS — недоступны без HTTPS-сертификатов/браузера в
этой среде.

Критический путь: 1 → 2 → 3 → 5 → 6 → 8; этап 4 параллелен 3 (синхронизация: 4a до 5); 7 — после 5.

## 5. Риски

1. **wasm-bindgen и generics** — решено обёртками в game-crate; engine-crate не должен зависеть от wasm-bindgen вовсе (иначе конфликт glue). Проверить в 4b сборку `wasm-pack build games/tanks/core` с path-dependency.
2. **Производительность** — мономорфизация без оверхеда; schema-driven кодек — интерпретация на ~30 упаковок/сек, пренебрежимо на фоне Rapier; `sample()` без аллокаций (переиспользуемый буфер). Бенчмарк-гейт в 4a (время `step+pack_body` до/после).
3. **Vite и мульти-entry игры** — общие chunks могут утащить DOM-код в worker-бандл: собирать client/host двумя независимыми прогонами. WASM грузится только по явному `entries.wasm` через `init(url)` — `import.meta.url`-резолюция glue не используется вовсе (известные грабли динамически импортируемых модулей в Worker'е); base64-инлайн отвергнут (+33% размера, ломает `instantiateStreaming`, дублирует WASM в двух бандлах вместо общего HTTP-кеша).
4. **Двойной WASM во вкладке хоста** (GameCore в Worker + ClientCore в main thread) — уже так; следить, чтобы оба entry ссылались на один hashed `.wasm` (HTTP-кеш).
5. **CSP/динамический import** — бандлы игры same-origin (`/games/...`): `script-src 'self'` достаточно, для wasm — `'wasm-unsafe-eval'` в prod-CSP Nginx (задокументировать в deployment.md). Module-Worker — уже требование текущего прода (`HostController` создаёт `new Worker(url, {type:'module'})`), и нужен он только хосту комнаты; classic-fallback не строим (запретил бы ESM и потребовал инлайн WASM) — вместо него фича-детект при «Создать сервер» (6.3). Dynamic import в module-Worker'е — включить в smoke этапов 6 и 8 (особенно Firefox/Safari).
6. **Эстафета при рассинхроне** — плагин с чужим `engineApi` отвергается при init нового Worker'а → штатный `resume`; хеши по содержимому, чтобы смена только манифеста не провоцировала эстафету.
7. **Schema-driven DOM панели/статы** — самый заметный UI-рефакторинг (генерация вместо pug): регресс стилей/z-index; игровой CSS отделяется от движкового. Митигируется ручным smoke в 3.10 и скриншот-сравнением.
8. **Объём правок тестов** (~620 JS) — этапы 3 (моки SocketManager/CommandProcessor/Panel), 4a (формы decode_frame в harness), 5 (пути). Митигируется мелкой нарезкой PR и правилом «тесты в том же PR».
9. **Инварианты, которые легко потерять**: gameId в кадре — u8 (≤255 участников — задокументировать в plugin-api.md); порядок ключей `weapons` определяет weapon-index (зафиксировать тестом); соответствие полей `panel` ↔ ключей `weapons` валидировать в `new GameCore`.
10. **Dev-DX** — HMR для parts сохраняется через Vite-URL исходников в dev-манифесте; для Worker'а HMR нет и не было (reload); nodemon следит за `games/*/src`.

## 6. Открытые вопросы (решать по ходу, с рекомендациями)

- **`GAME_CODES`/`gameInform`** (winnerTeam/roundStart/gameOver): раунды — движковый механизм, тексты — у игры (рекомендация: оставить коды движковыми, на v1 не усложнять хуками).
- **Лобби при нескольких играх**: поля `gameId`/`title` в `/servers` и фильтр заложить в 6.2/6.3; полноценный UI выбора игры — при появлении второй игры.
- **Публикация движка для внешнего репозитория игры**: npm-пакет + git/crates-зависимость engine-core — решение на этапе 8 (чек-лист), монорепо не блокирует.
- **`serialize_state`/`deserialize_state`** (mid-round handoff): переводятся на `{engine, game}`-дамп через `GameSim::serialize`, сохраняются как задел — не выпиливать.
- **`chatMaxLength`** — связан с DOM-инпутом чата (движок) и валидацией хоста: рекомендация — движковый параметр с override игры.

## 7. Задел под пункт 2 (слои карт и редактор — вне этого плана)

- Формат тайл-карты — движковый (`map.rs` + `MapCatalog`/`maps:export`), контент — игровой: редактор карт станет страницей движка, пишущей движковый формат.
- `respawns` как словарь произвольных команд (3.6) и schema-driven снапшот (3.4) — уже готовы к «полноценным игровым слоям» (слой как поле сущности в схеме, семантика слоёв — у игры).
- Схемы panel/stat/vote (произвольные команды/поля) не будут мешать картам с иным числом команд.
- `PredictCtx` в `motion_step` (3.6) — готовый канал доступа предиктора к сетке статических тайлов карты: клиентские коллизии/скольжение вдоль стен для будущих жанров без инерции, без bump `ENGINE_API_VERSION`.

## 8. Верификация всего плана

- Автоматическая: на каждом этапе — `npx eslint .`, `npm test`, `npm run core:test` (позже `cargo test --workspace`), CI-матрица этапа 7; ESLint-граница «движок не импортирует игру» с этапа 5.
- Ручной smoke (минимум в 3.10, 4a, 6, 8): две вкладки — создание комнаты, движение/выстрелы/урон/респаун, панель/стата/чат/голосования, `/bot`, смена карты; эстафета Worker'ов с подменой версии; `/ban`.
- Доказательство отделимости: фикстурная мини-игра (этап 7) собирается и проходит движковые тесты без единого импорта из `games/tanks`.
