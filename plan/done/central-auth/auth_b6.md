# B6. Конфиг/деплой/доки (B) ✅ выполнен

- CI/CD (`.github/workflows/deploy.yml`): новая джоба `build_and_push_auth`
  собирает и публикует отдельный образ `ghcr.io/<repo>-auth:latest` из
  `packages/auth/Dockerfile` (обычный Node-образ, без стадий Rust/Vite —
  `@vimp/auth` их не требует) параллельно с образом мастера, на каждый пуш
  в `main`.
- `packages/auth/Dockerfile` — двухстадийная сборка (root-контекст, npm
  workspaces): `builder` ставит зависимости `--workspace=@vimp/auth`,
  `runner` копирует `node_modules` + `packages/auth`; переменные окружения
  и RS256-ключи (`.keys/`) приходят снаружи (`env_file`/volume в
  docker-compose), не запекаются в образ; миграции — отдельный one-off
  (`node src/db/migrate.js`), не гоняются на каждом старте контейнера.
- Деплой джоба мастера (`deploy` в `deploy.yml`) пишет `VIMP_AUTH_SERVICE_URL`
  в `.env.prod` каждого мастера из новой репозиторной переменной
  `AUTH_SERVICE_URL` (задаётся один раз, применяется ко всем серверам из
  `SERVERS_MATRIX`) — `packages/engine/src/master/main.js` уже читал эту
  переменную (Этап B2), не хватало только прокидывания из CI.
- Auth-сервис как singleton-инстанс (в отличие от мастера — по инстансу на
  домен) деплоится вручную тем же Nginx+SSL флоу (`add-server.sh`), но
  двухсервисным docker-compose стеком (auth + postgres) — задокументировано
  в `deployment.md`, автоматизация через `SERVERS_MATRIX` для него не
  подошла бы (это не набор идентичных per-domain реплик).
- CI-тесты (`.github/workflows/test.yml`): джоба `engine` ранее не гоняла
  vitest-проект `auth` вовсе (`npx vitest run --project engine-node
  --project engine-client` не покрывал `tests/auth/`) — добавлен отдельный
  шаг `--project auth` в ту же джобу (чистый Node/Express, Rust/WASM не
  нужен).
- Доки: `docs/{en,ru}/deployment.md` — новый раздел «Central auth service»
  (образ, docker-compose auth+postgres, миграции, `AUTH_SERVICE_URL`);
  `docs/{en,ru}/configuration.md` — `VIMP_AUTH_SERVICE_URL` в таблицу env
  vars; `docs/{en,ru}/auth.md` — статус-баннер обновлён (B1–B6 реализованы).
  `master.md`/`gameplay.md` уже покрывали проксирование `/auth/*` и `/rank`
  с этапов B3–B5, изменений не потребовалось.
- `npx eslint .` и `npx vitest run --project auth --project engine-node
  --project engine-client` — зелёные.

## Критические файлы

- `.github/workflows/deploy.yml` — джоба `build_and_push_auth`, env
  `VIMP_AUTH_SERVICE_URL` в джобе `deploy`.
- `.github/workflows/test.yml` — шаг `--project auth` в джобе `engine`.
- `packages/auth/Dockerfile` (новый).
- `docs/en/deployment.md`, `docs/ru/deployment.md`, `docs/en/configuration.md`,
  `docs/ru/configuration.md`, `docs/en/auth.md`, `docs/ru/auth.md`.

> Игро-специфичные части B (схема state/rank в `game.js`, `/rank`, правка
> `auth.js`) остаются в движковом репозитории до Этапа A3 (вынос репозитория
> игры) — их актуализация в новом репо игры довершает B6 после A3.
