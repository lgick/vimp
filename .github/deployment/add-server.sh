#!/bin/bash
# ====================================================
# add-server.sh
# Добавление нового игрового сервера vimp.
# ====================================================

set -euo pipefail
IFS=$'\n\t'

# --- Подключение общей библиотеки ---
# Логгеры, check_system_installed, read_domain/read_port/read_email,
# validate_origin, генерация Nginx+SSL и каталог проекта живут в lib/common.sh
# и общие с add-dedicated.sh.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

# --- Глобальные переменные добавления мастера (инициализация для set -u) ---
IS_AUTH_SERVICE=""
AUTH_RECONFIGURE_MODE=""
AUTH_DB_PASSWORD=""
AUTH_STATE_SECRET=""
AUTH_ALLOWED_ORIGINS=""
AUTH_GITHUB_CLIENT_ID=""
AUTH_GITHUB_CLIENT_SECRET=""
AUTH_ADMIN_NICKS=""
GHCR_IMAGE=""
GHCR_USER=""
GHCR_TOKEN=""
GHCR_IMAGE_DEFAULT="ghcr.io/lgick/vimp-auth"
AUTH_STACK_OK=""

# Устанавливаем ловушку на любую ошибку
trap 'cleanup' ERR

read_auth_service_url() {
  local ANSWER
  read -r -p "🔐 Этот домен — сам central auth-сервис? [y/N]: " ANSWER
  if [[ "$ANSWER" =~ ^[Yy]$ ]]; then
    IS_AUTH_SERVICE="y"
    AUTH_SERVICE_URL=""
    return
  fi
  IS_AUTH_SERVICE="n"

  # Мастер без auth-URL в CSP сломает вход в лобби (fetch POST /nick
  # заблокирует connect-src) — поэтому URL обязателен. Если auth-сервис ещё
  # не развёрнут: сначала добавьте его домен этим же скриптом (ответ "y" на
  # вопрос выше), потом добавляйте домен мастера. Чтобы поменять auth-URL на
  # уже настроенном мастере позже — запустите ./add-server.sh на этом же
  # домене снова и подтвердите "Перезаписать?".
  while true; do
    read -r -p "   URL central auth-сервиса (например https://auth.example.com, без пути): " RAW
    if [[ -z "${RAW// /}" ]]; then
      warn "URL обязателен для домена мастера — auth должен быть развёрнут заранее."
      warn "Для dedicated-сервера используйте ./add-dedicated.sh — там URL необязателен."
      continue
    fi
    if ! AUTH_SERVICE_URL=$(validate_origin "$RAW"); then
      warn "URL '$RAW' некорректен — нужен только origin http(s)://host[:port], без пути (/api и т.п.)."
      continue
    fi
    break
  done
}

read_auth_stack_inputs() {
  TARGET_DIR="$PROJECTS_ROOT/$DOMAIN"

  # --- Режим повторного запуска ---
  if [ -f "$TARGET_DIR/.env.prod" ]; then
    echo ""
    warn "Найден существующий auth-стек в $TARGET_DIR."
    echo "   1) Обновить образ (сохранить БД, ключи, секреты)"
    echo "   2) Пересоздать (docker compose down -v — сотрёт БД и ключи!)"
    while true; do
      read -r -p "   Выберите режим [1/2]: " MODE_CHOICE
      case "$MODE_CHOICE" in
        1)
          AUTH_RECONFIGURE_MODE="update"
          break
          ;;
        2)
          read -r -p "   Точно пересоздать и стереть БД/ключи? Введите 'yes' для подтверждения: " CONFIRM_RECREATE
          if [[ "$CONFIRM_RECREATE" == "yes" ]]; then
            AUTH_RECONFIGURE_MODE="recreate"
            break
          fi
          warn "Отменено, выберите режим ещё раз."
          ;;
        *)
          warn "Введите 1 или 2."
          ;;
      esac
    done
  else
    AUTH_RECONFIGURE_MODE="fresh"
  fi

  if [[ "$AUTH_RECONFIGURE_MODE" != "update" ]]; then
    AUTH_DB_PASSWORD=$(openssl rand -hex 24)
    AUTH_STATE_SECRET=$(openssl rand -hex 32)

    echo ""
    info "🌐 Origin'ы мастеров, которым разрешён доступ к auth-сервису (CORS)."
    echo "   Вводите по одному (например https://ru1.example.com), пустая строка — закончить."
    local origins=()
    while true; do
      read -r -p "   Origin (Enter — закончить, если хоть один уже введён): " ORIGIN_INPUT
      if [[ -z "$ORIGIN_INPUT" ]]; then
        [[ ${#origins[@]} -eq 0 ]] && warn "Нужен хотя бы один origin." && continue
        break
      fi
      local VALIDATED
      if ! VALIDATED=$(validate_origin "$ORIGIN_INPUT"); then
        warn "Origin '$ORIGIN_INPUT' некорректен — нужен http(s)://host[:port] без пути."
        continue
      fi
      origins+=("$VALIDATED")
    done
    AUTH_ALLOWED_ORIGINS=$(IFS=,; echo "${origins[*]}")
    warn "При добавлении новых мастеров эту переменную нужно будет дополнить"
    warn "вручную и пересоздать auth-контейнер (docker compose up -d --force-recreate auth)."

    echo ""
    info "🔑 GitHub OAuth App (создаётся заранее вручную на github.com/settings/developers):"
    echo "   Homepage URL:                https://$DOMAIN"
    echo "   Authorization callback URL:  https://$DOMAIN/oauth/github/callback"
    while true; do
      read -r -p "   Client ID: " AUTH_GITHUB_CLIENT_ID
      [[ -z "$AUTH_GITHUB_CLIENT_ID" ]] && warn "Client ID обязателен." && continue
      break
    done
    while true; do
      read -rs -p "   Client Secret: " AUTH_GITHUB_CLIENT_SECRET
      echo ""
      [[ -z "$AUTH_GITHUB_CLIENT_SECRET" ]] && warn "Client Secret обязателен." && continue
      break
    done

    echo ""
    info "👑 Админы платформы (модерация игр в лобби), ники через запятую."
    echo "   Можно оставить пустым: список задаётся переменной VIMP_ADMIN_NICKS"
    echo "   в GitHub Variables и переписывается при каждом деплое."
    read -r -p "   Ники админов (Enter — пропустить): " AUTH_ADMIN_NICKS

    echo ""
    read -r -p "🐳 Docker-образ auth [по умолчанию: $GHCR_IMAGE_DEFAULT]: " GHCR_IMAGE_INPUT
    GHCR_IMAGE="${GHCR_IMAGE_INPUT:-$GHCR_IMAGE_DEFAULT}"
  fi

  echo ""
  read -r -p "   GitHub-логин для GHCR (Enter — пропустить, если пакет сделан публичным; иначе скрипт спросит PAT при неудачном pull): " GHCR_USER
  if [[ -n "$GHCR_USER" ]]; then
    read -rs -p "   GHCR Personal Access Token (read:packages): " GHCR_TOKEN
    echo ""
  fi
}

# --- Поднятие central auth-стека (postgres + auth) в $TARGET_DIR ---
# Вызывается ПОСЛЕ снятия trap ERR: сбой docker'а не должен откатывать уже
# применённые Nginx/SSL. set -e внутри функции не действует, когда функция
# вызвана как `if setup_auth_stack; then` — поэтому ошибки каждого шага
# обрабатываем явно.
setup_auth_stack() {
  cd "$TARGET_DIR" || { error "Каталог проекта $TARGET_DIR недоступен."; return 1; }

  if [[ "$AUTH_RECONFIGURE_MODE" == "recreate" ]]; then
    if [ -f docker-compose.yml ]; then
      info "🗑️  Пересоздание: снос старого стека (docker compose down -v)..."
      docker compose down -v || true
    fi
    rm -rf .keys
  fi

  mkdir -p .keys
  if [ ! -f .keys/jwt.pem ]; then
    info "🔑 Генерация RS256-ключей для JWT..."
    openssl genrsa -out .keys/jwt.pem 2048 >/dev/null 2>&1
    openssl rsa -in .keys/jwt.pem -pubout -out .keys/jwt.pub.pem >/dev/null 2>&1
    chmod 600 .keys/jwt.pem
  fi

  if [[ "$AUTH_RECONFIGURE_MODE" != "update" ]]; then
    info "📝 Запись .env.prod..."
    cat > .env.prod <<EOF
NODE_ENV=production
VIMP_AUTH_PUBLIC_URL=https://$DOMAIN
VIMP_AUTH_ALLOWED_ORIGINS=$AUTH_ALLOWED_ORIGINS
VIMP_AUTH_STATE_SECRET=$AUTH_STATE_SECRET
VIMP_AUTH_GITHUB_CLIENT_ID=$AUTH_GITHUB_CLIENT_ID
VIMP_AUTH_GITHUB_CLIENT_SECRET=$AUTH_GITHUB_CLIENT_SECRET
VIMP_ADMIN_NICKS=$AUTH_ADMIN_NICKS
VIMP_AUTH_DATABASE_URL=postgres://vimp:$AUTH_DB_PASSWORD@postgres:5432/vimp_auth
EOF
    chmod 600 .env.prod

    info "📝 Запись docker-compose.yml..."
    cat > docker-compose.yml <<EOF
services:
  postgres:
    image: postgres:16-alpine
    container_name: vimp-$DOMAIN-postgres
    environment:
      POSTGRES_DB: vimp_auth
      POSTGRES_USER: vimp
      POSTGRES_PASSWORD: $AUTH_DB_PASSWORD
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vimp -d vimp_auth"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: always

  auth:
    image: $GHCR_IMAGE:latest
    container_name: vimp-$DOMAIN
    env_file: .env.prod
    volumes:
      - ./.keys:/app/.keys:ro
    ports:
      - "127.0.0.1:$PORT:3010"
    depends_on:
      postgres:
        condition: service_healthy
    restart: always

volumes:
  pgdata:
EOF
  fi

  # Каждая итерация: pull с текущим состоянием docker-авторизации; при неудаче —
  # ступенчатое восстановление, бережа уже существующий валидный логин ghcr.io:
  #   1) первый pull — как есть (ambient-креды, если валидны — приватный образ);
  #   2) упал и явный логин не задавали → один раз сбрасываем возможные
  #      УСТАРЕВШИЕ креды (docker logout) и повторяем анонимно (чинит публичный
  #      образ, заблокированный протухшими кредами);
  #   3) не помогло → просим PAT (приватный образ) и повторяем, до max_try.
  local pull_try=1 max_try=3
  local anon_reset=0
  local RETRY_ANS
  while true; do
    if [[ -n "$GHCR_USER" && -n "$GHCR_TOKEN" ]]; then
      info "🔐 Вход в GHCR..."
      echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null \
        || warn "Не удалось войти в GHCR — проверьте логин/PAT."
    fi

    info "📥 docker compose pull..."
    docker compose pull && break

    error "docker compose pull не удался для '${GHCR_IMAGE:-образ auth}:latest'."

    # Публичный образ, но pull упал → возможно, мешают устаревшие ambient-креды.
    # Сбрасываем их ОДИН раз и повторяем анонимно, не тратя попытку на ввод PAT.
    if [[ -z "$GHCR_USER" && "$anon_reset" -eq 0 ]]; then
      anon_reset=1
      warn "Сбрасываю возможные устаревшие креды ghcr.io и повторяю анонимно..."
      docker logout ghcr.io >/dev/null 2>&1 || true
      continue
    fi

    warn "Обычно причина — GHCR-пакет по умолчанию ПРИВАТНЫЙ."
    warn "Сделайте его публичным (Package settings → Change visibility → Public)"
    warn "ИЛИ войдите с PAT (scope read:packages)."

    if [[ "$pull_try" -ge "$max_try" ]]; then
      error "Не удалось скачать образ после $max_try попыток."
      return 1
    fi
    read -r -p "   Ввести GHCR-логин/PAT и повторить? [Y/n]: " RETRY_ANS
    [[ "$RETRY_ANS" =~ ^[Nn]$ ]] && return 1

    read -r -p "   GitHub-логин для GHCR (Enter — повторить анонимно): " GHCR_USER
    if [[ -n "$GHCR_USER" ]]; then
      read -rs -p "   GHCR Personal Access Token (read:packages): " GHCR_TOKEN
      echo ""
    else
      GHCR_TOKEN=""
    fi
    pull_try=$((pull_try + 1))
  done

  info "🐳 docker compose up -d..."
  if ! docker compose up -d; then
    error "docker compose up -d упал. Логи: docker compose -f $TARGET_DIR/docker-compose.yml logs"
    return 1
  fi

  info "🗃️  Применение миграций auth-БД..."
  local attempt=1
  local migrated=0
  while [ "$attempt" -le 15 ]; do
    if docker compose exec -T auth node src/db/migrate.js; then
      migrated=1
      break
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  if [ "$migrated" -ne 1 ]; then
    error "Миграции не прошли за отведённое время. Смотрите логи:"
    error "  docker compose -f $TARGET_DIR/docker-compose.yml logs auth"
    return 1
  fi

  info "🩺 Проверка здоровья (/jwks)..."
  local health_attempt=1
  local healthy=0
  while [ "$health_attempt" -le 10 ]; do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/jwks"; then
      healthy=1
      break
    fi
    sleep 1
    health_attempt=$((health_attempt + 1))
  done

  # Локальный curl на 127.0.0.1:$PORT изредка ловит "Connection reset by peer"
  # даже когда сервис уже реально отвечает (гонка с docker-proxy/только что
  # стартовавшим процессом) — ложное срабатывание, не факт поломки. К этому
  # моменту Nginx+SSL для $DOMAIN уже настроены (Этап 3 выполняется раньше
  # этого шага) и проксируют на тот же порт, так что вместо предположений
  # перепроверяем по публичному HTTPS-пути — тому же самому, который реально
  # важен (это его вызывает браузер/master), и получаем точный ответ, а не
  # догадку.
  if [ "$healthy" -ne 1 ]; then
    warn "Локальная проверка /jwks (127.0.0.1:$PORT) не прошла за 10 попыток —"
    warn "перепроверяю через публичный https://$DOMAIN/jwks..."
    local pub_attempt=1
    while [ "$pub_attempt" -le 5 ]; do
      if curl -fsS -o /dev/null "https://$DOMAIN/jwks"; then
        healthy=1
        break
      fi
      sleep 2
      pub_attempt=$((pub_attempt + 1))
    done
  fi

  if [ "$healthy" -ne 1 ]; then
    error "/jwks не ответил 200 ни локально, ни через https://$DOMAIN — сервис"
    error "действительно не поднялся. Смотрите логи:"
    error "  docker compose -f $TARGET_DIR/docker-compose.yml logs auth"
    return 1
  fi

  return 0
}

check_system_installed

# --- Основной процесс ---
info "🚀 МАСТЕР УСТАНОВКИ СЕРВЕРА VIMP"

read_domain
read_port
read_email
read_auth_service_url
[[ "$IS_AUTH_SERVICE" == "y" ]] && read_auth_stack_inputs

# В режиме update docker-compose.yml не переписывается — маппинг порта остаётся
# прежним. Приводим $PORT к нему ДО записи Nginx-конфига (Этап 4), чтобы
# proxy_pass указывал на реально слушающий порт, а не на свежевведённый; сменить
# порт можно только пересозданием (recreate).
if [[ "$IS_AUTH_SERVICE" == "y" && "$AUTH_RECONFIGURE_MODE" == "update" ]]; then
  EXISTING_PORT=$(grep -oP '127\.0\.0\.1:\K[0-9]+' "$TARGET_DIR/docker-compose.yml" 2>/dev/null | head -n1) || true
  if [[ -n "$EXISTING_PORT" && "$EXISTING_PORT" != "$PORT" ]]; then
    warn "Режим update: порт берётся из существующего docker-compose.yml ($EXISTING_PORT);"
    warn "введённый $PORT игнорируется. Чтобы сменить порт — режим «пересоздать»."
    PORT="$EXISTING_PORT"
  fi
fi

check_auth_placeholder

echo ""
info "Проверка конфигурации:"
echo "  Домен: $DOMAIN"
echo "  Порт:  $PORT"
echo "  Email: $EMAIL"
echo "  Auth CSP: ${AUTH_SERVICE_URL:-(не задан)}"
if [[ "$IS_AUTH_SERVICE" == "y" ]]; then
  echo "  Auth-стек:"
  echo "    Режим:         $AUTH_RECONFIGURE_MODE"
  if [[ "$AUTH_RECONFIGURE_MODE" != "update" ]]; then
    echo "    Образ:         $GHCR_IMAGE"
    echo "    Allowed origins: $AUTH_ALLOWED_ORIGINS"
    echo "    Админы:        ${AUTH_ADMIN_NICKS:-(не заданы)}"
  fi
  if [[ -n "$GHCR_USER" ]]; then
    echo "    Вход в GHCR:   да ($GHCR_USER)"
  else
    echo "    Вход в GHCR:   пропущен"
  fi
fi
read -r -p "Нажмите Enter для продолжения..."

# --- Этапы 1-4: каталог проекта, Nginx, SSL (lib/common.sh) ---
ensure_project_dir
provision_nginx_ssl

# Снимаем ловушку: мы успешно закончили, откат больше не нужен
trap - ERR

# --- Этап 5: Auth-стек (postgres + auth), только для auth-домена ---
# После снятия trap ERR: сбой docker'а не должен откатывать уже применённые
# Nginx/SSL. AUTH_STACK_OK=0 при неудаче — скрипт всё равно доходит до
# финального блока и печатает инструкцию, а не тихо падает.
if [[ "$IS_AUTH_SERVICE" == "y" ]]; then
  info "4️⃣ Поднятие auth-стека (postgres + auth)..."
  if setup_auth_stack; then
    AUTH_STACK_OK=1
  else
    AUTH_STACK_OK=0
  fi
fi

echo ""
echo "=================================================="
if [[ "$IS_AUTH_SERVICE" == "y" && "$AUTH_STACK_OK" == "0" ]]; then
  echo "⚠️ ЧАСТИЧНО. Сервер подготовлен, но auth-стек поднялся не полностью."
else
  echo "✅ УСПЕХ! Сервер подготовлен."
fi
echo "   URL:  https://$DOMAIN"
echo "   Порт: 127.0.0.1:$PORT"
echo ""
if [[ "$IS_AUTH_SERVICE" != "y" ]]; then
  # Домен мастера — деплоится CI по SERVERS_MATRIX (master-образ)
  echo "⚠️  ВАЖНО (домен мастера):"
  echo "1. Добавьте этот сервер в переменную SERVERS_MATRIX в настройках GitHub"
  echo "   (Settings -> Secrets and variables -> Variables)."
  echo "   Убедитесь, что 'port' в JSON равен $PORT!"
  echo "2. Перезапустите Action вручную или сделайте push, чтобы запустить деплой."
else
  # Домен самого auth-сервиса — НЕ входит в SERVERS_MATRIX (та матрица
  # раскатывает master-образ, а auth — отдельный образ + PostgreSQL)
  echo "⚠️  ВАЖНО (central auth-сервис):"
  if [[ "$AUTH_STACK_OK" == "1" ]]; then
    echo "✅ Auth-стек поднят и прошёл проверку (локально или через https://$DOMAIN/jwks)."
    echo "   docker compose -f $TARGET_DIR/docker-compose.yml ps"
    echo "   curl https://$DOMAIN/jwks"
  else
    echo "❌ Auth-стек поднялся не полностью — смотрите логи:"
    echo "   docker compose -f $TARGET_DIR/docker-compose.yml logs auth"
  fi
  echo "1. Задайте переменную репозитория AUTH_SERVICE_URL = https://$DOMAIN"
  echo "   (Settings -> Variables) и перезапустите Build & Deploy — мастера"
  echo "   пересоберут клиентский бандл/CSP с VITE_AUTH_SERVICE_URL."
  echo "2. При добавлении новых мастеров дополните VIMP_AUTH_ALLOWED_ORIGINS"
  echo "   в $TARGET_DIR/.env.prod и пересоздайте: docker compose up -d --force-recreate auth."
fi
echo "=================================================="
