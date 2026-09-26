-- Журнал клиентских ошибок (plan/client-reports): строка — отпечаток
-- (sha256 от вида ошибки, сообщения, верхнего кадра и версий), повторы
-- копятся в count. Отпечаток считает бокс, auth его только хранит.
CREATE TABLE IF NOT EXISTS client_reports (
  id             BIGSERIAL PRIMARY KEY,
  fingerprint    CHAR(64)    NOT NULL UNIQUE,
  source         TEXT        NOT NULL,           -- client | host-worker | plugin | box
  kind           TEXT        NOT NULL,           -- error | rejection | worker | warn | csp
  code           TEXT,                           -- только у warn/plugin
  message        TEXT        NOT NULL,
  stack          TEXT,
  details        JSONB,
  engine_version TEXT,
  game_id        TEXT,
  game_version   TEXT,
  box            TEXT,                           -- домен бокса, приславшего первым
  mode           TEXT,                           -- lobby | dedicated | solo
  user_agent     TEXT,
  count          BIGINT      NOT NULL DEFAULT 0,
  first_seen     TIMESTAMPTZ NOT NULL,
  last_seen      TIMESTAMPTZ NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'fixed', 'ignored')),
  status_note    TEXT,
  status_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- users.id — SERIAL
  status_at      TIMESTAMPTZ
);

-- главный запрос панели: «открытые, свежие сверху»
CREATE INDEX IF NOT EXISTS client_reports_status_last_idx
  ON client_reports (status, last_seen DESC, id DESC);

-- фильтр по игре в панели
CREATE INDEX IF NOT EXISTS client_reports_game_idx
  ON client_reports (game_id, last_seen DESC);
