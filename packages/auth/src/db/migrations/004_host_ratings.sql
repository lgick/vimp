-- server-rating этап 2 (plan/server-rating/stage_2.md): рейтинг хостера
-- комнаты вместо эфемерной /ban-жалобы по IP. host_votes — текущее мнение
-- каждого голосующего (не леджер: like меняет предыдущий unlike того же
-- голосующего, а не копит обе записи); host_ratings.score — денормализованный
-- кэш SUM(value) по host_votes, клампленный в config.rating.min/max;
-- blocked — score <= config.rating.blockAt (хостеру запрещено создавать
-- комнаты, пока не наберёт голосов обратно выше порога).
CREATE TABLE IF NOT EXISTS host_ratings (
  hoster_user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0,
  blocked BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS host_votes (
  hoster_user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  voter_user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  value SMALLINT NOT NULL,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hoster_user_id, voter_user_id)
);
