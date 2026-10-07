# Этап 1. Обогащение существующих страниц (EN → RU) ✅ выполнен

Для каждой страницы: сверить с кодом → влить уникальное из `docs/ai` в `docs/en` → зеркало в `docs/ru`.

- 1.1 ✅ `network.md` ← `06-snapshot-protocol` (frame, hot buffer, типы блоков, порты); версия фрейма — по коду
- 1.2 ✅ `core.md` ← `05-wasm-core` (GameDef/GameSim/GameClientDef, `PLAYER_STATE_LEN`, SimCtx, init JSON, детерминизм)
- 1.3 ✅ `plugin-api.md` ← `03-host-plugin`, `04-client-plugin` (поля HostPlugin/ClientPlugin, gameConfig, parts, bakers)
- 1.4 ✅ `host.md` / `configuration.md` ← `08-gameplay-meta` (раунды, скоринг, команды, кики, таймеры, informs)
- 1.5 ✅ `architecture.md` ← `01-architecture` (версии, lifecycle, каналы, два ядра, потоки)
- 1.6 ✅ `debugging.md` ← `13-debugging` (сценарии, 12 инвариантов, drift, recorder) без дублей
