-- Контекст отчёта (plan/client-reports-review): роль вкладки и страница.
-- Как box/mode/user_agent — «первый прислал», в отпечаток не входят
ALTER TABLE client_reports ADD COLUMN IF NOT EXISTS role TEXT;  -- client | host
ALTER TABLE client_reports ADD COLUMN IF NOT EXISTS page TEXT;  -- pathname страницы, ≤ 128
