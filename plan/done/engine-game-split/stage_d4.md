# Д4. Робастность хоста и мастера (важно, ~S) ✅ выполнен

## 1. Null-guard'ы HostGame

`updateKeys` (HostGame.js:707), `pushMessage` (:730), `parseVote` (:755),
`mapReady` (:438), `firstShotReady` (:452) читают
`participants.get(gameId)` без проверки. Гонка «кик (RTT/idle) → в полёте
ещё сообщения клиента до `disconnect`» даёт TypeError в Worker'е
(host.worker.js чистит `clients` только на `disconnect`).

**Решение:** ранний `return` при `!user` (по образцу `updateRTT:795`).
Тест на каждый метод с несуществующим gameId.

## 2. Клампы времён комнаты

`applyRoomOverrides` (host.worker.js:73-79): `roundTime`/`mapTime`
принимаются любыми конечными числами; форма лобби пропускает отрицательные
(`Number(x) || default` в master/main.js:1418-1420; `min='1'` в pug — не
серверная граница).

**Решение:** клампы (10 000…3 600 000 мс, константы в `hostDefaults`) +
`Math.floor`; зеркально `min`/`max` в `lobby.pug`.

## 3. GameCatalog

Ключ каталога — `manifest.id`, а статик-маунт (master/main.js:170-172)
строит путь `games/<manifest.id>/dist`, хотя сканируется имя директории —
при dir≠id маунт бьёт мимо. Битый JSON карты валит мастер на старте
(`_readMaps` без try вокруг `JSON.parse`).

**Решение:** пропускать игру с предупреждением при
`manifest.id !== dirname`; try/catch вокруг чтения карты с warn+skip.
Тесты на оба случая.

## Критерий готовности

eslint/тесты зелёные; новые тесты на гварды/клампы/каталог; docs (master,
configuration) при изменении поведения.
