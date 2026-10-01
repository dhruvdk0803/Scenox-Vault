#!/usr/bin/env bash
# Deploy (or update) Scenox Vault on a remote Ubuntu server over SSH — run from your own machine.
#
#   bash deploy/scripts/deploy-remote.sh <user@host> <domain> <acme-email> [owner-email]
#
#   example:
#   bash deploy/scripts/deploy-remote.sh dhruv@188.245.6.249 vault.scenoxlabs.com you@company.com you@company.com
#
# What it does
#   1. packages the current checkout (tracked files only — no .env, node_modules or build output)
#   2. preflight on the server: sudo access, OS, DNS → server IP, ports 80/443 not used by another web server
#   3. uploads the package and unpacks it into /opt/scenox-vault (an existing .env and all data volumes are kept)
#   4. runs deploy/scripts/install.sh non-interactively (Docker, secrets, firewall, build, start, health check)
#   5. first install only: creates the owner account via the CLI (password prompt), so /setup can't be claimed by anyone else
#
# Re-running it later is the update path: new code is unpacked over the old, images are rebuilt,
# migrations run automatically on API start, data and secrets are untouched.
#
# Optional env: OWNER_PASSWORD (non-interactive owner creation), SSH_PORT (default 22), INSTALL_DIR (default /opt/scenox-vault), UPLOAD_DOMAIN (default = domain),
#               SKIP_FIREWALL=1, FORCE_PORTS=1 (skip the 80/443 conflict check)
set -euo pipefail

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
[[ $# -ge 3 ]] || usage
TARGET="$1"
DOMAIN="$2"
ACME_EMAIL="$3"
OWNER_EMAIL="${4:-}"
UPLOAD_DOMAIN="${UPLOAD_DOMAIN:-$DOMAIN}"
SSH_PORT="${SSH_PORT:-22}"
INSTALL_DIR="${INSTALL_DIR:-/opt/scenox-vault}"

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy] %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]] || die "Invalid domain: $DOMAIN"
[[ "$ACME_EMAIL" == *@*.* ]] || die "Invalid e-mail: $ACME_EMAIL"
for bin in ssh scp; do command -v "$bin" >/dev/null || die "$bin not found on this machine"; done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[[ -f docker-compose.yml ]] || die "Run this from a Scenox Vault checkout"

SSH=(ssh -p "$SSH_PORT" -o ServerAliveInterval=30)
# Force a remote TTY on a laptop so sudo/password prompts work (also under Windows Git Bash, where
# stdin may not look like a terminal); CI runs fully non-interactive.
if [[ -n "${CI:-}${GITHUB_ACTIONS:-}" ]]; then TTY=(-T); else TTY=(-tt); fi
SCP=(scp -P "$SSH_PORT" -q)

# ── 1. package ───────────────────────────────────────────────────────────────
PKG="$(mktemp -t scenox-vault.XXXXXX).tar.gz"
trap 'rm -f "$PKG"' EXIT
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  [[ -z "$(git status --porcelain)" ]] || log "Note: uncommitted changes are NOT included (only committed files are deployed)"
  # LF line endings regardless of local Git settings (Windows core.autocrlf would break bash/.env on Linux)
  git -c core.autocrlf=false archive --format=tar.gz -o "$PKG" HEAD
  VERSION="$(git rev-parse --short HEAD)"
else
  tar czf "$PKG" --exclude=node_modules --exclude=.next --exclude=dist --exclude=.env --exclude=.data --exclude=.git .
  VERSION="$(date +%Y%m%d%H%M)"
fi
log "Packaged version $VERSION ($(du -h "$PKG" | cut -f1))"

# ── 2. preflight ─────────────────────────────────────────────────────────────
log "Connecting to $TARGET (you may be asked for your SSH key passphrase / sudo password)"
"${SSH[@]}" "$TARGET" 'true' || die "SSH connection failed"

SERVER_IP="$("${SSH[@]}" "$TARGET" "curl -fsS -4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print \$1}'")"
for d in "$DOMAIN" "$UPLOAD_DOMAIN"; do
  # resolved on the server (works from Windows Git Bash / macOS, which lack getent)
  resolved="$("${SSH[@]}" "$TARGET" "getent ahostsv4 '$d' 2>/dev/null | awk 'NR==1{print \$1}'" || true)"
  if [[ -z "$resolved" ]]; then
    die "$d does not resolve. Create an A record: $d → $SERVER_IP, wait for DNS, then re-run."
  elif [[ "$resolved" != "$SERVER_IP" ]]; then
    log "WARNING: $d resolves to $resolved but the server reports $SERVER_IP (OK only behind a proxy/CDN; Let's Encrypt needs port 80 reachable)"
  else
    log "DNS ok: $d → $SERVER_IP"
  fi
done

if [[ "${FORCE_PORTS:-0}" != "1" ]]; then
  # Ports used by something other than this stack's Caddy container would block HTTPS.
  busy="$("${SSH[@]}" "$TARGET" "sudo ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v docker-proxy || true")"
  if [[ -n "$busy" ]]; then
    printf '%s\n' "$busy" >&2
    die "Ports 80/443 are already used by another program on the server (see above). Stop it (e.g. 'sudo systemctl disable --now nginx' or 'apache2'), or set FORCE_PORTS=1."
  fi
fi

# ── 3. upload + unpack ───────────────────────────────────────────────────────
log "Uploading package"
"${SCP[@]}" "$PKG" "$TARGET:/tmp/scenox-vault.tar.gz"
"${SSH[@]}" "${TTY[@]}" "$TARGET" "sudo mkdir -p '$INSTALL_DIR' && sudo tar xzf /tmp/scenox-vault.tar.gz -C '$INSTALL_DIR' && rm -f /tmp/scenox-vault.tar.gz && sudo find '$INSTALL_DIR/deploy' '$INSTALL_DIR/.env.example' '$INSTALL_DIR/docker-compose.yml' -type f -exec sed -i 's/\\r\$//' {} + && echo '$VERSION' | sudo tee '$INSTALL_DIR/.deployed-version' >/dev/null"

# ── 4. install / update ──────────────────────────────────────────────────────
log "Installing on the server (first build takes a few minutes)"
"${SSH[@]}" "${TTY[@]}" "$TARGET" "cd '$INSTALL_DIR' && sudo APP_DOMAIN='$DOMAIN' UPLOAD_DOMAIN='$UPLOAD_DOMAIN' ACME_EMAIL='$ACME_EMAIL' NONINTERACTIVE=1 INSTALL_DIR='$INSTALL_DIR' SKIP_FIREWALL='${SKIP_FIREWALL:-0}' bash deploy/scripts/install.sh"

# ── 5. owner account (first install only) ────────────────────────────────────
if [[ -n "$OWNER_EMAIL" ]]; then
  users="$("${SSH[@]}" "$TARGET" "cd '$INSTALL_DIR' && sudo docker compose exec -T api node dist/cli.js list-users 2>/dev/null | grep -c '@' || true")"
  if [[ "${users:-0}" == "0" ]]; then
    log "Creating the owner account $OWNER_EMAIL — choose a password (min. 12 characters)"
    if [[ -n "${OWNER_PASSWORD:-}" ]]; then
      # non-interactive (CI): password travels over SSH stdin, so it never appears in CI logs or local argv
      printf '%s' "$OWNER_PASSWORD" | "${SSH[@]}" -T "$TARGET" "cd '$INSTALL_DIR' && sudo docker compose exec -T -e SCENOX_PASSWORD=\"\$(cat)\" api node dist/cli.js create-owner --email '$OWNER_EMAIL' --name 'Owner'"
    else
      "${SSH[@]}" "${TTY[@]}" "$TARGET" "cd '$INSTALL_DIR' && sudo docker compose exec api node dist/cli.js create-owner --email '$OWNER_EMAIL' --name 'Owner'"
    fi
  else
    log "Users already exist; skipping owner creation"
  fi
fi

# ── 6. verify from the outside ───────────────────────────────────────────────
log "Waiting for HTTPS on https://$DOMAIN"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/ready" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
if [[ "$ok" == "1" ]]; then
  log "Live: https://$DOMAIN  (health: https://$DOMAIN/api/ready)"
  if [[ -n "$OWNER_EMAIL" ]]; then log "Sign in at https://$DOMAIN/login as $OWNER_EMAIL"
  else log "Create the owner account NOW at https://$DOMAIN/setup"; fi
else
  die "https://$DOMAIN is not answering yet. On the server: cd $INSTALL_DIR && sudo docker compose ps && sudo docker compose logs caddy api"
fi
