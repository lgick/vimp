-- rank-periods: лидерборд за день/месяц считается на лету из леджера
-- (SUM(delta) по окну created_at), а не из кэша ratings — без этого индекса
-- каждый такой запрос шёл бы полным сканом rank_events.
-- voided в предикате индекса: аннулированные события в срез не входят
-- никогда, и держать их в индексе незачем.
CREATE INDEX IF NOT EXISTS rank_events_game_created_idx
  ON rank_events (game_id, created_at DESC)
  WHERE voided = false;
