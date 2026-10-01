-- Рейтинг серверов (/like·/unlike) удалён вместе с аннулированием вклада
-- хостера (plan/host-migration, этап 1): хост теперь динамический, «рейтинг
-- сервера» смысла не имеет. migrate.js прогоняет все файлы на каждом старте,
-- поэтому всё — IF EXISTS. Данные удаляются безвозвратно (согласовано с
-- разработчиком). state_snapshots существовали только для отката при
-- аннулировании; voided в rank_events остаётся (резерв, всегда false).
DROP TABLE IF EXISTS host_votes;
DROP TABLE IF EXISTS host_ratings;
DROP TABLE IF EXISTS state_snapshots;
DROP INDEX IF EXISTS rank_events_hoster_idx;
ALTER TABLE rank_events DROP COLUMN IF EXISTS hoster_user_id;
