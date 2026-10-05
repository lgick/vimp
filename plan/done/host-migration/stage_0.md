# Этап 0. Замеры и проверки браузера (spike) — ✅ выполнен

Цель: получить цифры, от которых зависят параметры этапов 5–9, и проверить
три предположения о браузере. Продакшн-код не меняется. Результат —
`plan/host-migration/spike-results.md` (таблицы + принятые значения).

Скретч-код класть в `_spikes/host-migration/` (каталоги с `_` — скретч, не
коммитятся, CLAUDE.md → Conventions).

## 0.1. Размер и время дампа ядра (Node, без браузера)

Нужно: для каждой игры (`@vimp-games/tanks`, `@vimp-games/snakes`, обе
слинкованы в `node_modules` — см. `docs/en/getting-started.md`) — размер
`serialize_state()` сырой и после gzip, время `serialize_state` и
`deserialize_state`, на «тяжёлом» сценарии.

1. Разобраться, как headless-раннер поднимает матч:
   `packages/engine/bin/vimp-sim.js`, `packages/engine/src/devtools/ScenarioRunner.js`,
   `packages/engine/src/lib/createHostRuntime.js` (Node-путь грузит
   `entries.wasmNode`). Найти, где доступен объект ядра
   (`GameCoreAdapter` хранит core — `packages/engine/src/host/GameCoreAdapter.js`).
2. Скрипт `_spikes/host-migration/dump-size.mjs`:
   - поднять матч через `createHostRuntime` (как ScenarioRunner) с
     максимумом ботов: tanks — 8 участников-ботов на самой большой карте,
     snakes — 30+ ботов (сколько позволяет `maxPlayers`/конфиг ботов);
   - прогнать 60 с виртуального времени, каждые 500 мс **сразу после
     `pack_body`** (предусловие дампа, `core/src/game.rs:473-475`) вызвать
     `serialize_state()`;
   - мерить: `bytes.length`, `zlib.gzipSync(bytes, {level: 6}).length`,
     `zlib.gzipSync(..., {level: 1})`, время serialize (`performance.now()`),
     время `deserialize_state` во второй, свежесозданный экземпляр ядра с
     тем же конфигом;
   - проверить корректность: после deserialize оба ядра делают 120 шагов с
     одинаковым вводом → `debug_json`/позиции совпадают (как тест tanks
     `state_dump_restores_identical_simulation`, `vimp-tanks/core/tests/sim.rs:808`).
3. Отдельно оценить размер JS-меты контрольной точки: JSON карты
   (`room.maps` / `RoundManager._currentMapData`), Stat, участники.

## 0.2. Браузер: три проверки (вручную с разработчиком)

Страница `_spikes/host-migration/browser.html` + `worker.js` (открывается
через `npm run dev` как статика или любым локальным https-сервером):

1. **Пауза главного потока при диалоге `beforeunload`.** Worker тикает
   каждые 8 мс и шлёт `postMessage(performance.now())`; главный поток пишет
   разрывы между получениями в `localStorage`. Вызвать диалог закрытия
   (после клика по странице), подождать 5 с, нажать «Остаться» — есть ли
   разрыв ≈ 5 с в главном потоке? Продолжал ли Worker тикать (его
   собственный счётчик)? Отправляет ли `RTCDataChannel.send`, вызванный в
   обработчике `beforeunload`, данные до показа диалога? Chrome, Firefox,
   Safari.
2. **`pagehide` + `WebSocket.send`.** Мини-WS-сервер на Node (скрипт рядом)
   логирует сообщения; страница в `pagehide` шлёт сообщение и закрывается
   крестиком / Ctrl+W / переходом по URL. Доходит ли сообщение (10 попыток
   на браузер)?
3. **Фоновая вкладка.** Worker-цикл `setTimeout` 8.33 мс (как
   `TimerManager`): частота итераций при скрытой вкладке через 10 с, 1 мин,
   6 мин; задержка ретрансляции главным потоком (Worker → main →
   DataChannel loopback из двух `RTCPeerConnection` в одной странице).
   Отдельно: с открытым `RTCPeerConnection` и без.
4. **DataChannel**: `pc.sctp.maxMessageSize` в каждом браузере; время
   отправки 300 КБ кусками по 16/64 КБ через loopback-пару при
   `bufferedAmountLowThreshold`.

## 0.3. Решения, которые фиксируются в `spike-results.md`

| Параметр                     | Как выбрать                                                                                       | Дефолт-гипотеза |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | --------------- |
| `checkpointIntervalMs`       | такой, чтобы поток ≤ ~150 КБ/с исходящего у хоста и serialize ≤ 25 % бюджета тика (8.33 мс)       | 500             |
| сжатие                       | gzip level 1 vs 6: время vs размер; в браузере — `CompressionStream('gzip')` в Worker             | gzip            |
| `standbyChunkBytes`          | ≤ минимального `maxMessageSize` из 0.2.4 с запасом                                                | 65536           |
| `standbyHighWaterBytes`      | порог `bufferedAmount`, выше которого очередная периодическая точка пропускается                  | 1 МБ            |
| встраивать JSON карты в мету | если карта сжата < 50 КБ — всегда; иначе — только `mapName` + `mapsVersion` с фолбэком на каталог | встраивать      |
| `beforeunload`               | подтверждено ли, что главный поток стоит → финальный дамп при закрытии вкладки не обещаем         | не обещаем      |
| скрытая вкладка              | если Worker при скрытой вкладке держит ≥ 100 Гц — триггер этапа 9 ставим 7 с; если нет — ниже     | 7 с             |

**Стоп-условие.** Если gzip-дамп tanks > 300 КБ **или** serialize > 4 мс на
типичном железе — остановиться и обсудить с разработчиком (варианты:
реже точки, дельты, бинарный формат в крейте — это уже изменение крейта и
отдельное решение).

## Готово, когда

- `spike-results.md` содержит таблицы замеров по обеим играм и по трём
  браузерам и заполненную таблицу 0.3;
- значения перенесены в дефолты этапов 5–9 (правкой этих файлов плана,
  если отличаются от гипотез);
- в репозитории не изменено ничего, кроме `plan/host-migration/`.
