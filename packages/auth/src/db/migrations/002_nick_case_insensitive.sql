-- F7 кодревью (plan-readme-md-b-zippy-giraffe.md): "Admin" и "admin" не должны
-- быть разными глобальными никами. Добавляет уникальный индекс по lower(nick)
-- поверх существующего UNIQUE(nick) — тот остаётся для быстрого точного поиска,
-- этот ловит различия только в регистре. IF NOT EXISTS — миграции здесь без
-- таблицы версий, файл должен быть повторно безопасным (см. migrate.js)
CREATE UNIQUE INDEX IF NOT EXISTS users_nick_lower_unique_idx ON users (lower(nick));
