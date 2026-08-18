# Этап 4. Шаблон: Rust-ядро ✅ выполнен

Порядок внутри этапа — предписанный `docs/ai/11-authoring-workflow.md`
(шаг 5): `config.rs` → `actor.rs` → `motion.rs` → `game.rs` →
`client/predictor.rs` → `client/mod.rs` → `lib.rs`.

## 4.1. Состав `core/src/`

| Файл | Содержимое |
| --- | --- |
| `config.rs` | serde-структуры init-JSON: `RootConfig { engine, game }`, `RootClientConfig`, `ActorConfig`, `WeaponConfig`. Хост читает `timeStep` в **секундах**, клиент — `timeStepMs` в **миллисекундах**; расхождение единиц намеренное и комментируется прямо в коде |
| `body_tag.rs` | тегирование тел Rapier в `u128`; младший байт `1` зарезервирован движком (`MAP_OBJECT_TAG`), игровые виды начинаются с `2` |
| `motion.rs` | **единственный** источник математики движения: чистые функции без Rapier и без состояния мира. Используется и авторитетным `Actor::update`, и клиентским `Predictor` |
| `actor.rs` | авторитетный актор: тело Rapier, здоровье, боезапас, перезарядка, вызов `motion.rs` |
| `game.rs` | `GameDef` + `impl GameSim`: спавн/удаление акторов и ботов, `apply_input`, `on_fixed_step`, `on_contacts`, `on_ai_tick`, hitscan, упаковка блоков снапшота, `serialize`/`deserialize`, `clear` |
| `client/predictor.rs` | предикция своего актора на 8 `f32` + `mod parity` (cargo-тест сравнения с авторитетной симуляцией) |
| `client/mod.rs` | `impl GameClientDef`: `on_server_state`, `update`, `track_frame`, `filter_frame_game`, `update_world`, `update_world_interpolated`, `render_overlay`, `apply_input`, `set_model`, `set_active`, `set_map`, `sync_panel`, `reset`, `cycle_item`, `try_action` + опциональные `predicted_state`/`replayed_inputs` |
| `lib.rs` | структуры `GameCore { state: EngineSim<G>, packer: SnapshotPacker }` и `ClientCore { state: ClientState<G> }`, рукописные `new()`, вызовы `vimp_engine_core::export_game_core_abi!(GameCore)` и `export_client_core_abi!(ClientCore)` |

Имена полей структур под ABI-макросами (`state`, `packer`) — контрактные,
макрос ищет их буквально.

## 4.2. Контрактные обязательства, которые шаблон обязан демонстрировать

- **`PLAYER_STATE_LEN = 8`**: `prediction_state()` возвращает
  `([f32; 8], bool)` с раскладкой `[x, y, angle, vx, vy, hp, ammo, 0]`;
  раскладка задокументирована в комментарии рядом — она же читается
  клиентским партом.
- **Детерминизм**: только движковый `Rng` (SplitMix64) из
  `vimp-engine-core`, никаких `rand`, `Math.random` и часов; `rapier2d` с
  фичей `enhanced-determinism`.
- **Округление**: `vimp_engine_core::physics::round2` на упакованных
  float-полях — кроме блока игроков, который пакуется и декодируется сырым.
- **Событийность**: `build_snapshot_blocks` возвращает `had_events = true`
  в кадре с выстрелом — это то, что переводит кадр на надёжный канал.
- **События ядра**: `panelSet`/`panelActive` при изменении hp/ammo, `death`
  при смерти, `shake` при попадании; `custom` шаблон не использует, но
  оставляет комментарий с точкой расширения (→ `HostPlugin.onCoreEvent`).
- **Реализованы `predicted_state()` и `replayed_inputs()`** — необязательные
  методы, но именно они поднимают детектор расхождения предикции в
  headless-раннере до первого уровня; для шаблона это бесплатная страховка
  от главного класса багов.

## 4.3. Тесты ядра

`core/tests/sim.rs` — интеграционные, на `rlib`-половине крейта:

1. спавн актора и раскладка респаунов по командам;
2. движение по вводу и остановка о стену;
3. hitscan-попадание снимает hp, смерть удаляет актора;
4. `friendlyFire = false` не даёт урона своей команде;
5. полный вайп команды приводит мир в состояние конца раунда;
6. `serialize`/`deserialize` даёт побитово тот же кадр (round-trip);
7. два прогона с одним seed дают одинаковый поток кадров.

`core/src/client/predictor.rs` → `mod parity`: авторитетная симуляция и
предиктор гоняются по одному и тому же расписанию ввода, расхождение
позиций и скоростей держится в пределах допуска. Тест обязателен: он
единственный, кто ловит разъезд `motion.rs` между двумя половинами.

## Готовность этапа

- [x] `npm run core:build` собирает `core/pkg-web` и `core/pkg-node`
      (проверено на сгенерированной игре `arena-check`).
- [x] `npm run core:test` (`cargo test --workspace`) зелёный, включая
      `parity`: 13 unit-тестов (5 из них — `client::predictor::parity`) +
      7 интеграционных `core/tests/sim.rs`; `cargo clippy --all-targets`
      без предупреждений.
- [ ] `npm run sim` в сгенерированной игре завершается кодом `0`
      (12 инвариантов раннера, `entries.wasmNode` резолвится).
- [ ] `npm run sim -- --determinism` не находит расхождений.

Два последних пункта переносятся в этап 5: `sim` поднимает матч через
JS-половину, а `src/config/game.js`, `src/host/` и `src/client/` после
этапа 3 остаются заглушками (нет `models`/`weapons`/`playerKeys`/`panel`/
`snapshot`), поэтому `GameCore::new` в сгенерированной игре сегодня не
получает валидный init-JSON. Клиентская половина ABI проверена вручную
через `core/pkg-node` (кадр от `GameCore` → `push_frame`/`sample` →
predicted-хвост hot-буфера и локальный трассер).

## Отклонения от плана

- «смерть удаляет актора» (тест 3) реализована как уход с полотна:
  актор остаётся в симуляции (иначе движковый респаун `reset_actor`
  некуда применить), но его строка уходит null-маркером, тело
  выключается (`set_enabled(false)` — труп не ловит луч и не сталкивается),
  а обратно оно включается в `change_player_data`.
- Модуль ботов отдельным файлом не заводился: ИИ шаблона — десяток строк
  в `on_ai_tick` (`game.rs`), состав файлов `core/src/` в остальном
  ровно такой, как в 4.1.
