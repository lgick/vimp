#!/bin/bash
# ====================================================
# add-server.sh
# Добавление нового игрового сервера vimp.
# ====================================================

set -euo pipefail
IFS=$'\n\t'

# --- Глобальные переменные (инициализация для set -u) ---
TEMPLATE="/etc/nginx/vimp.template"
DEFAULT_EMAIL="admin@example.com"
PROJECTS_ROOT="$HOME/vimp_projects"
DOMAIN=""
PORT=""
EMAIL=""
CONFIG_FILE=""
SYMLINK_FILE=""

# --- Логирование ---
info()  { echo -e "ℹ️  $*"; }
warn()  { echo -e "⚠️  $*"; }
error() { echo -e "❌ $*"; }

# --- Проверка предварительных требований системы ---
check_system_installed() {
  local missing=0

  # 1. Проверка шаблона Nginx (создается в install-system)
  if [ ! -f "$TEMPLATE" ]; then
    error "Файл шаблона Nginx ($TEMPLATE) не найден."
    missing=1
  fi

  # 2. Проверка Certbot
  if ! command -v certbot &> /dev/null; then
    error "Certbot не установлен."
    missing=1
  fi

  # 3. Проверка Docker
  if ! command -v docker &> /dev/null; then
    error "Docker не установлен."
    missing=1
  fi

  if [ $missing -eq 1 ]; then
    echo ""
    echo "========================================================"
    echo "⛔ КРИТИЧЕСКАЯ ОШИБКА: Система не настроена."
    echo "   Похоже, вы забыли запустить скрипт первичной настройки."
    echo ""
    echo "   👉 РЕШЕНИЕ: Запустите ./install-system.sh один раз."
    echo "========================================================"
    exit 1
  fi
}

# --- Rollback (Откат при ошибке) ---
cleanup() {
  # Сначала проверяем, были ли установлены переменные, чтобы не удалять /etc/nginx/sites-enabled/
  if [[ -n "$SYMLINK_FILE" && -L "$SYMLINK_FILE" ]]; then
    sudo rm -f "$SYMLINK_FILE" && info "Откат: Симлинк удален"
  fi

  if [[ -n "$CONFIG_FILE" && -f "$CONFIG_FILE" ]]; then
    sudo rm -f "$CONFIG_FILE" && info "Откат: Конфиг удален"
  fi

  # Пытаемся перезагрузить Nginx, если конфиг был сломан
  if sudo nginx -t >/dev/null 2>&1; then
    sudo systemctl reload nginx
    info "Откат: Nginx перезагружен."
  else
    error "КРИТИЧЕСКОЕ СОСТОЯНИЕ: Даже после отката Nginx содержит ошибки!"
    sudo nginx -t
  fi
}

# Устанавливаем ловушку на любую ошибку
trap 'cleanup' ERR

# Экранирование для sed
escape_sed() { printf '%s\n' "$1" | sed 's/[&/\]/\\&/g'; }

# --- Функции ввода ---
read_domain() {
  while true; do
    read -r -p "🌐 Домен (например, ru1.example.com): " DOMAIN
    DOMAIN="${DOMAIN// /}" # Удаление пробелов
    [[ -z "$DOMAIN" ]] && warn "Домен не может быть пустым" && continue
    break
  done

  CONFIG_FILE="/etc/nginx/sites-available/$DOMAIN"
  SYMLINK_FILE="/etc/nginx/sites-enabled/$DOMAIN"

  if [ -f "$CONFIG_FILE" ]; then
    warn "Конфигурация для $DOMAIN уже существует."
    read -r -p "   Перезаписать? [y/N]: " OVERWRITE
    [[ ! "$OVERWRITE" =~ ^[Yy]$ ]] && info "Отмена." && exit 0

    # Удаляем сразу, это безопасно, так как пользователь подтвердил
    sudo rm -f "$CONFIG_FILE" "$SYMLINK_FILE"
    info "Старый конфиг удален."
  fi
}

read_port() {
  while true; do
    read -r -p "🔌 Локальный порт Docker (1024-65535): " PORT

    # Проверка на число
    [[ ! "$PORT" =~ ^[0-9]+$ ]] && warn "Введите число." && continue

    # Проверка диапазона (арифметический контекст)
    ((PORT < 1024 || PORT > 65535)) && warn "Порт вне диапазона (1024-65535)." && continue

    # Проверка занятости порта (TCP и UDP)
    # set +e внутри if не нужен, так как grep возвращает статус 1 (не найдено),
    # но if обрабатывает это корректно без падения скрипта.
    if ss -lnutH | grep -E ":$PORT([[:space:]]|$)" >/dev/null; then
      warn "Порт $PORT занят."
      read -r -p "   Всё равно использовать? [y/N]: " CONFIRM
      [[ ! "$CONFIRM" =~ ^[Yy]$ ]] && continue
    fi
    break
  done
}

read_email() {
  read -r -p "📧 Email для SSL [по умолчанию: $DEFAULT_EMAIL]: " EMAIL_INPUT
  EMAIL="${EMAIL_INPUT:-$DEFAULT_EMAIL}"
}

check_system_installed

# --- Основной процесс ---
info "🚀 МАСТЕР УСТАНОВКИ СЕРВЕРА VIMP"

read_domain
read_port
read_email

echo ""
info "Проверка конфигурации:"
echo "  Домен: $DOMAIN"
echo "  Порт:  $PORT"
echo "  Email: $EMAIL"
read -r -p "Нажмите Enter для продолжения..."

# --- Этап 1: Создание папки проекта (если не была создана ранее) ---
TARGET_DIR="$PROJECTS_ROOT/$DOMAIN"
if [ ! -d "$TARGET_DIR" ]; then
  info "📂 Создание директории для проекта: $TARGET_DIR"
  mkdir -p "$TARGET_DIR"
  # Права текущего пользователя, чтобы GitHub Runner (через SSH) мог писать туда
  sudo chown -R $USER:$USER "$TARGET_DIR"
fi

# --- Этап 2: Временный HTTP конфиг ---
info "1️⃣ Создание временного HTTP конфига..."
sudo tee "$CONFIG_FILE" >/dev/null <<EOF
server {
  listen 80;
  server_name $DOMAIN;

  location / {
    return 200 "VIMP Server: Ожидание настройки SSL...";
    add_header Content-Type text/plain;
  }
}
EOF

sudo ln -sf "$CONFIG_FILE" "$SYMLINK_FILE"

# Проверяем конфиг. Если ошибка — сработает trap
sudo nginx -t >/dev/null
sudo systemctl reload nginx

# --- Этап 3: Получение SSL ---
info "2️⃣ Запрос SSL сертификата..."
# Если certbot упадет, сработает trap и удалит конфиг
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"

# --- Этап 4: Финальный HTTPS конфиг ---
info "3️⃣ Применение финальной конфигурации..."
ESC_DOMAIN=$(escape_sed "$DOMAIN")
sudo sed -e "s/__DOMAIN__/$ESC_DOMAIN/g" -e "s/__PORT__/$PORT/g" "$TEMPLATE" | sudo tee "$CONFIG_FILE" >/dev/null

# --- Завершение ---
info "🔄 Финальная перезагрузка Nginx..."
sudo nginx -t >/dev/null
sudo systemctl reload nginx

# Снимаем ловушку: мы успешно закончили, откат больше не нужен
trap - ERR

echo ""
echo "=================================================="
echo "✅ УСПЕХ! Сервер подготовлен."
echo "   URL:  https://$DOMAIN"
echo "   Порт: 127.0.0.1:$PORT"
echo ""
echo "⚠️  ВАЖНО:"
echo "1. Добавьте этот сервер в переменную SERVERS_MATRIX в настройках GitHub"
echo "   (Settings -> Secrets and variables -> Variables)."
echo "   Убедитесь, что 'port' в JSON равен $PORT!"
echo "2. Перезапустите Action вручную или сделайте push, чтобы запустить деплой."
echo "=================================================="
