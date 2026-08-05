# Этап 7 — Документация ✅ выполнен

Правило репозитория: функциональная правка обновляет `docs/en/` и `docs/ru/`
в том же изменении.

- **`docs/en/debugging.md` + `docs/ru/debugging.md`** (новые) — CLI, формат
  сценария, инварианты, `debug_json`, детектор рассинхрона, рекордер.
  Ссылки из обоих `README.md`.
- **`docs/ai/13-debugging.md`** (новый) + строки в `README.md` (карта файлов)
  и `12-questionnaire.md` (блок 14).
- **`docs/ai/10-pitfalls.md:210`** — строку «No debug mode» заменить.
- **`docs/ai/11-authoring-workflow.md`** — перед ручным 14-пунктовым смоуком
  в две вкладки (шаг 9) вставить **автоматический** шаг: «прогнать
  `npm run sim`, устранить все нарушения инвариантов, и только потом
  открывать браузер». Это главная правка для практической ценности.
- **`docs/ai/02-packaging.md`** — `entries.wasmNode` в манифесте.
- **`docs/en|ru/plugin-api.md`** — `entries.wasmNode`, `predicted_state`,
  `debug_json`, `take_divergence`.
- **`docs/en|ru/network.md`** — порт 12 `CONSOLE`.
- **`docs/en|ru/master.md`** — `/debug/report`.
- **`docs/en|ru/host.md`** — `createHostRuntime`, `seed` в сообщении `ready`
  (этап 1), рекордер.
- **`docs/en|ru/client.md`** — `reconstructHot`, `window.__vimpDebug`.
- **`docs/en|ru/core.md`** — `debug_json`, `take_divergence`.
- **`docs/en|ru/configuration.md`** — `lib/clock.js` (этап 1), флаги отладки.
- **`CLAUDE.md`** — новые npm-скрипты (`sim`, `sim:replay`, `sim:check`).

## Что сделано ✅ выполнен

- **`docs/en/debugging.md` + `docs/ru/debugging.md`** (новые) — CLI и коды
  возврата, порядок поиска ядра, формат сценария и операции, таблица 12
  инвариантов, состав отчёта (`report.md`/`report.json`/`scene-<tick>.json`),
  `debug_json` обоих ядер, детектор рассинхрона (уровни 0/1, конфиг, формат
  записи), браузерная половина (`window.__vimpDebug`, рекордер,
  `POST /debug/report`, порт `CONSOLE`), связка «браузер → headless» и
  рекомендуемый порядок для нового плагина. Ссылки — из обоих `README.md`
  (таблица разделов + «с чего начать»).
- **`docs/ai/13-debugging.md`** (новый, самодостаточный, без ссылок в
  двуязычный контур) + строка в карте файлов `docs/ai/README.md`, правка
  шага 5 «How to use this guide» и правила «Silence is the failure mode».
- **`docs/ai/10-pitfalls.md`** — «No debug mode» заменено: внутриигрового
  оверлея по-прежнему нет, но есть внешний контур, и чек-лист этой страницы
  проверяется прогоном, а не глазами.
- **`docs/ai/11-authoring-workflow.md`** — новый **шаг 9 «headless
  simulation»** перед двухвкладочным смоуком (он стал шагом 10), плюс пункт
  в «Definition of done». Главная правка ради практической ценности.
- **`docs/ai/02-packaging.md`** — `entries.wasmNode` в примере манифеста и
  строка в таблице правил полей (путь относительно манифеста, не URL).
- **`docs/ai/12-questionnaire.md`** — вопросы 67–69 в блок 14
  (`entries.wasmNode`, набор отладочных сценариев, `predicted_state`) и
  дополненная строка 14 в answer→artifact map.
- **`docs/en|ru/plugin-api.md`** — `entries.wasmNode`, `debug_json` в
  обязательном наборе GameCore, `debug_json`/`take_divergence` в ClientCore,
  опциональные `predicted_state`/`replayed_inputs`.
- **`docs/en|ru/network.md`** — порт 12 `CONSOLE` больше не «свободен».
- **`docs/en|ru/master.md`** — раздел `POST /debug/report` (только dev,
  закрытый список `kind`, лимит 8 MB, коды 400/413).
- **`docs/en|ru/host.md`** — `createHostRuntime` в описании `init`,
  `ready { mapName, seed }`, сообщения `debug`/`debug_result`, подраздел
  «Отладочный рекордер».
- **`docs/en|ru/client.md`** — `reconstructHot` как общий модуль
  `lib/reconstructHot.js`, пункт про `window.__vimpDebug` и порт `CONSOLE`.
- **`docs/en|ru/core.md`** — `debug.rs`/`client/divergence.rs` в структуре
  и раздел «Отладка: `debug_json` и детектор рассинхрона».
- **`docs/en|ru/configuration.md`** — `isDevMode` (рекордер), секция
  `divergence`, `lobby.js: debugReportUrl`, новый раздел `lib/clock.js`.
- **`CLAUDE.md`** — строка «devtools/сценарий/инварианты/рекордер →
  `debugging.md`» в таблице «area → page» (npm-скрипты там уже с этапа 2).

## Проверка ✅ выполнен

- `npx eslint .` — зелёный.
- `npm test` — 98 файлов, 983 теста, зелёные.
- Якоря перекрёстных ссылок сверены в обе стороны (EN и RU отдельно).
