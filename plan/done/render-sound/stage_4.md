# Этап 4 — баг 3: пустой `#vimp` после возврата на вкладку ✅ выполнен

Реализовано 4.2–4.4 целиком; из 4.1 постоянными остались `webglcontextlost`/
`webglcontextrestored` с `console.warn` (они же часть лечения) и dev-лог
состояния полотен + `clientCore.debug_json()` при возврате на вкладку.
Ручное воспроизведение (2–5 минут в фоне) остаётся за разработчиком.

## Что известно точно

- Весь рендер идёт с одного `Ticker.shared` (Pixi 8.19.0, `sharedTicker:
  true`). rAF в скрытой вкладке останавливается и корректно возобновляется —
  сам по себе это не причина.
- `push_frame` продолжает работать в скрытой вкладке (событие `message`, не
  rAF). Буфер интерполятора ограничен `max_frame_age` и
  `MAX_BUFFER_FRAMES = 256`, лавины событий при возврате не будет.
- **Обработчиков `webglcontextlost`/`webglcontextrestored` нет нигде** — ни в
  движке, ни в плагине. Единственный `visibilitychange` только мьютит звук.
- Pixi 8 сам ничего не восстанавливает: `GlContextSystem.handleContextLost`
  делает только `preventDefault()`, `handleContextRestored` —
  `getExtensions()` и `contextChange`. Ни лога, ни исключения.
- Всё видимое содержимое — `RenderTexture` **без CPU-источника**: карта
  целиком (`Map.js`, исходный контейнер уничтожается сразу после
  `generateTexture`) и все атласы спрайтов (`BakingProvider.bakeAll`).
  Полотен два (`vimp` + `radar`) → два WebGL-контекста.

Главный подозреваемый: контекст потерян при сворачивании вкладки, сцена и
тикер целы, а все текстуры пустые → виден только фон `#222`, **без ошибок в
консоли**. Подтвердить замером.

## 4.1. Диагностика (делать первой)

Временная инструментация под `import.meta.env.DEV`:

- на каждый `canvas` повесить `webglcontextlost` (с `event.preventDefault()`)
  и `webglcontextrestored` с `console.warn`;
- в `handleVisibilityChange` при переходе в `visible` залогировать по каждому
  полотну: `app.renderer.gl?.isContextLost?.()`, `app.canvas.width/height`,
  `app.stage.scale.x`, `app.stage.position`, `Ticker.shared.started`, плюс
  `clientCore.debug_json()`.

Воспроизведение: переключиться на тяжёлую вкладку/другое приложение на 2–5
минут, вернуться.

| Наблюдение | Диагноз | Лечение |
| --- | --- | --- |
| `isContextLost() === true` или сработал `webglcontextlost` | потеря WebGL-контекста | 4.2 |
| `stage.scale.x === 0` или `canvas.width === 0` | нулевой resize | 4.3 |
| контекст жив, размеры в норме, но `Ticker.shared.started === false` / `renderTick` не вызывается | остановленный общий тикер | 4.4 |

## 4.2. Восстановление WebGL-контекста (основной сценарий)

Переиспользуем существующие пути «полной перерисовки»:

1. Поднять на модульный уровень `main.js` контекст каждого полотна:
   `renderContexts[canvasId] = { app, assetProvider, bakingArr }` — сейчас это
   локальные переменные колбэка `initPromises`.
2. Вынести тело `socketMethods[PS_MAP_DATA]` в именованную
   `applyMapData(data, { notifyHost = true } = {})` и кэшировать последний
   payload в `lastMapData`.
3. `webglcontextlost` на любом полотне: `event.preventDefault()`
   (**обязательно**, иначе контекст не восстановится), снять `renderTick` с
   `Ticker.shared`, выставить флаг.
4. `webglcontextrestored`:
   - `for (const p in CTRL) { CTRL[p].remove(); }` — сущности держат мёртвые
     текстуры;
   - для каждого полотна `assetProvider.bakeAll(bakingArr, app)` —
     `BakingProvider` пишет в **тот же** экземпляр `Map`, который держит
     `GameModel._assets`, поэтому новые сущности получат свежие текстуры без
     пересоздания контроллеров;
   - `applyMapData(lastMapData, { notifyHost: false })` — пересборка карты
     без повторного `MAP_READY` (хост его не ждёт, повторный сломает машину
     состояний портов);
   - вернуть `renderTick` на тикер; танки и динамика восстановятся сами из
     ближайших кадров.
5. `BakingProvider.bakeAll` перед `this._collection.clear()` должен уничтожать
   старые текстуры (`destroy(true)`), иначе перепечка течёт GPU-памятью.
   Обернуть в `try/catch` — после потери контекста они уже мертвы.

## 4.3. Защита от нулевого resize

`CanvasManagerModel.resize` считает `width/height` из `data.width/height` без
нижней границы, а `currentScale = (width / designWidth) * baseScale`. При
`innerWidth === 0` получаем `renderer.resize(0, 0)` и `stage.scale.set(0)`,
причём **scale сам не пересчитается** — только на следующем настоящем
`resize`. Лечение: игнорировать вызовы с `width <= 0 || height <= 0` и зажать
итоговые размеры `Math.max(1, …)`.

## 4.4. Тикер и часы

- `handleDisconnect` вызывает `apps[id].stop()`; при `sharedTicker: true` это
  `Ticker.shared.stop()` — глобально. А `Ticker.shared.autoStart` возвращает
  тикер к жизни при первом же `Ticker.shared.add(...)` из любого part'а, но
  уже **без** `renderTick`. Убрать вызов `stop()`: `renderTick` снят строкой
  выше, а `location.reload()` через 3 с и так убивает страницу.
- Ресинк часов интерполятора после длинной паузы: добавить в
  `export_client_core_abi!` (`packages/engine/core/src/abi.rs`) метод
  `resync()` → `ClientState::resync()` = `interpolator.reset()` +
  `frames_out.clear()` (**предикт не трогаем**). Вызывать из
  `handleVisibilityChange` при переходе в `visible`, обязательно как
  `clientCore?.resync?.()` — старая сборка плагина этого метода не имеет.
  Это сбрасывает `offset_ema`/`last_render_time`, чтобы следующий кадр
  пересеял оффсет точно, а не догонял EMA 30–50 кадров.

## Файлы

- `packages/engine/src/client/main.js`
- `packages/engine/src/client/providers/BakingProvider.js`
- `packages/engine/src/client/components/model/CanvasManager.js`
- `packages/engine/core/src/abi.rs`, `packages/engine/core/src/client/game.rs`

## Тесты

- cargo: новый `resync()` чистит буфер интерполятора и не трогает игровую
  половину.
- Vitest: `CanvasManager.resize` игнорирует нулевые размеры.
