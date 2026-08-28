#!/usr/bin/env sh
# Sendsprite one-line installer: curl -fsSL https://sendsprite.com/install.sh | sh
set -eu

DIR="${SENDSPRITE_DIR:-$HOME/sendsprite}"
# Where docker-compose.yml is fetched from. sendsprite.com is itself a
# Sendsprite instance and serves it (and this script) from apps/web/public.
# Point this at your own instance or a raw GitHub URL to install a fork.
BASE_URL="${SENDSPRITE_BASE_URL:-https://sendsprite.com}"

command -v docker >/dev/null 2>&1 || { echo "Docker is required: https://docs.docker.com/get-docker/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required."; exit 1; }

mkdir -p "$DIR" && cd "$DIR"
[ -f docker-compose.yml ] || curl -fsSL "$BASE_URL/docker-compose.yml" -o docker-compose.yml

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
# Sendsprite — written by install.sh. Every option the image understands is
# listed; commented lines show the default. Edit, then: docker compose up -d
# Reference: https://sendsprite.com/docs/self-hosting#environment

# ---- Required ----
APP_URL=$APP_URL
# Encrypts stored AWS/Cloudflare credentials. Changing it makes them unreadable.
APP_SECRET=$(gen 48)
# docker compose only: DATABASE_URL is derived from it.
POSTGRES_PASSWORD=$(gen 32)

# ---- Sign-in (each provider is on when its variables are set) ----
EMAIL_PASSWORD_ENABLED=true
#GOOGLE_CLIENT_ID=
#GOOGLE_CLIENT_SECRET=
#GITHUB_CLIENT_ID=
#GITHUB_CLIENT_SECRET=
# auto = open until the first user exists, then invite-only; or open|invite|closed
SIGNUP_MODE=auto
# Comma-separated emails that always have instance-admin access (lockout escape
# hatch). Unset: the first account to sign up is flagged.
#INSTANCE_ADMIN_EMAILS=

# ---- Behaviour ----
LANDING_ENABLED=true
# inline runs jobs in this container; separate = start the worker profile too.
WORKER_MODE=inline

# ---- SMTP relay (username anything, password = API key) ----
SMTP_ENABLED=true
# Host port published for the relay (the container always listens on 2587).
#SMTP_PORT=587
# Own STARTTLS certificate: host directory with the PEM files, mounted at /certs.
# Unset, a self-signed certificate is generated (clients must skip verify).
#SMTP_TLS_DIR=/etc/letsencrypt/live/mail.example.com
#SMTP_TLS_CERT=/certs/fullchain.pem
#SMTP_TLS_KEY=/certs/privkey.pem
#SMTP_MAX_SIZE=10485760

# ---- AWS / Cloudflare setup ----
# Region preselected in the AWS connect wizard
#AWS_DEFAULT_REGION=us-east-1
# S3 URL of the one-click CloudFormation template (default: Sendsprite's bucket)
#CFN_TEMPLATE_URL=
# Cloudflare OAuth client so Sendsprite can write DNS records itself. Its
# redirect URI must be exactly $APP_URL/api/setup/cloudflare/callback
#CLOUDFLARE_OAUTH_CLIENT_ID=
#CLOUDFLARE_OAUTH_CLIENT_SECRET=
EOF
  chmod 600 .env
  echo "Wrote $DIR/.env (keep APP_SECRET safe — it encrypts your AWS/Cloudflare credentials)."
fi

# A failed pull is fine when the image is already present locally.
docker compose pull || docker image inspect ghcr.io/defy-works/sendsprite:latest >/dev/null 2>&1 || { echo "Image not available yet"; exit 1; }
docker compose up -d
echo
echo "Sendsprite is starting. Open $(grep '^APP_URL=' .env | cut -d= -f2-)/signup to create the first account."
echo "Every option (OAuth sign-in, SMTP TLS, Cloudflare DNS, admin emails) is listed in $DIR/.env; edit it and run: docker compose up -d"
