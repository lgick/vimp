# Этап 4. Эстафета Worker'ов: снятие при `destroy`, без ложных «сбойных» версий, без потерянных обновлений ✅ выполнен

Находка: **N5** ([review.md](review.md#n5--эстафета-workerов-залипающий-флаг-ложная-сбойная-версия-потерянное-обновление-остаток-f11)).
Уровень: 🟠 важно. Критерии: работоспособность, поддерживаемость.

Делать после этапа 1 (тот же `HostController.js`).

## Проблема

Эстафета Worker'ов — замена Worker'а комнаты на новую версию кода на
границе раунда: `HostRole.refreshWorker()` (`packages/engine/src/client/session/HostRole.js:558-621`)
качает манифесты (`fetchWorkerManifest`, `fetchGameManifest`), затем
`await this._controller.swapWorker(url, game)`; флаг `_swapInProgress`
снимается в `finally`. Плановая передача её вытесняет:
`HandoffFlow.start()` (`client/session/HandoffFlow.js:195-199`):
`if (this._hostRole.swapInProgress && !controller.cancelPendingSwap()) return false;`.

1. **Залипание флага.** `HostController.destroy()`
   (`client/network/HostController.js:561-573`) при идущем свопе
   обнуляет `this._swap`, но **не отвергает** его промис. `refreshWorker`
   висит на `await` вечно, `finally` не выполняется, `_swapInProgress`
   остаётся `true` (`HostRole.teardown()`, строки 419-446, его не
   сбрасывает). Если вкладка потом снова станет хостом (промоушен в той же
   странице): `refreshWorker` всегда выходит сразу (обновления кода
   выключены), а `HandoffFlow.start` видит `swapInProgress === true` при
   `cancelPendingSwap() === false` (`_swap` нет) и **отказывает в любой
   плановой передаче** — «Hand over host», «Leave server» с людьми (уходит
   аварийно, с откатом), автотриггеры, голосование. Путь: хост с ожидающей
   эстафетой получает `host_revoked` / `staleEpoch` → `PromotionFlow.demote`
   → `hostRole.teardown()` → `destroy()`.
2. **Ложная «сбойная» версия.** `teardown()` во время загрузки манифестов:
   после `await` `this._controller === null`, `this._controller.swapWorker`
   бросает `TypeError`, `catch` записывает новую версию в
   `_failedCodeVersion` — эта вкладка на неё больше не перейдёт.
3. **Снятая отложенная передача.** Отложенная передача (`defer: true`:
   перегрузка, `network`, «Hand over host» в игре без `midRound`)
   вытесняет ожидающую эстафету, а `refreshWorker`, пока передача
   активна, сразу выходит. Перезапуск эстафеты есть только в
   `HandoffFlow._onAborted` (строки 354-357).
   `PlannedHandoff.cancelDeferred()` (нагрузка нормализовалась, вызывается
   политикой через обёртку `HandoffFlow.js:109-117`) колбэков не зовёт —
   комната остаётся на старом коде до следующего деплоя/реконнекта.
4. **Окно загрузки манифестов** (известно с этапа 8 прошлого плана):
   `_swapInProgress === true`, а `HostController._swap` ещё `null` —
   `cancelPendingSwap()` возвращает `false`, `start()` отказывает, хотя
   своп ещё не начат и его можно просто не начинать.

## Решение

### 4.1 `HostController.destroy()` отвергает идущий своп

```js
destroy() {
  this._shutdownResolve?.();

  this._rejectDebugRequests('host destroyed');

  if (this._swap) {
    const { reject } = this._swap;

    this._swap.next?.terminate();
    this._clearSwapTimeout();
    this._swap = null;
    // своп ждёт HostRole.refreshWorker: без отказа его finally не
    // выполнится, и флаг эстафеты залипнет до перезагрузки страницы
    reject(new Error('host destroyed'));
  }

  this._worker.terminate();
}
```

### 4.2 `HostRole`: поколение эстафеты и вытеснение до `swapWorker`

Новые поля в конструкторе (рядом с `_swapInProgress`):

```js
// эстафета дошла до swapWorker (дальше её снимает только контроллер)
this._swapStarted = false;
// плановая передача вытеснила эстафету, ещё качающую манифесты
this._swapPreempted = false;
// номер эстафеты: teardown() начинает новый — finally прежней флаги новой
// роли не трогает
this._swapGeneration = 0;
```

`refreshWorker()` переписать так (логика сравнения версий — прежняя):

```js
async refreshWorker() {
  const controller = this._controller;

  if (this._swapInProgress || !controller || this._getHandoff().active) {
    return;
  }

  const generation = this._swapGeneration;

  this._swapInProgress = true;
  this._swapStarted = false;
  this._swapPreempted = false;

  let manifest = null;
  let game = null;

  try {
    manifest = await this._prep.fetchWorkerManifest();
    const gameManifest = await this._prep.fetchGameManifest(
      this._getActiveGame().id,
    );

    game = { … как сейчас … };

    const nextCodeVersion = { … как сейчас … };
    const nextKey = codeVersionKey(nextCodeVersion);

    if ( … те же условия выхода … ) {
      return;
    }

    // пока качались манифесты, роль сняли или плановая передача вытеснила
    // эстафету: преемник поднимется на актуальном коде
    if (
      this._controller !== controller ||
      this._swapPreempted ||
      this._getHandoff().active
    ) {
      console.info('[worker] swap preempted by planned host handoff');
      return;
    }

    this._swapStarted = true;
    await controller.swapWorker(manifest.url, game);

    if (this._controller === controller) {
      this._codeVersion = nextCodeVersion;
      this._failedCodeVersion = null;
      console.info(`[worker] room migrated to code version ${nextKey}`);
    }
  } catch (e) {
    // вытеснила плановая передача или роль снята (destroy) — версия не
    // сломана: сорвётся передача — HandoffFlow запустит эстафету снова
    if (e.message === 'swap preempted' || this._controller !== controller) {
      console.info('[worker] swap preempted by planned host handoff');
      return;
    }

    if (manifest?.version) {
      this._failedCodeVersion = { engine: manifest.version, game };
    }

    console.warn('[worker] swap to new version failed:', e);
  } finally {
    if (generation === this._swapGeneration) {
      this._swapInProgress = false;
      this._swapStarted = false;
      this._swapPreempted = false;
    }
  }
}
```

Новый метод:

```js
/**
 * Плановая передача вытесняет эстафету Worker'ов: ещё качающую манифесты —
 * флагом (до swapWorker она не дойдёт), ждущую границы раунда — снятием в
 * контроллере.
 * @returns {boolean} false — своп уже переносит состояние, передача ждёт.
 */
preemptSwap() {
  if (!this._swapInProgress) {
    return true;
  }

  if (!this._swapStarted) {
    this._swapPreempted = true;
    return true;
  }

  return this._controller?.cancelPendingSwap() === true;
}
```

`teardown()` — в начало добавить сброс эстафеты (после `handoff.cancelTokenHandoff()`):

```js
// прежняя эстафета досчитает своё и выйдет (контроллер сменился); новая
// роль начинает с чистых флагов
this._swapGeneration += 1;
this._swapInProgress = false;
this._swapStarted = false;
this._swapPreempted = false;
```

Геттер `swapInProgress` оставить (им пользуются тесты и отладка).

### 4.3 `HandoffFlow`: вытеснение через `preemptSwap` и возврат обновления кода

1. Новый приватный метод:

   ```js
   // вкладка осталась хостом, а эстафету вытеснила (или не дала начать)
   // передача — обновление кода нужно снова
   _resumeCodeUpdate() {
     if (this._hostRole.controller && this._hostRole.codeVersion) {
       this._hostRole.refreshWorker();
     }
   }
   ```

2. `start()` (строки 187-208) переписать:

   ```js
   start({ reason, stay = true, defer = stay }) {
     const controller = this._hostRole.controller;

     // промоушен сам владеет Worker'ом; передача уже идёт; комната ещё не
     // зарегистрирована — до вытеснения эстафеты, чтобы не снять её зря
     if (
       !this._planned ||
       !controller ||
       this._hostRole.promotion ||
       this._planned.active ||
       !this._hostRole.room
     ) {
       return false;
     }

     // эстафета Worker'ов уступает передаче (преемник и так поднимется на
     // актуальном коде); своп, уже переносящий состояние, — нет
     if (!this._hostRole.preemptSwap()) {
       return false;
     }

     const started = this._planned.start({ reason, stay, defer });

     if (started) {
       this._ui.setHandoffMenu('pending');
     } else {
       this._resumeCodeUpdate();
     }

     return started;
   }
   ```

3. `_onAborted`: заменить
   `if (this._hostRole.codeVersion) { this._hostRole.refreshWorker(); }`
   на `this._resumeCodeUpdate();`.
4. Обёртка `cancelDeferred` политики (строки 109-117): при `cancelled ===
true`, кроме `this._ui.setHandoffMenu(null)`, вызвать
   `this._resumeCodeUpdate()`. Комментарий: «нагрузка нормализовалась до
   границы раунда — передача не нужна, а вытесненная ею эстафета — нужна».

## Тесты (сначала падающие)

`tests/client/network/HostController.test.js` (хелперы `createController`,
`workers[0].emit`, `workers[0].posted`):

1. «destroy() при ожидающей эстафете отвергает её промис»: `ready` →
   `const swap = controller.swapWorker('/worker-2.js')` →
   `controller.destroy()` → `await expect(swap).rejects.toThrow('host
destroyed')`.
2. То же при переносящей (после `emit({ type: 'handoff_state', state: {}
})`).

`tests/client/session/HostRole.test.js` (хелперы `createReady`,
`registered`, `controllers`, `prep` — `prep.fetchWorkerManifest`
по умолчанию `vi.fn(async () => ({ version: 'e2', url: '/w2.js' }))`, —
фейк `handoff` с полем `active`; отложенный промис для манифеста делать
через `vi.fn(() => promise)` с ручным `resolve`):

3. «teardown во время загрузки манифестов: своп не начинается, версия не
   сбойная, флаг снят»: `refreshWorker()` с подвешенным
   `fetchWorkerManifest` → `role.teardown()` → `role.swapInProgress ===
false` → отпустить манифест → дождаться промиса `refreshWorker` →
   `swapWorker` старого контроллера не вызывался, `console.warn` с `swap to
new version failed` не вызывался; новая роль (`createReady`-подобный
   `adopt` + `registered({ codeVersion: … })` той же новой версии)
   вызывает `swapWorker` у нового контроллера.
4. «destroy во время ожидающего свопа не залипает»: `swapWorker` фейка
   возвращает промис, который тест отвергает `new Error('host destroyed')`
   после `role.teardown()` → `role.swapInProgress === false`; при новом
   `adopt` и `refreshWorker` своп запускается.
5. «preemptSwap во время загрузки манифестов → true, swapWorker не
   вызывается».
6. «preemptSwap при ожидающем свопе зовёт cancelPendingSwap и возвращает
   его ответ» (фейк контроллера: `cancelPendingSwap` → `true`/`false`).

`tests/client/session/HandoffFlow.test.js` (фабрика `create()`; фейки
`hostRole`, `planned`, `policy` — см. начало файла; у фейка `hostRole`
добавить `preemptSwap: vi.fn(() => true)`, `refreshWorker: vi.fn()`,
`codeVersion`, `room`):

7. «start: preemptSwap false — передача не начинается».
8. «start: передача уже идёт или комната не зарегистрирована — preemptSwap
   не вызывается».
9. «start: эстафета вытеснена, а planned.start вернул false — эстафета
   перезапускается (refreshWorker)».
10. «снятая отложенная передача (policy cancelDeferred) перезапускает
    эстафету»: `policy.options.handoff.cancelDeferred()` при
    `planned.cancelDeferred → true` → `hostRole.refreshWorker` вызван;
    при `false` — нет.
11. Существующие тесты на `swapInProgress`/`cancelPendingSwap` в
    `HandoffFlow.test.js` переписать на `preemptSwap` (поведение то же).

Проверить, что 1, 3, 4, 9, 10 падают до правки кода.

## Документация

- `docs/en/host.md` (около строк 899-905, абзац про
  `HostController.cancelPendingSwap()` и `swap preempted`) + зеркало
  `docs/ru/host.md`: эстафета уступает передаче и пока качает манифесты
  (просто не начинается); снятая отложенная передача и несостоявшийся
  старт передачи возвращают обновление кода; снятие роли хоста
  (`HostController.destroy`) отвергает своп ошибкой `host destroyed`, и
  версия сбойной не считается.
- `docs/en/client.md` (около строки 743) + зеркало — то же одной фразой.

## CHANGELOG

`## [Unreleased]` → `### Added`, запись «Planned host handoff…», последняя
фраза («A handoff does not wait for the room's code update: a Worker
handoff still waiting for the round boundary yields to it … and is retried
if the handoff is aborted»): заменить хвост на «… still waiting for the
round boundary (or still fetching its manifests) yields to it … and is
retried if the handoff is aborted or a deferred handoff is cancelled».

## Критерии готовности

- Тесты этапа зелёные, перечисленные до правки падали.
- prettier, `npx eslint .`, `npx vitest run --reporter=dot` — зелёные.
- Доки en/ru и CHANGELOG обновлены.
- Этап помечен «✅ выполнен» здесь и в `README.md`.

## Release impact

npm `vimp-engine` (клиент), уточнение `[Unreleased]`. Протокол Worker'а
не меняется. Игры, крейт, `create-vimp-game`, auth не затронуты.
