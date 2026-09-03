#!/bin/bash
# ====================================================
# add-dedicated.sh
# Добавление dedicated-сервера vimp (один матч в Node-процессе, без лобби
# и без OAuth). Сосед add-server.sh, а не флаг внутри него: у сценариев
# расходятся вопросы, обязательность полей и генерируемые файлы.
# ====================================================

set -euo pipefail
IFS=$'\n\t'

# --- Подключение общей библиотеки ---
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

# --- Глобальные переменные dedicated-сервера (инициализация для set -u) ---
GAME=""
ROOM_JSON=""
GAMES_DIR="/var/vimp/games"
IMAGE_DEFAULT="ghcr.io/lgick/vimp"

# Значения по умолчанию настроек комнаты: пустая строка = поле не пишется в
# VIMP_DEDICATED_ROOM, и движок берёт свой дефолт
# (packages/engine/src/config/hostDefaults.js).
DEFAULT_MAP=""
DEFAULT_MAX_PLAYERS="8"
DEFAULT_ROUND_TIME="120000"
DEFAULT_FRIENDLY_FIRE="false"

# Устанавливаем ловушку на любую ошибку
trap 'cleanup' ERR

read_game() {
  echo ""
  info "🎮 Игра dedicated-сервера: имя npm-пакета (@vimp-games/tanks) или id (tanks)."
  echo "   Можно с пином версии: @vimp-games/tanks@0.16.1"
  echo "   Игра по id достаётся только через реестр — тогда нужен auth-URL ниже."
  while true; do
    read -r -p "   Игра: " GAME
    GAME="${GAME// /}"
    [[ -z "$GAME" ]] && warn "Игра обязательна — без неё dedicated-серверу нечего запускать." && continue
    break
  done
}

# В отличие от лобби-мастера auth-URL здесь НЕобязателен: OAuth в dedicated
# нет вовсе (личность гостевая, профиль — офлайн-заглушка), а реестр нужен
# ровно для одного — достать пакет игры, названной по id. Игра, названная
# именем npm-пакета, тянется прямо из npm.
read_auth_service_url_optional() {
  echo ""
  info "🔐 URL central auth-сервиса — только для игры, названной по id."
  echo "   Пустой ввод: игра берётся из npm по имени пакета, реестр не нужен."
  while true; do
    read -r -p "   URL (например https://auth.example.com, Enter — пропустить): " RAW
    if [[ -z "${RAW// /}" ]]; then
      AUTH_SERVICE_URL=""
      break
    fi
    if ! AUTH_SERVICE_URL=$(validate_origin "$RAW"); then
      warn "URL '$RAW' некорректен — нужен только origin http(s)://host[:port], без пути (/api и т.п.)."
      continue
    fi
    break
  done
}

# Настройки комнаты: у каждой свой дефолт, пустой ввод его оставляет.
read_room_settings() {
  local MAP MAX_PLAYERS ROUND_TIME FRIENDLY_FIRE ANSWER
  local fields=()

  echo ""
  info "🏟️  Настройки комнаты (Enter — оставить значение по умолчанию)."
  echo "   При деплое значение перезапишется из SERVERS_MATRIX, если поле"
  echo "   'settings' там задано."

  read -r -p "   Карта [по умолчанию: первая карта игры]: " MAP
  MAP="${MAP// /}"
  MAP="${MAP:-$DEFAULT_MAP}"
  [[ -n "$MAP" ]] && fields+=("\"map\":\"$MAP\"")

  while true; do
    read -r -p "   Лимит игроков [по умолчанию: $DEFAULT_MAX_PLAYERS]: " MAX_PLAYERS
    MAX_PLAYERS="${MAX_PLAYERS// /}"
    MAX_PLAYERS="${MAX_PLAYERS:-$DEFAULT_MAX_PLAYERS}"
    [[ ! "$MAX_PLAYERS" =~ ^[0-9]+$ ]] && warn "Введите число." && continue
    break
  done
  fields+=("\"maxPlayers\":$MAX_PLAYERS")

  while true; do
    read -r -p "   Время раунда, мс [по умолчанию: $DEFAULT_ROUND_TIME]: " ROUND_TIME
    ROUND_TIME="${ROUND_TIME// /}"
    ROUND_TIME="${ROUND_TIME:-$DEFAULT_ROUND_TIME}"
    [[ ! "$ROUND_TIME" =~ ^[0-9]+$ ]] && warn "Введите число миллисекунд." && continue
    break
  done
  fields+=("\"roundTime\":$ROUND_TIME")

  read -r -p "   Огонь по своим? [y/N]: " ANSWER
  if [[ "$ANSWER" =~ ^[Yy]$ ]]; then
    FRIENDLY_FIRE="true"
  else
    FRIENDLY_FIRE="$DEFAULT_FRIENDLY_FIRE"
  fi
  fields+=("\"friendlyFire\":$FRIENDLY_FIRE")

  # Одна строка JSON без внешних кавычек: так его читает env_file docker compose
  ROOM_JSON="{$(IFS=,; echo "${fields[*]}")}"
}

# --- Генерация .env.prod и docker-compose.yml в $TARGET_DIR ---
# Вызывается ПОСЛЕ снятия trap ERR: файлы проекта к Nginx-конфигу отношения
# не имеют, откатывать его из-за них нечего.
write_project_files() {
  info "📝 Запись .env.prod..."
  {
    echo "NODE_ENV=production"
    echo "VIMP_DOMAIN=$DOMAIN"
    echo "VIMP_GAMES_DIR=$GAMES_DIR"
    echo "VIMP_DEDICATED_GAME=$GAME"
    if [[ -n "$AUTH_SERVICE_URL" ]]; then
      echo "VIMP_AUTH_SERVICE_URL=$AUTH_SERVICE_URL"
    fi
    # Значение перезапишется деплоем, если в SERVERS_MATRIX задано поле
    # 'settings' для этого домена: .env.prod генерируется заново на каждом
    # прогоне. Источником истины лучше держать матрицу, а введённое здесь
    # считать стартовым значением до первого деплоя
    echo "VIMP_DEDICATED_ROOM=$ROOM_JSON"
  } > "$TARGET_DIR/.env.prod"

  info "📝 Запись docker-compose.yml..."
  # Тот же том vimp-games, что у лобби-мастера: хранилище скачанных пакетов
  # переживает пересоздание контейнера. Порт слушает только 127.0.0.1 —
  # наружу его отдаёт Nginx.
  cat > "$TARGET_DIR/docker-compose.yml" <<EOF
services:
  master:
    image: $IMAGE_DEFAULT:latest
    container_name: "vimp-$DOMAIN"
    restart: always
    env_file: .env.prod
    ports:
      - "127.0.0.1:$PORT:3002"
    volumes:
      - "vimp-games:$GAMES_DIR"
volumes:
  vimp-games:
EOF
}

check_system_installed

# --- Основной процесс ---
info "🚀 МАСТЕР УСТАНОВКИ DEDICATED-СЕРВЕРА VIMP"

read_domain
read_port
read_email
read_game
read_auth_service_url_optional
read_room_settings

check_auth_placeholder

echo ""
info "Проверка конфигурации:"
echo "  Домен:    $DOMAIN"
echo "  Порт:     $PORT"
echo "  Email:    $EMAIL"
echo "  Игра:     $GAME"
echo "  Auth URL: ${AUTH_SERVICE_URL:-(не задан — игра тянется из npm)}"
echo "  Комната:  $ROOM_JSON"
read -r -p "Нажмите Enter для продолжения..."

# --- Этапы 1-4: каталог проекта, Nginx, SSL (lib/common.sh) ---
ensure_project_dir
provision_nginx_ssl

# Снимаем ловушку: мы успешно закончили, откат больше не нужен
trap - ERR

# --- Этап 5: файлы проекта ---
write_project_files

echo ""
echo "=================================================="
echo "✅ УСПЕХ! Dedicated-сервер подготовлен."
echo "   URL:  https://$DOMAIN"
echo "   Порт: 127.0.0.1:$PORT"
echo "   Игра: $GAME"
echo ""
echo "⚠️  ВАЖНО:"
echo "1. Добавьте сервер в переменную SERVERS_MATRIX в настройках GitHub"
echo "   (Settings -> Secrets and variables -> Variables) с полем"
echo "   \"dedicatedGame\": \"$GAME\" и \"port\": $PORT."
echo "   Без dedicatedGame деплой поднимет здесь обычный лобби-мастер."
echo "2. Перезапустите Action вручную или сделайте push, чтобы запустить деплой."
echo "3. Поднять сервер прямо сейчас, не дожидаясь деплоя:"
echo "   cd $TARGET_DIR && docker compose pull && docker compose up -d"
echo "=================================================="
