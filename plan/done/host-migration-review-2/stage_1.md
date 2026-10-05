# Этап 1. «Leave server» одинокого хоста при ожидающей эстафете Worker'ов пишет очки ✅ выполнен

Находка: **N1** ([review.md](review.md#n1--leave-server-одинокого-хоста-при-ожидающей-эстафете-теряет-очки)).
Уровень: 🟠 важно. Критерии: работоспособность.

## Проблема

`packages/engine/src/client/network/HostController.js`, `shutdown()`
(строки ~530-534):

```js
shutdown({ timeoutMs = 3000 } = {}) {
  // эстафета переносит состояние в новый Worker, закрывать нечего
  if (this._swap) {
    return Promise.resolve();
  }
  …
}
```

`this._swap` создаёт `swapWorker()` (эстафета Worker'ов на новую версию
кода) и держит его, пока старый Worker ждёт границы раунда. Своп бывает:

- **ожидающий** — `this._swap.paused === false`: Worker играет как обычно,
  ничего не переносил и очки участников не писал;
- **переносящий** — `this._swap.paused === true` (выставляет
  `_onHandoffState` по сообщению `handoff_state`): старый Worker уже
  выполнил `HostGame._flushBeforeHandoff()` (`host/HostGame.js:880`) и отдал
  мету новому.

Для ожидающего свопа `shutdown()` тоже сразу возвращает выполненный промис.
`HandoffFlow.leaveByUser` (`client/session/HandoffFlow.js:272-289`) после
этого шлёт `host_leaving`, вызывает `leave()` → `HostRole.teardown()` →
`HostController.destroy()` → `worker.terminate()`: очки (rank/state)
участников с прошлой синхронизации пропадают. После каждого деплоя
эстафета ждёт границы раунда до часа (snakes: `mapTime` 1 ч,
`endlessRound`) — весь этот час «Leave server» единственного человека в
комнате теряет очки.

Попутно: `_onHandoffState` (строки ~591-597) при `!this._swap` шлёт
Worker'у `resume`. Если своп снят ради закрытия, а Worker успел отдать
состояние до `cancel_handoff`, `resume` придёт после `HostGame.destroy()`
и оживит таймеры уничтожаемого матча.

## Решение

### 1.1 `HostController.shutdown()`

Заменить начальную проверку:

```js
shutdown({ timeoutMs = 3000 } = {}) {
  // эстафета уже переносит состояние: старый Worker записал очки перед
  // отдачей меты (_flushBeforeHandoff) — закрывать нечего
  if (this._swap?.paused) {
    return Promise.resolve();
  }

  // повторный вызов (второй клик «Leave server») — тот же промис: второй
  // HostGame.destroy() поверх идущего повторил бы flush (двойной зачёт)
  if (this._shutdownPromise) {
    return this._shutdownPromise;
  }

  // эстафета ждёт границы раунда: ничего не переносила и очков не писала.
  // Комната закрывается — эстафета больше не нужна, а очки — нужны
  if (this._swap) {
    this.cancelPendingSwap();
  }

  this._shutdownPromise = new Promise(resolve => { … как сейчас … });

  return this._shutdownPromise;
}
```

`cancelPendingSwap()` (строки ~289-301) уже шлёт Worker'у `cancel_handoff`
и отвергает промис свопа ошибкой `swap preempted`;
`HostRole.refreshWorker` (`client/session/HostRole.js:606-611`) такую
ошибку пишет как `console.info` и версию сбойной не помечает. Порядок
сообщений Worker'у: `cancel_handoff`, затем `shutdown` — Worker обработает
их в этом порядке.

Обновить JSDoc `shutdown()`: ожидающая эстафета снимается, переносящая —
сразу выполненный промис.

### 1.2 `HostController._onHandoffState`

```js
_onHandoffState(state) {
  // своп снят (cancelPendingSwap), а Worker успел отдать состояние раньше,
  // чем получил cancel_handoff: его таймеры стоят — вернуть к игре. Если
  // своп сняло закрытие комнаты, возвращать нечего: Worker уже в
  // HostGame.destroy(). После destroy() сообщение ничего не сделает
  if (!this._swap) {
    if (!this._shutdownPromise) {
      this._worker.postMessage({ type: 'resume' });
    }

    return;
  }
  …
}
```

### 1.3 Что не меняется

`HandoffFlow.leaveByUser` не трогается: он уже зовёт `shutdown()` для
хоста без людей. Протокол Worker'а не меняется (`cancel_handoff` и
`shutdown` уже есть).

## Тесты (сначала падающие)

`tests/client/network/HostController.test.js` (хелперы файла:
`createController()` → `{ controller, workers }`, `workers[0].emit(msg)`,
`workers[0].posted`; образец — тесты около строк 541-585 и 588-660):

1. **Заменить** тест «во время эстафеты — сразу, без сообщения Worker'у»
   (около строки 636) двумя:
   - «shutdown при эстафете, ждущей границы раунда, снимает её и пишет
     очки»: `ready` → `const swap = controller.swapWorker('/worker-2.js')`
     → `controller.shutdown({ timeoutMs: 60000 })`. Ожидания: `swap`
     отвергнут с `swap preempted`; в `workers[0].posted` есть
     `{ type: 'cancel_handoff' }` **раньше** `{ type: 'shutdown',
timeoutMs: 60000 }`; промис `shutdown` не выполнен, пока нет
     `shutdown_done`, и выполнен после `workers[0].emit({ type:
'shutdown_done' })`.
   - «shutdown при переносе состояния (paused) — сразу, без сообщения
     Worker'у»: `ready` → `swapWorker(...)` (с `.catch(() => {})`) →
     `workers[0].emit({ type: 'handoff_state', state: {} })` →
     `shutdown()` выполнен сразу, `shutdown` Worker'у не уходил.
2. «поздний handoff_state после снятия свопа закрытием не шлёт resume»:
   `ready` → `swapWorker(...)` (`.catch`) → `shutdown({ timeoutMs: 60000 })`
   → `workers[0].emit({ type: 'handoff_state', state: {} })` → в
   `posted` нет `{ type: 'resume' }`.
3. Существующий тест «поздний handoff_state после снятия возвращает Worker
   к игре (resume)» (около строки 570) должен остаться зелёным без правок.

Проверить, что тесты 1 (первый пункт) и 2 падают до правки кода.

## Документация

- `docs/en/host.md`, раздел сообщений Worker'а, пункт `shutdown {
timeoutMs }` (около строки 107) и зеркало `docs/ru/host.md`: добавить —
  `HostController.shutdown()` сначала снимает эстафету Worker'ов, ещё
  ждущую границы раунда (`cancel_handoff`), а при эстафете, уже
  переносящей состояние, сразу выполнен (старый Worker записал очки перед
  отдачей меты).
- `docs/en/client.md` около строк 1548-1549 (описание «Leave server» через
  `HostController.shutdown`) и зеркало в `docs/ru/client.md` — то же одной
  фразой.

## CHANGELOG

`packages/engine/CHANGELOG.md`, `## [Unreleased]` → `### Added`, запись
«Planned host handoff in the lobby mode», фраза про «Leave server» («a host
alone closes the room — the master hides it … while the Worker writes the
participants' scores, up to `migration.leaveFlushTimeoutMs`, 3 s»):
дописать «— a Worker handoff still waiting for the round boundary is
cancelled first». Новой записи не заводить.

## Критерии готовности

- Тесты этапа зелёные, до правки падали (кроме п. 3).
- `npx prettier --write` по изменённым файлам, `npx eslint .`,
  `npx vitest run --reporter=dot` — зелёные.
- Доки en/ru и CHANGELOG обновлены.
- Этап помечен «✅ выполнен» здесь и в `README.md`.

## Release impact

npm `vimp-engine`, уточнение `[Unreleased]` (minor уже задан). Игры,
крейт, `create-vimp-game`, auth не затронуты.
