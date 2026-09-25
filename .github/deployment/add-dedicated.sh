#!/bin/bash
# ====================================================
# add-dedicated.sh
# Добавление dedicated-сервера vimp (один матч в Node-процессе, без лобби
# и без OAuth). Готовит только домен: папку проекта, Nginx и SSL.
# Всё о самой игре — какая игра, её настройки комнаты — задаёт
# SERVERS_MATRIX (dedicatedGame, settings): деплой пишет .env.prod и
# docker-compose.yml заново на каждом прогоне, поэтому спрашивать это здесь
# бессмысленно, а набор настроек у каждой игры свой.
# От add-server.sh отличается тем, что не спрашивает auth-URL и не поднимает
# auth-стек: dedicated-серверу OAuth не нужен, а реестр (для игры, названной
# по id) деплой передаёт ему из vars.AUTH_SERVICE_URL.
# ====================================================

set -euo pipefail
IFS=$'\n\t'

# --- Подключение общей библиотеки ---
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

# Устанавливаем ловушку на любую ошибку
trap 'cleanup' ERR

check_system_installed

# --- Основной процесс ---
info "🚀 МАСТЕР УСТАНОВКИ DEDICATED-СЕРВЕРА VIMP"

read_domain
read_port
read_email

echo ""
info "Проверка конфигурации:"
echo "  Домен:    $DOMAIN"
echo "  Порт:     $PORT"
echo "  Email:    $EMAIL"
read -r -p "Нажмите Enter для продолжения..."

# --- Этапы 1-4: каталог проекта, Nginx, SSL (lib/common.sh) ---
# AUTH_SERVICE_URL пуст: CSP dedicated-сервера auth-origin не нужен,
# WebSocket /game покрывает 'self' wss:
ensure_project_dir
provision_nginx_ssl

# Снимаем ловушку: мы успешно закончили, откат больше не нужен
trap - ERR

# Публичный IP для подсказки SERVERS_MATRIX: скрипт запущен на том самом
# сервере. Не определился (нет curl или сети) — остаётся заглушка, которую
# нужно заменить руками: с ней SSH-шаг деплоя упадёт
PUBLIC_IP=$(curl -4 -fsS -m 5 https://ifconfig.me 2>/dev/null || true)
[[ ! "$PUBLIC_IP" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && PUBLIC_IP="<IP этого сервера>"

echo ""
echo "=================================================="
echo "✅ УСПЕХ! Домен dedicated-сервера подготовлен."
echo "   URL:  https://$DOMAIN"
echo "   Порт: 127.0.0.1:$PORT"
echo ""
echo "⚠️  ВАЖНО: сервер ещё не запущен — его поднимет деплой."
echo "1. Добавьте сервер в переменную SERVERS_MATRIX в настройках GitHub"
echo "   (Settings -> Secrets and variables -> Variables):"
echo ""
echo "     {"
echo "       \"ip\": \"$PUBLIC_IP\","
echo "       \"domain\": \"$DOMAIN\","
echo "       \"port\": $PORT,"
echo "       \"dedicatedGame\": \"<npm-пакет игры, например @vimp-games/snakes>\""
echo "     }"
echo ""
echo "   Без dedicatedGame деплой поднимет здесь обычный лобби-мастер."
echo "   Необязательное поле \"settings\" — настройки комнаты; какие поля"
echo "   имеют смысл, зависит от игры (см. её документацию)."
echo "2. Перезапустите Action вручную или сделайте push, чтобы запустить деплой."
echo "=================================================="
