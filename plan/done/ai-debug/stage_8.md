# Этап 8 — Парные правки в `vimp-tanks` ✅ выполнен

Движок не блокируется: фикстура `miniGame` даёт рабочий контур сразу.
Работы ведутся в **отдельном репозитории** `vimp-tanks`.

1. ✅ `entries.wasmNode` в `scripts/build-game-manifest.js` (пишется, только
   если `core/pkg-node/` собран; иначе предупреждение). `core/pkg-node`
   добавлен в `files` пакета — раннер работает и из установленной копии.
2. ✅ `impl GameClientDef::predicted_state` + `replayed_inputs` в
   `core/src/client/predictor.rs` (+`TankState::to_array`, окно реплея
   пишется в `on_server_state`), делегирование в `core/src/client/mod.rs`.
3. ✅ Смоук-сценарии `tests/scenarios/{movement,combat,round}.json`,
   раннер `scripts/run-scenarios.js` (`npm run sim:scenarios`), шаг CI в
   job `integration` с `--determinism`.
4. ✅ `docs/en|ru/{getting-started,core,architecture}.md` игры + `CLAUDE.md`.

Дополнительно: `src/nodeCore.js` — общая для обеих половин плагина ветка
выбора ядра (браузерный `.wasm`-ассет против node-глюe), без неё
headless-прогон падал на `fetch failed`.

## Что этап вскрыл в движке (починено здесь же)

Всё это было невидимо на фикстуре `miniGame` — у неё JS-ядра, нет предикта
и нет составных портов:

- `devtools/pluginLoader.js` — `entries.host/client` резолвились как пути,
  хотя это URL-ы под `assetsBase` (уходило в корень ФС);
- `devtools/ScenarioRunner.js` — `room.game.wasmUrl` не передавался
  плагину; клиент создавался после `sendMap`; на `sendPing` никто не
  отвечал, и хост честно кикал участника посреди прогона;
- `devtools/VirtualClient.js` — не повторял проводку ядра из `main.js`
  (`onAuth`/`set_map`/`onPanel`/`set_active`): предикт вообще не включался,
  инвариант 9 был мёртв;
- `devtools/RecordingSocketManager.js` — не раскрывал составные отправители
  (`sendFirstShot`/`sendPlayerDefaultShot`/`sendSpectatorDefaultShot`),
  поэтому клиент не получал ни `keySet`, ни полную панель;
- `devtools/invariants.js` — инвариант 6 требовал совпадения имени поля
  панели на хосте и клиенте (контракт этого не требует), инвариант 11 не
  понимал снапшот-форму `players_data`.

## Блокер публикации — снят

Опубликованы `vimp-engine-core@0.2.0` (методы этапов 4–5) и
`vimp-engine@0.4.0` (devtools); `vimp-tanks@0.4.0` поднял обе зависимости,
временный `[patch.crates-io]` больше не нужен.

Побочный эффект бампа: `@vimp-games/tanks` тянул `vimp-engine` как
**runtime**-зависимость, хотя код движка вшивается в её `dist/` при сборке
(внешним в `vite.config.js` объявлен только `pixi.js`). Пока корень движка
требовал `^0.3.0`, npm ставил вторую, настоящую копию движка внутрь
плагина. Зависимость переехала в `devDependencies` игры.
