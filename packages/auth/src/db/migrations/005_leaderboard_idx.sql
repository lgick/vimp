-- lobby-page-plan: индекс под ORDER BY rank для GET /leaderboard —
-- без него сортировка топ-N по каждой игре шла бы полным сканом ratings.
CREATE INDEX IF NOT EXISTS ratings_game_rank_idx ON ratings (game_id, rank DESC);
