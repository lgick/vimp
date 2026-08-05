# Этап 1 — Детерминированное время и случайность ✅ выполнен

Фундамент: без управляемого времени 10-минутный матч не прогнать за секунды,
а без управляемой случайности прогон не воспроизводится.

## 1.1 `packages/engine/src/lib/clock.js` (новый) ✅ выполнен

Синглтон в идиоме `lib/config.js` — модуль экспортирует объект с методами,
состояние на уровне модуля.

Методы: `now()`, `monotonic()`, `random()`, `setTimeout`, `clearTimeout`,
`setInterval`, `clearInterval`; управление — `install(custom)` (возвращает
функцию отката) и `reset()`.

**Отклонение от исходной постановки (обосновано):** в плане `performance.now()`
предлагалось слить с `clock.now()`. Разделено на два метода —
`now()` (эпоха, мс, `Date.now`) и `monotonic()` (высокое разрешение,
`performance.now`). Причина — инвариант «прод не меняет поведение»:
игровой цикл считает `dt` по `performance.now()`, у которого разрешение
сильно выше миллисекунды `Date.now()`; слияние добавило бы джиттер в
реальную симуляцию. `VirtualClock` (этап 2) выводит оба метода из одного
виртуального счётчика, так что детерминизм не страдает.

Все методы делегируют через позднее связывание (`impl.now()` внутри
стрелки), поэтому `vi.useFakeTimers()`/`vi.setSystemTime()` в существующих
тестах продолжают работать без правок.

## 1.2 `packages/engine/src/lib/AbstractTimer.js` ✅ выполнен

Единственная точка, через которую идут **все** таймеры хоста
(`_startTimer`/`_stopTimer`/`_clearAllTimers`). Берёт таймер-функции из
`clock`. Одна правка покрывает `TimerManager`, голосования, idle-check,
RTT-пинги и сам игровой цикл.

## 1.3 Замена call-site ✅ выполнен

Сигнатуры не меняются.

| Файл | Что |
| --- | --- |
| `host/HostGame.js:316,401,743,769,794` | `Date.now()` → `clock.now()` |
| `host/meta/modules/TimerManager.js:69,82,98,109,116` | `Date.now()` → `clock.now()` |
| `host/meta/modules/TimerManager.js:123,149` | `performance.now()` → `clock.monotonic()` |
| `host/meta/modules/RTTManager.js:99,144` | `Date.now()` → `clock.now()` |
| `host/meta/SocketManager.js:281` | `Date.now()` (serverTime) → `clock.now()` |
| `host/meta/player/HumanParticipant.js:27` | `Date.now()` → `clock.now()` |
| `host/meta/modules/Vote.js:174` | `Math.random()` → `clock.random()` — розыгрыш ничьей влияет на ротацию карт, то есть виден в реплее |
| `host/host.worker.js:139` | `Math.random()` для seed → `clock.random()`, seed принимается из `room.seed`, если задан |

Примечание: в исходном плане `SocketManager` указан как
`host/meta/modules/SocketManager.js`, фактический путь — `host/meta/SocketManager.js`.

## 1.4 Проброс seed наружу ✅ выполнен

`postMessage({ type: 'ready', mapName, seed })` — до правки seed
генерировался в `host.worker.js` и нигде не сохранялся, то есть терялся.
Теперь:

- `room.seed` (uint32), если задан, используется как есть — реплей
  воспроизводит тот же мир;
- иначе генерируется через `clock.random()`;
- фактический seed уезжает в главный поток в сообщении `ready` (там его
  подхватит рекордер этапа 6).

## 1.5 Тесты ✅ выполнен

- `tests/lib/clock.test.js` (новый) — дефолты, `install`/`reset`, откат,
  частичная подмена, позднее связывание.
- `tests/lib/AbstractTimer.test.js` — добавлен блок на работу через
  подменённый `clock`.

Отложено на этап 2: перевод существующих host-тестов с
`vi.useFakeTimers()` на `VirtualClock` — самого `VirtualClock` ещё нет
(он живёт в `packages/engine/src/devtools/`). Текущие тесты зелёные без
правок, потому что дефолты `clock` резолвят глобалы в момент вызова.

## Проверка ✅ выполнен

- `npx eslint .` — зелёный.
- `npm test` — зелёный.
- Документация: пользовательского поведения этап не меняет; `clock` и
  `seed` в `ready` описываются в этапе 7 (`docs/en|ru/host.md`,
  `configuration.md`).
