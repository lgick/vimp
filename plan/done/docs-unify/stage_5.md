# Этап 5. Проверка ✅ выполнен

- `npx prettier --write` по изменённым, `npx eslint .`, `npm test -- --silent`, `npm run test:scaffold`
- `git grep "docs/ai/[0-9]"` — пусто
- EN/RU: совпадают наборы файлов и заголовки; относительные ссылки живы
- Сверка с кодом: `ENGINE_API_VERSION`, `PLAYER_STATE_LEN`, `WORLD_VOICE_LIMIT`, версия фрейма — одинаково во всех страницах
- Отчёт: release impact, список найденных расхождений
