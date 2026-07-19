#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/JuNglEKZN/local-clipboard.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/local-clipboard}"
APP_PORT="${APP_PORT:-8080}"
BIND_ADDRESS="${BIND_ADDRESS:-0.0.0.0}"
TIMEZONE="${TIMEZONE:-Europe/Amsterdam}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root: sudo bash install-proxmox.sh"
  exit 1
fi

APP_PASSWORD="${APP_PASSWORD:-$(openssl rand -base64 24)}"
API_TOKEN="${API_TOKEN:-$(openssl rand -base64 32)}"
SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -base64 48)}"

echo "Installing system packages..."
apt update
apt install -y ca-certificates curl git openssl

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

systemctl enable --now docker

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "Docker Compose is not available after Docker installation."
  exit 1
fi

echo "Cloning Local Clipboard..."
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

cat > .env <<EOF
APP_HOST=0.0.0.0
APP_PORT=$APP_PORT
BIND_ADDRESS=$BIND_ADDRESS

APP_PASSWORD=$APP_PASSWORD
API_TOKEN=$API_TOKEN
SESSION_SECRET=$SESSION_SECRET

SESSION_SECURE=false
SESSION_TTL_SECONDS=604800

MAX_ENTRY_BYTES=512000
MAX_HISTORY_ITEMS=50
RETENTION_DAYS=30
MAX_DATABASE_BYTES=104857600
DATABASE_PATH=/data/clipboard.db
TIMEZONE=$TIMEZONE
DEV_MODE=false
LOGIN_RATE_LIMIT=8
LOGIN_RATE_WINDOW_SECONDS=300
EOF

echo "Starting Local Clipboard..."
$COMPOSE up -d --build

SERVER_IP="$(hostname -I | awk '{print $1}')"

echo
echo "Local Clipboard is installed."
echo "Open: http://${SERVER_IP}:${APP_PORT}"
echo
echo "APP_PASSWORD:"
echo "$APP_PASSWORD"
echo
echo "API_TOKEN:"
echo "$API_TOKEN"
echo
echo "Save these values now. They are also stored in: $INSTALL_DIR/.env"
