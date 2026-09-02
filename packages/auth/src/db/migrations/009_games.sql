-- Роли пользователей (направление master-game-registry, этап 1).
-- Источник истины на этом этапе — переменная окружения VIMP_ADMIN_NICKS,
-- которая при каждом входе синхронизируется в эту колонку. Колонка заведена
-- сразу, чтобы будущее назначение модераторов из интерфейса не требовало
-- новой миграции.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

-- Реестр игр платформы. Один на все мастера (SERVERS_MATRIX), поэтому живёт
-- здесь, а не на мастере: модерация должна быть одна на платформу.
CREATE TABLE IF NOT EXISTS games (
  id                TEXT PRIMARY KEY,
  package_name      TEXT NOT NULL,
  title             TEXT,
  repo_url          TEXT,
  author_user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  version           TEXT,
  pending_version   TEXT,
  max_game_score    INTEGER,
  moderator_note    TEXT,
  moderator_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- имя пакета уникально независимо от регистра: две записи на один npm-пакет
-- означали бы две раздачи одного кода под разными id
CREATE UNIQUE INDEX IF NOT EXISTS games_package_lower_idx
  ON games (lower(package_name));
CREATE INDEX IF NOT EXISTS games_status_idx ON games (status);

-- Перенос уже живущих игр: без seed лобби опустеет между деплоем и первым
-- действием админа. author_user_id = NULL — игры платформы, автора нет.
INSERT INTO games (id, package_name, title, repo_url, status, version)
VALUES
  ('tanks',  '@vimp-games/tanks',  'VIMP Tanks',  'https://github.com/lgick/vimp-tanks',  'approved', '0.16.1'),
  ('snakes', '@vimp-games/snakes', 'VIMP Snakes', 'https://github.com/lgick/vimp-snakes', 'approved', '0.9.1')
ON CONFLICT (id) DO NOTHING;
