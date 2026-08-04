# Этап 4 — `debug_json()` в ядре ✅ выполнен

`EngineSim::serialize_state()` (`core/src/game.rs:343`) уже дампит мир, но в
сыром serde-формате rapier — нечитаемо. Нужен **курированный** дамп рядом,
через тот же `serde_json` (зависимость уже есть, новых не нужно):

- тела: `{ tag, gameId?, translation, rotation, linvel, angvel, mass, bodyType, ccd }`
- коллайдеры: `{ shape, halfExtents|radius, isSensor, collisionGroups (hex), solverGroups, parent }`
- статика карты, счётчики ячеек spatial-сетки, число узлов nav, состояние
  `rng`, аккумулятор фикс-шага.

Зеркало на клиенте (`ClientState::debug_json`): глубина буфера
интерполятора, окно `seq`, `offset`, `seq`/`serverTime` последнего кадра.

Экспорт — через `abi.rs` (`export_game_core_abi!` строка 17,
`export_client_core_abi!` строка 265), значит каждый плагин получает метод
даром и `ENGINE_API_VERSION` не бампается. Прокидывается в
`GameCoreAdapter.js` и в отчёт runner'а.

Проверка: `npm run core:test` + cargo-тест на `debug_json`.

## Что сделано

- `core/src/debug.rs` (новый) — курированный дамп движковой половины:
  тела (`tag`/`userData`/`translation`/`rotation`/`linvel`/`angvel`/`mass`/
  `bodyType`/`ccd`), коллайдеры (`shape` + `halfExtents`/`radius`,
  `isSensor`, группы в hex, `parent`), карта (`setId`, шаг, размеры сетки,
  счётчики статики/динамики, респауны), нав-граф (узлы/рёбра/шаг),
  spatial-сетка (размер ячейки, заполненность по ячейкам), состояние `rng`,
  аккумулятор фикс-шага. Порядок записей детерминирован — дампы двух
  прогонов сравниваются дифом.
- `EngineSim::debug_json()` и зеркало `ClientState::debug_json()`
  (глубина буфера интерполятора, окно `seq`, `offset`, последний кадр
  `seq`/`serverTime`, свой gameId, длины hot-буфера и очереди кадров;
  `Interpolator::debug_json` — источник сетевой половины).
- Мелкие аксессоры под дамп: `Rng::state`, `SpatialGrid::{cell_size,
  cell_counts}`, `NavigationSystem::{node_count, edge_count, grid_step}`,
  `GameMap::{static_body_count, dynamic_body_count}`.
- Экспорт — через `export_game_core_abi!`/`export_client_core_abi!`:
  каждый плагин получает метод даром, `ENGINE_API_VERSION` не бампается.
- JS: `GameCoreAdapter.debugJson()` и `VirtualClient.debug()` (оба отдают
  `null`, если ядро игры собрано против движка без метода — старая сборка
  плагина прогон не роняет), `inspectCore()` в `devtools/inspectHost.js`.
- Отчёт runner'а: каждый срез сцены несёт `core` (дамп мира) рядом с
  клиентами, снимок клиента — поле `debug`; `report.md` получил секцию
  `## World (core dump)` со счётчиками последнего среза.
- Фикстурные ядра `miniGame` (`fakeCore.js`, `fakeClientCore.js`)
  реализуют `debug_json` — headless-контур покрыт тестами без WASM.
- Тесты: cargo — `game::tests::debug_json_*` (дамп карты/мира, `null` без
  карты, совпадение дампов двух одинаковых прогонов),
  `client::game::tests::debug_json_reports_buffer_seq_window_and_offset`;
  Vitest — `GameCoreAdapter`, `VirtualClient`, `report`, `ScenarioRunner`.

Документация — этап 7 (`docs/{en,ru}/core.md`, `plugin-api.md`).
