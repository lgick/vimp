-- rank — append-only леджер дельт с атрибуцией к комнате (session_id).
-- ratings.rank остаётся денормализованным кэшем SUM(delta) WHERE NOT voided.
-- voided — резерв ручного ремонта (сейчас всегда false; аннулирование вклада
-- хостера удалено вместе с рейтингом серверов). Колонка hoster_user_id,
-- индекс rank_events_hoster_idx и таблица state_snapshots выведены из
-- схемы: на существующих БД их удаляет 015_drop_host_rating.sql.
CREATE TABLE IF NOT EXISTS rank_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  session_id TEXT,
  delta INTEGER NOT NULL,
  voided BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rank_events_user_game_idx
  ON rank_events (user_id, game_id);

-- бэкофилл: текущие ratings.rank становятся стартовым событием леджера.
-- session_id-маркер '__backfill__' и NOT EXISTS делают вставку
-- идемпотентной — migrate.js прогоняет все файлы на каждом старте.
INSERT INTO rank_events (user_id, game_id, session_id, delta)
SELECT r.user_id, r.game_id, '__backfill__', r.rank
FROM ratings r
WHERE r.rank <> 0
  AND NOT EXISTS (
    SELECT 1 FROM rank_events e
    WHERE e.user_id = r.user_id
      AND e.game_id = r.game_id
      AND e.session_id = '__backfill__'
  );
