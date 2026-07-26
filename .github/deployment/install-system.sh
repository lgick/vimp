#!/usr/bin/env bash
# ====================================================
# install-system.sh
# Запускается один раз на новом сервере (Ubuntu 20.04/22.04/24.04)
# перед добавлением новых игровых серверов.
#
# - Поддержка режима dry-run
# - Умное открытие портов (TCP/UDP раздельно)
# - Установка и настройка Fail2Ban
# ====================================================

set -euo pipefail

# ----------------------
# Конфигурация / значения по умолчанию
# ----------------------
DRY_RUN=0
VERBOSE=0

# Исключить эти порты из предложений на открытие
EXCLUDE_PORTS_REGEX='^(22|80|443|53|67|68|631|5353)$'

# Пакеты, обязательные к установке
REQUIRED_PKGS=(
  nginx-full
  libnginx-mod-http-brotli-filter
  libnginx-mod-http-brotli-static
  certbot
  python3-certbot-nginx
  curl
  ufw
  lsof
  openssl
  fail2ban
)

# ----------------------
# Вспомогательные функции
# ----------------------
log() {
  echo -e "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

dbg() {
  if [[ $VERBOSE -eq 1 ]]; then
    echo -e "DEBUG: $*"
  fi
}

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "DRY-RUN: $*"
  else
    eval "$@"
  fi
}

prompt_yes() {
  read -r -p "$1 [y/N]: " ans
  case "$ans" in
    [Yy]|[Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

# ----------------------
# Интерфейс командной строки (CLI)
# ----------------------
usage() {
  cat <<EOF
Использование: $0 [--dry-run] [--verbose]

Опции:
  --dry-run   : вывести действия, НЕ выполнять их
  --verbose   : подробный вывод отладки
  -h|--help   : показать эту справку
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help) usage ;;
    *) echo "Неизвестный аргумент: $1"; usage ;;
  esac
done

# ----------------------
# Проверка прав root
# ----------------------
if [[ $EUID -ne 0 ]]; then
  dbg "Запущено не от root; будет использовать sudo."
fi

# ----------------------
# Установка
# ----------------------
install_pkg() {
  local pkg=$1
  if dpkg -s "$pkg" >/dev/null 2>&1; then
    dbg "Пакет $pkg уже установлен."
    return 0
  fi
  log "Установка пакета: $pkg"
  run "sudo apt-get install -y $pkg"
}

ensure_packages() {
  log "Обновление списков пакетов (apt)..."
  run "sudo apt-get update"
  for p in "${REQUIRED_PKGS[@]}"; do
    install_pkg "$p"
  done
}

ensure_docker() {
  if command -v docker &>/dev/null && docker compose version &>/dev/null; then
    log "Docker и плагин Docker Compose (v2) уже установлены. Пропуск."
    return 0
  fi

  log "Установка или обновление Docker до актуальной версии..."
  run "curl -fsSL https://get.docker.com -o /tmp/get-docker.sh"
  run "sudo sh /tmp/get-docker.sh"
  run "rm -f /tmp/get-docker.sh"
  run "sudo systemctl enable --now docker"
}

# ----------------------
# Порты
# ----------------------
# Надежное извлечение порта из строк типа:
# 0.0.0.0:3000, *:3000, [::]:3000, [::ffff:0.0.0.0]:3000
extract_port() {
  local s="$1"
  # получаем последнее двоеточие и цифры после него в конце строки
  if [[ $s =~ :([0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo ""
  fi
}

# Получение читаемого имени процесса на порту (по возможности)
proc_name_for_port() {
  local port=$1
  # парсим вывод ss users:(("prog",pid=1234,...))
  local name
  name=$(ss -lnutpH 2>/dev/null | grep -E "[:[]${port}[[:space:]]" || true)

  if [[ -z "$name" ]]; then
    echo "unknown"
    return
  fi

  # попытка извлечь имя программы из users:(("NAME",
  # используем grep -F для поиска текста без спецсимволов regex
  if echo "$name" | grep -Fq 'users:(("'; then
    # sed берет первое совпадение
    echo "$name" | sed -E 's/.*users:\(\("([^"]+)".*/\1/' | head -n1
  else
    echo "unknown"
  fi
}

# Открытие публичных портов с учетом протокола (TCP/UDP)
prompt_open_public_ports() {
  log "Сканирование публичных портов (0.0.0.0 / [::])..."

  declare -A port_protocols
  local raw_ss netid state recv send local_addr peer_addr port proto

  raw_ss=$(ss -lnutH 2>/dev/null)

  while read -r netid state recv send local_addr peer_addr; do
    # Публичные интерфейсы
    if [[ "$local_addr" != *"0.0.0.0"* && "$local_addr" != *"[::]"* && "$local_addr" != *"*"* ]]; then
      continue
    fi

    port=$(extract_port "$local_addr")
    [[ -z "$port" ]] && continue

    if echo "$port" | grep -qE "$EXCLUDE_PORTS_REGEX"; then
      dbg "Пропуск исключенного порта: $port ($netid)"
      continue
    fi

    # Нормализация протоколов: tcp6 -> tcp, udp6 -> udp
    if [[ "$netid" == tcp* ]]; then
        proto="tcp"
    elif [[ "$netid" == udp* ]]; then
        proto="udp"
    else
        continue
    fi

    # Добавляем протокол
    if [[ "${port_protocols[$port]:-}" != *"$proto"* ]]; then
        port_protocols[$port]="${port_protocols[$port]:-} $proto"
    fi

  done <<< "$raw_ss"

  local sorted_ports
  sorted_ports=$(echo "${!port_protocols[@]}" | tr ' ' '\n' | sort -n)

  if [[ -z "$sorted_ports" ]]; then
    log "Публичных портов не найдено."
    return 0
  fi

  log "Обнаружены публичные порты:"

  for p in $sorted_ports; do
    local protos="${port_protocols[$p]}"
    local proc
    proc=$(proc_name_for_port "$p")

    # Убираем лишние пробелы
    protos=$(echo "$protos" | xargs)
    echo "  - Порт $p (Процесс: $proc, Протоколы: $protos)"

    # Логика раздельного опроса

    # 1. Проверяем TCP
    if [[ "$protos" == *"tcp"* ]]; then
      if prompt_yes "    > [TCP] Открыть порт $p/tcp?"; then
        log "Открытие порта $p/tcp..."
        run "sudo ufw allow $p/tcp >/dev/null || true"
      else
        log "Пропуск открытия порта $p (tcp)."
      fi
    fi

    # 2. Проверяем UDP
    if [[ "$protos" == *"udp"* ]]; then
      if prompt_yes "    > [UDP] Открыть порт $p/udp?"; then
        log "Открытие порта $p/udp..."
        run "sudo ufw allow $p/udp >/dev/null || true"
      else
        log "Пропуск открытия порта $p (udp)."
      fi
    fi

  done
}

# ----------------------
# Firewall & Fail2Ban
# ----------------------
enable_firewall() {
  log "Настройка UFW по умолчанию: запретить входящие, разрешить исходящие"
  run "sudo ufw default deny incoming"
  run "sudo ufw default allow outgoing"

  log "Разрешение базовых портов (ssh, http, https)"
  run "sudo ufw allow ssh >/dev/null || true"
  run "sudo ufw allow 'Nginx Full' >/dev/null || true"

  log "Включение UFW..."
  run "sudo ufw --force enable"
  dbg "Статус UFW: $(sudo ufw status verbose 2>/dev/null || true)"
}

configure_fail2ban() {
  local cfg="/etc/fail2ban/jail.local"
  log "Настройка Fail2Ban..."

 if [[ -f "$cfg" ]]; then
    dbg "Конфигурация $cfg уже существует, пропускаем создание."

    # Проверяем статус (read-only), подавляем ошибки (|| echo), чтобы set -e не остановил скрипт
    local f2b_status
    f2b_status=$(systemctl is-active fail2ban 2>/dev/null || echo "inactive")

    local f2b_enabled
    f2b_enabled=$(systemctl is-enabled fail2ban 2>/dev/null || echo "disabled")

    log "Fail2Ban уже настроен. Статус сервиса: $f2b_status (autostart: $f2b_enabled)"
    return 0
  fi

  log "Создание конфигурации $cfg (SSH + Nginx)"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "# (fail2ban config skipped in dry-run)"
    return 0
  fi

  # Создаем jail.local, чтобы не трогать системный jail.conf
  sudo tee "$cfg" >/dev/null <<EOF
# ==========================================
# Fail2Ban конфиг
# ==========================================

[DEFAULT]
# Время блокировки IP после превышения лимита
bantime = 1h

# Период, в течение которого считаются попытки
findtime = 10m

# Количество ошибок до бана
maxretry = 5

# Автоматически выбирать лучший метод чтения логов (systemd/file)
backend = auto

# Разрешить банить IPv6 адреса
allowipv6 = true

# Не банить себя
ignoreip = 127.0.0.1/8 ::1

# SSH — защита от перебора паролей
[sshd]
enabled = true
logpath = /var/log/auth.log

# NGINX — защита HTTP авторизации (попытки подобрать пароль)
[nginx-http-auth]
enabled = true
logpath = /var/log/nginx/error.log

# NGINX — защита от ботов, сканирования, перебора URL (404, 403, SQLi, сканеры)
[nginx-botsearch]
enabled = true
logpath = /var/log/nginx/access.log

# Повышенный лимит, т.к. 404 ошибок может быть больше
maxretry = 10
EOF

  log "Перезапуск Fail2Ban для применения настроек..."
  run "sudo systemctl enable fail2ban"
  run "sudo systemctl restart fail2ban"
}

# ----------------------
# DH Params
# ----------------------
generate_dhparam() {
  local dhfile="/etc/letsencrypt/ssl-dhparams.pem"
  if [[ -f "$dhfile" ]]; then
    dbg "Файл параметров DH уже существует: $dhfile"
    return 0
  fi
  log "Генерация параметров Диффи-Хеллмана (2048 бит). Это может занять 10-60 сек..."
  run "sudo mkdir -p /etc/letsencrypt"
  run "sudo openssl dhparam -out $dhfile 2048"
  log "Параметры DH записаны в $dhfile"
}

write_nginx_template() {
  local dest="/etc/nginx/vimp.template"
  log "Запись шаблона Nginx в $dest"

  if [[ $DRY_RUN -eq 1 ]]; then
    cat <<'EOF'
# (шаблон был бы записан здесь в режиме dry-run)
EOF
    return 0
  fi

  sudo tee "$dest" >/dev/null <<'EOF'
# =================================================================
# ШАБЛОН СЕРВЕРА VIMP (мастер: лобби, сигналинг WebRTC, статика)
# =================================================================

# 1. Редирект HTTP -> HTTPS
server {
  listen 80;
  server_name __DOMAIN__;
  return 301 https://$host$request_uri;
}

# 2. Основной HTTPS сервер
server {
  listen 443 ssl http2;
  server_name __DOMAIN__;

  # --- SSL ---
  ssl_certificate /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  # --- ЗАГОЛОВКИ БЕЗОПАСНОСТИ (Этап 5.4, см. docs/deployment.md) ---
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options DENY always;
  add_header Referrer-Policy "no-referrer" always;

  # --- Content Security Policy ---
  # Source of truth политики — src/config/master.js (security.csp):
  # 'wasm-unsafe-eval' — компиляция WASM-ядра; worker-src blob: — Worker хоста;
  # connect-src wss: — сигнальный WebSocket мастера (WebRTC CSP не гейтит);
  # data: — PixiJS проверяет поддержку ImageBitmap фетчем тестового data:-URL.
  add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' wss: data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;

  # --- СЖАТИЕ (Brotli & Gzip) ---
  # Brotli, если браузер клиента его поддерживает.
  brotli on;
  brotli_comp_level 6;
  brotli_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;

  # Gzip для старых браузеров.
  gzip on;
  gzip_vary on;
  gzip_proxied any;
  gzip_comp_level 6;
  gzip_min_length 256;
  gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;

  # --- НАСТРОЙКИ ПРОКСИ ---
  client_max_body_size 1m;
  proxy_buffering off;
  proxy_read_timeout 90s;
  proxy_send_timeout 90s;
  proxy_connect_timeout 75s;

  # --- МАРШРУТИЗАЦИЯ В DOCKER ---
  location / {
    # Трафик идет на локальный порт, где висит Docker-контейнер
    proxy_pass http://127.0.0.1:__PORT__;

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;

    # Forwarded headers
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_cache_bypass $http_upgrade;
    proxy_no_cache $http_upgrade;
  }
}
EOF
}

# ----------------------
# Основной поток выполнения
# ----------------------
log "СТАРТ: install-system"

ensure_packages
ensure_docker

prompt_open_public_ports
enable_firewall
configure_fail2ban
generate_dhparam
write_nginx_template

log "ГОТОВО: первоначальная настройка завершена."

if [[ $DRY_RUN -eq 1 ]]; then
  log "Примечание: был включен режим dry-run (тестовый прогон); изменения не применялись."
fi
