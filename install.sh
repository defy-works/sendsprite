#!/usr/bin/env sh
# Sendsprite one-line installer: curl -fsSL https://sendsprite.dev/install.sh | sh
set -eu

DIR="${SENDSPRITE_DIR:-$HOME/sendsprite}"
REPO_RAW="https://raw.githubusercontent.com/defy-works/sendsprite/main"

command -v docker >/dev/null 2>&1 || { echo "Docker is required: https://docs.docker.com/get-docker/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required."; exit 1; }

mkdir -p "$DIR" && cd "$DIR"
[ -f docker-compose.yml ] || curl -fsSL "$REPO_RAW/docker-compose.yml" -o docker-compose.yml

if [ ! -f .env ]; then
  printf "Public URL of this instance (e.g. https://mail.example.com) [http://localhost:3000]: "
  read -r APP_URL </dev/tty || APP_URL=""
  APP_URL="${APP_URL:-http://localhost:3000}"
  APP_URL="${APP_URL%/}"
  case "$APP_URL" in
    http://*|https://*) ;;
    *) echo "APP_URL must start with http:// or https:// (got: $APP_URL)"; exit 1 ;;
  esac
  gen() { head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-"$1"; }
  # .env holds APP_SECRET and the DB password: owner-only from the first byte.
  umask 077
  cat > .env <<EOF
APP_URL=$APP_URL
APP_SECRET=$(gen 48)
POSTGRES_PASSWORD=$(gen 32)
EMAIL_PASSWORD_ENABLED=true
SIGNUP_MODE=auto
LANDING_ENABLED=true
SMTP_ENABLED=true
WORKER_MODE=inline
EOF
  chmod 600 .env
  echo "Wrote $DIR/.env (keep APP_SECRET safe — it encrypts your AWS/Cloudflare credentials)."
fi

# A failed pull is fine when the image is already present locally.
docker compose pull || docker image inspect ghcr.io/defy-works/sendsprite:latest >/dev/null 2>&1 || { echo "Image not available yet"; exit 1; }
docker compose up -d
echo
echo "Sendsprite is starting. Open $(grep '^APP_URL=' .env | cut -d= -f2-)/signup to create the first account."
echo "Add Google/GitHub sign-in later by setting GOOGLE_CLIENT_ID/SECRET or GITHUB_CLIENT_ID/SECRET in $DIR/.env and running: docker compose up -d"
