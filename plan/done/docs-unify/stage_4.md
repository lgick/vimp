# Этап 4. Ссылки и индексы ✅ выполнен

- 4.1 `docs/en|ru/README.md`: 3 новые строки, абзац про `docs/ai`
- 4.2 Ссылки `../ai/...` в client/configuration/debugging/plugin-api/scaffolding (en и ru)
- 4.3 Корневой `CLAUDE.md`: строка про `docs/ai`, таблица «область → страница», ≤1000 токенов
- 4.4 Комментарии с `docs/ai/NN-*.md` в `packages/engine/src/**`, `packages/create-vimp-game/src/ui.js`, `templates/default/**`, `tests/scaffold/template.test.js` (~20 мест) → `docs/en/*.md`
- 4.5 `docs/en|ru/plugin-api.md`, пример манифеста: `"engineApi": 3` → `4` (`ENGINE_API_VERSION = 4`, `packages/engine/src/config/opcodes.js`); сделать вместе с 4.2. Найдено на этапе 2.
