# Этап 3. Отображение рейтинга сервера в лобби ✅ выполнен

Цель: показать рейтинг сервера в списке лобби (`GET /servers`) и в UI выбора
сервера.

## 3.1. Сервер

- `packages/engine/src/master/HostRegistry.js` — `_toPublic` добавляет поле
  `rating` (текущий `score` хостера из этапа 2). Заблокированные хостеры
  (`blocked`) комнату вообще не поднимают, так что в списке их нет; отдельного
  флага в выдаче не нужно.
- Если хранение центральное (auth) — рейтинг подтягивается при формировании
  списка; закэшировать в сессии `HostRegistry`, чтобы `GET /servers` не ходил
  в БД на каждый запрос (обновлять при голосовании и по таймеру).

## 3.2. Клиент (лобби)

- Модуль/вью списка серверов в `packages/engine/src/client/` — добавить колонку
  рейтинга. Значение уже приходит в объекте сервера (`rating`).
- Рендер: числовой рейтинг в диапазоне (напр. `+7`, `−3`); диапазон известен
  из конфига движка, при желании визуализировать шкалой.
- Игровой плагин рейтинг не рисует — это движковый UI лобби (общий для всех
  игр), значит публичный код движка.

## 3.3. Тесты

- `_toPublic` включает `rating`; служебные поля (`ip`, голоса) наружу не
  утекают.
- `getList` сохраняет `rating` в срезе/поиске/региональной фильтрации.
- Клиентский вью (happy-dom) рендерит рейтинг из данных сервера.

## Готово, когда

Рейтинг виден в списке серверов лобби и корректно проходит через `GET /servers`;
`npx eslint .` и `npm test` зелёные.

## Реализация (2026-07-26)

Master: `HostRegistry` — новое поле `rating` (стартует с `0`), методы
`setRating(hostId, rating)`, `setRatingForHoster(hosterUserId, rating)`,
`getHosterUserIds()`; `_toPublic` отдаёт `rating`. `SignalingServer`:
`register_host` сеет `rating` из уже запрошенного `hostRatingProxy.getRating`
(проверка блокировки), `_vote` сразу пишет `score` голоса в кэш комнаты, новый
метод `refreshRatings()` периодически опрашивает `getPublic` auth-сервиса по
каждому `hosterUserId` активных комнат (ошибка одного хостера логируется и не
прерывает остальных). `main.js` — `setInterval(signaling.refreshRatings,
config.rating.refreshInterval)` (по образцу `sweepStaleHosts`), новый конфиг
`rating.refreshInterval` (30 с).

Auth: `GET /host-rating/:hosterUserId` — публичный (без `requireAuth`)
эндпоинт, отдаёт `{ score, blocked }` — нужен мастеру для `refreshRatings()`,
т.к. он не хранит Bearer-токен конкретного хостера между запросами.
`HostRatingProxy.getPublic(hosterUserId)` — новый метод (без токена);
`_request` научился пропускать заголовок `authorization`, если токена нет.

Client: `LobbyView._appendCard` — новый элемент `.lobby-card-rating`
(`+N`/`-N`/`0`), стиль в `style.css`. `LobbyModel` рейтинг уже прокидывал как
обычное поле сервера — правок не потребовалось.

Тесты: `HostRegistry.test.js` (кэш `rating`, `setRating`/`setRatingForHoster`/
`getHosterUserIds`), `SignalingServer.test.js` (сидирование при регистрации,
обновление при голосе, `refreshRatings` — успех/no-op без прокси/ошибка одного
хостера не рушит остальные), `HostRatingProxy.test.js` (`getPublic` без
Bearer), `LobbyView.test.js` (рендер рейтинга со знаком). `npx eslint .`
чисто, `npm test` — 754/754 зелёных.

Документация обновлена (en+ru): `master.md` (модули, `HostSession`, `GET
/servers`, раздел «Рейтинг сервера», описание тестов), `auth.md` (новый
эндпоинт), `client.md` (карточка лобби), `configuration.md`
(`rating.refreshInterval`).
