# Этап 10. «Leave server» последнего человека: синхронизация очков перед закрытием ✅ выполнен

Находка: **F13** ([review.md](review.md), раздел F13).
Уровень: 🟡 качество. Критерии: работоспособность (сохранность данных).

## Проблема

`packages/engine/src/client/main.js:2783-2826`: хост, один в комнате,
нажимает «Leave server» → `leaveServerByUser` → `host_leaving` →
`leaveServer()` → `teardownHostRole()` → `HostController.destroy()`
(`client/network/HostController.js:507-517`) → `worker.terminate()`.
`HostGame.destroy()` (`host/HostGame.js:829-860`, закрывает игры
участников и ждёт `flushAll({ urgent: true })`) в браузере не вызывается.
Накопленные с прошлой синхронизации rank/state (интервал до
`lobby.playerData.minFlushInterval`, 5 мин) пропадают.

Это явное действие пользователя — завершить матч корректно можно.

Когда в комнате есть другие люди, синхронизировать **не нужно**: очки
едут в финальной/последней точке к преемнику, и он запишет их с номером
`writeSeq + 1` (`host/meta/modules/PlayerDataSync.js`, `restore`). Запись
из уходящего Worker'а в этом случае только добавила бы риск повтора.

## Решение

### 10.1 Сообщение Worker'а `shutdown`

`packages/engine/src/host/host.worker.js` (только добавление в протокол):

```js
// хост закрывает комнату («Leave server» последнего человека): закрыть
// игры участников и дождаться записи профилей — не дольше timeoutMs
case 'shutdown': {
  const timeoutMs = Number(msg.timeoutMs) > 0 ? Number(msg.timeoutMs) : 3000;
  try {
    await Promise.race([
      host?.destroy(),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  } catch (e) {
    self.postMessage({ type: 'diagnostic', kind: 'shutdown', message: e?.message ?? String(e), stack: e?.stack ?? null });
  }
  self.postMessage({ type: 'shutdown_done' });
  break;
}
```

### 10.2 `HostController.shutdown`

`packages/engine/src/client/network/HostController.js`:

```js
/**
 * Корректное закрытие комнаты: Worker закрывает игры участников и пишет
 * профили (HostGame.destroy). Разрешается по ответу Worker'а или по
 * таймауту — Worker не гасится, это делает destroy().
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<void>}
 */
shutdown({ timeoutMs = 3000 } = {}) { … }
```

Реализация: одноразовый слушатель `shutdown_done` в `_onWorkerMessage`
(поле `this._shutdownResolve`), `postMessage({ type: 'shutdown', timeoutMs })`,
страховочный `setTimeout(resolve, timeoutMs + 500)`. Во время эстафеты
(`this._swap`) — сразу `resolve()` (состояние переносится, а не
закрывается).

### 10.3 main.js: уход последнего человека

`client/main.js`:

1. Новый ключ `packages/engine/src/config/lobby.js` →
   `migration.leaveFlushTimeoutMs: 3000`.
2. `leaveServerByUser` (строки 2783-2802): ветка «хост, передавать
   некому» — если `(hostConnections?.peerCount ?? 0) === 0`, перед
   `leaveServer()`:
   ```js
   showSessionOverlay('Leaving…');
   await hostController.shutdown({ timeoutMs: lobbyConfig.migration.leaveFlushTimeoutMs });
   ```
   Функцию сделать `async`; меню вызывает её без ожидания результата.
   Если люди есть, но передача не началась (эстафета уже переносит
   состояние, промоушен) — поведение прежнее, без `shutdown`.
3. `pagehide` (закрытие вкладки) не трогать: ждать там нельзя.

### 10.4 Мастер: состояние комнаты «закрывается» (согласовано 2026-10-04)

Записывать очки до `host_leaving`: пока комната зарегистрирована, мастер
помечает запись комнатой (`rank_events.session_id`, ключ лимита частоты —
`RoomRegistry.verifiedAttribution`). Rank/state при этом общие по игре —
комната только пометка. Чтобы за время записи (≤ 3 с) в комнату никто не
вошёл и не был выкинут закрытием, комната переходит в `closing`:

- новое сообщение хоста `host_closing { roomId, epoch }` (только
  добавление); принимается от сессии хоста комнаты, при `epoch ===
room.epoch` и `status === 'online'` → `room.status = 'closing'`
  (`MigrationCoordinator.onHostClosing`). Таймера нет: дальше `host_leaving`
  или обрыв WS → `hostLost`, как раньше;
- `closing`: нет в `GET /servers` (фильтр `status === 'online'` уже есть),
  `GET /rooms/:id` → 404 (`getPublic` → null), `join_room` и `webrtc_offer`
  → `error unknownRoom` (`re` — по запросу; не `migrating`, чтобы гость не
  повторял оффер). Новичок уходит искать другую комнату.

### 10.5 Порядок ухода одинокого хоста в main.js

`showSessionOverlay('Leaving…')` → `signaling.hostClosing(...)` →
`await hostController.shutdown(...)` (в `try/finally`) →
`signaling.hostLeaving(...)` → `leaveServer()`. Новый метод
`SignalingClient.hostClosing(roomId, epoch)`.

### 10.6 Доработки по код-ревью (согласовано 2026-10-04)

- Гость, чей оффер мастер переслал до `host_closing`, не входит в
  закрывающийся матч: после `shutdown` Worker на новый `connect` (и
  `resume`) отвечает `close_client` без кода — в лобби-режиме гость ищет
  другую комнату.
- Повторный «Leave server»: `HostController.shutdown()` возвращает уже
  идущий промис (второго `shutdown` Worker не получает), `main.js` —
  флаг `leavingServer`.

## Тесты (сначала падающие)

- `tests/host/hostWorker.test.js`: `shutdown` вызывает `host.destroy()` и
  отвечает `shutdown_done`; зависший `destroy` — ответ по таймауту;
  исключение в `destroy` — `diagnostic` и всё равно `shutdown_done`.
- `tests/client/network/HostController.test.js`: `shutdown` разрешается
  по `shutdown_done`; без ответа — по таймауту; во время эстафеты —
  сразу.
- Мастер: `host_closing` скрывает комнату из списка и ссылки, `join_room` и
  `webrtc_offer` → `unknownRoom`; чужая сессия / неверная эпоха / не
  `online` — без эффекта; `verifiedAttribution` в `closing` работает.
- `SignalingClient.hostClosing` шлёт кадр.

`main.js` юнит-тестами не покрыт — ручная проверка: создать комнату,
набрать очки, «Leave server» → в auth появилась запись `rank_events`.

## Документация (en и ru одинаково)

- `docs/{en,ru}/host.md`: сообщение Worker'а `shutdown` / `shutdown_done`.
- `docs/{en,ru}/client.md`: «Leave server» последнего человека
  синхронизирует профили перед закрытием; `HostController.shutdown`.
- `docs/{en,ru}/configuration.md`: `migration.leaveFlushTimeoutMs`.
- `docs/{en,ru}/master.md`: сообщение `host_closing` (таблица сообщений
  мастера живёт здесь, не в `network.md`) и статус комнаты `closing`.

## CHANGELOG

`[Unreleased]` → `### Added`, запись «Planned host handoff» (строка про
«Leave server»): хост, уходящий последним, перед закрытием комнаты
записывает очки участников. Новой записи не заводить.

## Критерии готовности

- «Leave server» одинокого хоста не теряет очки (ожидание ≤ 3 с).
- Prettier, eslint, vitest — зелёные. Release impact: npm `vimp-engine`,
  уточнение `[Unreleased]`; протокол Worker'а только дополнен.
