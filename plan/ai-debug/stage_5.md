# Этап 5 — Детектор рассинхрона предикта ✅ выполнен

Два уровня, чтобы не требовать ничего от плагина в базовом случае.

## Уровень 0 (без правок плагина)

Сравнивать авторитетный player-блок `[f32;8]` из кадра с
`render_overlay().camera` (`core/src/client/game.rs:24`) — для
предсказывающего плагина это предсказанная позиция. Даёт дрейф по x/y.

## Уровень 1 (один опциональный trait-метод)

`GameClientDef::predicted_state(&self) -> Option<[f32; PLAYER_STATE_LEN]>` с
дефолтом `None`. Движок в `ClientState` снимает его **непосредственно перед**
`on_server_state` (`core/src/client/game.rs:42`) — то есть до затирания
состояния авторитетным — и сравнивает покомпонентно с порогами из конфига.
Записи кладутся в кольцевой буфер, вычерпываются новым методом
`take_divergence()` из `export_client_core_abi!`.

## Формат отчёта

Как предложено, плюс `serverTime`, `offset` и окно истории вводов, которое
переигрывалось: именно они позволяют локализовать формулу.

Существенно: предиктор реконсилится **по времени**, а не по `seq`
(`vimp-tanks/core/src/client/predictor.rs:274`) — отчёт должен это отражать,
иначе сравнение «по тому же seq» вводит в заблуждение.

Прогоняется в runner'е (основное) и в браузере (этап 6).

Проверка: `npm run core:test` + cargo-тест на `take_divergence`.

## Что сделано

- `core/src/client/divergence.rs` (новый) — трекер: кольцевой буфер записей
  (ёмкость из конфига, вытесненные считаются как `dropped`), накопительные
  агрегаты `samples`/`violations`/`maxDelta`. Запись кладётся, только если
  хотя бы один компонент вышел за свой порог — иначе отчёт утонул бы в шуме.
- Конфиг: `EngineClientConfig.divergence` (`thresholds` позиционно,
  `defaultThreshold`, `capacity`) — `Option`, в боевом конфиге секции нет,
  и путь кадра тогда не меняется вовсе.
- Trait-методы с дефолтом: `GameClientDef::predicted_state` (уровень 1) и
  `replayed_inputs` (окно переигранной истории ввода). Без них работает
  уровень 0 — камера `render_overlay` против x/y player-блока.
- `ClientState::push_frame` снимает предикт **перед** `on_server_state`
  (после — сравнивать уже не с чем), `take_divergence()` вычерпывает записи;
  экспорт — через `export_client_core_abi!`, `ENGINE_API_VERSION` не бампается.
- Формат записи: `source`, `serverTime`, `localNow`, `offset`, `inputSeq`
  (справочно), `replayed {from,to,count}`, `predicted`/`authoritative`/
  `delta`/`thresholds`/`exceeded`. Сопоставление — по времени кадра, а не по
  `seq`; это зафиксировано и в тексте нарушения.
- JS: `buildClientCoreConfig` пробрасывает секцию `divergence`,
  `VirtualClient` вычерпывает записи каждый тик (до `sample`, иначе тик с
  пустым hot-буфером их бы потерял), сценарий получил поле `divergence`
  (`{}` — дефолты ядра, `null` — детектор выключен).
- Инвариант 9 `predictionDrift` реализован (skip → pass/fail), в `report.md`
  добавлена секция `## Prediction drift`.
- Клиентская фикстура `miniGame` получила настоящий предикт (та же таблица
  скоростей, что у `fakeCore`, плюс история ввода с переигрыванием от
  авторитетного состояния) и `take_divergence` — headless-контур покрыт без
  WASM: 29 реконсиляций, максимум |Δ| ≈ 6.5e-6.
- Тесты: cargo — `client::game::tests::divergence_*` (уровень 0, уровень 1 с
  окном ввода, вытеснение из кольцевого буфера, выключенный детектор);
  Vitest — `VirtualClient`, `invariants` (включая «проверку самой проверки»
  с нулевым порогом на реальном прогоне), `report`, `ScenarioRunner`.

Документация — этап 7 (`docs/{en,ru}/core.md`, `plugin-api.md`).
