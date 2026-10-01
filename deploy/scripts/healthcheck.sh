#!/usr/bin/env bash
# Scenox Vault — health check. Exit 0 = healthy, 1 = problem. Suitable for cron / uptime monitors.
#
#   deploy/scripts/healthcheck.sh             # one check, human-readable
#   deploy/scripts/healthcheck.sh --wait 120  # retry for up to 120 s (used by update.sh)
#   deploy/scripts/healthcheck.sh --quiet     # no output, exit code only
#
# Checks: every compose service running/healthy, API /ready (database, redis, storage writable),
# public HTTPS reachability, and disk usage of the upload volume (warn >= 85 %, fail >= 95 %).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

WAIT=0
QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait)  WAIT="${2:?seconds required}"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { [[ "$QUIET" == "1" ]] || printf '%s\n' "$*"; }
env_get() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }

run_checks() {
  local failed=0 svc cid state health

  for svc in postgres redis api worker web caddy; do
    cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
    if [[ -z "$cid" ]]; then say "FAIL  $svc: not running"; failed=1; continue; fi
    state="$(docker inspect -f '{{.State.Status}}' "$cid")"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$cid")"
    if [[ "$state" != "running" || ( "$health" != "healthy" && "$health" != "n/a" ) ]]; then
      say "FAIL  $svc: state=$state health=$health"; failed=1
    else
      say "ok    $svc ($state, health=$health)"
    fi
  done

  # readiness from inside the api container: DB + Redis + storage
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:4000/ready').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(1))" >/tmp/scenox-ready.json 2>&1; then
    say "ok    api /ready"
  else
    say "FAIL  api /ready: $(cat /tmp/scenox-ready.json 2>/dev/null)"; failed=1
  fi

  # public reachability
  local app_domain
  app_domain="$(env_get APP_DOMAIN)"
  if [[ -n "$app_domain" ]] && command -v curl >/dev/null 2>&1; then
    if curl -fsS -o /dev/null --max-time 10 "https://$app_domain/api/health"; then
      say "ok    https://$app_domain/api/health"
    else
      say "FAIL  https://$app_domain/api/health unreachable (DNS / certificate / firewall?)"; failed=1
    fi
  fi

  # disk usage of the upload volume (as seen by the api container)
  local pct
  pct="$(docker compose exec -T api df -P /data/storage 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}' || true)"
  if [[ "$pct" =~ ^[0-9]+$ ]]; then
    if   (( pct >= 95 )); then say "FAIL  upload disk ${pct}% used"; failed=1
    elif (( pct >= 85 )); then say "WARN  upload disk ${pct}% used"
    else say "ok    upload disk ${pct}% used"; fi
  fi

  return "$failed"
}

deadline=$(( $(date +%s) + WAIT ))
while true; do
  if run_checks; then say "HEALTHY"; exit 0; fi
  if (( $(date +%s) >= deadline )); then say "UNHEALTHY"; exit 1; fi
  say "-- retrying in 5 s --"
  sleep 5
done
