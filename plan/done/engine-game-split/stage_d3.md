# Д3. bot → scripted в движке (важно, ~M) — ✅ выполнен

## Замечание

§1 PLAN.md: «Ботов в движке быть не должно — только нейтральная абстракция
"скриптовый участник"». Фактически в движке остались:
`host/meta/player/BotParticipant.js`, контракт scripted-модуля с
bot-именами: `createModules(ctx).bots`, `getBotCountsPerTeam()`,
`removeOneBotForPlayer()`, `createBots/removeBots/getBots`
(HostGame.js:132,653-657; RoundManager.js:109-118,159-161,303-305), поле
`bots` в handoff-мете (`_collectHandoff`).

## Решение

Переименовать, пока `engineApi` не заморожен внешним репо игры:

- `BotParticipant` → `ScriptedParticipant` (класс и файл).
- Контракт модуля: `createModules(ctx).scripted` с методами
  `createScripted(count, team?)`, `removeScripted(team?)`,
  `removeOneForHuman(team)`, `getCount()`, `getCountsPerTeam()`.
- Handoff-поле `bots` → `scripted` с бампом `HANDOFF_VERSION` → 3
  (несовместимый своп валит init → штатный `resume`, §3.7).
- `TanksBotManager` игры и фикстурный `ScriptedManager` реализуют новые
  имена (внутри игры слово «бот» законно).
- Обновить plugin-api.md (en+ru). `ENGINE_API_VERSION` не поднимать, пока
  игра в монорепо и обновляется атомарно — зафиксировать это решение в
  plugin-api.

## Критерий готовности

`grep -ri bot packages/engine/src/host` — только нейтральные scripted-имена;
eslint/тесты зелёные; сценарий эстафеты (swap → resume) работает.
