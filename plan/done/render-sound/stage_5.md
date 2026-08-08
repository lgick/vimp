# Этап 5 ✅ выполнен — документация, changelog'и, отчёт о влиянии на релиз

## Билингвально (`docs/en/` + зеркало `docs/ru/`), движок

- `client.md` — новая семантика `SoundManager.reset()` и `releaseSound()`;
  обработка потери WebGL-контекста в разделе про render loop; `resync()` в
  разделе Client Core.
- `host.md` — `RoundManager.createMap` отправляет keyset наблюдателя.
- `network.md` — уточнить, что `KEYSET_DATA` приходит и при смене карты.
- `plugin-api.md` + `docs/ai/` — новый метод Wasm ABI `resync()`.

## Плагин (`vimp-tanks/docs/en` + `ru`)

- `core.md` — новая схема дедупликации бомб (алиас вместо подмены).

## Changelog'и

- `packages/engine/CHANGELOG.md` (`## [Unreleased]`) — `resync()` в ABI,
  изменение семантики `SoundManager.reset()`, keyset при смене карты.
- `packages/engine/core/CHANGELOG.md` — `reset()` обнуляет `my_game_id`,
  новый `resync()`.
- `vimp-tanks` — свой журнал по правилам того репозитория.

## Отчёт о влиянии на релиз

Свести и выдать в отчёте о работе (см. таблицу в
[README.md](README.md#влияние-на-релиз-флагуется-заранее)): какой артефакт,
какой bump, должен ли игровой репозиторий следовать, какие пред-публикационные
проверки нужны и какие реально прогнаны.

## Финальные прогоны

`npx eslint . && npm test`, `npm run core:test`, `npm run sim:check` —
зелёные в обоих репозиториях.
