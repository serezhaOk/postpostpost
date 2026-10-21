#!/usr/bin/env bash
# Установка или обновление postpostpost на сервере Ubuntu/Debian одной командой:
#   curl -fsSL https://raw.githubusercontent.com/serezhaOk/postpostpost/main/deploy/install.sh | sudo bash
set -euo pipefail

DIR=/opt/postpostpost
REPO=https://github.com/serezhaOk/postpostpost.git

[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }

if ! command -v docker >/dev/null; then
  echo "→ Ставлю Docker"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }

# На машинах с 1 ГБ памяти (например, бесплатная e2-micro) добавляем swap, чтобы сборка не падала
if [ "$(awk '/MemTotal/{print $2}' /proc/meminfo)" -lt 1500000 ] && [ -z "$(swapon --show)" ]; then
  echo "→ Добавляю swap 1 ГБ"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ -d "$DIR/.git" ]; then
  echo "→ Обновляю код"
  git -C "$DIR" pull --ff-only
else
  echo "→ Скачиваю код"
  git clone "$REPO" "$DIR"
fi
cd "$DIR/deploy"

if [ ! -f .env ]; then
  ip=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  default_domain="$(echo "$ip" | tr . -).sslip.io"
  domain="${DOMAIN:-}"
  if [ -z "$domain" ] && [ -r /dev/tty ] && : </dev/tty 2>/dev/null; then
    read -rp "Домен для сервиса (Enter — $default_domain): " domain </dev/tty || true
  fi
  domain=${domain:-$default_domain}
  password=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-16)
  cat > .env <<ENV
DOMAIN=$domain
PUBLIC_URL=https://$domain
APP_PASSWORD=$password
TIKTOK_MODE=inbox
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ENV
  chmod 600 .env
fi

echo "→ Запускаю"
docker compose up -d --build

# shellcheck disable=SC1091
. ./.env
echo
echo "Готово! Откройте $PUBLIC_URL"
echo "Пароль для входа: $APP_PASSWORD"
echo "(пароль и настройки — в $DIR/deploy/.env)"
