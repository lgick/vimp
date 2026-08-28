-- Агрегат срезов рейтинга: одна строка на (игрок, игра, окно) вместо свёртки
-- всего леджера на каждый запрос.
--
-- ***** ЗАЧЕМ *****
--
-- До этой миграции дневной и месячный срезы считались на лету:
--   GROUP BY user_id ПО ВСЕМ событиям игры за окно.
-- На целевом масштабе (100 игр × 100 серверов × 8 игроков = 80 000 игроков)
-- одна игра пишет порядка 8 000 результатов в минуту, то есть ~500 000 строк
-- леджера за сутки. Каждый запрос места игрока сворачивал их целиком — а
-- место спрашивается на каждый вход участника.
--
-- Агрегат схлопывает эти полмиллиона строк до ЧИСЛА ИГРОКОВ: 8 000 строк на
-- (игру, сутки). Два порядка на самом дорогом запросе схемы, и запрос
-- становится диапазонным сканом индекса вместо сортировки хеш-агрегата.
--
-- Леджер rank_events при этом остаётся источником истины: он хранит
-- атрибуцию (какой сервер начислил) и нужен для аннулирования вклада
-- забаненного хостера. Агрегат — производная от него и всегда пересчитывается
-- из него (UserRepository.recomputePeriods).
--
--   kind   'd' — сутки UTC, 'm' — календарный месяц UTC;
--   period  начало окна;
--   best    лучшая ОДИНОЧНАЯ игра в окне (дневной рейтинг);
--   points  сумма очков всех игр окна (месячный рейтинг).
CREATE TABLE IF NOT EXISTS rank_periods (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  kind CHAR(1) NOT NULL,
  period DATE NOT NULL,
  best INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, game_id, kind, period)
);

-- по одному частичному индексу на срез: он же обслуживает и топ (ORDER BY
-- DESC LIMIT), и место (COUNT(*) WHERE > моего) — оба запроса читают ровно
-- один диапазон (game_id, period) в нужном порядке
CREATE INDEX IF NOT EXISTS rank_periods_day_idx
  ON rank_periods (game_id, period, best DESC)
  WHERE kind = 'd';

CREATE INDEX IF NOT EXISTS rank_periods_month_idx
  ON rank_periods (game_id, period, points DESC)
  WHERE kind = 'm';

-- Бэкофилл из леджера. Идемпотентен ПО ПОСТРОЕНИЮ, а не по WHERE: значение
-- пересчитывается из rank_events целиком и присваивается, а не прибавляется,
-- поэтому повторный прогон (migrate.js гоняет все файлы каждый раз, журнала
-- версий нет) даёт тот же результат. Это же свойство делает файл безопасным
-- средством ручного ремонта агрегата.
INSERT INTO rank_periods (user_id, game_id, kind, period, best, points)
SELECT e.user_id, e.game_id, k.kind,
       date_trunc(k.unit, e.created_at AT TIME ZONE 'utc')::date,
       MAX(e.best), SUM(e.delta)
FROM rank_events e
CROSS JOIN (VALUES ('d', 'day'), ('m', 'month')) AS k(kind, unit)
WHERE e.voided = false
GROUP BY e.user_id, e.game_id, k.kind, k.unit,
         date_trunc(k.unit, e.created_at AT TIME ZONE 'utc')
ON CONFLICT (user_id, game_id, kind, period)
DO UPDATE SET best = EXCLUDED.best, points = EXCLUDED.points;
