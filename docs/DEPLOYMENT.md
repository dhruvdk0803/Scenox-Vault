# Deployment guide

Target: a single Ubuntu 22.04 / 24.04 VPS (2 vCPU / 4 GB RAM is comfortable; 1 vCPU / 2 GB works for light use; add 3 GB RAM if you enable ClamAV).

Contents: [1 Fast path](#1-fast-path-installer) · [2 Step by step](#2-fresh-vps-step-by-step) · [3 DNS](#3-dns-records) · [4 HTTPS](#4-https) · [5 Domains](#5-adding-or-changing-domains--single-domain-mode) · [6 Env reference](#6-environment-reference) · [7 ClamAV](#7-clamav) · [8 SMTP](#8-smtp) · [9 Updates](#9-updates) · [10 Backup & restore](#10-backup--restore) · [11 Monitoring](#11-monitoring--health) · [12 Capacity](#12-disk-capacity-planning) · [13 Move storage](#13-moving-storage-to-a-larger-volume) · [14 Object storage](#14-migrating-to-object-storage-s3--r2--b2--minio) · [15 Troubleshooting](#15-troubleshooting)

## 0. One command from your laptop (recommended)

From a checkout of this repository on your own machine (needs `ssh`/`scp` and an SSH login with `sudo` on the server):

```bash
bash deploy/scripts/deploy-remote.sh <user@server> <domain> <acme-email> [owner-email]
# e.g.
bash deploy/scripts/deploy-remote.sh dhruv@188.245.6.249 vault.scenoxlabs.com you@company.com you@company.com
```

It refuses to continue if the domain's A record doesn't point at the server or if another web server already holds ports 80/443. Then it uploads the committed code to `/opt/scenox-vault`, runs the installer (Docker, generated secrets, firewall, build, start, health check), creates the owner account over the CLI (so `/setup` can't be claimed by someone else), and checks `https://<domain>/api/ready` from outside.

**Updating** is the same command: new code is unpacked over the old, images rebuild, migrations run on API start; `.env`, the database and uploaded files are untouched.

## 1. Fast path (installer)

```bash
git clone <your-repo-url> scenox-vault && cd scenox-vault
sudo bash deploy/scripts/install.sh
```

The script is idempotent. It installs Docker Engine + the compose plugin (official apt repo), copies the project to `/opt/scenox-vault`, asks for your domains and e-mail, writes `.env` with freshly generated secrets (mode 600; an existing `.env` is never overwritten), configures `ufw` (22 or your sshd port, 80, 443/tcp, 443/udp), builds the images and starts everything. Non-interactive: `APP_DOMAIN=… UPLOAD_DOMAIN=… ACME_EMAIL=… NONINTERACTIVE=1 sudo -E bash deploy/scripts/install.sh`.

Then open `https://APP_DOMAIN/setup` and create the owner account (or `docker compose exec api node dist/cli.js create-owner --email you@example.com --name "You"`).

## 2. Fresh VPS, step by step

### 2.1 Prepare the server

```bash
# as root on a new Ubuntu VPS
adduser deploy && usermod -aG sudo deploy        # optional: non-root admin
apt-get update && apt-get -y upgrade
timedatectl set-timezone UTC
```

Harden SSH (key-only login) before exposing the machine. Add 2–4 GB of swap on small VPSes: `fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`.

### 2.2 Install Docker

```bash
curl -fsSL https://get.docker.com | sh          # or follow https://docs.docker.com/engine/install/ubuntu/
docker compose version                           # compose v2 plugin must be present
```

### 2.3 Firewall

```bash
ufw allow 22/tcp      # use your sshd port
ufw allow 80/tcp      # ACME HTTP-01 + redirect
ufw allow 443/tcp     # HTTPS (HTTP/1.1, HTTP/2)
ufw allow 443/udp     # HTTP/3 (QUIC)
ufw enable
```

Docker publishes container ports by editing iptables directly (bypassing `ufw`). Only Caddy publishes ports in this stack; Postgres/Redis/API/web are never published, so the firewall is a second line of defence, not the only one.

### 2.4 Get the code and configure

```bash
sudo mkdir -p /opt && cd /opt
sudo git clone <your-repo-url> scenox-vault && cd scenox-vault
sudo cp .env.example .env && sudo chmod 600 .env
```

Edit `.env`. **Required:**

```bash
APP_DOMAIN=app.example.com
UPLOAD_DOMAIN=upload.example.com
UPLOAD_HOST=upload.example.com      # same as UPLOAD_DOMAIN (leave empty for single-domain mode)
ACME_EMAIL=you@example.com
POSTGRES_PASSWORD=<output of: openssl rand -hex 24>
SESSION_SECRET=<output of: openssl rand -hex 32>
ENCRYPTION_KEY=<output of: openssl rand -hex 32>
```

Run each `openssl` command in your shell and paste the result (`.env` does not execute `$(...)`). The API refuses to start while `SESSION_SECRET` / `ENCRYPTION_KEY` still hold the placeholder `CHANGE_ME`.

> **Back up `ENCRYPTION_KEY` and `SESSION_SECRET` now** (password manager). Losing `ENCRYPTION_KEY` means portal links can no longer be re-displayed in the admin; changing `SESSION_SECRET` logs everyone out and invalidates all portal links.

### 2.5 Start

```bash
docker compose up -d --build        # first build: a few minutes
docker compose ps                   # all services "healthy" after ~1 minute
docker compose logs -f api          # look for "database migrations applied" and "API listening"
```

Caddy requests certificates on first contact; watch `docker compose logs -f caddy`. Open `https://APP_DOMAIN/setup`.

## 3. DNS records

Create these at your DNS provider (replace with your server's IPs), **before** starting Caddy so certificate issuance succeeds first time:

| Type | Name | Value |
|---|---|---|
| A | `app` | `203.0.113.10` |
| A | `upload` | `203.0.113.10` |
| AAAA (optional) | `app`, `upload` | your IPv6 |

Verify: `dig +short app.example.com upload.example.com`. If you also use Cloudflare, read the proxy caveat in [UPLOAD_ENGINE.md §9](UPLOAD_ENGINE.md#9-tuning-knobs).

## 4. HTTPS

Automatic. Caddy obtains certificates from Let's Encrypt (falling back to ZeroSSL) over HTTP-01/TLS-ALPN-01, renews them ~30 days before expiry, redirects HTTP → HTTPS, and enables HTTP/2 and HTTP/3. Certificates and the ACME account live in the `caddy_data` volume — **don't delete it** (Let's Encrypt rate-limits re-issuance) and it is included in `backup.sh`.

Requirements: ports 80 and 443 reachable from the internet, DNS pointing at the server. Check: `curl -I https://app.example.com/api/health`. Logs: `docker compose logs caddy | grep -i -E "obtain|error"`.

## 5. Adding or changing domains / single-domain mode

- **Change a domain:** edit `APP_DOMAIN` / `UPLOAD_DOMAIN` (and `UPLOAD_HOST`) in `.env`, point DNS, then `docker compose up -d` (this recreates `caddy`, `api`, `worker`, `web` with the new values). `APP_URL`/`UPLOAD_URL` are derived automatically from the domains, so CSRF/CORS allow-lists follow. **Existing portal links embed the old upload domain** — they stop resolving; the admin shows the new URL for each portal immediately (links are rebuilt from the stored token), but links already sent to clients must be re-sent.
- **Extra hostnames** (e.g. a vanity domain pointing at the same stack): add them to the site address list in `deploy/Caddyfile` (`{$APP_DOMAIN}, {$UPLOAD_DOMAIN}, files.client.com`) and to `CORS_ORIGINS=https://files.client.com`.
- **Single-domain mode:** set `UPLOAD_DOMAIN` equal to `APP_DOMAIN` and leave `UPLOAD_HOST=` empty. Portals live at `https://APP_DOMAIN/u/<token>` next to the admin UI. Simpler, but clients can then see the admin login page; two domains are recommended for agencies.
- **Using Nginx instead of Caddy:** see `deploy/nginx.conf.example` (header comment explains publishing `127.0.0.1:3000/4000` and disabling the `caddy` service).

## 6. Environment reference

`.env.example` is the authoritative, commented list. Summary:

| Variable | Default | Notes |
|---|---|---|
| `APP_DOMAIN` | – (required) | admin host |
| `UPLOAD_DOMAIN` | = `APP_DOMAIN` | client portal host |
| `ACME_EMAIL` | – (required by Caddyfile) | certificate account e-mail |
| `UPLOAD_HOST` | empty | web hides admin routes on this host; empty = single-domain |
| `API_INTERNAL_URL` | `http://api:4000` | web → API (fallback rewrite); baked at image build |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `scenox` / – / `scenox` | `DATABASE_URL` is derived by compose (use URL-safe passwords: `openssl rand -hex 24`) |
| `POSTGRES_SHARED_BUFFERS`, `REDIS_MAXMEMORY`, `VAULT_VERSION` | 256MB, 256mb, latest | optional tuning |
| `NODE_ENV` | production (forced by compose) | |
| `LOG_LEVEL` | `info` | |
| `HOST` / `PORT` | `0.0.0.0` / `4000` | API bind |
| `DATABASE_URL`, `REDIS_URL`, `STORAGE_PATH`, `APP_URL`, `UPLOAD_URL`, `CLAMAV_HOST` | overridden by compose | only used for local `pnpm dev` |
| `DATABASE_POOL_MAX` | 20 | Postgres pool per process |
| `CORS_ORIGINS` | empty | extra allowed origins (also used for the CSRF Origin check) |
| `TRUST_PROXY` | 1 | number of proxies in front of the API (Caddy = 1) |
| `MIGRATE_ON_START` | true | `false` = run migrations yourself |
| `SESSION_SECRET` | – (≥ 32 chars) | HMAC key for session/portal token hashes |
| `ENCRYPTION_KEY` | – (64 hex chars) | AES-256-GCM key for portal tokens |
| `COOKIE_SECURE` | true when `APP_URL` is https | |
| `STORAGE_DRIVER` / `STORAGE_PATH` | `local` / `/data/storage` | |
| `MAX_FILE_SIZE`, `MAX_PORTAL_SIZE` | 0 (unlimited) | |
| `MAX_CONCURRENT_UPLOADS`, `DEFAULT_CHUNK_SIZE`, `MAX_CHUNK_SIZE`, `MIN_CHUNK_SIZE`, `RETRY_COUNT`, `UPLOAD_TIMEOUT`, `TUS_PATH` | 4, 64MB, 256MB, 8MB, 6, 600000, `/api/tus` | see [UPLOAD_ENGINE.md](UPLOAD_ENGINE.md#9-tuning-knobs) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | empty, 587, false, … | e-mail disabled while `SMTP_HOST` is empty |
| `CLAMAV_ENABLED`, `CLAMAV_HOST`, `CLAMAV_PORT` | false, clamav, 3310 | |
| `RATE_LIMIT_ENABLED` | true | |
| `WORKER_CONCURRENCY` | 2 | |
| `WEBHOOK_ALLOW_PRIVATE` | false | allow webhook deliveries to private/loopback addresses — development only (SSRF protection) |

After editing `.env`: `docker compose up -d` (compose recreates only affected services).

## 7. ClamAV

```bash
# 1. in .env
CLAMAV_ENABLED=true
# 2. start the scanner (downloads ~300 MB of signatures on first start; give it a few minutes)
docker compose --profile clamav up -d
docker compose ps clamav            # wait for "healthy"
# 3. recreate api + worker so they pick up the setting
docker compose up -d
```

Notes: clamd needs ~1.5–2 GB RAM (limit set to 3 GB in compose). Signatures auto-update inside the container (`freshclam`). Scanning is CPU- and disk-bound: a 100 GB file takes a long time, and clamd has its own size limits (`MaxFileSize`, `StreamMaxLength`; raise them with a custom `clamd.conf` mounted into the container if you need to scan very large files). The upload itself is never delayed — files show *processing* until the scan finishes. Infected files go to `quarantine/` and are not downloadable. Without `--profile clamav` the scanner is simply absent and `CLAMAV_ENABLED` must stay `false`.

## 8. SMTP

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587              # 587 + SMTP_SECURE=false (STARTTLS)  |  465 + SMTP_SECURE=true (implicit TLS)
SMTP_USER=apikey-or-username
SMTP_PASSWORD=...
SMTP_FROM="Scenox Vault <no-reply@example.com>"
```

`docker compose up -d`, then **Settings → Notifications → Send test e-mail** (or `POST /api/settings/test-email`). Use a provider that lets you send from your domain (Postmark, SES, Mailgun, Resend, your own relay) and set SPF/DKIM/DMARC for the From domain, otherwise notifications land in spam. Failed sends are retried by the worker and recorded in `notifications.error`.

## 9. Updates

```bash
cd /opt/scenox-vault
deploy/scripts/update.sh            # backup DB → git pull --ff-only → docker compose build → up -d → wait for health
```

Migrations run automatically when the new `api` container starts. Uploads in progress during the restart are retried by the browsers and resume. Options: `--no-pull` (build the working tree), `SKIP_BACKUP=1`.

**Rollback:** `git checkout <previous-tag>` then `deploy/scripts/update.sh --no-pull`. If the new version ran a destructive migration, restore the pre-update dump with `restore.sh` first. Migrations are forward-only; keep the pre-update backup until you're happy.

## 10. Backup & restore

What matters, in priority order:

| Asset | Where | How it is backed up |
|---|---|---|
| Uploaded files | volume `upload_data` | `BACKUP_RSYNC_TARGET` or `BACKUP_RCLONE_REMOTE` (copy semantics, never deletes) |
| Database | volume `postgres_data` | `pg_dump --format=custom` → `scenox-db-<ts>.dump` |
| Secrets/config | `.env`, Caddyfile | `scenox-env-<ts>.tar.gz` (**contains secrets: store encrypted**) |
| TLS certs | volume `caddy_data` | `scenox-caddy-<ts>.tar.gz` (optional; certs are re-issued if lost) |

**Back up:**

```bash
deploy/scripts/backup.sh                                       # local dumps in /var/backups/scenox-vault
BACKUP_RCLONE_REMOTE=b2:my-bucket/scenox RETENTION_DAYS=30 deploy/scripts/backup.sh
BACKUP_RSYNC_TARGET=backup@host:/srv/backups/scenox deploy/scripts/backup.sh
# cron, daily at 03:00 (as root):
0 3 * * * BACKUP_RCLONE_REMOTE=b2:my-bucket/scenox /opt/scenox-vault/deploy/scripts/backup.sh >> /var/log/scenox-backup.log 2>&1
```

Take the 3-2-1 rule seriously: the dump on the same disk as the database protects against mistakes, not against losing the server. Copy dumps and files off the machine. Uploaded files are immutable, so incremental `rsync`/`rclone copy` after the first run is fast; `tus/`, `staging/` and `exports/` are excluded (transient).

**Restore (same or new server):**

```bash
# new server: run install.sh, then put the ORIGINAL .env back (same ENCRYPTION_KEY / SESSION_SECRET / POSTGRES_PASSWORD)
docker compose up -d postgres redis
deploy/scripts/restore.sh /var/backups/scenox-vault/scenox-db-20250101T030000Z.dump   # asks you to type the DB name
# restore the files into the upload_data volume (path from: docker volume inspect scenox-vault_upload_data)
rsync -a backup@host:/srv/backups/scenox/ "$(docker volume inspect -f '{{.Mountpoint}}' scenox-vault_upload_data)/"
chown -R 1000:1000 "$(docker volume inspect -f '{{.Mountpoint}}' scenox-vault_upload_data)"
docker compose up -d
```

**Test restores.** An untested backup is a hope. Once a quarter, restore into a scratch VPS and open a few files. The database and the files must come from the same point in time ± the backup interval; files newer than the dump simply have no DB row (orphans, harmless) and rows newer than the files show as missing downloads.

## 11. Monitoring & health

| What | How |
|---|---|
| Liveness | `GET https://APP_DOMAIN/api/health` → `{"status":"ok"}` |
| Readiness | `GET https://APP_DOMAIN/api/ready` → 200 when Postgres, Redis and storage-write all work, 503 otherwise (JSON lists each check with latency) |
| Everything at once | `deploy/scripts/healthcheck.sh` (exit 0/1; services, `/ready`, public HTTPS, disk %) — put it in cron or an uptime monitor wrapper |
| In the UI | **System** page (database, Redis, storage, worker and ClamAV health, queue depth) and **Storage** page (usage per client, disk capacity with warning/critical thresholds, default 85 % / 95 %, configurable in Settings → Notifications) |
| Containers | `docker compose ps`, `docker stats` |
| Logs | `docker compose logs -f api worker caddy`; JSON, rotated (20 MB × 5 per service). Request logs redact tokens and cookies |

Point an external monitor (UptimeRobot, Better Stack, …) at `/api/ready` and alert on the disk threshold e-mails.

## 12. Disk capacity planning

The default design stores every file on the server's local disk, so **local disk size is the hard limit on total client data.** A typical 160 GB NVMe VPS:

| Item | Reserve |
|---|---|
| Ubuntu + Docker images (api, web, caddy, postgres, redis) | ~10–15 GB (+ ~3 GB with ClamAV signatures) |
| Postgres data + WAL | ~1–5 GB (metadata only) |
| Local backup dumps (`RETENTION_DAYS` × dump size) | ~1–10 GB |
| In-flight data: `tus/` + `staging/` ≈ the files being uploaded right now | allow 2–4 × your largest file |
| `exports/` ZIPs ≈ size of the selection being exported, kept 24 h | allow your largest expected export |
| Safety headroom (filesystem performance and alerts degrade > 85 %) | ≥ 15 % of the disk |

Worked example (an estimate, not a measurement): 160 GB − 15 (system) − 5 (DB) − 5 (dumps) − 25 (transient peak) = 110 GB, of which you should plan to *fill* ≈ 90–100 GB before adding storage. **Do not rely on 160 GB meaning 160 GB of footage.** A single 100 GB upload already needs ~100 GB free during upload *and* the same again if someone exports it as a ZIP.

Operating rules: act when the warning alert (85 %) fires; delete or archive finished projects, shorten `exportHours`/incomplete-upload retention, or grow storage ([§13](#13-moving-storage-to-a-larger-volume), [§14](#14-migrating-to-object-storage-s3--r2--b2--minio)). Per-client/per-portal quotas (and `MAX_PORTAL_SIZE`) stop one client filling the disk. Useful commands: `df -h /var/lib/docker`, `docker system df`, `du -sh /var/lib/docker/volumes/*`.

## 13. Moving storage to a larger volume

When you attach block storage (Hetzner Volume, DO Volume, EBS …), move the **entire** `/data/storage` tree (tus/ and uploads/ must stay on one filesystem).

```bash
# 1. mount the new volume, e.g. at /mnt/vault-data (ext4/xfs), add to /etc/fstab
sudo mkdir -p /mnt/vault-data && sudo chown 1000:1000 /mnt/vault-data      # uid 1000 = "node" user in the image

# 2. stop writers, copy
cd /opt/scenox-vault && docker compose stop caddy web api worker
SRC="$(docker volume inspect -f '{{.Mountpoint}}' scenox-vault_upload_data)"
sudo rsync -aHAX --info=progress2 "$SRC/" /mnt/vault-data/

# 3. point the services at it: docker-compose.override.yml
cat <<'YAML' | sudo tee docker-compose.override.yml
services:
  api:
    volumes: ["/mnt/vault-data:/data/storage"]
  worker:
    volumes: ["/mnt/vault-data:/data/storage"]
YAML
docker compose up -d
docker compose exec api df -h /data/storage        # confirm the new size
```

Keep the old volume for a few days, then `docker volume rm scenox-vault_upload_data` (also remove it from `clamav` volumes in the override if you use ClamAV: `clamav: { volumes: ["/mnt/vault-data:/data/storage:ro"] }`).

## 14. Migrating to object storage (S3 / R2 / B2 / MinIO)

> **Status:** the application currently ships the **local** storage driver only (`STORAGE_DRIVER=local`). The `StorageService` interface and the on-disk key layout are designed so an S3 driver can be added without schema changes; this section describes the plan and the data-migration procedure you can already rehearse. Do not expect `STORAGE_DRIVER=s3` to work until that driver is released.

What changes when it exists:

- New env: driver `s3`, bucket, endpoint, region, access key/secret, path-style flag (MinIO).
- Uploads: `@tus/s3-store` (multipart upload parts) or direct browser → bucket presigned multipart uploads, which take the VPS disk and NIC out of the data path entirely.
- Downloads: short-lived presigned URLs (`getSignedDownloadUrl`) instead of streaming through the API.
- `tus/` and `staging/` become bucket prefixes or multipart state; `quarantine/` and `exports/` likewise.
- Multi-replica API becomes possible (stage 3 of the scaling path).

Data migration (the DB stores *relative keys* such as `uploads/{client}/{portal}/{session}/{file}`, which map 1:1 to object keys):

```bash
# 1. configure the destination once (rclone config), then rehearse while the system is live
rclone copy /var/lib/docker/volumes/scenox-vault_upload_data/_data/uploads r2:scenox-vault/uploads \
  --transfers 8 --checksum --progress
# 2. maintenance window: stop uploads (docker compose stop caddy), final delta copy + verify
rclone copy …/uploads r2:scenox-vault/uploads --checksum
rclone check …/uploads r2:scenox-vault/uploads --one-way
# 3. switch the driver in .env, docker compose up -d, verify downloads; keep local copy read-only for a week
```

## 15. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **Uploads stall or fail at ~100 MB** | Cloudflare proxy (free/pro 100 MB body limit). Set `MAX_CHUNK_SIZE=95MB`, or make the upload DNS record grey-cloud (DNS only). [UPLOAD_ENGINE.md §9](UPLOAD_ENGINE.md#9-tuning-knobs) |
| **`413 Request Entity Too Large`** | Some proxy in front of the API enforces a body limit: Nginx `client_max_body_size 0;`, Cloudflare (above), a corporate/hosting proxy, or a quota/size rule (the JSON error body says `too_large`/`quota_exceeded`). Caddy itself has no limit |
| **502/504 under load** | `docker compose logs api` — crashed/restarting? Out of memory (`dmesg \| grep -i oom`)? Add swap/RAM |
| **`EACCES` / permission denied writing to `/data/storage`** | The volume must be writable by uid 1000 (`node`). Named volumes inherit this automatically; bind mounts need `chown -R 1000:1000 <dir>`. After restoring files as root, chown again |
| **`/api/ready` → storage down** | disk full (`df -h`), read-only filesystem, or wrong ownership |
| **Certificate not issued** | DNS not pointing here yet, port 80/443 blocked (ufw / cloud firewall), or rate-limited: `docker compose logs caddy`. Fix, then `docker compose restart caddy` |
| **API exits at start: "Invalid environment configuration"** | `SESSION_SECRET`/`ENCRYPTION_KEY` still `CHANGE_ME` or too short; `docker compose logs api` lists each problem |
| **Login works but you're bounced back / cookie not set** | `APP_DOMAIN` doesn't match the URL in the browser, or you browse over `http://` (cookie is `Secure`) |
| **"Request origin not allowed" (403) on POST** | the page's origin isn't in the allow-list: it must equal `https://APP_DOMAIN` / `https://UPLOAD_DOMAIN`, or be listed in `CORS_ORIGINS` |
| **Wrong client IPs in logs/audit (all 172.x)** | `TRUST_PROXY` must be 1 (Caddy is the one proxy). If Cloudflare proxies the domain you will see Cloudflare's IPs unless Caddy is told to trust its ranges (`servers { trusted_proxies … client_ip_headers CF-Connecting-IP }`) |
| **Admin UI visible on the client domain** | `UPLOAD_HOST` is empty or different from `UPLOAD_DOMAIN`; set it and `docker compose up -d web` |
| **Files stuck in "processing"** | worker down or Redis unreachable: `docker compose ps worker`, `docker compose logs worker`; queue state on the System page |
| **ClamAV unhealthy for minutes after start** | normal on first start (signature download + load); `docker compose logs clamav` |
| **Disk filling although you deleted files** | check `tus/` partials (`du -sh $VOL/tus`), expired exports, Docker logs/images: `docker system df`; cleanup runs on schedule per Settings → Retention |
| **Postgres password change has no effect** | the password is set at first initialisation of `postgres_data`; change it with `ALTER USER` inside the container, then update `.env` |
| **Build fails: pnpm/corepack cannot download** | build host has no outbound HTTPS to registry.npmjs.org; allow it or build the images elsewhere |
| **Everything is slow** | measure: [PERFORMANCE_TESTING.md](PERFORMANCE_TESTING.md); suspects: client uplink, VPS bandwidth cap, disk `await`, CPU steal |

Support bundle: `docker compose ps && docker compose logs --since 1h api worker caddy | tail -n 500` (tokens and cookies are redacted by the application; still review before sharing).
