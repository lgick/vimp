# Этап 5. Свежесть точки беты — по возрасту точки, а не по приходу статуса ✅ выполнен

Находка: **F8** ([review.md](review.md), раздел F8).
Уровень: 🟠 важно. Критерии: работоспособность.

Делать после этапа 4 (те же `_onStandbyStatus` и `_pickCandidate`).

## Проблема

- `packages/engine/src/master/SignalingServer.js:496-516`
  `_onStandbyStatus`: на каждый `standby_status` ставит
  `room.standby.receivedAt = this._now()`, даже если точка та же.
- `packages/engine/src/client/main.js:2031-2042` `reportStandbyStatus`:
  бета раз в `standbyStatusIntervalMs` (5 с) шлёт свою последнюю точку,
  какой бы старой она ни была.
- `packages/engine/src/master/MigrationCoordinator.js:291-300` и
  `:654-669`: режим `checkpoint` и плановая передача разрешаются, если
  `now - standby.receivedAt <= checkpointMaxAgeMs` (12 с) — то есть по
  свежести **статуса**.
- `packages/engine/src/client/network/StandbySender.js:144-149`: если
  канал `standby` закрылся при живом пире беты, хост выключает точки и
  открывает канал заново только при смене состава пиров или беты.
- `packages/engine/src/client/network/Promotion.js:281-289`: возраст точки
  перед подъёмом матча не проверяется.

**Сценарий.** Поток точек встал (канал `standby` закрылся сам, хост
пропускает точки из-за забитого канала). Бета продолжает докладывать старую
точку, мастер считает её свежей. Хост падает → режим `checkpoint` из точки
минутной давности → мир откатывается на минуты, хотя честнее был бы
холодный старт.

## Решение

### 5.1 Бета сообщает возраст точки

1. `client/main.js` `reportStandbyStatus`: добавить поле
   `ageMs: Math.max(0, Date.now() - latest.receivedAt)` (`receivedAt` —
   `Date.now()` бета-приёмника, `client/network/StandbyReceiver.js:29, 213`).
2. `client/network/SignalingClient.js` `standbyStatus`: передавать
   `ageMs`.

### 5.2 Мастер считает момент получения точки по её возрасту

`SignalingServer._onStandbyStatus`:

```js
const now = this._now();
const prev = room.standby;
const ageMs =
  Number.isFinite(msg.ageMs) && msg.ageMs >= 0 ? Math.min(msg.ageMs, STANDBY_AGE_CAP_MS) : null;
let receivedAt;

if (ageMs !== null) {
  receivedAt = now - ageMs;
} else if (
  prev &&
  prev.memberId === room.successorMemberId &&
  prev.checkpointId === checkpointId.slice(0, 64)
) {
  // бета до этого этапа: та же точка свежее не становится
  receivedAt = prev.receivedAt;
} else {
  receivedAt = now;
}
```

`STANDBY_AGE_CAP_MS = 10 * 60 * 1000` — константа модуля с комментарием.
Комментарий у поля `standby` в `RoomRegistry._create` (строки 183-185):
`receivedAt` — момент, когда бета получила точку (часы мастера).

### 5.3 Преемник не поднимает слишком старую точку

1. `packages/engine/src/config/lobby.js`, раздел `migration`:
   `maxRestoreAgeMs: 15000` (больше `master.room.checkpointMaxAgeMs` на
   запас дороги статуса).
2. `client/network/Promotion.js`: опции `maxRestoreAgeMs = 15000` и
   `now = () => Date.now()`. После выбора точки (строка 287):
   ```js
   if (this._now() - latest.receivedAt > this._maxRestoreAgeMs) {
     throw new Error('checkpoint is too old to restore from');
   }
   ```
   Финальная точка плановой передачи свежая всегда.
3. `client/main.js` `handlePromote`: передать
   `maxRestoreAgeMs: lobbyConfig.migration.maxRestoreAgeMs`.

Отказ уходит обычным путём: `onFailed` → `promote_failed` → мастер берёт
следующего кандидата (холодный старт).

### 5.4 Хост открывает закрывшийся канал `standby` заново

`client/network/StandbySender.js`:

1. Опции `reopenDelayMs = 1000`, `reopenMaxDelayMs = 10000`,
   `timers = globalThis`.
2. В `channel.onclose` (строки 144-149) после `_dropChannel()` и
   `_setCheckpoints(false)` — `_scheduleReopen()`: таймер с
   экспоненциальной задержкой (1 с, 2 с, 4 с … до 10 с) вызывает
   `refresh()`. `refresh()` сам решит: пира нет — канала не будет.
3. `channel.onopen` сбрасывает задержку к `reopenDelayMs`;
   `setSuccessor`, `destroy` снимают таймер.
4. `client/main.js` `adoptHostRole`: значения из
   `lobbyConfig.migration.standbyReopenDelayMs` (1000) и
   `standbyReopenMaxDelayMs` (10000) — добавить в `config/lobby.js`.

## Тесты (сначала падающие)

- `tests/master/SignalingServer.test.js`:
  - `standby_status` с той же точкой без `ageMs` не освежает
    `receivedAt`; через 13 с аварийная миграция идёт в `cold`;
  - `ageMs: 20000` — точка не свежая; `ageMs: 100` — свежая;
  - мусорный `ageMs` (строка, отрицательный) — как будто поля нет.
- `tests/client/network/Promotion.test.js`: `latest.receivedAt` старше
  `maxRestoreAgeMs` → `onFailed`, контроллер не создан.
- `tests/client/network/StandbySender.test.js`: закрытие канала при живом
  пире → через задержку открыт новый канал и точки включены; рост
  задержки; `destroy` снимает таймер; нет пира — канала нет.

## Документация (en и ru одинаково)

- `docs/{en,ru}/master.md`: `standby_status.ageMs`, как мастер считает
  свежесть точки.
- `docs/{en,ru}/host.md` (раздел о преемнике): бета не поднимает точку
  старше `maxRestoreAgeMs`; хост переоткрывает канал `standby`.
- `docs/{en,ru}/client.md`: `StandbySender` — повторное открытие канала.
- `docs/{en,ru}/configuration.md`: `migration.maxRestoreAgeMs`,
  `standbyReopenDelayMs`, `standbyReopenMaxDelayMs`.

## CHANGELOG

`[Unreleased]` → `### Added`, запись «Standby successor»: бета докладывает
возраст точки, мастер судит о свежести по нему; хост переоткрывает
закрывшийся канал `standby`. Новой записи не заводить.

## Критерии готовности

- Застрявший поток точек больше не выглядит свежим: авария через
  `checkpointMaxAgeMs` после последней настоящей точки идёт в холодный
  старт.
- Prettier, eslint, vitest — зелёные. Release impact: npm `vimp-engine`,
  уточнение `[Unreleased]`.
