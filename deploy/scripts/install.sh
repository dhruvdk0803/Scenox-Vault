#!/usr/bin/env bash
# Scenox Vault — installer for a fresh Ubuntu 22.04 / 24.04 server.
#
#   sudo bash deploy/scripts/install.sh
#
# What it does (safe to re-run):
#   1. installs Docker Engine + compose plugin (official apt repo) if missing
#   2. puts the project in $INSTALL_DIR (default /opt/scenox-vault)
#   3. creates .env with freshly generated secrets (an existing .env is never overwritten)
#   4. opens ufw ports 22 (or your sshd port), 80, 443/tcp, 443/udp
#   5. builds and starts the stack
#
# Non-interactive:  APP_DOMAIN=app.example.com UPLOAD_DOMAIN=upload.example.com \
#                   ACME_EMAIL=you@example.com NONINTERACTIVE=1 sudo -E bash deploy/scripts/install.sh
# Optional env: INSTALL_DIR, REPO_URL (git clone source when run outside a checkout), SKIP_FIREWALL=1
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/scenox-vault}"
REPO_URL="${REPO_URL:-}"
NONINTERACTIVE="${NONINTERACTIVE:-0}"
SKIP_FIREWALL="${SKIP_FIREWALL:-0}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0"

# ── 1. OS check ──────────────────────────────────────────────────────────────
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]] || [[ "${VERSION_ID:-}" != "22.04" && "${VERSION_ID:-}" != "24.04" ]]; then
    warn "Tested on Ubuntu 22.04/24.04; detected ${PRETTY_NAME:-unknown}. Continuing anyway."
  fi
fi

# ── 2. Docker Engine + compose plugin ────────────────────────────────────────
install_docker() {
  log "Installing Docker Engine and the compose plugin"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg openssl ufw
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  local arch codename
  arch="$(dpkg --print-architecture)"
  codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  [[ -n "$codename" ]] || die "Cannot determine Ubuntu codename"
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

if docker compose version >/dev/null 2>&1; then
  log "Docker + compose plugin already installed ($(docker --version))"
else
  install_docker
fi
command -v openssl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y openssl; }

# ── 3. Project directory ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ -f "$INSTALL_DIR/docker-compose.yml" ]]; then
  log "Using existing installation in $INSTALL_DIR"
elif [[ -f "$SRC_DIR/docker-compose.yml" ]]; then
  if [[ "$SRC_DIR" == "$INSTALL_DIR" ]]; then
    log "Running from $INSTALL_DIR"
  else
    log "Copying project from $SRC_DIR to $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    cp -a "$SRC_DIR/." "$INSTALL_DIR/"
  fi
elif [[ -n "$REPO_URL" ]]; then
  command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }
  log "Cloning $REPO_URL into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
else
  die "Run this script from a checkout of the repository, or set REPO_URL=<git url>."
fi
cd "$INSTALL_DIR"

# ── 4. .env with generated secrets ───────────────────────────────────────────
ask() { # ask VAR "prompt" "default"
  local var="$1" prompt="$2" def="${3:-}" val="${!1:-}"
  if [[ -n "$val" ]]; then return 0; fi
  if [[ "$NONINTERACTIVE" == "1" ]]; then printf -v "$var" '%s' "$def"; return 0; fi
  read -r -p "$prompt${def:+ [$def]}: " val || true
  printf -v "$var" '%s' "${val:-$def}"
}

# Replace KEY=... in .env (value is written verbatim; secrets are hex so no escaping issues).
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" 'BEGIN{done=0} $0 ~ "^"k"=" && !done {print k"="v; done=1; next} {print} END{if(!done) print k"="v}' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

valid_domain() { [[ "$1" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]]; }

if [[ -f .env ]] && grep -q '^SESSION_SECRET=.\{32,\}' .env; then
  log ".env already exists with secrets; leaving it untouched"
  APP_DOMAIN="$(grep -E '^APP_DOMAIN=' .env | head -1 | cut -d= -f2-)"
  UPLOAD_DOMAIN="$(grep -E '^UPLOAD_DOMAIN=' .env | head -1 | cut -d= -f2-)"
else
  [[ -f .env.example ]] || die ".env.example not found in $INSTALL_DIR"
  [[ -f .env ]] && cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
  cp .env.example .env
  chmod 600 .env

  ask APP_DOMAIN "Admin domain (e.g. app.example.com)" ""
  valid_domain "${APP_DOMAIN:-}" || die "Invalid admin domain: '${APP_DOMAIN:-}'"
  ask UPLOAD_DOMAIN "Client upload domain (blank = same as admin = single-domain mode)" ""
  UPLOAD_DOMAIN="${UPLOAD_DOMAIN:-$APP_DOMAIN}"
  valid_domain "$UPLOAD_DOMAIN" || die "Invalid upload domain: '$UPLOAD_DOMAIN'"
  ask ACME_EMAIL "E-mail for TLS certificate notices" ""
  [[ "${ACME_EMAIL:-}" == *@*.* ]] || die "Invalid e-mail: '${ACME_EMAIL:-}'"

  set_env APP_DOMAIN "$APP_DOMAIN"
  set_env UPLOAD_DOMAIN "$UPLOAD_DOMAIN"
  set_env ACME_EMAIL "$ACME_EMAIL"
  if [[ "$UPLOAD_DOMAIN" == "$APP_DOMAIN" ]]; then
    set_env UPLOAD_HOST ""        # single-domain: do not hide the admin UI
  else
    set_env UPLOAD_HOST "$UPLOAD_DOMAIN"
  fi
  set_env NODE_ENV production
  set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  set_env SESSION_SECRET "$(openssl rand -hex 32)"
  set_env ENCRYPTION_KEY "$(openssl rand -hex 32)"
  log "Generated .env with new secrets (mode 600). BACK IT UP: ENCRYPTION_KEY cannot be recovered."
fi
chmod 600 .env

# ── 5. DNS sanity check (warning only) ───────────────────────────────────────
public_ip="$(curl -fsS -4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
for d in "$APP_DOMAIN" "$UPLOAD_DOMAIN"; do
  resolved="$(getent ahostsv4 "$d" 2>/dev/null | awk 'NR==1{print $1}' || true)"
  if [[ -z "$resolved" ]]; then
    warn "$d does not resolve yet. Create an A record -> ${public_ip:-the server IP} before HTTPS can be issued."
  elif [[ -n "$public_ip" && "$resolved" != "$public_ip" ]]; then
    warn "$d resolves to $resolved but the server public IP is $public_ip (fine if behind a proxy/CDN)."
  fi
done

# ── 6. Firewall ──────────────────────────────────────────────────────────────
if [[ "$SKIP_FIREWALL" != "1" ]] && command -v ufw >/dev/null 2>&1; then
  ssh_port="$(sshd -T 2>/dev/null | awk '$1=="port"{print $2; exit}' || true)"
  ssh_port="${ssh_port:-22}"
  log "Configuring ufw (ssh ${ssh_port}, 80, 443/tcp, 443/udp)"
  ufw allow "${ssh_port}/tcp" >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw status | grep -q "Status: active" || ufw --force enable >/dev/null
  warn "Docker publishes ports itself and bypasses ufw rules; only Caddy publishes ports in this stack, so that is fine."
fi

# ── 7. Build + start ─────────────────────────────────────────────────────────
log "Building images and starting the stack (first build takes a few minutes)"
docker compose up -d --build

log "Waiting for the API to become healthy"
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q api)" 2>/dev/null || echo starting)"
  [[ "$status" == "healthy" ]] && break
  sleep 5
done
[[ "${status:-}" == "healthy" ]] || { docker compose ps; die "API did not become healthy. Check: docker compose logs api"; }

cat <<DONE

════════════════════════════════════════════════════════════
  Scenox Vault is running.
════════════════════════════════════════════════════════════
  1. Create the owner account (first visit only):
       https://${APP_DOMAIN}/setup
  2. Client portals are served on:  https://${UPLOAD_DOMAIN}/u/<token>
  3. Back up now:  ${INSTALL_DIR}/.env  (secrets)  and schedule deploy/scripts/backup.sh
       0 3 * * * ${INSTALL_DIR}/deploy/scripts/backup.sh >> /var/log/scenox-backup.log 2>&1
  4. Health:   ${INSTALL_DIR}/deploy/scripts/healthcheck.sh
  5. Logs:     cd ${INSTALL_DIR} && docker compose logs -f
  6. Optional: ClamAV  -> docs/DEPLOYMENT.md#clamav
  Certificates are issued automatically on first request; if DNS was not ready, run: docker compose restart caddy
DONE
