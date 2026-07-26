# Этап 2. `/like`·`/unlike` вместо `/ban` (master + client) ✅ выполнен

Цель: заменить эфемерную жалобу `/ban` на идентичностный рейтинг сервера с
двумя командами и порогом блокировки хостера.

## 2.1. Правила (из README)

- `/like <причина>` — +1 к рейтингу сервера; `/unlike <причина>` — −1.
- Диапазон настраивается в движке, дефолт `[-10..+10]`, единый для всех игр.
- Один голос на пользователя за сервер; мнение меняемо (`like`→`unlike` не
  копит, а переставляет голос). Повторный тот же голос — no-op.
- Достигнут `min` (`blockAt`, дефолт −10) → сервер блокируется, хостеру
  запрещено создавать сервера.
- Достигнут `max` (+10) → выше не растёт.
- Причина обязательна (как у нынешнего `/ban`).

## 2.2. Идентичность хостера и голосующего (решено)

- **Решено**: ключ голоса — `userId` голосующего, субъект рейтинга —
  `hosterUserId` (создатель комнаты). Оба из JWT: регистрация комнаты и голос
  требуют аутентификации. IP-ключ (как сейчас) обходится сменой вкладки/IP и
  для «блокировки хостера» не годится.
- Требует: при регистрации комнаты хост передаёт свой JWT → мастер кладёт
  `hosterUserId` в сессию (`HostRegistry.add`). Голос гостя несёт его JWT.
- Голосуют, как и сейчас, **гости комнаты** (сыграл → оценил), не случайные
  зрители лобби.

## 2.3. Хранение (решено: центрально в БД auth)

- **Решено**: персистентно и глобально — в БД auth (нужно и этапу 4).
  Таблицы:

```sql
CREATE TABLE host_ratings (
  hoster_user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0,
  blocked BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE host_votes (
  hoster_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voter_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value SMALLINT NOT NULL,          -- +1 / -1
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hoster_user_id, voter_user_id)
);
```

`score` = `clamp(SUM(value), min, max)`; `blocked` = `score <= blockAt`.
Альтернатива (эфемерно, per-master) — как сейчас в `HostRegistry`, но тогда
нет глобальной блокировки и персистентности; для выбранной модели не подходит.

## 2.4. Изменения в коде

- `packages/engine/src/config/master.js` — заменить `host.banThreshold`/
  `reportWindowMs` на блок рейтинга:
  ```js
  rating: { min: -10, max: 10, blockAt: -10 }, // движковый диапазон, все игры
  ```
- `packages/engine/src/master/HostRegistry.js`:
  - `add(...)` принимает `hosterUserId`; при регистрации проверяет
    `host_ratings.blocked` → отказ создать комнату.
  - `report()` → `vote(hosterUserId, voterUserId, value, reason)`: upsert
    голоса, пересчёт `score`, clamp по диапазону, выставление `blocked`.
    Возвращает `{ counted, score, blocked }`.
  - Убрать IP-специфику бана (`_bannedIps`) в пользу `host_ratings.blocked`.
- `packages/engine/src/master/SignalingServer.js`:
  - Обработчики двух сообщений вместо одного `report`; на достижении `blockAt`
    закрыть WS хоста (`4002`) и снять комнату из реестра.
  - На входе хоста проверять блокировку хостера (аналог нынешнего `isBanned`).
- `packages/engine/src/master/PlayerDataProxy.js` / `main.js` — проксирование
  голосов на auth (если хранение центральное).
- `packages/engine/src/client/main.js` — перехват `/like`·`/unlike <причина>`
  вместо `/ban`; те же гости-комнаты; сообщения чата обновить.
- `packages/engine/src/client/network/SignalingClient.js` — метод(ы) отправки
  голоса вместо `report`.

## 2.5. Тесты

- `vote`: like→+1, unlike→−1; повтор того же — no-op; смена like→unlike
  переставляет (Δ=−2, не −1).
- clamp по `[min,max]`; на `blockAt` → `blocked=true`.
- заблокированный хостер не может `add()` комнату.
- причина обязательна (пустая — голос не учитывается).
- SignalingServer закрывает WS хоста при достижении `blockAt`.

## Готово, когда

`/like`·/`unlike` заменили `/ban` end-to-end, рейтинг персистентен и
ограничен диапазоном, блокировка хостера работает; `npx eslint .` и `npm test`
зелёные.

## Реализация (2026-07-26)

Auth: миграция `004_host_ratings.sql` (`host_ratings` — денормализованный
score/blocked, `host_votes` — одна строка на пару `(hoster, voter)`, не
леджер, т.к. мнение меняемо); `UserRepository.voteHost`/`getHostRating`
(no-op на неизменный голос, clamp в `config.rating`, признак `blocked`);
`config/auth.js: rating`; валидаторы `isValidVoteValue`/`isValidVoteReason`;
REST `GET /host-rating` (self) и `PUT /host-rating/:hosterUserId` (голос,
запрет self-vote).

Master: `HostRatingProxy` (по образцу `PlayerDataProxy`); `config/master.js:
rating` заменил `host.banThreshold`/`reportWindowMs`; `HostRegistry`
упрощён — убраны `_bannedIps`/`report`/`isBanned`, `add()` принимает
`hosterUserId`; `SignalingServer` — `register_host` требует Bearer
identity-токен (проверяется по JWKS через тот же `verifyIdentityToken`,
каким пользуется Worker хоста) и спрашивает у auth собственный рейтинг
хостера перед созданием комнаты (`blocked` → отказ); `report_host` заменён
на `like_host`/`unlike_host` (проверка `offeredHosts`, обязательная причина,
голос проксируется в auth, `blocked` в ответе закрывает WS хоста кодом
`4002`).

Client: `SignalingClient.registerHost` шлёт `token`, `reportHost` заменён на
`likeHost`/`unlikeHost`; `handleChatSend` перехватывает `/like`·`/unlike
<причина>` вместо `/ban`.

Побочный эффект: обработчики `register_host`/`like_host`/`unlike_host` стали
асинхронными (проверка identity-токена и запрос к auth) — диспетчер
сообщений в `SignalingServer` обёрнут в `Promise.resolve(...).catch(...)`,
чтобы ошибка одного обработчика не роняла остальные.

Тесты: добавлены/переписаны `HostRegistry.test.js`, `SignalingServer.test.js`
(identity-токены подписаны настоящим RSA-ключом через `jsonwebtoken`, как в
`tests/lib/jwt.test.js`), `HostRatingProxy.test.js`, расширены
`UserRepository.test.js`/`validators.test.js`/`SignalingClient.test.js`.
`npx eslint .` чисто, `npm test` — 742/742 зелёных.

Документация обновлена (en+ru): `master.md` (переименован раздел «Соц-
модерация `/ban`» → «Рейтинг сервера»), `auth.md`, `client.md`, `host.md`,
`network.md`, `configuration.md`, `architecture.md` (ASCII-диаграмма),
`README.md`.
