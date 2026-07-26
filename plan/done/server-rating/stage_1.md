# Этап 1. Модель доверия и атрибуция записей rank/skills (auth) ✅ выполнен

Цель: закрепить, кто и куда пишет в общий профиль, и **привязать каждую
запись rank/skills к серверу и сессии** — без этого этап 4 (аннулирование)
невозможен.

## 1.1. Namespace и формат (контракт)

- `game_id` — namespace. Уже так в схеме (`ratings.game_id`, `states.game_id`).
  Игра A физически не может писать в `game_id` игры B — это гарантирует auth
  по идентичности игры (см. 1.2), а не доверие к хосту.
- **rank** — общий integer-шаблон для всех игр. Валидатор на auth: целое,
  ограниченное диапазоном (напр. `[0..N]`), одинаковый для всех `game_id`.
- **skills** (`state` JSONB) — формат определяет игра; auth не валидирует
  поля, только размер (лимит байт) и то, что это объект.
- Ник/идентичность из JWT — игра их не трогает (уже так: `PUT /rank`·`/state`
  берут `user_id` из `requireAuth`, не из тела).

## 1.2. Авторизация игры на запись (курируемый онбординг)

- Источник разрешённых `game_id` — каталог мастера (`config/master.js › games`
  / `GAMES_MATRIX`). Публичность SDK не даёт права записи: пишет только игра,
  которую вы добавили в каталог.
- **Решено (MVP)**: доверяем мастеру — он валидирует `game_id` в запросе против
  своего каталога (`games`) перед проксированием на auth; отдельный per-game
  серверный ключ на запись — задел на будущее, не в MVP.

## 1.3. Атрибуция записи к серверу (ключевое)

Чтобы этап 4 мог откатить вклад одного сервера, каждая запись должна нести:
- `hoster_user_id` — идентичность хостера сервера (из этапа 2);
- `session_id` — идентификатор серверной сессии (одна «жизнь» комнаты).

### Rank → леджер вместо абсолютного upsert

Сменить модель rank с «абсолютное значение» на **append-only леджер дельт**:

```sql
CREATE TABLE rank_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  hoster_user_id INTEGER,          -- чей сервер (для аннулирования)
  session_id TEXT,                 -- какая серверная сессия
  delta INTEGER NOT NULL,          -- изменение rank за матч
  voided BOOLEAN NOT NULL DEFAULT false,  -- аннулировано баном
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- Актуальный rank = `SUM(delta) WHERE voided = false` для `(user_id, game_id)`.
- `ratings.rank` остаётся как **денормализованный кэш** (быстрый `GET /rank`),
  пересчитывается при вставке события и при аннулировании.
- `PUT /rank` меняет семантику: принимает **дельту матча**, не абсолют (или
  auth сам вычисляет дельту `new-current` и пишет событие). Хост уже шлёт
  результат матча — маппинг уточнить при реализации.

### Skills → снапшот на входе (MVP отката)

`state` JSONB обобщённо необратим. MVP: перед серверной сессией сохранять
снапшот `state` игрока, чтобы этап 4 мог восстановить «как было до сервера»:

```sql
CREATE TABLE state_snapshots (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  hoster_user_id INTEGER,
  state_before JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_id, session_id)
);
```

Компромисс снапшота: если игрок между баненным и честным серверами играл на
третьем, восстановление «до» затрёт честный прогресс. Отметить как известное
ограничение MVP; полноценно решается только обратимыми дельтами от игры
(расширение SDK — вне MVP).

## 1.4. Файлы

- `packages/auth/src/db/migrations/003_rank_ledger.sql` (новый) — `rank_events`,
  `state_snapshots`, бэкофилл `ratings` из текущих значений одним событием.
- `packages/auth/src/UserRepository.js` — `appendRankEvent`, `recomputeRank`,
  `snapshotState`; `upsertRank` → пишет событие + обновляет кэш.
- `packages/auth/src/lib/validators.js` — валидатор диапазона rank и размера
  state.
- `packages/auth/src/main.js` — принять `hosterUserId`/`sessionId` в теле
  `PUT /rank`·`/state` (проброшены мастером).

Смена семантики `PUT /rank` (абсолют → дельта) — breaking change для
единственного текущего вызывающего, поэтому пришлось задеть ещё три файла
вне `packages/auth`, иначе rank-синк сломался бы сразу после мержа:
`packages/engine/src/host/meta/modules/PlayerDataSync.js` (шлёт
`pendingRankDelta`, накопленный с последнего успешного flush, вместо
абсолютного `rank`; вычитает отправленное после `200`, чтобы не терять
`addRank` во время запроса), `packages/engine/src/master/PlayerDataProxy.js`
и `packages/engine/src/master/main.js` (прокидывают `delta` вместо `rank`
транзитом, без бизнес-логики). `hosterUserId`/`sessionId` в тело пока не
добавлены — сервер/сессия появятся в этапе 2.

## 1.5. Тесты (`tests/`, зеркалит `packages/auth/src/`)

- `appendRankEvent` + `recomputeRank`: сумма непогашенных дельт; `voided`
  исключается.
- namespace-изоляция: запись под `game_id=A` не видна в `getRank(...,'B')`.
- rank-валидатор режет выход за диапазон; state-валидатор — превышение размера.
- снапшот `state_before` создаётся один раз на `(user, game, session)`.

## Готово, когда

Записи rank/skills атрибутированы к `(hoster_user_id, session_id)`, rank
считается через непогашенный леджер, снапшот state берётся на входе в сессию;
`npx eslint .` и `npm test` зелёные.
