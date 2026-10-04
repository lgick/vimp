# Этап 14. Декомпозиция `client/main.js` (необязательный, крупный)

Находка: **F19** ([review.md](review.md), раздел F19).
Уровень: 🟡 качество. Критерии: тестируемость, поддерживаемость,
читаемость.

## ⚠️ Только по отдельному решению разработчика

Этап — чистый рефакторинг без изменения поведения, но объёмный (сотни
строк переезжают). Начинать, только если разработчик подтвердил. Делать
после этапов 1–13 (они правят те же места `main.js`).

## Проблема

`packages/engine/src/client/main.js` — 4316 строк (+2185 в задаче
host-migration). В модуле живут роль хоста, роль беты, промоушен,
плановая передача, роутинг ссылок, голосование «Change host» и около 40
изменяемых переменных модуля (`hostController`, `hostConnections`,
`hostRoom`, `hostPromotion`, `promotionInFlight`, `standbyRole`,
`standbyReceiver`, `hostPrewarm`, `currentRoomId`, `roomEpoch`, …).
Модуль исполняется при импорте и не покрыт юнит-тестами: ошибки F2, F4,
F9 этого ревью сидели именно в его связках.

## Цель

Вынести сценарии в модули с инъекцией зависимостей (сигналинг,
супервизор, фабрики контроллеров, конфиг, DOM-колбэки) и покрыть их
тестами. `main.js` остаётся сборщиком: создаёт модули и связывает их.

## Подэтапы (каждый — отдельный зелёный прогон, поведение не меняется)

### 14.1 `client/session/StandbyRole.js`

Переезжает: `ensureStandbyReceiver`, `onStandbyCheckpoint`,
`startStandbyDuties`, `reportStandbyStatus`, `teardownStandby`,
подписки `standby_assigned` / `standby_released` (`client/main.js`
~1949-2101). Состояние: `standbyRole`, `standbyReceiver`, `hostPrewarm`,
`standbyStatusTimer`. Зависимости: `signaling`, `prepareRoom`,
`diagnostics`, `config.migration`, `isHost()`, `currentRoomId()`.
Тесты `tests/client/session/StandbyRole.test.js`: назначение → приём
точки → статус; смена эпохи → сброс; освобождение.

### 14.2 `client/session/HostRole.js`

Переезжает: `adoptHostRole`, `startHostRegistration`, `teardownHostRole`,
`handleHostLobbyInfo`, `refreshHostMaps`, `refreshHostWorker`,
`codeVersionKey`/`codeVersionChanged`, подписки `host_registered`,
`probe`, `update_available`, `successor_assigned` (`client/main.js`
~2347-2502, 2504-2575, 3059-3198). Состояние: `hostController`,
`hostConnections`, `hostHeartbeat`, `hostRoom`, `hostRoomConfig`,
`hostLobbyInfo`, `hostPromotion`, `hostMapsVersion`, `hostCodeVersion`,
`failedCodeVersion`, `workerSwapInProgress`, `hostRegistration`.
Тесты: регистрация → `host_registered` → `setRoom`; reclaim при
реконнекте; `roomTaken` → новая регистрация; смена кода → эстафета.

### 14.3 `client/session/PromotionFlow.js`

Переезжает: `handlePromote`, `cancelPromotion`, `abandonPromotion`,
`finishPromotion`, `handleOwnPlayerLost`, `demoteHost`, подписки
`promote`, `promote_cancelled`, `host_revoked` (`client/main.js`
~2828-3020). Тесты: planned → `holdSession` и финальная точка (этап 2);
checkpoint → регистрация → возврат своего игрока; отмена; `staleEpoch`
→ разжалование.

### 14.4 `client/session/HandoffFlow.js`

Переезжает: `startPlannedHandoff`, `handleHandoffFrozen`,
`handleHandoffAborted`, `handleHostReleased`, `leaveServerByUser`,
`announceGuestLeave`, `leaveServer`, подписки `request_handoff`,
`host_released`, создание `PlannedHandoff` и `HostHealthPolicy`
(`client/main.js` ~2603-2826). Тесты: «Hand over host», «Leave server»
один и с людьми (этап 10), `request_handoff` vote/network, вытеснение
эстафеты (этап 8).

### 14.5 `client/session/RouteBoot.js`

Переезжает: `runRoute`, `bootRoute`, `quickPlay`, `findQuickPlayRoom`,
`waitRoomOnline`, `pollRoom`, `fetchRoom`, `takeRoutePromotion`,
`promoteCold`, `handleHashChange`, `showLobby`, `activateRouteGame`,
`joinFromRoute` (`client/main.js` ~3726-4052). Тесты: каждая ветка
`decideRouteAction`, ожидание мигрирующей комнаты, смена hash во время
ожидания, холодный промоушен из `sessionStorage`.

### 14.6 `client/session/GuestSession.js`

Переезжает: `connectToRoom`, `guestReconnect`, `openRoomTransport`,
`roomEpoch`, обработчики `host_migrating`, `host_changed`, `room_closed`,
`welcome` (часть гостя), `handleSignalingError` (как сборщик решений из
`client/lib/signalingErrors.js`), `memberJoined` / `JoinRetry` (этап 6).
Тесты: сценарии F4 и F9 целиком на фейковом сигналинге и транспорте.

## Правила этапа

- Ни одного изменения поведения: тексты, порядок сообщений, тайминги —
  как были. Любое расхождение, найденное при переносе, — отдельный
  вопрос разработчику, не «попутная правка».
- Модули — без импорта `main.js` и без глобального DOM (DOM-действия —
  колбэками владельца).
- `docs/{en,ru}/client.md`: раздел о структуре клиента — новые модули
  `client/session/*` и что в них живёт. `docs/{en,ru}/architecture.md` —
  если там перечислены модули клиента.

## CHANGELOG

Нет: рефакторинг — не запись.

## Критерии готовности

- `client/main.js` не содержит логики сценариев миграции — только
  создание модулей и связывание.
- У каждого модуля `client/session/*` есть тесты основных сценариев.
- Prettier, eslint, vitest — зелёные. Release impact: npm `vimp-engine`,
  без записи в changelog.
