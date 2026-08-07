# Rust-ядро движка (packages/engine/core)

`vimp-engine-core` — rlib-crate (`packages/engine/core/`, **без
wasm-bindgen**), реализующий обобщённый каркас симуляции: физику, фикс-шаг
тика, фрейминг снапшота, примитивы интерполяции/предикта/raycast и
нав-утилиты. Игровой специфики в нём нет — ни «танка», ни «бомбы»: игровой
crate (публикуется в собственном репозитории игры, например
`vimp-tanks-core`) зависит от него, реализует трейты `GameDef`/`GameSim`/
`GameClientDef` и выполняет собственно `#[wasm_bindgen]`-обвязку
(wasm-bindgen не умеет экспортировать дженерики, поэтому конкретные классы
`GameCore`/`ClientCore` существуют только в игровом crate). Движковый crate
не может импортировать ничего игрового, поэтому вторая игра просто
добавляет свой crate рядом со своим репозиторием, переиспользуя
`vimp-engine-core` без изменений.

Эта страница документирует **только движковый crate** — его трейты,
обобщённые механизмы и команды сборки/тестов для данного репозитория.
Конкретный WASM ABI, который обязан реализовать игровой crate, — контракт
в [plugin-api.md](plugin-api.md#wasm-host-abi-v1); собственная реализация
ядра игры документируется в её собственном репозитории (например,
`docs/ru/core.md` в `vimp-tanks`).

**Граница ядра — симуляция, а не мета**: чат, голосования, статистика,
панель, оркестрация раундов, реестр участников и auth остаются на JS. Мета
управляет ядром командами и питается его событиями.

## Структура

```
Cargo.toml                        # workspace: packages/engine/core (единственный member в этом репозитории)
packages/engine/core/             # vimp-engine-core — rlib, без wasm-bindgen
├── Cargo.toml                    # rapier2d (enhanced-determinism, serde) — без wasm-bindgen
├── src/
│   ├── lib.rs                    # только объявления pub mod
│   ├── sim.rs                    # GameDef/GameSim/SimCtx — граница трейтов движок↔игра
│   ├── game.rs                   # EngineSim<G> — тик, контакты, очередь удаления, handoff
│   ├── abi.rs                    # export_game_core_abi!/export_client_core_abi! — макросы
│   │                              #   wasm-bindgen-обвязки (см. разделы ABI ниже);
│   │                              #   раскрываются в игровом crate, который поставляет
│   │                              #   #[wasm_bindgen]
│   ├── map.rs                    # GameMap — статические/динамические тела, масштаб карты
│   ├── snapshot.rs                # SnapshotPacker + Block — упаковка бинарного кадра v3;
│   │                              #   Block обобщён по форме строки (Indexed8/Indexed32/
│   │                              #   List16/IndexedNoNull8), не по игровой сущности —
│   │                              #   движок не знает слов «танк»/«бомба», только форму строки
│   ├── events.rs                  # CoreEvent — стандартный словарь событий для JS-меты
│   ├── config.rs                  # EngineConfig/EngineClientConfig + типы схемы снапшота
│   │                              #   (BlockKind — enum формы строки, не игровой сущности)
│   ├── physics.rs                 # тег тела статики карты (encode_map_object/is_map_object),
│   │                              #   округления, углы — игровые теги тел (например, игрок/выстрел)
│   │                              #   живут в собственном модуле body-тегов игрового crate
│   ├── rng.rs                     # детерминированный PRNG (SplitMix64)
│   ├── debug.rs                   # курированный дамп мира (debug_json) — тела, коллайдеры,
│   │                              #   карта, нав, spatial, rng, аккумулятор фикс-шага
│   ├── nav/                       # обобщённые утилиты, смежные с ИИ (без слова «bot»)
│   │   ├── navigation.rs         # нав-сетка + граф + видимость (NavigationSystem)
│   │   ├── pathfinder.rs         # A*
│   │   └── spatial.rs            # пространственная сетка поиска целей
│   └── client/                    # обобщённые клиентские примитивы + оркестрация
│       ├── game.rs                # трейт GameClientDef + generic ClientState<G> — конвейер
│       │                          #   sample(), hot-буфер, очередь кадров; игра поставляет
│       │                          #   предикт/спавн выстрела через трейт
│       ├── unpack.rs              # декодер кадра v3 + JSON-формы
│       ├── divergence.rs          # детектор рассинхрона предикта (кольцевой буфер записей)
│       ├── interpolator.rs        # буфер снапшотов, seq, лерп (schema-driven)
│       └── raycast.rs             # DDA по тайлам + OBB slab-тест
```

## Сборка

У движкового crate нет собственного WASM-таргета — это обычный rlib,
покрытый своими unit-тестами и используемый любым игровым crate, который
от него зависит. Из этого репозитория:

```bash
npm run core:test         # cargo test --workspace (единственный member этого репозитория: packages/engine/core)
```

Настоящая сборка WASM (`wasm-pack build`, таргеты web + nodejs) происходит
в собственном репозитории игры, поскольку именно там определены классы
`#[wasm_bindgen]` — см. `core.md` того репозитория (например, `npm run
core:build` в `vimp-tanks`).

## ABI: макросы

Обвязка wasm-bindgen для двух экспортируемых классов игры (механические
1:1-делегации в generic `EngineSim<G>`/`ClientState<G>`) генерируется
двумя макросами в `packages/engine/core/src/abi.rs` —
`export_game_core_abi!` и `export_client_core_abi!` — единственным
источником истины обязательного набора методов, дрейф игрового crate от
него исключён. Игровой crate зовёт каждый макрос рядом со своими
дополнительными методами (например, действие огня/перезарядки/смены
модели или сигнатура спавна, зависящая от конфига); `new` (парсинг
конфига) и не-`#[wasm_bindgen]` тестовые аксессоры остаются рукописными в
игровом crate. Точный обязательный набор методов документирован как
контракт в [plugin-api.md](plugin-api.md#wasm-host-abi-v1).

## Детерминизм

- `rapier2d` собирается с `enhanced-determinism` (бит-в-бит на всех
  платформах при одинаковом вводе);
- вся случайность (разброс оружия, решения ботов и т.п.), как ожидается,
  проходит через встроенный SplitMix64 PRNG с сидом из конфига (`seed`),
  без `Math.random` — обеспечивается соглашением в играх, построенных на
  этом движке;
- handoff-дамп должен восстанавливать симуляцию бит-в-бит; движок
  предоставляет хуки serialize/deserialize в `GameSim`, игра закрепляет
  это своими тестами `state_dump_restores_identical_simulation`.

## Rust-трейты (`vimp-engine-core`)

Движковый crate — чистый Rust без wasm-bindgen (ошибки — `Result<_,
String>`; игровой crate маппит их в `JsError`). Статическая generic-
диспетчеризация: `EngineSim<G>` (хост) и `ClientState<G>` (клиент)
мономорфизируются под игровой `GameDef` `G` — нулевые накладные расходы на
120 Гц; `dyn` не нужен (один wasm-бандл = одна игра). Полные сигнатуры — в
[plugin-api.md](plugin-api.md#rust-трейты-vimp-engine-core); эта выжимка не
должна с ними расходиться.

- `trait GameDef { type Config; type Sim: GameSim<Self>; }`
- `trait GameSim<G: GameDef>`: `new`, `spawn_actor`, `remove_actor`,
  `reset_actor`, `reset_all_vitals`, `spawn_scripted_actor`,
  `remove_scripted_actor`, `apply_input`, `last_input_seq`, `is_alive`,
  `actor_position`, `prediction_state`, `alive_players_flat`,
  `players_json`, `on_fixed_step(ctx, dt)`, `on_contacts(ctx, pairs)`,
  `on_before_destroy`, `on_ai_tick(ctx, dt)`, `refresh_cached`,
  `build_snapshot_blocks(&mut self) -> (Vec<(String, Block)>, has_events)`,
  `remove_players_and_shots`, `clear`, `serialize/deserialize` (handoff
  посреди раунда — задел на будущее), `rebuild_spatial_grid`.
- `SimCtx<'a>` — доступ игры к возможностям движка внутри тиковых
  колбэков; **не** генерик по игре: `world` (Rapier), `cfg`
  (`EngineConfig`), `map` (респауны — `IndexMap<String, Vec<[f32;3]>>`,
  произвольные команды), `nav`/`spatial` (A*/сетка — движковые утилиты в
  модуле `nav/`, без слова «bot»), `rng`, `events`, `bodies_to_destroy`.
  Поля `game_cfg` нет: игровой конфиг приходит игре один раз, в
  `GameSim::new`, и реализация сама хранит нужное.
- Движок владеет: аккумулятором фикс-шага, сбором контактов, очередью
  удаления, schema-driven `SnapshotPacker`, скелетом handoff,
  `CoreEvent`.
- Клиентская половина: `trait GameClientDef` — `new`, `on_server_state`,
  `set_server_offset`, `update`, `track_frame`, `filter_frame_game`,
  `update_world`, `update_world_interpolated`, `render_overlay`,
  `apply_input`, `set_model`, `set_active`, `set_map`, `sync_panel`,
  `reset`, `cycle_item`, `try_action` плюс два хука детектора рассинхрона
  (`predicted_state`, `replayed_inputs`) с дефолтом `None` (см. ниже).
  Движок предоставляет `Interpolator` (schema-driven), generic-оркестровку
  `ClientState<G>` (сетевой буфер, очередь событийных кадров, hot-буфер
  рендер-тика) и raycast. Предсказание актора, клиентский спавн выстрела и
  панель — целиком забота игрового crate внутри его реализации
  `GameClientDef`, которая вызывает движковый raycast.

Форма трейта проверяется фикстурным вторым клиентом (`TestClient`, тесты в
`packages/engine/core/src/client/game.rs`) ещё до появления настоящей
второй игры — именно это гарантирует, что трейты остаются
игро-независимыми.

## Отладка: `debug_json` и детектор рассинхрона

Два отладочных механизма живут в движковом crate и экспортируются
ABI-макросами, поэтому достаются каждой игре даром и не трогают
`ENGINE_API_VERSION`. Контур, который их потребляет, целиком описан в
[debugging.md](debugging.md).

- **`debug.rs` — `EngineSim::debug_json()`** (экспортируется как
  `GameCore.debug_json()`): *курированный* дамп мира рядом с сырым выводом
  `serialize_state()`, который нечитаем. Тела (`tag`, `userData`,
  `translation`, `rotation`, `linvel`, `angvel`, `mass`, `bodyType`, `ccd`),
  коллайдеры (`shape` + `halfExtents`/`radius`, `isSensor`, группы
  столкновений/солвера в hex, `parent`), карта (`setId`, шаг, сетка,
  счётчики статики/динамики, респауны), нав-граф (узлы/рёбра/шаг),
  spatial-сетка (размер ячейки, заполненность), `rng.state` и аккумулятор
  фикс-шага. Порядок записей детерминирован — два дампа сравниваются дифом.
  `ClientState::debug_json()` — зеркало на клиенте: глубина буфера
  интерполятора, окно `seq`, `offset`, `seq`/`serverTime` последнего кадра.
- **`client/divergence.rs` — детектор рассинхрона предикта.**
  Непосредственно перед тем, как `on_server_state` затрёт предикт,
  `ClientState` сравнивает предсказанное состояние с авторитетным
  player-блоком и кладёт запись, если хоть один компонент вышел за свой
  порог. Уровню 0 от игры не нужно ничего (камера `render_overlay()` против
  x/y кадра); уровень 1 использует опциональные
  `GameClientDef::predicted_state()` (покомпонентно) и `replayed_inputs()`
  (окно переигранного ввода), оба с дефолтом `None`. Настройка —
  опциональная `EngineClientConfig.divergence` (`thresholds` позиционно,
  `defaultThreshold`, `capacity` кольцевого буфера); в боевом конфиге её
  нет, и путь кадра не меняется. `ClientCore.take_divergence()` вычерпывает
  буфер. Сопоставление — по **времени** кадра, а не по `seq`: реконсиляция
  переигрывает историю ввода от момента авторитетного состояния.

## Блоки снапшота — декларативная схема

Раскладки фиксированных блоков — это схема, а не захардкоженные структуры:
`SnapshotConfig.keys` сопоставляет каждому ключу `BlockSchema` ровно из
четырёх полей — `id` (опкод блока в кадре), `kind` (`BlockKind`: форма
строки, из неё и следуют ширины count/id и наличие null-маркера), `class`
(`hot` — интерполируется / `event` — только кадром) и `fields` (у каждого
тип `f32/u8/u16/u32` и режим интерполяции `lerp`/`lerpAngle`/discrete).
Префикс `d` у id блоков `indexedNoNull8` — тоже не поле схемы, он
захардкожен в распаковщиках. Упаковщик (`snapshot.rs`), распаковщик
(`client/unpack.rs`), интерполятор и движковый hot-буфер — все
интерпретаторы схемы; игровой crate лишь поставляет строки как плоский
`Vec<FieldValue>`. Сама схема — игровые данные,
поставляемые через `HostPlugin.gameConfig.snapshot` (см.
[plugin-api.md](plugin-api.md)) — движковый бандл не несёт собственных
snapshot-ключей. `SNAPSHOT_FORMAT_VERSION` (сейчас `3`) — версия фрейминга
движка; побайтовая совместимость между деплоями не требуется (хост и
клиенты — один деплой, версия защищает только фрейминг внутри комнаты).

## Тесты

| Слой | Где | Что покрывает |
| --- | --- | --- |
| Rust unit | `packages/engine/core/src/*` (`#[cfg(test)]`) | PRNG, нав-сетка, A*, пространственная сетка; клиентский модуль: round-trip unpack, интерполятор (seq/дедуп/late/лерп), raycast, hot-буфер; форма трейта `GameClientDef`, проверенная фикстурным `TestClient` |
| Rust интеграция | в этом репозитории отсутствует — сценарии симуляции игры (вождение, оружие, боты, handoff и т.д.) — забота репозитория игры | — |

`npm run core:test` запускает `cargo test --workspace`, что в этом
репозитории — только `packages/engine/core`: здесь выполняются
собственные unit-тесты движкового crate, и здесь же должна проверяться
любая правка его трейтов/макросов/фрейминга. Собственный `cargo test
--workspace` репозитория игры гоняет только её игровой crate (зависимость
от `vimp-engine-core`, а не member workspace), поэтому эти тесты не
перезапускает — CI этого репозитория остаётся источником истины для
самого движкового crate.

---

[← Предыдущая: Браузерный хост](host.md) · [Следующая: Клиентские модули →](client.md)
