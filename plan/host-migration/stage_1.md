# Этап 1. Удаление `/like`·`/unlike`, атрибуции хостера и аннулирования

Цель: убрать социальный рейтинг серверов целиком — клиент, мастер,
auth-сервис, БД, доки. Хост теперь динамический, рейтинг «сервера» не имеет
смысла. Этап независим от миграции и делается первым, чтобы следующие этапы
не тащили за собой мёртвый код (`hosterUserId`, `rating`, `offeredHosts`).

Номера строк ниже — на 2026-10-01, перед правкой сверять.

## 1.1. Клиент (`packages/engine/src/client/`)

- `main.js:1220-1257` — убрать перехват `/like`·`/unlike` в `handleChatSend`
  (и все строки-сообщения про голос). Сам `handleChatSend` оставить: этап 10
  добавит туда перехват `/changehost`.
- `main.js:281-283` — `currentHostId` с комментарием про рейтинг; если
  переменная нужна только рейтингу — удалить (этап 2 заведёт `currentRoomId`).
- `network/SignalingClient.js:102-111` — методы `likeHost`/`unlikeHost`,
  комментарий `:62-64`.
- `components/view/Lobby.js:297-314, 326` — бейдж рейтинга;
  `:330-349` — рейтинг как tie-break в `_reorderCard` (оставить сортировку
  по задержке/игрокам без рейтинга).
- `style.css:777-786` — `.lobby-card-rating`.
- Тесты: `tests/client/network/SignalingClient.test.js:170-190`,
  `tests/client/LobbyView.test.js:91, 179-197`.

## 1.2. Мастер (`packages/engine/src/master/`)

- `SignalingServer.js`: опции `jwksProxy`/`hostRatingProxy` (`:29-35`) —
  `jwksProxy` **оставить** (проверка токена в `register_host` нужна дальше:
  этапы 2, 6, 10 опираются на проверенный `userId`); хендлеры
  `like_host`/`unlike_host` (`:54-55`); блок `getRating`/`blocked`/
  `authServiceUnavailable` в `register_host` (`:196-225`), использование
  `rating` (`:259`); `offeredHosts` (`:320`); методы `_onLikeHost`,
  `_onUnlikeHost`, `_vote`, `_evacuateHoster`, `refreshRatings`
  (`:381-503`). `_verifyToken` (`:507-523`) оставить.
- `HostRegistry.js`: комментарий `:39-42`; поле `rating` и связанные методы
  `setRating`, `setRatingForHoster`, `getHostIdsForHoster`,
  `getHosterUserIds` (`:136-199`); `rating` в `_toPublic` (`:302, 312`).
  Поле `hosterUserId` в сессии **оставить** под именем `hostUserId`
  (проверенный `sub` хоста — понадобится этапам 2/6), но убрать его из
  атрибуции записей. `verifiedAttribution` (`:163-170`) переделать: больше не
  возвращает `hosterUserId`, только признак «секрет комнаты верен» — он
  остаётся ключом per-room rate-limit (`lobby.js:516-528`).
- `HostRatingProxy.js` — удалить файл.
- `PlayerDataProxy.js:51-74` — аргумент атрибуции: передавать в auth только
  `session_id` (= id комнаты, сейчас `hostId`), без `hoster_user_id`.
- `lobby.js`: импорт `:34`, конструирование `:145-150`, лог старта
  `:254-256`, опция `:326`, цикл `refreshRatings` `:951-966`; атрибуция в
  `PUT /auth/rank`·`/state` (`:516-528, 545-549, 586-590`) — оставить только
  per-room rate-limit по верному секрету.
- `config/master.js:120-133` — секция `rating` удалить. Проверить, как
  загружается конфиг (`src/lib/config.js`?): если неизвестные ключи
  пользовательского override игнорируются — это `Removed`; если
  отвергаются — `⚠️ Breaking` + `Migration` (см. README → правила).
- `config/closeCodes.js:10` — `blocked: 4002` вывести из оборота:
  удалить ключ, оставить строку-комментарий `// 4002 retired (server
rating removed) — номер не переиспользуется`. Обновить
  `client/network/policyClose.js` (если 4002 там упомянут) и
  `tests/client/network/policyClose.test.js:36-37` (тест требует решения по
  каждому коду карты).
- Тесты: удалить `tests/master/HostRatingProxy.test.js`; вычистить
  `tests/master/HostRegistry.test.js` (`:61-71` hoster attribution → под
  новое имя, `:391-450` rating, `:452-488` verifiedAttribution — переписать
  под новый контракт); `tests/master/SignalingServer.test.js` (моки рейтинга
  `:93-125`, `:317-389` token/blocked — оставить проверку токена, убрать
  blocked; `:670-680`; `:818-1002` like/unlike; `:1004-1075`
  refreshRatings); `tests/master/PlayerDataProxy.test.js:77-131`.

## 1.3. Auth-сервис (`packages/auth/src/`)

- `main.js`: импорты `:26-27`, комментарий `:864`; `readAttribution`
  (`:916-934`, вызовы `:960`, `:1005`) — оставить только чтение
  `session_id`; маршруты `GET /host-rating`, `GET /host-rating/:id`,
  `PUT /host-rating/:id` (`:1010-1063`) — удалить.
- `UserRepository.js`: `getHostRating` `:668-677`, `_recomputeHostRating`
  `:679-715`, `voidHosterContributions` `:717-771`, `voteHost` `:773-799`,
  комментарий `:181` — удалить. В `recordGameResult` (`:326-363`) перестать
  писать `hoster_user_id`. `snapshotState`/`upsertState` (`:634-666`) —
  убрать снапшоты (они существовали только для отката при аннулировании).
  `recomputePeriods`/`recomputeRank` (`:366-401`, `:403-…`) **оставить** —
  это инструменты ручного ремонта (упомянуты в `db/ratingsJob.js`).
  `GAME_DATA_TABLES` (`:183-189`) — убрать `state_snapshots`.
- `lib/validators.js:28-35` — `isValidVoteValue`/`isValidVoteReason` удалить.
- `config/auth.js:179-188` — секция `rating` удалить.
- **БД.** `db/migrate.js` прогоняет **все** `.sql` на каждом старте без
  таблицы версий, поэтому:
  - `migrations/004_host_ratings.sql` — заменить содержимое комментарием
    «retired: таблицы удаляются в 015» (иначе каждый старт создаёт таблицы
    заново);
  - `migrations/003_rank_ledger.sql` — убрать создание `state_snapshots`,
    индекса `rank_events_hoster_idx` и колонку `hoster_user_id` из
    `CREATE TABLE` **и из backfill-`INSERT`** (иначе INSERT упадёт после
    удаления колонки); колонки `session_id` и `voided` оставить (`voided`
    используют индексы `006:8`, `008:58`, `db/ratingsJob.js:34`,
    `UserRepository.js:383,396,418` — теперь всегда `false`, оставить
    комментарий «резерв»);
  - новая `migrations/015_drop_host_rating.sql`:
    `DROP TABLE IF EXISTS host_votes; DROP TABLE IF EXISTS host_ratings;
DROP TABLE IF EXISTS state_snapshots; DROP INDEX IF EXISTS
rank_events_hoster_idx; ALTER TABLE rank_events DROP COLUMN IF EXISTS
hoster_user_id;` — с комментарием-обоснованием.
  - **Безвозвратное удаление данных**: перед выполнением этапа ещё раз явно
    спросить разработчика (по-русски), согласен ли он на DROP в проде.
- Тесты: `tests/auth/UserRepository.test.js:271-312` (снапшоты),
  `:314-612` (host rating, voteHost, void) — удалить;
  `tests/auth/validators.test.js:5-6, 55-79`.

## 1.4. Хост

- `tests/host/PlayerDataSync.test.js:394-441, 495`,
  `tests/lib/createHostRuntime.test.js:80-83` — поправить ожидания, если они
  про атрибуцию хостера (механизм `hostId`/`hostSecret` в теле записи пока
  остаётся — его переименует этап 2).

## 1.5. Документация

Удалить/переписать упоминания рейтинга (en и ru зеркально):
`docs/{en,ru}/master.md` (таблица модулей `:61`, `register_host` `:684`,
таблица клиентских сообщений `:698`, раздел «Server rating» `:708-740`,
«Protection» — 1 room per IP без рейтинга, «Tests»), `network.md:81-84` и
таблица кодов закрытия (4002 → retired), `client.md:76, 183, 187-193, 427`,
`host.md:523`, `configuration.md:387` (секция `rating`), `architecture.md:8`,
`auth.md` (схема `host_ratings`/`host_votes`/`state_snapshots`, маршруты
`/host-rating`, аннулирование). `docs/ai/03-host-plugin.md:322, 588`
(код `4002` в таблице кодов), `08-gameplay-meta.md:101`,
`10-pitfalls.md:301`. Раздел «Protection» в master.md: честно написать, что
защита от читера-хоста теперь — автотриггеры и голосование «Change host»
(появятся в этапах 9–10; до тех пор — «нет»).

## 1.6. CHANGELOG

`packages/engine/CHANGELOG.md` → `## [Unreleased]` → `### Removed`:
«Server rating `/like`·`/unlike` (lobby badge, signaling messages
`like_host`/`unlike_host`, master config `rating`, close code `4002`
retired).» (или `⚠️ Breaking` + `Migration`, если конфиг с ключом `rating`
теперь отвергается — см. 1.2).

## Проверка

```bash
npx prettier --write <изменённые файлы>
npx eslint .
npm test -- --silent
grep -rn "like_host\|unlike_host\|host_rating\|hostRating\|HostRatingProxy\|voidHoster\|state_snapshots\|hoster_user_id" packages tests docs   # пусто (кроме 003/004/015 и retired-комментариев)
```

Ручная (если есть локальный Postgres): `npm run auth:db:migrate` дважды
подряд на чистой и на существующей БД — оба прогона зелёные, таблиц
`host_*`/`state_snapshots` нет.

## Готово, когда

Все проверки зелёные; поиск выше пуст; доки en/ru синхронны; CHANGELOG
обновлён; в отчёте — release impact (npm `vimp-engine`: patch или minor по
подзаголовку; auth-сервис — приватный деплой, порядок выката: сначала
мастер, потом миграция auth, см. этап 11).
