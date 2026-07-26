## 1. Структура Rust-ядра

Всего ~9400 строк Rust. По модулям (строки — по `wc -l`):

| Файл | Строк | Роль |
| --- | --- | --- |
| `game.rs` | 1208 | **Ядро симуляции хоста** `GameState`: физ-цикл + вся игровая логика (танки/бомбы/оружие/боты/контакты/детонация/снапшот-накопители/handoff). Главный кандидат на распил `EngineSim` ↔ `TanksSim`. |
| `lib.rs` | 423 | Публичный WASM-ABI: `#[wasm_bindgen]`-обёртки `GameCore` и `ClientCore`. |
| `snapshot.rs` | 388 | `SnapshotPacker` — бинарная упаковка кадра v3 (захардкоженные раскладки блоков). |
| `config.rs` | 207 | Serde-конфиги: `CoreConfig`, `ClientConfig`, модели/оружие/клавиши/снапшот-ключи. |
| `physics.rs` | 152 | `BodyTag` (кодировка `user_data` тела) + math-утилиты (`round1/2`, `deg_to_rad`, `lerp`, `clamp`, `lerp_angle`, `normalize_angle`). **Не** содержит `PhysicsWorld` — это тип из `rapier2d::prelude` (см. §7). |
| `motion.rs` | 146 | Mass-free формулы движения танка — общий источник для `Tank::update` и клиентского предикта. |
| `map.rs` | 255 | `GameMap`: статические стены (жадный блок-мёрж), динамические объекты, респауны, `dynamic_map_data`. |
| `tank.rs` | 540 | `Tank` + `PlayerKeyBits` + `ShotCommand`: движение, урон, оружие, снапшот-строка, prediction_state. |
| `bomb.rs` | 84 | `Bomb` + `BombRow`: взрывной снаряд (сенсор в Rapier), строка снапшота. |
| `events.rs` | 27 | `CoreEvent` (enum: Kill/Health/Ammo/ActiveWeapon/Shake) — «топливо» JS-меты. |
| `rng.rs` | 69 | `Rng` (SplitMix64) — детерминированный PRNG. |
| **`client/`** | | Клиентское ядро (§5) |
| `client/mod.rs` | 649 | `ClientState` — оркестратор клиентского тика (hot-буфер §5). |
| `client/shot.rs` | 948 | `ShotPredictor` — визуальный спавн выстрелов, фильтр дублей (игровое). |
| `client/predictor.rs` | 861 | `Predictor` — CSP своего танка + parity-тесты. |
| `client/unpack.rs` | 833 | Декодер кадра v3 + JSON-сериализация форм `unpackFrame`. |
| `client/interpolator.rs` | 639 | `Interpolator` — snapshot-интерполяция. |
| `client/raycast.rs` | 303 | 2D raycast-примитивы (`ray_vs_grid` DDA, `ray_vs_box` OBB slab) — движковое. |
| **`bots/`** | | ИИ и навигация (§6) |
| `bots/controller.rs` | 715 | `BotBrain` — ИИ танка (игровое). |
| `bots/navigation.rs` | 303 | `NavigationSystem` — nav-граф + LoS (Брезенхэм) + walkable. |
| `bots/pathfinder.rs` | 116 | A* по графу (движковое). |
| `bots/spatial.rs` | 97 | `SpatialGrid` — сетка поиска соседей (движковое). |
| `bots/mod.rs` | 4 | Реэкспорт. |
| `tests/sim.rs` | 460 | Интеграционные тесты через `GameCore`. |

Соответствие таблице распила из PLAN.md (строки 196-198): движок ← `physics/rng/map/pathfinder/spatial/snapshot-framing/interpolator/predictor/raycast/unpack-framing` + фикс-шаг из `game.rs`; игра ← `tank/bomb/motion/controller/navigation/shot` + логика `game.rs`.

---

## 2. JS-граница с ядром

Две `#[wasm_bindgen]`-структуры. `GameCore` держит `state: GameState` + `packer: SnapshotPacker` (`lib.rs:28-31`). `ClientCore` держит `state: ClientState` (`lib.rs:305-307`).

### `GameCore` — методы (сигнатуры)

| Метод | Строка | Сигнатура / обмен |
| --- | --- | --- |
| `new(config_json: &str)` | 38 | конструктор; парсит `CoreConfig` из JSON → `Result<GameCore, JsError>` |
| `load_map(map_json: &str)` | 51 | JSON-in → `Result<(), JsError>` |
| `map_info()` | 57 | → JSON-строка (setId/step/width/height/respawns) |
| `spawn_tank(game_id:u32, model:&str, team_id:u8, x,y,angle_deg:f32)` | 77 | скаляры → `Result<(),JsError>` |
| `remove_tank(game_id:u32)` | 91 | скаляр |
| `reset_tank(game_id,team_id,x,y,angle_deg)` | 96 | скаляры |
| `reset_all_vitals()` | 101 | — |
| `add_bot(...)` / `remove_bot(game_id)` | 105 / 119 | как spawn_tank |
| `apply_input(game_id:u32, seq:u32, action:&str, key_name:&str)` | 127 | wire `seq:action:name` парсит JS-обёртка |
| `step(dt:f32)` | 132 | скаляр |
| `take_events()` | 138 | → JSON-строка `Vec<CoreEvent>`, дренирует `state.events` |
| `last_input_seq(game_id)->u32` | 146 | скаляр |
| `is_alive(game_id)->bool` | 150 | скаляр |
| `position_of(game_id)->Vec<f32>` | 155 | `[x,y]` round2 или пусто |
| `players_data()->String` | 164 | JSON `Game.getPlayersData` (не дренирует) |
| `alive_players()->Vec<f32>` | 170 | плоский `[id,team,x,y,...]` |
| `pack_body()` | 194 | собирает body-блоки, дренирует накопители → `Result<(),JsError>` |
| `pack_frame(server_time:f64, seq:u32, has_camera:bool, camera_x,camera_y:f32, force_reset:bool, shake:Option<String>, player_id:i32)->usize` | 206 | собирает per-user кадр во внутр. буфер, возвращает длину; `player_id<0` = наблюдатель |
| `body_has_events()->bool` | 247 | классификация канала WebRTC (meta/state) |
| `frame_ptr()->*const u8` | 253 | zero-copy указатель на буфер кадра |
| `frame_bytes()->Vec<u8>` | 259 | копия (nodejs-таргет) |
| `remove_players_and_shots()->String` | 267 | JSON-массив имён |
| `clear()` | 273 | — |
| `serialize_state()->Result<Vec<u8>,JsError>` / `deserialize_state(&[u8])` | 278 / 282 | Worker handoff |

Плюс не-экспортируемые `state()` / `state_mut()` для нативных тестов (`lib.rs:289-298`).

### `ClientCore` — методы

| Метод | Строка | Обмен |
| --- | --- | --- |
| `new(config_json:&str)` | 314 | парсит `ClientConfig` → `Result<ClientCore,JsError>` |
| `push_frame(data:&[u8], local_now:f64)->bool` | 328 | бинарный кадр in |
| `my_game_id()->i32` | 333 | -1 если нет |
| `offset()->f64` | 338 | NaN если нет |
| `sample(local_now:f64)->usize` | 347 | рендер-тик, длина hot-буфера |
| `hot_ptr()->*const f32` / `hot_values()->Vec<f32>` | 354 / 359 | zero-copy / копия |
| `take_frames()->String` | 366 | JSON событийных кадров |
| `apply_input(action:&str, key_name:&str, local_now:f64)` | 373 | — |
| `try_fire(local_now:f64)->Option<String>` | 379 | JSON спавна или None |
| `cycle_weapon(back:bool)` | 384 | — |
| `set_model(&str)` / `set_active(bool)` | 391 / 396 | — |
| `set_map(map_json:&str)->Result<(),JsError>` | 401 | — |
| `sync_panel(panel_json:&str)` | 406 | — |
| `reset()` | 411 | — |
| `decode_frame(data:&[u8])->String` | 420 | чистая распаковка для тестов |

Замечание для 4a: `pack_frame` (`lib.rs:224-237`) достаёт player-блок через `state.prediction_state(game_id)` возвращая `([f32;8], centering)` — жёстко зашитая длина состояния 8; PLAN.md 4a.2 требует schema-driven `STATE_LEN`.

---

## 3. Спроектированный этап 4a

**Граница `EngineSim` / `TanksSim` уже физически видна** в `game.rs`:
- Движок забирает: `world/map/nav/spatial/rng/accumulator/time_step/bodies_to_destroy/events`, `while`-цикл `step` (317-322), сбор контактов (401-413), `destroy_queued_bodies` (488), фрейминг `build_snapshot_blocks`, handoff-каркас.
- `TanksSim` получает callbacks: `on_fixed_step` ← тело цикла танков + снаряды (348-398), `on_contacts` ← `process_contact_events` (420) + `apply_damage`/`process_hitscan`/`detonate`, `on_ai_tick` ← блок ботов (329-340).

**Захардкоженные раскладки под schema-driven (4a.2):** `snapshot.rs:write_block` (130-206), `unpack.rs:read_*` (237-354), `client/mod.rs:write_hot` (295-371), `interpolator.rs` (`TANK_ANGLE_INDEXES`/`TANK_LERP_LENGTH` 24-25), player-блок `[f32;8]` в `lib.rs:224-237` + `snapshot.rs:256-265` (нужен `STATE_LEN` из схемы).

**Уже generic / движковое, минимум работы:** `raycast.rs`, `pathfinder.rs`, `spatial.rs`, `rng.rs`, `map.rs` (респауны по произвольным командам), math в `physics.rs`.

**Требует разделения `BodyTag`:** `physics.rs:4-16` — `Shot{weapon, owner_id}` игровые поля в движковом теге. Остаётся нерешённым и после трейт-распила ниже (не блокирует его — `BodyTag::decode` вызывается только внутри `TanksSim`/`BotView`, не в движковом коде `game.rs`); актуально к физическому распилу crate (4b).

**Фактическая реализация пункта 1 (трейты `GameDef`/`GameSim` + `EngineSim<TanksGame>`):**
- `core/src/sim.rs` — `trait GameDef { type Sim: GameSim<Self>; }`, `trait GameSim<G>` (spawn/remove/reset участников, `apply_input`, запросы состояния, `on_fixed_step`/`on_contacts`/`on_before_destroy`/`on_ai_tick`, `build_snapshot_blocks`, `serialize`/`deserialize`, `rebuild_spatial_grid`), `struct SimCtx<'a>` (мир, конфиг, карта, нав-граф, сетка, PRNG, события, destroy-очередь) — конструируется только на время тика (`step`/`step_fixed`), остальные методы трейта получают точечные параметры вместо всего `SimCtx`.
- `core/src/game.rs` — `EngineSim<G: GameDef = TanksGame>` (было `GameState`; `pub type GameState = EngineSim<TanksGame>` оставляет старое имя рабочим во всех вызывающих местах без правок). Владеет `world`/`map`/`nav`/`spatial`/`rng`/`accumulator`/`events`/`bodies_to_destroy`; `step`/`step_fixed` — единственное место, что зовёт `sim.on_fixed_step`/`on_contacts`/`on_before_destroy`/`on_ai_tick`; `build_snapshot_blocks` добавляет блок динамики карты поверх игровых блоков от `sim`.
- `core/src/tanks.rs` — `TanksGame` (маркер), `TanksSim` (бывшие игровые поля `GameState`: `tanks`/`bots`/`shots`/накопители снапшота/`key_bits`), реализация `GameSim<TanksGame>` + перенесённые `process_hitscan`/`create_weapon_action`/`process_shots_expired_by_time`/`detonate`/`apply_damage`/`remove_shots`. `BotView<'a>` — адаптер с именами полей/методов монолитного `GameState` (`world`/`nav`/`spatial`/`rng`/`tanks`/`key_bits`/`weapon_index`/`tank_position_rounded`/`tank_alive`/`update_tank_keys`), передаётся в `BotBrain::update` вместо `&mut GameState` — тело `bots/controller.rs` не потребовало смысловых изменений, только замена типа параметра.
- `on_before_destroy(&mut self, world: &PhysicsWorld, handle)` — метод трейта, которого не было в дословной сигнатуре PLAN.md §3.6; добавлен, т.к. `destroy_queued_bodies` (движковое) нуждается в игровом хуке для null-маркера уничтоженной бомбы без утечки `BodyTag`-семантики в `game.rs`.
- `CoreConfig` не разделён на движковую/игровую половины (в `sim.rs`/`game.rs` используется целиком, `GameDef` без `type Config`) — этот шаг не был частью пункта 1, актуален вместе с `BodyTag`-разделением к физическому распилу 4b.
- Проверено: `cargo test --manifest-path core/Cargo.toml` — 95/95 (включая `client::predictor::parity::*` и `state_dump_restores_identical_simulation`), пересборка `core:build:node`+`core:build:web`, `npm test` — 664/664, `npx eslint .` — чисто.

---

## 4. JS-сторона Этапа 4a (актуализация после Этапа 5)

Секции 1–3 актуальны без правок: `core/` не менялся с до-Этапа-3 (счётчики строк и
якоря `lib.rs`/`snapshot.rs`/`interpolator.rs`/`physics.rs`/`game.rs` совпадают), ядро
остаётся в корне репозитория — переезд в `packages/engine/core` + `games/tanks/core`
относится к Этапу 4b, **не** к 4a.

Этап 5 (коммит `7b3df8a`) перенёс движковый JS `src/` → `packages/engine/src/`. Файлы,
которые 4a правит **зеркально** к Rust-изменениям, теперь лежат по новым путям (номера
строк — на момент актуализации):

| Под-этап | Rust-изменение | JS-зеркало (текущий путь) | Якоря |
| --- | --- | --- | --- |
| 4a.1 ✅ | ABI-переименования `spawn_tank→spawn_actor`, `add_bot→spawn_scripted_actor`, `remove_tank/reset_tank→remove_actor/reset_actor` | `packages/engine/src/host/GameCoreAdapter.js` (181 стр.) | вызовы ядра: `players_data`@104, `step`@111, `take_events`@119, `pack_body`@130, `body_has_events`@136, `pack_frame`@155 |
| 4a.2 ✅ | schema-driven снапшот (`SnapshotConfig.keys: BlockSchema{id,kind,class,fields}`, `FieldType`/`Interp`/`FieldValue` в `core/src/config.rs`; `write_block`/`read_*`/`interpolate_game` — интерпретаторы схемы; `PLAYER_STATE_LEN` централизована). Байтовая раскладка не изменилась (побайтовая парность подтверждена существующими тестами) → `SNAPSHOT_FORMAT_VERSION` **не** поднят (осталась 3) — версия защищает фрейминг, не JSON-конфиг. Бенчмарк: `step+pack_body` ~7мкс/вызов (8 танков), деградации нет | `packages/engine/src/config/opcodes.js` (SNAPSHOT_KEYS расширен до `{id,kind,class,fields}` по каждому ключу) | — |
| 4a.2 | generic `reconstructHot` в `main.js` — **сознательно не сделано**: раскладка hot-записи (12 float/танк, 5/динамика) не изменилась, т.к. Row-структуры (`TankRow` и т.п.) остались конкретными (инкрементальный, не полный `RowData`-подход, см. план) — переписывать byte-идентичный код без функциональной необходимости признано лишним риском для rAF-пути | `packages/engine/src/client/main.js` (1261 стр.) | `reconstructHot`@533 (зовётся @602) — без изменений |
| 4a.3 ✅ | стандартные события `panelSet/panelActive/death/shake/custom` + generic-роутинг (снимает временный eventRouter из PR 3.1). `core/src/events.rs`: `Health/Ammo→PanelSet{id,field,value}`, `ActiveWeapon→PanelActive{id,field}`, `Kill→Death{victim,killer}`, `Shake` без изменений, `+Custom{data}` (задел, танки не используют) | `packages/engine/src/host/GameCoreAdapter.js` | `_drainEvents` роутит стандартный словарь сама (без инъекции); опциональный `onCoreEvent(data, services)` только для `custom`. `games/tanks/src/host/coreEventRouter.js` удалён, `HostPlugin.onCoreEvent` не задан (танки не используют custom-события) |

**Внимание:** сам `PLAN.md` в разделе Этапа 4 (и в §3.1/3.5/3.6 таблицы этапа 3) всё ещё
ссылается на до-Этап-5 пути — `src/host/GameCoreAdapter.js:114-144` (стр. 166),
`src/client/main.js:505-551` (стр. 178), «зеркально `GameCoreAdapter`» (стр. 251). Читать
их как `packages/engine/src/...` с актуальными номерами строк из таблицы выше.

---

## 5. Этап 4b — физический распил на два crate (актуализация)

Раздел 1 (таблица файлов) и §3 этого документа описывают монолитный `core/`
до распила; после 4b те же модули лежат в `packages/engine/core/src/` или
`games/tanks/core/src/` по разметке §3.1 (движок ← physics/rng/map/
pathfinder/spatial/snapshot-framing/interpolator/predictor(generic)/raycast/
unpack-framing + фикс-шаг; игра ← tank/bomb/motion/controller/navigation/
shot) — с двумя уточнёнными отступлениями, зафиксированными по факту
кода (не по табличной разметке из §3.6 PLAN.md). Изначально при 4b
предполагалось ещё два отступления (`BodyTag` не разделён,
`snapshot.rs`/`Block` остаётся «игровым» набором вариантов) — при ревизии
плана выяснилось, что оба уже фактически реализованы в коде того же
коммита и отступлениями не являются:

- `BodyTag` **разделён**: движок (`packages/engine/core/src/physics.rs`)
  владеет только зарезервированным `MAP_OBJECT_TAG`/`encode_map_object`/
  `is_map_object`; весь enum `BodyTag` (`Player`/`Shot`) — в игровом
  `games/tanks/core/src/body_tag.rs`, с тестом round-trip против движковой
  кодировки.
- `snapshot.rs`/`Block` уже generic по форме: варианты (`Indexed8`/
  `Indexed32`/`List16`/`IndexedNoNull8`) названы по байтовой форме, а не по
  игровым сущностям (`Tanks`/`Bombs`/…), содержимое — `Vec<FieldValue>` по
  схеме. Полностью типизированный `RowData` не понадобился — эта форма уже
  закрывает потребности и движка, и игры без игровой семантики в самом
  типе.

Актуальные отступления:

1. **`bots/navigation.rs` → `nav/navigation.rs` (движок), а не игра**,
   вопреки табличной разметке PLAN.md §3.6 (`игра ← ... navigation`): файл
   уже не имел игровых зависимостей (`pathfinder`/`rng` только), а
   `EngineSim`/`SimCtx` хранят `Option<NavigationSystem>` как собственное
   поле движка — перенос в игру потребовал бы generic-параметра нав-типа в
   движковом каркасе. `bots/controller.rs` (`BotBrain`) остался в игре.
2. **`ClientState`/`Predictor`/`ShotPredictor`/`motion.rs` — целиком в
   game-crate**, GameClientDef-трейт (мотив §3.6 PLAN.md — `motion_step`/
   `render_from_state`) не реализован: `predictor.rs` уже вызывал
   `crate::motion` (формулы движения танка) напрямую до распила, т.е. не
   был generic на практике несмотря на расположение в `client/`. Движок
   экспортирует только действительно generic клиентские примитивы
   (`Interpolator`, `raycast`, `unpack`, схему снапшота); вторая игра
   напишет свой `ClientState` по образцу `TanksSim`/`GameSim`. Остаётся
   нереализованным — форма трейта не может быть надёжно спроектирована без
   второго реального клиента для проверки.

Движковые макросы `export_game_core_abi!`/`export_client_core_abi!`
(§3.4 PLAN.md, снятие ~45-метод-boilerplate) на момент 4b не были
реализованы — `games/tanks/core/src/lib.rs` переписан вручную построчным
зеркалом старого `core/src/lib.rs`. При ревизии плана выяснилось, что
`export_game_core_abi!` для `GameCore` можно извлечь уже сейчас, и это
сделано (`packages/engine/core/src/abi.rs`): 25 из 26 методов были
механическими 1:1-делегациями в уже generic `EngineSim<G>`/
`SnapshotPacker`, чья сигнатура зафиксирована трейтом `GameSim<G>`
(`sim.rs`) независимо от количества игр в дереве — это не проектирование
под гипотетическую вторую игру, а извлечение уже существующего
соответствия; `games/tanks/core/src/lib.rs` теперь содержит только
рукописный `new` и вызов `vimp_engine_core::export_game_core_abi!(GameCore);`.
Заодно приведены в порядок имена трейта `GameSim<G>`: `tank_alive`/
`tank_position_rounded` → `is_alive`/`actor_position` (соответствуют именам
в wasm ABI `is_alive`/`position_of`, ранее расходились). `export_client_core_abi!`
для `ClientCore` остаётся заблокирован тем же, чем п.2 (`ClientState`
целиком в игровом crate, нет
движкового аналога `EngineSim<G>` для клиента) — сделать сейчас без
угадывания формы трейта нельзя.

> **Актуализация (этап 4c):** оба «заблокированных» выше пункта выполнены.
> Трейт `GameClientDef` реализован — движок владеет generic
> `ClientState<G: GameClientDef>`
> (`packages/engine/core/src/client/game.rs`), игра поставляет
> `games/tanks/core/src/client/mod.rs`; `export_client_core_abi!` извлечён
> (`packages/engine/core/src/abi.rs`) и вызывается из
> `games/tanks/core/src/lib.rs` зеркально `export_game_core_abi!`.
> Отступление п.2 в части «`Predictor`/`motion.rs` в game-crate» снято
> частично: `motion.rs`/`predictor.rs`/`shot.rs` остаются игровыми, но
> generic-оркестрация клиента ушла в движок.

`CoreConfig`/`ClientConfig` разделены на движковую/игровую половины
(`EngineConfig`/`EngineClientConfig` vs `TanksConfig`/`TanksClientConfig`) —
пункт, отложенный в 4a.1 (§3 этого документа, «`CoreConfig` не разделён...
актуален... к физическому распилу 4b»). Игровой конфиг передаётся один раз
в `GameSim::new(cfg: &G::Config, engine_cfg: &EngineConfig)`; `TanksSim`
хранит свою копию (`models`/`weapons`/`panel`/`friendly_fire`/
`player_keys`), поэтому остальные методы трейта `GameSim` больше не
принимают `cfg`-параметр вовсе (был у `spawn_actor`/`apply_input`/
`reset_all_vitals`/`refresh_cached`/`build_snapshot_blocks`/
`remove_players_and_shots` — исчез). Wire-формат конструкторов `GameCore`/
`ClientCore::new` стал `{engine: {...}, game: {...}}` (`RootConfig`/
`RootClientConfig` в `games/tanks/core/src/config.rs`); JS-сборщики
(`packages/engine/src/lib/coreConfig.js`/`clientCoreConfig.js`) строят
плоский объект и раскладывают поля по обеим половинам — старые вызовы с
плоскими `overrides` не изменились.

Проверено: `cargo test --workspace` — 95/95 (50 engine + 33 tanks-lib + 12
integration, то же число тестов, что до распила — перенос файлов и
переработка сигнатур не потеряли и не задублировали тестов); `npm test` —
664/664 (интеграционный `tests/core/` и `tests/host/HostGame.test.js`
корректно находят пересобранный `games/tanks/core/pkg-node/`, не
скипаются); `npx eslint .` — чисто; `npm run build` (`core:build:web` +
Vite) — собирается, `vimp_tanks_core_bg.wasm` подхватывается как единый
ассет.
