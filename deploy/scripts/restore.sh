#!/usr/bin/env bash
# Scenox Vault — restore the PostgreSQL database from a backup made by backup.sh.
#
#   deploy/scripts/restore.sh /var/backups/scenox-vault/scenox-db-20250101T030000Z.dump
#   deploy/scripts/restore.sh <dump> --yes          # skip the confirmation (automation)
#
# DESTRUCTIVE: replaces ALL current data in the database. Uploaded files are NOT touched;
# restore them separately (rsync/rclone back into the upload_data volume) so that DB rows and
# files on disk match.
#
# Full disaster recovery on a new server:
#   1. run install.sh (or copy the project), then replace .env with the one from scenox-env-*.tar.gz
#      (the SAME ENCRYPTION_KEY / SESSION_SECRET are required for portal links and sessions)
#   2. docker compose up -d postgres redis
#   3. restore.sh <dump>
#   4. restore uploaded files into the upload_data volume, then docker compose up -d
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

log() { printf '%s [restore] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

DUMP="${1:-}"
ASSUME_YES="${2:-}"
[[ -n "$DUMP" && -f "$DUMP" ]] || die "usage: $0 <dump-file> [--yes]"
[[ -f .env ]] || die ".env not found in $ROOT"

env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
PGUSER="$(env_get POSTGRES_USER)"; PGUSER="${PGUSER:-scenox}"
PGDB="$(env_get POSTGRES_DB)";     PGDB="${PGDB:-scenox}"

docker compose exec -T postgres pg_restore --list < "$DUMP" > /dev/null || die "$DUMP is not a valid pg_dump custom-format archive"

echo "This will ERASE database '$PGDB' and replace it with:"
echo "  $DUMP ($(du -h "$DUMP" | cut -f1))"
if [[ "$ASSUME_YES" != "--yes" ]]; then
  read -r -p "Type the database name ($PGDB) to confirm: " answer
  [[ "$answer" == "$PGDB" ]] || die "confirmation did not match; aborting"
fi

log "Stopping api, worker and web"
docker compose stop caddy web worker api >/dev/null 2>&1 || true
docker compose up -d postgres redis >/dev/null
for _ in $(seq 1 30); do
  docker compose exec -T postgres pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1 && break
  sleep 2
done

log "Restoring (drop + recreate objects)"
# --clean --if-exists drops existing objects; --no-owner avoids role mismatches on a new server.
docker compose exec -T postgres pg_restore -U "$PGUSER" -d "$PGDB" --clean --if-exists --no-owner --exit-on-error < "$DUMP"

log "Starting the stack (pending migrations are applied by the API on start)"
docker compose up -d
log "Restore complete. Verify with deploy/scripts/healthcheck.sh and by opening the dashboard."
