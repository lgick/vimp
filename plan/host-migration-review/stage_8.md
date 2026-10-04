# Этап 8. Плановая передача вытесняет ожидающую эстафету Worker'ов ✅ выполнен

Находка: **F11** ([review.md](review.md), раздел F11).
Уровень: 🟠 важно. Критерии: работоспособность, поддерживаемость.

## Проблема

После каждого деплоя мастер рестартует, хост возвращает комнату
`reclaim_host`, в `host_registered` видит новый `codeVersion` и
запускает эстафету Worker'ов (`client/main.js:2536-2546` →
`refreshHostWorker`, строки 3148-3198 → `HostController.swapWorker`,
`client/network/HostController.js:262-285`). Старый Worker ждёт границы
раунда (`host/meta/core/RoundManager.js:321-328, 345-356`): в tanks —
минуты, в snakes (`endlessRound`, `mapTime` 1 ч,
`../vimp-snakes/src/config/game.js:99-100, 134`) — до часа.

Всё это время `startPlannedHandoff` (`client/main.js:2710-2728`)
отказывает по `workerSwapInProgress`:

- «Hand over host» молча не работает;
- «Leave server» уходит аварийным путём `host_leaving` — откат у всех;
- автотриггеры (скрытая вкладка, перегрузка) не срабатывают;
- прошедшее голосование кончается принудительной миграцией через 5 с.

Плановая передача — и так способ обновить код: преемник готовит комнату с
**актуальным** worker-бандлом (`prepareHostRoom` → `fetchWorkerManifest`,
`client/main.js:2229-2247`).

## Решение

### 8.1 Worker умеет отменить ещё не наступившую эстафету

1. `packages/engine/src/host/HostGame.js`: публичный
   `cancelHandoff()` → `this._roundManager.cancelHandoff()` (снимает
   `_handoffCallback`, если граница ещё не наступила; повторный вызов
   безвреден). Комментарий: плановая передача хоста вытесняет эстафету
   (этап 8 ревью).
2. `packages/engine/src/host/host.worker.js`: новый тип сообщения
   (только добавление в протокол главный поток ↔ Worker):
   ```js
   // плановая передача хоста вытесняет эстафету, ещё ждущую границы раунда
   case 'cancel_handoff':
     host?.cancelHandoff();
     break;
   ```

### 8.2 HostController снимает своп, пока он не на паузе

`packages/engine/src/client/network/HostController.js`:

1. Метод
   ```js
   /**
    * Снять эстафету, ждущую границы раунда (плановая передача хоста
    * важнее). Своп уже переносит состояние — снять нельзя.
    * @returns {boolean} эстафета снята.
    */
   cancelPendingSwap() {
     if (!this._swap || this._swap.paused) {
       return false;
     }
     const { reject } = this._swap;
     this._swap = null;
     this._worker.postMessage({ type: 'cancel_handoff' });
     reject(new Error('swap preempted'));
     return true;
   }
   ```
2. Гонка: Worker мог отдать `handoff_state` раньше, чем получил
   `cancel_handoff` (его таймеры уже остановлены). `_onHandoffState`
   (строки 535-563): при `!this._swap` вместо молчаливого `return` —
   `this._worker.postMessage({ type: 'resume' })` (Worker вернёт таймеры и
   начнёт раунд, `HostGame.resumeAfterHandoff`). После `destroy()` Worker
   уже остановлен — сообщение ничего не сделает.

### 8.3 main.js: передача сначала снимает своп

`client/main.js` `startPlannedHandoff` (строки 2710-2728):

```js
if (!plannedHandoff || !hostController || hostPromotion) {
  return false;
}

// эстафета, ждущая границы раунда, уступает передаче: преемник и так
// поднимется на актуальном коде. Своп, уже переносящий состояние, — нет
if (workerSwapInProgress && !hostController.cancelPendingSwap()) {
  return false;
}
```

`refreshHostWorker` (строки 3148-3198): в `catch` при
`e.message === 'swap preempted'` не записывать `failedCodeVersion`, в
журнал — `console.info`, а не `warn`. В `handleHandoffAborted` (вкладка
осталась хостом, строки 2740-2762) в конце — `refreshHostWorker()`
(проверка версии повторится, своп запустится снова, если нужен) — под тем
же условием `hostCodeVersion`, что и вызовы из `host_registered`
(обновления кода не отключены).

## Тесты (сначала падающие)

- `tests/client/network/HostController.test.js`:
  - `swapWorker` → до `handoff_state` `cancelPendingSwap()` возвращает
    `true`, Worker получил `cancel_handoff`, промис отвергнут
    `'swap preempted'`, `_swap` снят;
  - после `handoff_state` (пауза) → `false`, своп продолжается;
  - поздний `handoff_state` после снятия → Worker получил `resume`.
- `tests/host/hostWorker.test.js`: `cancel_handoff` вызывает
  `host.cancelHandoff()`.
- `tests/host/HostGame.checkpoint.test.js` (или тест эстафеты в
  `tests/host/`): `requestHandoff` → `cancelHandoff()` → ближайший
  `initiateNewRound` стартует раунд, колбэк эстафеты не зовётся.

## Документация (en и ru одинаково)

- `docs/{en,ru}/host.md`, «Worker handoff» и «Planned handoff»: плановая
  передача снимает эстафету, ждущую границы раунда; новое сообщение
  Worker'а `cancel_handoff`; поздний `handoff_state` возвращается
  `resume`.
- `docs/{en,ru}/client.md`: `HostController.cancelPendingSwap`.

## CHANGELOG

`[Unreleased]` → `### Added`, запись «Planned host handoff»: передача не
ждёт обновления кода комнаты — эстафета Worker'ов, ждущая границы раунда,
ей уступает. Новой записи не заводить.

## Критерии готовности

- Во время ожидающей эстафеты «Hand over host», «Leave server» с людьми,
  автотриггеры и голосование идут плановой передачей.
- Prettier, eslint, vitest — зелёные. Release impact: npm `vimp-engine`,
  уточнение `[Unreleased]`; протокол Worker'а только дополнен.
