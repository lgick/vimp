# Этап 7. Истечение identity-токена в сценариях миграции ✅ выполнен

Находка: **F10** ([review.md](review.md), раздел F10).
Уровень: 🟠 важно. Критерии: работоспособность, безопасность.

Зависит от этапа 3 (поле `re` в ошибках мастера).

## Согласовано с разработчиком (2026-10-04)

Оба пункта ниже приняты в рекомендованном виде: п.1 — да (7.4 делается),
п.2 — да (только журнал, без UI).

### Исходные вопросы

1. **Проактивная передача.** Хост, у которого до истечения токена
   осталось меньше `migration.tokenHandoffLeadMs` (5 мин) и есть бета,
   один раз начинает плановую передачу «Hand over host» (причина
   `handover`, `stay: true`, с ожиданием границы раунда). Без этого хост с
   истёкшим токеном при любом моргании сигналинга не вернёт комнату
   (`reclaim_host` → `invalidToken`) и закроет её. Рекомендуется: да.
2. **Без нового текста в UI.** Истёкший токен у гостя в работающем матче
   не выбрасывает его и не показывает сообщения: новый системный код
   потребовал бы текстов во всех играх (решение «только кодами»).
   Записывается только в журнал (`diagnostics.warn`). Рекомендуется: да.

Полное решение — тихое продление токена в auth — вне этого плана (D3 в
`review.md`).

## Проблема

Identity-токен живёт 4 часа (`packages/auth/src/config/auth.js:63`,
`expiresIn: '4h'`), продления нет
(`packages/engine/src/client/components/model/LobbyAuth.js`), срок
проверяется везде (`packages/engine/src/lib/jwt.js:71`). Токен из
`localStorage` может истечь через минуту после входа в матч. Новые потоки
предъявляют его посреди матча:

- `client/main.js:4214-4220`: на любой `invalidToken` — `logout()` и
  `leaveRoomWith(...)`. Гость, у которого моргнул сигналинг, получает
  `invalidToken` на `join_room` и **выбрасывается из работающего P2P-матча**;
- бета с истёкшим токеном соглашается на промоушен
  (`client/main.js:2830-2903`), получает `invalidToken` на `register_host`,
  уходит из комнаты; мастер ждёт `promotionTimeoutMs` (10 с) до следующего
  кандидата;
- `memberCaps` (`client/main.js:1957-1967`) объявляет `canHost: true`
  независимо от срока токена — мастер выбирает такую вкладку бетой.

## Решение

### 7.1 Срок токена доступен клиенту

`packages/engine/src/client/components/model/LobbyAuth.js`:
`getTokenExpiresAt()` → `payload.exp * 1000` или `null` (через уже
существующий `decodeJwtPayload`).

`packages/engine/src/client/lib/hostCaps.js`: чистая функция

```js
/**
 * Хватит ли срока токена, чтобы вкладка могла принять роль хоста.
 * @param {number|null} expiresAt - мс эпохи; null — неизвестно (не мешает).
 * @param {number} minLifetimeMs
 * @param {number} [now]
 * @returns {boolean}
 */
export function tokenAllowsHosting(expiresAt, minLifetimeMs, now = Date.now()) {
  return expiresAt === null || expiresAt - now > minLifetimeMs;
}
```

`packages/engine/src/config/lobby.js`, раздел `migration`:
`minTokenLifetimeMs: 600000` (10 мин), `tokenHandoffLeadMs: 300000`
(5 мин).

### 7.2 Вкладка с кончающимся токеном не вызывается в хосты

`client/main.js`:

1. `memberCaps()`: `canHost: canHostCached && tokenAllowsHosting(lobbyAuthModel.getTokenExpiresAt(), lobbyConfig.migration.minTokenLifetimeMs)`.
2. Одноразовый таймер на момент `expiresAt - minTokenLifetimeMs` (ставится
   при входе в комнату и при `authenticated`; снимается при выходе):
   `sendMemberUpdate()` — мастер пересмотрит бету.
3. `handlePromote` (оба режима): если `!tokenAllowsHosting(...)` —
   `signaling.promoteFailed(msg)` и `return` до любой подготовки.
4. `promoteCold` (строки 3963-3989): та же проверка до `connectAsHost`;
   отказ → `signaling.promoteFailed(pending)` и обычный вход гостем
   (`return false`).

### 7.3 Решение по `invalidToken` — с учётом запроса

Расширить `packages/engine/src/client/lib/signalingErrors.js` (этап 3):

```js
/**
 * @returns {'abandonPromotion'|'keepPlaying'|'logoutAndLeave'|'logout'}
 */
export function decideInvalidToken({ msg, promoting, inRoom, sessionState }) {
  if (msg.re === 'register_host' && promoting) return 'abandonPromotion';
  // гость в живом матче: токен нужен мастеру, а не P2P-соединению с хостом
  if (msg.re === 'join_room' && inRoom && sessionState !== 'closed') return 'keepPlaying';
  return inRoom ? 'logoutAndLeave' : 'logout';
}
```

`client/main.js` `handleSignalingError`, `case 'invalidToken'`:

- `abandonPromotion` → `abandonPromotion({ code, report: true })` без
  выхода из аккаунта;
- `keepPlaying` → `diagnostics.warn('engine.session.tokenExpired', { re: msg.re }, { source: 'client' })`,
  `joinRetry.stop()` (этап 6); ни `logout`, ни выхода из комнаты;
- `logoutAndLeave` / `logout` — нынешнее поведение.

### 7.4 Проактивная передача хоста (если подтверждено)

`client/main.js`: таймер на `expiresAt - tokenHandoffLeadMs`, заводится в
`adoptHostRole` и снимается в `teardownHostRole`. На срабатывании — если
вкладка всё ещё хост и `hostSuccessorMemberId !== null` —
`startPlannedHandoff({ reason: 'handover', stay: true, defer: true })`.
Если беты нет — ничего (повторно не взводить).

## Тесты (сначала падающие)

- `tests/client/LobbyAuthModel.test.js`: `getTokenExpiresAt` для токена с
  `exp`, без `exp`, без токена.
- `tests/client/lib/hostCaps.test.js`: `tokenAllowsHosting` — граница,
  `null`.
- `tests/client/lib/signalingErrors.test.js`: все ветки
  `decideInvalidToken`.

`main.js` юнит-тестами не покрыт — ручная проверка: токен с коротким `exp`
(dev-логин, если умеет задавать срок, или подмена `exp` в dev через
`localStorage`) → вкладка не становится бетой; моргание сигналинга гостя
с истёкшим токеном не выбрасывает его из матча.

## Документация (en и ru одинаково)

- `docs/{en,ru}/client.md`: срок токена и роль хоста (`canHost`,
  отказ от промоушена, проактивная передача), обработка `invalidToken` по
  `re`.
- `docs/{en,ru}/configuration.md`: `migration.minTokenLifetimeMs`,
  `migration.tokenHandoffLeadMs`.
- `docs/{en,ru}/auth.md`: в разделе о сроке identity-токена — одна фраза о
  том, как клиент лобби учитывает срок в миграции хоста.

## CHANGELOG

`[Unreleased]` → `### Added`, запись о миграции хоста: вкладка, чей вход
скоро истечёт, не принимает роль хоста (а хост заранее передаёт её);
истёкший вход не выбрасывает гостя из работающего матча. Новой записи не
заводить.

## Критерии готовности

- Бета с истекающим токеном не выбирается (мастер получает
  `canHost: false`) и не соглашается на промоушен.
- `invalidToken` на `join_room` не прерывает матч.
- Prettier, eslint, vitest — зелёные. Release impact: npm `vimp-engine`,
  уточнение `[Unreleased]`; auth не меняется.
