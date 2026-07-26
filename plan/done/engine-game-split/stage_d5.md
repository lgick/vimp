# Д5. Аудио-пайплайн и скрипты сборки (важно, ~S) ✅ выполнен

## Замечание

`scripts/process-audio.js` пишет в `packages/engine/public/sounds`
(легаси-путь, признан в `copy-game-sounds.js:4`), затем копия уезжает в
`games/tanks/dist/sounds`. Клиент слушает только `assetsBase`
(client/main.js:205-208 всегда переопределяет путь) → копия в движковом
`public/` — мёртвый груз в dist движка. `npm run build` гоняет
`audio:process` дважды (`game:build` и `build:app` оба вызывают).

## Решение

- Вывод `process-audio.js` → `games/tanks/build/sounds/` (промежуточный,
  в .gitignore); `copy-game-sounds.js` читает оттуда.
- `packages/engine/public/sounds` удалить.
- `build:app` без `audio:process`; в package.json `audio:process` остаётся
  только внутри `game:build`.
- `scripts/build-game-manifest.js:14`: `URL.pathname` → `fileURLToPath`
  (ломается на пробелах/Windows).
- Обновить docs/{en,ru} (getting-started/deployment), `.dockerignore` при
  необходимости.

## Критерий готовности

`npm run build` — одинарный прогон аудио, нет `public/sounds`;
`npm run dev` — звуки с `/games/tanks/sounds/`; eslint/тесты зелёные.
