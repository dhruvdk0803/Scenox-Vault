#!/usr/bin/env bash
# Scenox Vault — backup.
#
#   deploy/scripts/backup.sh
#
# Produces in $BACKUP_DIR (default /var/backups/scenox-vault):
#   scenox-db-<ts>.dump        pg_dump custom format (restore with restore.sh)
#   scenox-env-<ts>.tar.gz     .env (secrets!) + deploy/Caddyfile      (mode 600)
#   scenox-caddy-<ts>.tar.gz   Caddy data volume (TLS account + certificates)
# Optionally copies uploaded files (immutable, so copy — never delete — semantics):
#   BACKUP_RSYNC_TARGET=user@host:/backups/scenox/uploads     (rsync over ssh)
#   BACKUP_RCLONE_REMOTE=remote:bucket/scenox/uploads         (any rclone backend: S3, B2, R2, SFTP...)
# Old backups are removed after RETENTION_DAYS (default 14).
#
# Cron (daily 03:00):
#   0 3 * * * /opt/scenox-vault/deploy/scripts/backup.sh >> /var/log/scenox-backup.log 2>&1
#
# SECURITY: the .env archive contains ENCRYPTION_KEY and SESSION_SECRET. Store backups encrypted
# and off-box. Without a DB dump you lose all metadata; without the files you lose the uploads.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/scenox-vault}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_RSYNC_TARGET="${BACKUP_RSYNC_TARGET:-}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"

log() { printf '%s [backup] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

[[ -f .env ]] || die ".env not found in $ROOT"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "RETENTION_DAYS must be a number"

# Read only the variables we need (do not `source` .env: values may contain spaces or quotes).
env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
PGUSER="$(env_get POSTGRES_USER)"; PGUSER="${PGUSER:-scenox}"
PGDB="$(env_get POSTGRES_DB)";     PGDB="${PGDB:-scenox}"

# one backup at a time
exec 9>"/tmp/scenox-backup.lock"
flock -n 9 || die "another backup is already running"

umask 077
mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# ── 1. PostgreSQL ────────────────────────────────────────────────────────────
log "Dumping database $PGDB"
DB_FILE="$BACKUP_DIR/scenox-db-$TS.dump"
docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$PGDB" --format=custom --compress=6 > "$DB_FILE.partial"
# verify the archive is readable before declaring success
docker compose exec -T postgres pg_restore --list < "$DB_FILE.partial" > /dev/null || die "dump verification failed"
mv "$DB_FILE.partial" "$DB_FILE"
log "Database dump: $DB_FILE ($(du -h "$DB_FILE" | cut -f1))"

# ── 2. Configuration + secrets ───────────────────────────────────────────────
log "Archiving .env and Caddyfile"
tar czf "$BACKUP_DIR/scenox-env-$TS.tar.gz" .env deploy/Caddyfile docker-compose.yml

# ── 3. Caddy certificate store ───────────────────────────────────────────────
if docker compose ps -q caddy | grep -q .; then
  log "Archiving Caddy data volume"
  docker compose exec -T caddy tar czf - -C /data . > "$BACKUP_DIR/scenox-caddy-$TS.tar.gz"
fi

# ── 4. Uploaded files (optional) ─────────────────────────────────────────────
if [[ -n "$BACKUP_RSYNC_TARGET" || -n "$BACKUP_RCLONE_REMOTE" ]]; then
  API_CID="$(docker compose ps -q api)"
  [[ -n "$API_CID" ]] || die "api container not found"
  SRC="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/storage"}}{{.Source}}{{end}}{{end}}' "$API_CID")"
  [[ -d "$SRC" ]] || die "cannot locate upload volume on host (got '$SRC'); run as root"

  if [[ -n "$BACKUP_RSYNC_TARGET" ]]; then
    command -v rsync >/dev/null || die "rsync not installed"
    log "rsync uploads -> $BACKUP_RSYNC_TARGET"
    # no --delete: files removed in the app stay in the backup until you prune them deliberately
    rsync -a --partial --exclude 'tus/' --exclude 'staging/' --exclude 'exports/' "$SRC/" "$BACKUP_RSYNC_TARGET/"
  fi
  if [[ -n "$BACKUP_RCLONE_REMOTE" ]]; then
    command -v rclone >/dev/null || die "rclone not installed"
    log "rclone copy uploads -> $BACKUP_RCLONE_REMOTE"
    rclone copy "$SRC" "$BACKUP_RCLONE_REMOTE" --exclude 'tus/**' --exclude 'staging/**' --exclude 'exports/**' --transfers 4 --checksum
  fi
else
  log "Uploaded files NOT backed up (set BACKUP_RSYNC_TARGET or BACKUP_RCLONE_REMOTE)."
fi

# ── 5. Retention ─────────────────────────────────────────────────────────────
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  log "Removing local backups older than $RETENTION_DAYS days"
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'scenox-db-*' -o -name 'scenox-env-*' -o -name 'scenox-caddy-*' \) -mtime "+$RETENTION_DAYS" -print -delete
fi

log "Backup complete"
