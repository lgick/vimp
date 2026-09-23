# План: детектор рассинхрона сравнивает углы без приведения к ±π ✅ выполнен

Задача для репозитория движка `vimp` (`/Users/dmitry/Sites/my/vimp`). План самодостаточен.

- Источник: этап 7 плана игры `vimp-tanks` — `/Users/dmitry/Sites/my/vimp-tanks/plan/night-city-fixes.md`, раздел
  «Этап 7…», «Ход выполнения»; продолжение `plan/divergence-time-alignment.md` (шаг 8).
- Правила — `/Users/dmitry/Sites/my/vimp/CLAUDE.md` (docs en+ru, три CHANGELOG, тест перед исправлением,
  «Release impact», `contract/surface.json`). Без `git commit`, без правки версий и публикации. Развилки — с согласия
  пользователя, вопросы — на русском.

## Контекст

Детектор рассинхрона предикта (отладочный, включается секцией `divergence` конфига клиентского ядра) сравнивает
предсказанное состояние своего актора с player-блоком кадра покомпонентно:
`DivergenceTracker::observe` в `packages/engine/core/src/client/divergence.rs` — `delta = predicted[i] − authoritative[i]`,
порог `DivergenceConfig::threshold(i)` (`packages/engine/core/src/config.rs`, `DivergenceConfig`: `thresholds`,
`defaultThreshold`, `capacity`). Раскладка player-блока — игровая, движок смысла компонентов не знает.

Если компонент — угол, то при переходе через ±π одно и то же направление даёт Δ ≈ 2π. Замер в игре
(`vimp-tanks`, `npm run sim -- --scenario tests/scenarios/jump.json`, порог угла 0.06):

```
sock-p1: serverTime 1700000004200 … source 'state': #2 Δ6.2828 > 0.06 (predicted 3.1412, authoritative -3.1416)
```

Реальная разница — 0.0004 рад. Нарушение ложное; поправить его в игре нельзя (оба значения корректны, они по разные
стороны разреза).

## Решение

Новое необязательное поле секции `divergence`: `angles` — список индексов компонентов, которые сравниваются по
окружности: `delta = wrap(predicted − authoritative)` в `(−π, π]`. По умолчанию пусто — поведение прежнее.

```json
{ "thresholds": [3, 3, 0.06, 25, 25, 1.5], "angles": [2], "capacity": 64 }
```

Отвергнуто: угадывать углы по значению (|Δ| близко к 2π) — маскирует настоящие развороты на ~2π; знание раскладки
в движке — раскладка игровая.

## Шаги

1. Тест, который падает сейчас: в `divergence.rs` (или `client::game::tests::divergence_*`, `game.rs` ≈ 1160–1280,
   фикстура `config_with_divergence`) — наблюдение `predicted[2] = 3.1412`, `authoritative[2] = −3.1416`, порог 0.06,
   `angles: [2]` → нарушения нет, `maxDelta[2] ≈ 0.0004`; без `angles` — нарушение есть (обратная совместимость).
2. `config.rs`, `DivergenceConfig`: `#[serde(default)] pub angles: Vec<usize>` + doc-комментарий;
   метод `is_angle(index)`. Некорректный индекс (≥ `PLAYER_STATE_LEN`) — игнорировать или ошибка разбора (выбрать
   вариант, согласованный с тем, как конфиг валидируется рядом; при ошибке — это «может отвергнуть конфиг, который
   раньше грузился» только для новых конфигов, т. е. не breaking).
3. `divergence.rs`, `observe`: для угловых индексов `delta = wrap(delta)` (`rem_euclid(2π)`, затем сдвиг в
   `(−π, π]`); `maxDelta`, `exceeded` и запись (`delta`) — уже по приведённой разнице. Уровень 0 (`Source::Camera`,
   только x/y) не затрагивается.
4. JS: `packages/engine/src/lib/clientCoreConfig.js` уже пробрасывает `divergence` целиком — проверить, что `angles`
   доходит до ядра из сценария (`ScenarioRunner.js` ≈ стр. 91, `raw.divergence`); тест раннера/`VirtualClient`, если
   проброс где-то фильтрует поля.
5. Документация: `docs/en/debugging.md` и `docs/ru/debugging.md` (раздел «Prediction divergence detector» — пример
   конфига и абзац про `angles`; раздел «Scenario format» — поле `divergence`), `docs/ai/13-debugging.md`,
   `docs/en|ru/core.md` раздел «Debugging: `debug_json` and the divergence detector», если там перечислены поля.
6. CHANGELOG: `packages/engine/core/CHANGELOG.md` `### Added` — «`divergence.angles`: components compared on the
   circle, so an angle crossing ±π no longer reports a 2π drift». Если менялся JS — и `packages/engine/CHANGELOG.md`.
   `contract/surface.json` — проверить, описан ли там конфиг детектора; только добавление.
7. Проверки: `npx eslint .`, `npm test -- --silent`, `npm run core:test`. Отчёт «Release impact»: крейт
   `vimp-engine-core` (minor по `### Added`), игре для использования нужен подъём крейта.

## После релиза — в игре (не в этой задаче)

`vimp-tanks`: поднять `vimp-engine-core` в `core/Cargo.toml`, во всех `tests/scenarios/*.json` с секцией `divergence`
добавить `"angles": [2]` (индекс `angle` в player-блоке `[x, y, angle, vx, vy, angvel, …]`), прогнать
`npm run sim:scenarios` — `jump.json` зелёный.

## Ход выполнения

**2026-09-23 — шаги 1–7 выполнены.**
1. Тесты — модуль `tests` в `core/src/client/divergence.rs`: `angle_component_is_compared_on_the_circle` (3.1412
   против −3.1416, порог 0.06, `angles: [2]` → 0 нарушений, `maxDelta[2] ≈ 0.0004`; до правки падал — 1 нарушение),
   `without_angles_the_component_stays_linear` (обратная совместимость), `angle_index_out_of_the_player_block_is_ignored`.
2. `config.rs`, `DivergenceConfig`: `#[serde(default)] pub angles: Vec<usize>` + `is_angle(index)`. Некорректный
   индекс игнорируется — как и лишние `thresholds`: конфиг детектора рядом не валидируется, ошибка разбора выбивалась бы
   из соседнего поведения.
3. `divergence.rs`, `observe`: для `Source::State` и угловых индексов `delta = wrap_angle(delta)`
   (`rem_euclid(TAU)`, затем в `(−π, π]`); `maxDelta`, `exceeded`, `delta` записи — по приведённой разнице. Камера
   (уровень 0) не затронута.
4. JS: `clientCoreConfig.js` и `ScenarioRunner.js` пробрасывают `divergence` целиком, полей не фильтруют — правок и
   JS-теста не понадобилось.
5. Документация: `docs/en|ru/debugging.md` (пример конфига, абзац про `angles`, строка `divergence` таблицы формата
   сценария), `docs/ai/13-debugging.md`, `docs/en|ru/core.md`; плюс `docs/en|ru/configuration.md` — там тоже перечислены
   поля секции (правило `CLAUDE.md`: `src/config/*`/конфиг → `configuration.md`).
6. `packages/engine/core/CHANGELOG.md` → `[Unreleased]` `### Added`. JS не менялся — журнал npm не тронут.
   `contract/surface.json` описывает только `take_divergence`, конфиг детектора там не описан — без изменений.
7. `npx eslint .` — чисто; `npm test -- --silent` — 185 файлов, 2393/2393; `npm run core:test` — 226/226.

