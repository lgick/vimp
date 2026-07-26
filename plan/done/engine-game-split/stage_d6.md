# Д6. Актуализация документации en+ru (важно, ~M) ✅ выполнен

Систематическая проблема: все Rust-пути вне `core.md` остались от
до-4b монолита `core/` (каталога больше нет).

## Правки

1. **CLAUDE.md** (строки 26, 65-68, 104-106, 120-121): `core/` →
   `packages/engine/core` + `games/tanks/core`;
   `core/pkg-node` → `games/tanks/core/pkg-node`; Docker-стадия —
   `games/tanks/core/pkg-web`.
2. **plugin-api.md** (en:223,287 / ru):
   - `SNAPSHOT_FORMAT_VERSION → 4` → фактическое 3;
   - `dist/games/<id>/manifest.json` (:38) → `games/tanks/dist/manifest.json`;
   - убрать несуществующие `buildCoreGameConfig` и `voteDefs` (движок сам
     собирает конфиг ядра в `lib/coreConfig.js`; голосования создаются
     динамически `voteCoordinator.createVote` из чат-команды);
   - задокументировать фактический `ctx` `createModules`
     (participants/coreAdapter/panel/stat/chat/socketManager/scripted — без
     roundManager/voteCoordinator/timerManager из §3.2) и отдельный `ctx`
     чат-команд;
   - таблица «распил core/src» — в прошедшее время.
3. **network/architecture/client/configuration/host/getting-started/master
   (en+ru)**: ~30 устаревших `core/src/*`, `core/pkg-web`, `core/pkg-node`
   путей; `configuration.md` — лобби-конфиг карт `/maps/manifest.json`
   (снят в 6.4) → пер-игровые функции-URL из `config/lobby.js`;
   `architecture.md` — таблица ENGINE/GAME/MIXED из будущего времени в
   состоявшееся; `core.md:182` — битый путь.
4. **PLAN_4_details.md §5** — пометка об актуализации 4c (GameClientDef
   реализован, export_client_core_abi выполнен).
5. Отразить изменения этапов Д1–Д5 (если ещё не отражены поэтапно).

## Критерий готовности

`grep -rn 'core/src\|core/pkg' docs/ CLAUDE.md` — только актуальные пути;
en и ru зеркальны.
