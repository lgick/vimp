# Развертывание

Гайд по подготовке чистого VPS, настройке окружения и запуску **мастер-сервера** (лобби + сигналинг; матчи исполняют браузерные хосты, серверных игровых инстансов нет) через CI/CD GitHub Actions. Скрипты установки лежат в [.github/deployment/](../../.github/deployment/).

**Как это работает**: пуш в `main` → [.github/workflows/deploy.yml](../../.github/workflows/deploy.yml) собирает Docker-образ и публикует его в GHCR → по SSH заходит на каждый сервер из `SERVERS_MATRIX`, генерирует `.env` и перезапускает контейнер `vimp-<domain>`. На VPS Nginx терминирует HTTPS и проксирует на порт приложения (внутри контейнера мастер слушает `3002`).

> **Rust-тулчейн больше не нужен.** После переезда игры-плагина (`@vimp-games/tanks`) в отдельный репозиторий (Этап A3) [Dockerfile](../../Dockerfile) больше не собирает WASM-ядро — это делает собственный CI репозитория игры, публикующий пакет. Node-стадия просто выполняет `npm ci` (ставит `@vimp-games/tanks` из registry, что приносит уже собранный `dist/` — client/host-точки входа, WASM-ассет, карты, звуки, `manifest.json`), а следом `npm run build:app` (Vite-сборка движка). Runner-стадия копирует `packages/engine/dist/` и `node_modules/@vimp-games/tanks/dist/`; мастер читает плагин только через `GameCatalog` (`dist/manifest.json` + `dist/maps/*.json`) и отвергает его при загрузке, если `engineApi` не совпадает с `ENGINE_API_VERSION` этой сборки движка — исходный код игры он никогда не импортирует.

## 📋 Предварительные требования

1. **VPS** с ОС Ubuntu 20.04, 22.04 или 24.04.
2. **Доменное имя**, привязанное к IP вашего сервера.
3. **SSH-доступ** к серверу (желательно с правами sudo).
4. Локально установленный **Git** и клонированный репозиторий проекта.

## Шаг 1: DNS (настройка домена)

Перед настройкой сервера создайте **A-запись** у регистратора домена:

- **Тип:** `A`
- **Имя (Host):** `game` (например, для game.example.com)
- **Значение (Value):** `IP_ВАШЕГО_СЕРВЕРА`

## Шаг 2: Первичная настройка системы (один раз)

Выполняется **один раз** на новом сервере. Скрипт установит Nginx, Docker, Fail2Ban и настроит Firewall.

1. Загрузите скрипты на сервер:

   ```bash
   scp .github/deployment/*.sh root@IP_ВАШЕГО_СЕРВЕРА:~/vimp-deployment-scripts/
   ```

2. Зайдите по SSH и сделайте скрипты исполняемыми:

   ```bash
   ssh root@IP_ВАШЕГО_СЕРВЕРА

   cd ~/vimp-deployment-scripts
   chmod +x *.sh
   ```

3. Подготовка VPS:

   ```bash
   ./install-system.sh
   ```

**Что произойдёт:**

- установятся необходимые пакеты;
- откроются порты (скрипт спросит подтверждение);
- создастся корневая папка проектов `~/vimp_projects`;
- сгенерируются ключи безопасности Nginx.

## Шаг 3: Добавление мастер-сервера

Выполняется, когда нужно поднять инстанс мастера на новом домене (например, `game.example.com`).

1. На сервере запустите:

   ```bash
   cd ~/vimp-deployment-scripts
   ./add-server.sh
   ```

2. Следуйте мастеру установки:
   - введите **домен** (например `game.example.com`);
   - введите **порт** (например `3005`) — **запомните его**;
   - введите email (для уведомлений SSL);
   - ответьте, является ли этот домен **самим central auth-сервисом**; если
     нет (домен мастера) — введите **URL auth-сервиса** (например
     `https://auth.example.com`) — обязателен, нужен для `connect-src` в CSP,
     чтобы браузер лобби мог сделать fetch `POST /nick` (см.
     «🔒 Security-заголовки и CSP» ниже). **Сначала разверните и добавьте
     домен auth-сервиса** — без рабочего auth-URL домен мастера добавить
     нельзя.
   - если ответ «да» (это домен auth-сервиса), скрипт дальше сам поднимет
     весь auth-стек (см. «Central auth-сервис» ниже); заранее подготовьте
     **GitHub OAuth App** (github.com/settings/developers) с callback URL
     `https://<домен>/oauth/github/callback`, и держите под рукой его
     Client ID/Secret, а также логин + PAT (`read:packages`) для GHCR —
     свежеопубликованный GHCR-пакет по умолчанию **приватный**, так что
     заранее либо сделайте его публичным (Package settings → Change
     visibility → Public), либо держите PAT под рукой.

**Результат:**

- создана папка проекта `~/vimp_projects/game.example.com`;
- получен SSL-сертификат (Let's Encrypt);
- настроен Nginx (HTTPS-проксирование на указанный порт).

> ⚠️ Сервер настроен, но **пустой** — игра не запустится, пока не выполнен следующий шаг.

## Шаг 4: Конфигурация и запуск (CI/CD)

Список серверов настраивается через переменные GitHub-репозитория.

1. Откройте **Settings → Secrets and variables → Actions → вкладка Variables**.
2. Создайте (или отредактируйте) переменную `SERVERS_MATRIX`:

   ```json
   [
     {
       "ip": "IP_ВАШЕГО_СЕРВЕРА",
       "domain": "game.example.com",
       "port": 3005
     }
   ]
   ```

   _(`domain` и `port` должны строго совпадать с указанными на Шаге 3. Игровые параметры в матрице не задаются: комнаты настраивают их создатели в лобби — см. [configuration.md](configuration.md#переменные-окружения-env))._

3. На вкладке **Secrets** должны существовать секреты для SSH-доступа деплоя: `SERVER_USER` (пользователь VPS) и `SERVER_SSH_KEY` (приватный ключ).
4. Перейдите во вкладку **Actions** и перезапустите пайплайн вручную (Re-run jobs) либо сделайте `git push` в ветку `main` — система задеплоит мастер на все серверы из списка.

## Central auth-сервис (`packages/auth`)

Вход в лобби, ник, rank и state ([auth.md](auth.md)) требуют, чтобы
`@vimp/auth` работал как отдельный долгоживущий сервис с PostgreSQL. В
отличие от мастера (по инстансу на домен в `SERVERS_MATRIX`), это обычно
один общий инстанс, на который смотрят все домены мастеров.

- **Образ.** Джоба `build_and_push_auth` из `deploy.yml` собирает и
  публикует второй образ, `ghcr.io/<repo>-auth:latest`, из
  [packages/auth/Dockerfile](../../packages/auth/Dockerfile) при каждом
  пуше в `main` — обычный Node-образ, без стадий Rust/Vite.
- **Хостинг полностью автоматизирован `add-server.sh`.** Заранее
  подготовьте только то, что нельзя сделать на VPS: **GitHub OAuth App**
  (github.com/settings/developers) с Homepage URL `https://<домен>` и
  Authorization callback URL `https://<домен>/oauth/github/callback`.
  Затем выполните Шаги 2–3 выше (`install-system.sh`, затем
  `add-server.sh`) и ответьте «да» на вопрос «этот домен — сам central
  auth-сервис?». Скрипт:
  - спросит origin'ы мастеров, которым разрешён доступ (CSV,
    `VIMP_AUTH_ALLOWED_ORIGINS`), Client ID/Secret OAuth, имя образа
    (по умолчанию `ghcr.io/lgick/vimp-auth`) и опционально логин + PAT для
    GHCR (`read:packages`; можно оставить пустым, если образ публичный —
    учтите, что свежеопубликованный пакет по умолчанию **приватный**, пока
    его не переключат в Public в настройках пакета на GitHub);
  - сгенерирует пару RS256-ключей в `./.keys/` (один раз — переиспользуется
    при повторных запусках), запишет `.env.prod` (`VIMP_AUTH_PUBLIC_URL`,
    `VIMP_AUTH_ALLOWED_ORIGINS`, `VIMP_AUTH_STATE_SECRET`,
    `VIMP_AUTH_GITHUB_CLIENT_ID`/`_SECRET`, `VIMP_AUTH_DATABASE_URL`) и
    docker-compose стек из двух сервисов (`postgres` + `auth`, по форме
    похож на одиночный контейнер мастера, но с соседом Postgres) в
    `~/vimp_projects/<домен>/`;
  - при наличии логина/PAT войдёт в GHCR (иначе сначала выйдет — чтобы
    сбросить устаревшие креды перед анонимным pull), затем выполнит
    `docker compose pull`; если pull не удался (обычно потому, что
    GHCR-пакет ещё приватный), предложит ввести логин/PAT и повторит в
    этом же запуске (без перезапуска всего скрипта), до 3 попыток, затем
    `docker compose up -d`;
  - прогонит миграции (`docker compose exec auth node src/db/migrate.js`,
    с повторами до готовности Postgres) и проверит `GET /jwks` на 200.
  - **При повторном запуске на том же auth-домене** предложит выбор:
    `1) обновить образ` (сохранить БД, RS256-ключи и секреты, просто
    перекачать и перезапустить) или `2) пересоздать`
    (`docker compose down -v` — сотрёт БД и ключи, требует ввести `yes`
    для подтверждения).
- **Миграции** теперь прогоняются автоматически как часть шага выше.
  Чтобы повторить вручную (например, после ручного изменения схемы):
  `docker compose exec auth node src/db/migrate.js` из
  `~/vimp_projects/<домен>/`.
- **Добавление мастера позже.** `VIMP_AUTH_ALLOWED_ORIGINS` задаётся
  только тем, что было введено при создании/пересоздании auth-стека —
  чтобы добавить новый домен мастера позже, отредактируйте её вручную в
  `~/vimp_projects/<auth-домен>/.env.prod` и выполните там `docker compose
  up -d --force-recreate auth` — `env_file` перечитывается только при
  создании контейнера, поэтому обычный `restart` молча оставит старое
  значение.
- **Привязка мастеров.** Задайте переменную репозитория
  `AUTH_SERVICE_URL` (Settings → Secrets and variables → Actions →
  Variables) публичным URL auth-сервиса; джоба `deploy` из `deploy.yml`
  прописывает её в `.env.prod` каждого мастера как
  `VIMP_AUTH_SERVICE_URL` (читается в
  [packages/engine/src/master/main.js](../../packages/engine/src/master/main.js),
  см. [configuration.md](configuration.md#переменные-окружения-env)) —
  одна переменная применяется ко всем серверам из `SERVERS_MATRIX`. Та же
  переменная передаётся и как build-arg `VITE_AUTH_SERVICE_URL` в джобе
  `build_and_push` (клиентский бандл получает её ещё на этапе сборки общего
  образа в `Dockerfile`, не в джобе `deploy` для конкретного сервера), так
  что задать её нужно до первого деплоя — иначе клиент откатывается на
  dev-дефолт (`http://localhost:3010`) и кнопка «Sign in» ломается в
  проде — см. [configuration.md](configuration.md#переменные-окружения-env)
  и [auth.md](auth.md#вход-в-лобби-клиент).

## 🔒 Security-заголовки и CSP

Гигиена среды: отсекает «уличных» злоумышленников — не хоста-читера: он физически исполняет симуляцию у себя в процессе, и WASM-память доступна ему из JS в обход логики ядра, этого CSP не предотвращает. В проде клиентскую статику и `.wasm` отдаёт **Nginx**, поэтому авторитетная точка Content-Security-Policy — заголовок Nginx в `server`-блоке домена. Единый source of truth политики — [packages/engine/src/config/master.js](../../packages/engine/src/config/master.js) (`security.csp`, функция от `authServiceUrl` — см. [auth.md](auth.md#вход-в-лобби-клиент)); мастер ставит её на свои ответы, но HTML/`.wasm` идут через Nginx.

Шаблон `install-system.sh` содержит `connect-src` с плейсхолдером `__AUTH_SERVICE_URL__`, который `add-server.sh` подставляет по ответу на вопрос «URL central auth-сервиса» (Шаг 3 выше) — для доменов мастера отвечайте реальным доменом auth-сервиса, иначе браузер лобби блокирует `fetch POST /nick` этой же CSP (`Refused to connect ... violates Content Security Policy`). Если установленный ранее шаблон ещё без этого плейсхолдера, `add-server.sh` прервётся и попросит сначала перезапустить `install-system.sh`. При ручной правке добавьте в Nginx `server`-блок (или в общий `snippet`):

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header X-Frame-Options "DENY" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' wss: data: https://auth.example.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;
```

Ключевые директивы: `script-src ... 'wasm-unsafe-eval'` (компиляция WASM-ядра в браузере), `worker-src 'self' blob:` (Web Worker хоста), `connect-src 'self' wss: data: https://auth.example.com` (сигнальный WebSocket мастера; `data:` — PixiJS проверяет поддержку `ImageBitmap` фетчем тестового `data:`-URL; `https://auth.example.com` — заменить на реальный домен central auth-сервиса, нужен для fetch `POST /nick` лобби, см. [auth.md](auth.md#вход-в-лобби-клиент); WebRTC data channels CSP не гейтит). В **dev** CSP не применяется — ViteExpress + HMR требуют `'unsafe-inline'` и HMR-WebSocket.

CSP сознательно не даёт `'unsafe-eval'` — PixiJS без него бросает `Current environment does not allow unsafe-eval`, поэтому `packages/engine/src/client/main.js` подключает `pixi.js/unsafe-eval` (до создания `Application`) — это переключает PixiJS на safe-eval путь без ослабления политики.

Минификация JS-оболочки — штатная у `vite build`. Усиленная обфускация осознанно вне scope: против хоста-читера она бесполезна.

## 🛠 Обслуживание и удаление

### Изменение настроек серверов

Отредактируйте `SERVERS_MATRIX` в настройках GitHub и запустите Action заново.

### Обновление игры

Просто `git push` в ветку `main` — GitHub Actions автоматически обновит все серверы из `SERVERS_MATRIX`. Клиентская статика и WASM-ядро внутри образа. Уже открытые комнаты подхватывают новую версию кода сами (эстафета Worker'ов): рестарт мастера рвёт сигнальные WS хостов → reconnect → re-register приносит новый `codeVersion` → вкладка хоста скачивает новый worker-бандл (`GET /worker/manifest.json`) и на ближайшей границе раунда заменяет Worker без разрыва P2P-соединений (счёт и участники переносятся, клиенты видят обычный старт раунда). Страницы клиентов при этом остаются старой сборки до перезагрузки — протокол клиент↔хост при деплое должен оставаться совместимым (несовместимый бинарный кадр клиент отбрасывает по версии формата). Детали — [host.md](host.md#эстафета-workerов).

### Удаление сервера

На VPS используйте `./delete-server.sh` — удалит конфиги Nginx, папку проекта и остановит контейнер.

> ⚠️ После этого удалите запись об этом сервере из `SERVERS_MATRIX` на GitHub!

### Просмотр логов на VPS

| Действие | Команда Docker |
| --- | --- |
| Смотреть логи (node.js) | `docker logs -f vimp-<domain>` |
| Список процессов | `docker ps -a` |
| Перезагрузить | `docker restart vimp-<domain>` |
| Остановить | `docker stop vimp-<domain>` |
| Потребление ресурсов | `docker stats` |

---

[← Предыдущая: Конфигурация](configuration.md) · [Следующая: Plugin API →](plugin-api.md)
