-- server-rating этап 1: rank становится append-only леджером дельт,
-- атрибутированным к серверу (hoster_user_id) и серверной сессии
-- (session_id), чтобы этап 4 мог аннулировать вклад забаненного сервера.
-- ratings.rank остаётся денормализованным кэшем SUM(delta) WHERE NOT voided.
CREATE TABLE IF NOT EXISTS rank_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  hoster_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  session_id TEXT,
  delta INTEGER NOT NULL,
  voided BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rank_events_user_game_idx
  ON rank_events (user_id, game_id);

CREATE INDEX IF NOT EXISTS rank_events_hoster_idx
  ON rank_events (hoster_user_id)
  WHERE hoster_user_id IS NOT NULL;

-- MVP-откат skills: снапшот state на вход в серверную сессию, чтобы
-- аннулирование могло восстановить "как было до сервера". Известное
-- ограничение (см. plan/server-rating/stage_1.md, 1.3): игра на честном
-- сервере между баненными сессиями будет затёрта восстановлением.
CREATE TABLE IF NOT EXISTS state_snapshots (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  hoster_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  state_before JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_id, session_id)
);

-- бэкофилл: текущие ratings.rank становятся стартовым событием леджера.
-- session_id-маркер '__backfill__' и NOT EXISTS делают вставку
-- идемпотентной — migrate.js прогоняет все файлы на каждом старте.
INSERT INTO rank_events (user_id, game_id, hoster_user_id, session_id, delta)
SELECT r.user_id, r.game_id, NULL, '__backfill__', r.rank
FROM ratings r
WHERE r.rank <> 0
  AND NOT EXISTS (
    SELECT 1 FROM rank_events e
    WHERE e.user_id = r.user_id
      AND e.game_id = r.game_id
      AND e.session_id = '__backfill__'
  );
