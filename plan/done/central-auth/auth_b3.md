# B3. Проброс токена в игру + верификация хостом ✅ выполнен

- **Клиент** прикладывает JWT к входу в игру: в `webrtc_offer`
  (`client/network/SignalingClient.js` / `WebRtcManager`) и/или в payload
  `AUTH_RESPONSE` (`client/main.js`, обработчик `PC_AUTH_RESPONSE`).
- **Хост** (точка верификации): `packages/engine/src/host/host.worker.js`
  (порт 1, где сейчас `validateAuth` + `host.createUser`) — вместо доверия
  свободному вводу проверяет подпись JWT по публичному ключу мастера
  (`/auth/jwks`, мастер проксирует ключ auth-сервиса) и берёт ник из claim.
  `HostGame.createUser` / `ParticipantManager.createHuman`
  (`meta/player/ParticipantManager.js`) используют проверенный ник; пер-комнатный
  дедуп `checkName` больше не нужен для людей (ник уже глобально уникален), но
  остаётся для scripted-участников.
- Игровая `authSchema` (`games/tanks/src/config/auth.js`) теряет поле `name` как
  вводимое (ник приходит из токена); остаётся выбор `model` и прочие
  игро-специфичные поля.

## Критические файлы

`packages/engine/src/host/host.worker.js` + `HostGame.js` +
`meta/player/ParticipantManager.js` (верификация, ник из токена);
`packages/engine/src/master/main.js` + `SignalingServer.js` (проксирование `/jwks`);
`games/tanks/src/config/auth.js` (убрать ввод name).

## Предусловие

B2 (клиент должен уже нести JWT).

## Реализация (как сделано)

- Токен пробрасывается только через `AUTH_RESPONSE` (`client/main.js`:
  `sending(PC_AUTH_RESPONSE, { ...data, token: lobbyAuthModel.getToken() })`) —
  вариант с `webrtc_offer`/`SignalingServer` не понадобился, доп. изменений в
  сигналинге нет.
- `packages/engine/src/lib/jwt.js`: `verifyIdentityToken(token, { jwks, issuer })` —
  проверка RS256 через Web Crypto (`crypto.subtle`), без JWT-библиотеки в
  движке (работает в браузере, Worker'е и в Node ≥19 одинаково).
- `packages/engine/src/master/JwksProxy.js` (новый) + роут `GET /auth/jwks` в
  `main.js` — проксирует и кэширует (TTL 10 мин) `/jwks` auth-сервиса под
  origin мастера.
- `packages/engine/src/host/host.worker.js`: порт 1 фетчит/кэширует JWKS
  (`config/lobby.js` → `auth.jwksUrl`), проверяет токен, берёт `nick` из
  payload, зовёт `host.createUser({ ...data, name: nick }, ...)`. `HostGame`/
  `ParticipantManager` не менялись — `checkName`-дедуп оставлен как есть
  (защитный фолбэк, не критично для корректности).
- `authClientConfig.issuer` (`config/authClient.js`) — должен совпадать с
  `packages/auth`'s `config.jwt.issuer` (`'vimp-auth'`).
- `games/tanks/src/config/auth.js` и тестовая фикстура
  `packages/engine/tests/fixtures/miniGame/config/auth.js` — поле `name`
  убрано из `params`.
- Тесты: `tests/lib/jwt.test.js` (`verifyIdentityToken`), новый
  `tests/master/JwksProxy.test.js`. Существующие host/participant тесты не
  потребовали изменений (сигнатуры `createUser`/`createHuman` не менялись).
- Доки обновлены: `docs/{en,ru}/auth.md`, `master.md`, `host.md`,
  `client.md`, `network.md`.
