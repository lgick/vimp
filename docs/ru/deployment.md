# Развертывание

Гайд по подготовке чистого VPS, настройке окружения и запуску **мастер-сервера** (лобби + сигналинг; матчи исполняют браузерные хосты, серверных игровых инстансов нет) через CI/CD GitHub Actions. Скрипты установки лежат в [.github/deployment/](../../.github/deployment/).

**Как это работает**: пуш в `main` → [.github/workflows/deploy.yml](../../.github/workflows/deploy.yml) собирает Docker-образ и публикует его в GHCR → по SSH заходит на каждый сервер из `SERVERS_MATRIX`, генерирует `.env` и перезапускает контейнер `vimp-<domain>`. На VPS Nginx терминирует HTTPS и проксирует на порт приложения (внутри контейнера мастер слушает `3002`).

> **Rust-тулчейн больше не нужен.** После переезда игры-плагина (`@vimp/tanks`) в отдельный репозиторий (Этап A3) [Dockerfile](../../Dockerfile) больше не собирает WASM-ядро — это делает собственный CI репозитория игры, публикующий пакет. Node-стадия просто выполняет `npm ci` (ставит `@vimp/tanks` из registry, что приносит уже собранный `dist/` — client/host-точки входа, WASM-ассет, карты, звуки, `manifest.json`), а следом `npm run build:app` (Vite-сборка движка). Runner-стадия копирует `packages/engine/dist/` и `node_modules/@vimp/tanks/dist/`; мастер читает плагин только через `GameCatalog` (`dist/manifest.json` + `dist/maps/*.json`) и отвергает его при загрузке, если `engineApi` не совпадает с `ENGINE_API_VERSION` этой сборки движка — исходный код игры он никогда не импортирует.

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
   - введите email (для уведомлений SSL).

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
- **Хостинг.** Разверните его один раз на отдельном домене: Шаги 2–3 выше
  (`install-system.sh`, затем `add-server.sh`) дают Nginx + SSL для любого
  домена/порта, поэтому подходят и для auth-сервиса. Вместо одного
  контейнера мастера запустите docker-compose стек из двух сервисов:

  ```yaml
  services:
    postgres:
      image: postgres:16-alpine
      restart: always
      environment:
        POSTGRES_DB: vimp_auth
        POSTGRES_USER: vimp
        POSTGRES_PASSWORD: <secret>
      volumes:
        - pgdata:/var/lib/postgresql/data
    auth:
      image: ghcr.io/<repo>-auth:latest
      restart: always
      env_file: .env.prod
      volumes:
        - ./.keys:/app/.keys:ro
      ports:
        - '127.0.0.1:<port>:3010'
  volumes:
    pgdata:
  ```

  `.env.prod` на этом хосте должен содержать `VIMP_AUTH_DATABASE_URL`
  (указывающий на сервис `postgres`), секреты OAuth-провайдера
  (`VIMP_AUTH_GITHUB_CLIENT_ID`/`_SECRET`, см. [auth.md](auth.md#запуск)) и
  ещё три переменные, без которых сервис отказывается стартовать в проде:
  `VIMP_AUTH_PUBLIC_URL` (собственный публичный origin — для OAuth
  `redirect_uri`, зарегистрированного у провайдера), `VIMP_AUTH_ALLOWED_ORIGINS`
  (CSV origin'ов мастеров — CORS на `POST /nick` и allowlist `returnUrl` для
  OAuth-редиректа) и `VIMP_AUTH_STATE_SECRET` (HMAC-секрет параметра `state`).
  Пара RS256-ключей кладётся в `./.keys/` на хосте (генерируется один раз —
  [auth.md](auth.md#запуск)); никогда не запекайте её в образ и не
  коммитьте.

- **Миграции.** Не запускаются автоматически при старте контейнера —
  примените их один раз, и снова после любого изменения схемы: `docker
  compose exec auth node src/db/migrate.js`.
- **Привязка мастеров.** Задайте переменную репозитория
  `AUTH_SERVICE_URL` (Settings → Secrets and variables → Actions →
  Variables) публичным URL auth-сервиса; джоба `deploy` из `deploy.yml`
  прописывает её в `.env.prod` каждого мастера как
  `VIMP_AUTH_SERVICE_URL` (читается в
  [packages/engine/src/master/main.js](../../packages/engine/src/master/main.js),
  см. [configuration.md](configuration.md#переменные-окружения-env)) —
  одна переменная применяется ко всем серверам из `SERVERS_MATRIX`.

## 🔒 Security-заголовки и CSP

Гигиена среды: отсекает «уличных» злоумышленников — не хоста-читера: он физически исполняет симуляцию у себя в процессе, и WASM-память доступна ему из JS в обход логики ядра, этого CSP не предотвращает. В проде клиентскую статику и `.wasm` отдаёт **Nginx**, поэтому авторитетная точка Content-Security-Policy — заголовок Nginx в `server`-блоке домена. Единый source of truth политики — [packages/engine/src/config/master.js](../../packages/engine/src/config/master.js) (`security.csp`, функция от `authServiceUrl` — см. [auth.md](auth.md#вход-в-лобби-клиент)); мастер ставит её на свои ответы, но HTML/`.wasm` идут через Nginx, поэтому реальный домен auth-сервиса нужно подставить в сниппет ниже вручную (или сгенерировать из `security.csp` и вставить в конфиг Nginx).

Шаблон `install-system.sh` уже содержит эти заголовки; при ручной настройке добавьте в Nginx `server`-блок (или в общий `snippet`):

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
