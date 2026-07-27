#!/bin/bash
# ====================================================
# delete-server.sh
# Удаляет игровые серверы VIMP.
# ====================================================

echo "=================================================="
echo "           🗑️ УДАЛЕНИЕ СЕРВЕРА VIMP               "
echo "=================================================="

# Папка, где находятся игровые проекты
PROJECTS_ROOT="$HOME/vimp_projects"

# ----------------------------------------------------
# 1. Поиск существующих серверов VIMP
# ----------------------------------------------------
# Логика: объединяем три источника, т.к. по отдельности каждый может быть
# неполным (например, если certbot упал при создании — нет конфига Nginx,
# но папка проекта и Docker-контейнер уже существуют):
#   - конфиги Nginx (sites-enabled), у которых есть папка проекта
#   - папки проектов в $PROJECTS_ROOT
#   - Docker-контейнеры с именем vimp-<домен> (в т.ч. остановленные)
RAW_SITES=$(ls /etc/nginx/sites-enabled/ 2>/dev/null | grep -v "default")
VIMP_SITES=""

for site in $RAW_SITES; do
  if [ -d "$PROJECTS_ROOT/$site" ]; then
    VIMP_SITES="$VIMP_SITES $site"
  fi
done

if [ -d "$PROJECTS_ROOT" ]; then
  for dir in "$PROJECTS_ROOT"/*/; do
    [ -d "$dir" ] || continue
    site=$(basename "$dir")
    [[ " $VIMP_SITES " == *" $site "* ]] || VIMP_SITES="$VIMP_SITES $site"
  done
fi

RAW_CONTAINERS=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep '^vimp-' | sed 's/^vimp-//')
for site in $RAW_CONTAINERS; do
  # Пропускаем postgres-компаньон auth-стека (vimp-<домен>-postgres) —
  # это не отдельный сервер, а часть сервера <домен>
  [[ "$site" == *-postgres ]] && continue
  [[ " $VIMP_SITES " == *" $site "* ]] || VIMP_SITES="$VIMP_SITES $site"
done

# Убираем возможные ведущие пробелы/дубликаты аккуратно
VIMP_SITES=$(echo $VIMP_SITES | xargs -n1 | sort -u | xargs)

# Если серверов нет
if [ -z "$VIMP_SITES" ]; then
  echo "❌ Игровых серверов VIMP не найдено."
  echo "   (Проверено: конфиги Nginx + наличие папок в $PROJECTS_ROOT)"
  exit 0
fi

# ----------------------------------------------------
# 2. Меню выбора сервера
# ----------------------------------------------------
PS3="👉 Выберите сервер для УДАЛЕНИЯ (введите номер): "
select DOMAIN in $VIMP_SITES "Отмена"; do
  if [[ "$DOMAIN" == "Отмена" ]]; then
    echo "Действие отменено."
    exit 0

  elif [[ -n "$DOMAIN" ]]; then
    # Порт мастера для этого домена — берём из proxy_pass в конфиге Nginx
    # (см. __PORT__ в install-system.sh:write_nginx_template), чтобы потом
    # закрыть его в ufw, если он был открыт вручную
    NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"
    PORT=$(sudo grep -oP 'proxy_pass\s+http://127\.0\.0\.1:\K[0-9]+' "$NGINX_CONF" 2>/dev/null | head -n1)

    echo ""
    echo "🚨 ВНИМАНИЕ! Вы собираетесь удалить сервер VIMP: $DOMAIN"
    echo "   Будет выполнено удаление:"
    echo "   - Конфига Nginx  (/etc/nginx/sites-enabled/$DOMAIN)"
    echo "   - SSL-сертификатов (через Certbot)"
    echo "   - Docker-контейнера и сети (vimp-$DOMAIN)"
    if [[ -n "$PORT" ]]; then
      echo "   - Правил ufw для порта $PORT (tcp/udp)"
    fi
    echo "   - Папки проекта ($PROJECTS_ROOT/$DOMAIN)"
    echo ""
    read -p "Для подтверждения введите 'yes': " CONFIRM

    if [[ "$CONFIRM" == "yes" ]]; then
      break
    else
      echo "❌ Удаление отменено."
      exit 0
    fi

  else
    echo "Неверный выбор. Попробуйте снова."
  fi
done

echo ""
echo "🔥 Удаление сервера: $DOMAIN..."

# ----------------------------------------------------
# 1. Docker
# ----------------------------------------------------
TARGET_DIR="$PROJECTS_ROOT/$DOMAIN"
CONTAINER_NAME="vimp-$DOMAIN"

# Признак auth-стека: VIMP_AUTH_PUBLIC_URL пишет только
# add-server.sh:setup_auth_stack() — мастерский .env.prod его не содержит.
# Фолбэк на случай частичного деплоя: постгрес-компаньон auth-стека.
IS_AUTH_SERVICE="n"
if [ -f "$TARGET_DIR/.env.prod" ] && grep -q '^VIMP_AUTH_PUBLIC_URL=' "$TARGET_DIR/.env.prod"; then
  IS_AUTH_SERVICE="y"
elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qxF "vimp-$DOMAIN-postgres"; then
  IS_AUTH_SERVICE="y"
fi

if [ -f "$TARGET_DIR/docker-compose.yml" ]; then
  echo "🐳 Остановка Docker Compose проекта ($TARGET_DIR)..."
  (cd "$TARGET_DIR" && docker compose down --remove-orphans --volumes 2>/dev/null) || true
fi

# На случай, если compose-файла нет или compose не удалил контейнер
echo "🐳 Остановка Docker-контейнера: $CONTAINER_NAME..."
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

# ----------------------------------------------------
# 2. Порт в ufw
# ----------------------------------------------------
# Docker-порт мастера ($PORT) публикуется только на 127.0.0.1, поэтому
# install-system.sh его не сканирует (prompt_open_public_ports смотрит
# только 0.0.0.0/[::]) и обычно в ufw не открыт — но если админ открыл его
# вручную, закрываем на всякий случай
if [[ -n "$PORT" ]]; then
  echo "🔒 Закрытие порта $PORT в ufw (если был открыт)..."
  sudo ufw delete allow "$PORT/tcp" 2>/dev/null || true
  sudo ufw delete allow "$PORT/udp" 2>/dev/null || true
else
  echo "⚠️  Не удалось определить порт из конфига Nginx — пропуск очистки ufw."
fi

# ----------------------------------------------------
# 3. Папка проекта
# ----------------------------------------------------
if [ -d "$TARGET_DIR" ]; then
  echo "📂 Удаление папки проекта: $TARGET_DIR..."
  rm -rf "$TARGET_DIR"
fi

# ----------------------------------------------------
# 4. Конфиги Nginx
# ----------------------------------------------------
echo "🌐 Удаление конфигураций Nginx..."
sudo rm -f /etc/nginx/sites-enabled/$DOMAIN
sudo rm -f /etc/nginx/sites-available/$DOMAIN

# ----------------------------------------------------
# 5. SSL сертификаты
# ----------------------------------------------------
echo "🔐 Удаление SSL-сертификатов..."
sudo certbot delete --cert-name "$DOMAIN" --non-interactive 2>/dev/null \
  || echo "   ⚠️  Certbot: сертификат не найден или уже удалён."

# ----------------------------------------------------
# 6. Перезагрузка Nginx
# ----------------------------------------------------
echo "🔄 Перезагрузка Nginx..."
if sudo nginx -t; then
  sudo systemctl reload nginx
  echo "✅ ГОТОВО! Сервер $DOMAIN успешно удалён."
  if [[ "$IS_AUTH_SERVICE" == "y" ]]; then
    echo "👉 Это был central auth-сервис — его НЕТ в переменной SERVERS_MATRIX,"
    echo "   там ничего трогать не нужно. Но проверьте вручную:"
    echo "   1. Переменная репозитория AUTH_SERVICE_URL (Settings -> Variables) —"
    echo "      обновите её на новый auth-домен или очистите."
    echo "   2. Перезапустите workflow 'Build & Deploy' (один прогон обновит"
    echo "      всех мастеров) — иначе"
    echo "      они продолжат использовать старый VIMP_AUTH_SERVICE_URL, и"
    echo "      JWKS/rank/state/host-rating начнут падать по fetch."
    echo "   3. CSP connect-src в Nginx каждого мастера запечён на этапе"
    echo "      add-server.sh (__AUTH_SERVICE_URL__) — обычный redeploy его не"
    echo "      обновляет, нужен ручной перезапуск add-server.sh на каждом"
    echo "      домене мастера либо ручная правка конфига."
    echo "   4. Клиентский бандл (VITE_AUTH_SERVICE_URL) запечён в образ на"
    echo "      этапе build_and_push — обновится только после новой сборки."
    echo "   5. Если поднимаете новый auth взамен — заполните его"
    echo "      VIMP_AUTH_ALLOWED_ORIGINS origin'ами всех мастеров."
  else
    echo "👉 Не забудьте удалить его конфигурацию из переменной SERVERS_MATRIX"
    echo "   в настройках репозитория GitHub (Settings -> Secrets and variables)!"
  fi
else
  echo "❌ Ошибка: некорректная конфигурация Nginx."
  sudo nginx -t
fi
