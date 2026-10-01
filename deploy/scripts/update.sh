#!/usr/bin/env bash
# Scenox Vault — update to the latest code.
#
#   deploy/scripts/update.sh            # git pull, rebuild, restart
#   deploy/scripts/update.sh --no-pull  # rebuild from the working tree (local changes / tags)
#   SKIP_BACKUP=1 deploy/scripts/update.sh
#
# Database migrations run automatically when the API container starts (MIGRATE_ON_START=true).
# A database backup is taken first so you can roll back (restore.sh) if needed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f .env ]] || die ".env not found"

if [[ "${1:-}" != "--no-pull" ]]; then
  [[ -d .git ]] || die "not a git checkout; use --no-pull"
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    die "working tree has local changes; commit/stash them or use --no-pull"
  fi
  log "Pulling latest code"
  git pull --ff-only
fi

if [[ "${SKIP_BACKUP:-0}" != "1" ]] && docker compose ps -q postgres | grep -q .; then
  log "Backing up the database before updating"
  "$SCRIPT_DIR/backup.sh"
fi

log "Building images"
docker compose build --pull

log "Restarting services (api applies migrations on start)"
docker compose up -d --remove-orphans

log "Waiting for health"
"$SCRIPT_DIR/healthcheck.sh" --wait 180

docker image prune -f >/dev/null
log "Update complete"
