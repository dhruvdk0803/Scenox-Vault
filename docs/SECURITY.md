# Security

Scenox Vault receives **other people's confidential files** from the public internet and stores them on a server you run. This document states what it defends against, how, and how to verify that on your own deployment.

## 1. Threat model

| Asset | Threats | Primary defences |
|---|---|---|
| Client files (confidentiality) | guessing/leaking portal links, unauthorised download, path traversal, public web server exposing the volume, stolen backups | 192-bit random links, authorised-only streaming downloads, generated storage keys, Caddy blocks `/data`, encrypted-at-rest is **not** provided (see §6) |
| Admin accounts | credential stuffing, brute force, session theft, CSRF, XSS | Argon2id, rate limits + lockout, HttpOnly/Secure/SameSite cookies, origin check, strict CSP/headers |
| Server integrity | malicious uploads (executables, malware, zip bombs), oversized/malformed requests, SQL injection | extension block-list, magic-byte MIME sniffing, optional ClamAV + quarantine, files never executed or served inline unless safe, parameterised SQL (Drizzle) |
| Availability | disk exhaustion, request floods, slow-loris, abusive uploads | quotas, size limits, per-route rate limits, bounded JSON bodies, header/idle timeouts, disk alerts |
| Audit | undetected misuse | activity log + audit log with IP, user agent, request id, result |

**Out of scope / residual risk:** a compromised server or root account (can read everything — keep the host patched, SSH key-only); a client who sends their link to someone else (the link *is* the credential — see §3); data-at-rest encryption (use full-disk encryption at the provider/OS level if you need it); physical or hypervisor-level access by your VPS provider.

## 2. Controls (brief → implementation)

| Requirement | Implementation |
|---|---|
| Strong admin passwords | Argon2id (m=19 MiB, t=2, p=1), minimum 12 characters, max 256; timing equalised for unknown users (`apps/api/src/lib/password.ts`) |
| Brute-force protection | `POST /api/auth/login` limited to 10/min/IP **and** account lockout after 10 failures for 15 minutes (Redis-backed limiter; DB counter) |
| Sessions | random 256-bit token in cookie `sv_session`; only an HMAC of it is stored (`sessions.token_hash`); `HttpOnly`, `Secure` (https), `SameSite=Lax`, absolute expiry (default 12 h); password change revokes other sessions; expired rows purged |
| CSRF | every cookie-authenticated `POST/PUT/PATCH/DELETE` needs an `Origin`/`Referer` in the allow-list (`APP_URL`, `UPLOAD_URL`, `CORS_ORIGINS`); `SameSite=Lax` as second layer; no cross-site credentials |
| CORS | strict allow-list, `credentials: true` only for listed origins; production is same-origin so CORS is rarely exercised |
| Security headers | API: helmet (`default-src 'none'`, `frame-ancestors 'none'`, HSTS in production, CORP same-site, nosniff). Caddy: HSTS, `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`; web responses add CSP `frame-ancestors 'none'` + `X-Frame-Options: DENY`; `Server` header removed |
| HTTPS | automatic certificates via Caddy; HTTP redirects to HTTPS; HTTP/2 + HTTP/3; TLS 1.2+ |
| Public links as credentials | 192-bit CSPRNG token (`/u/<token>`); stored as HMAC-SHA256 (lookup) + AES-256-GCM ciphertext (admins can re-copy); invalid/revoked tokens always return the same 404; regenerate = instant revocation; tokens redacted from logs |
| Link expiry / disable / password | `portals.expires_at`, `portals.status`, optional Argon2id portal password → short-lived `x-portal-access` token; checked on session creation and on every tus request |
| Upload authorisation | every tus request needs `x-upload-session` (random token, HMAC stored, expiry) bound to one portal; metadata `sessionId` must match |
| Validation before bytes | extension block-list (default `exe scr bat cmd com ps1 vbs vbe js jse wsf wsh msi msp cpl hta jar pif reg lnk`, editable), optional per-portal allow-list, size limits, client/portal quotas — all in `onUploadCreate` |
| MIME safety | declared MIME is regex-validated and stored as *claimed*; the worker sniffs magic bytes (`file-type`) into `detected_mime`; downloads are `application/octet-stream` + `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`; only explicitly safe sniffed types may be previewed inline |
| Malware | optional ClamAV; infected → `quarantine/`, never served, admins notified |
| Path traversal | original names stripped of directories/control chars/`..` and kept **only in the database**; disk names are generated UUIDs; `LocalStorage.localPath()` resolves and rejects any key escaping the storage root; route ids validated as UUIDs (404 otherwise) |
| Filename injection | sanitised on input (`sanitizeFilename`, `sanitizeRelativePath`), escaped on output (React), RFC 5987 encoding in `Content-Disposition` |
| SQL injection | Drizzle parameterised queries; `LIKE` wildcards escaped (`escapeLike`); zod validation on every body/query |
| XSS | React escapes by default; no `dangerouslySetInnerHTML` of user data; portal text fields are plain text; logos are served with `nosniff` and a sandboxing CSP; strict API CSP |
| Rate limiting | Redis-backed per-route limits (table below); **never on upload byte streams** |
| Request size | JSON bodies ≤ 2 MiB; multipart (logos) ≤ 5 MiB; upload bodies are streamed to disk with no memory buffering |
| Authorisation (RBAC) | `owner / admin / member / viewer`, permissions in `packages/shared/src/rbac.ts`, enforced per route; role hierarchy on user management; last owner protected |
| Audit trail | `activity_logs` (who, what, IP, UA, request id, result) for logins (success and failure), portal access, uploads, downloads, deletes, settings; visible under Activity / Audit; retention configurable |
| Secrets handling | `.env` mode 600, never committed (`.gitignore`); secrets redacted from pino logs (`cookie`, `authorization`, `x-upload-session`, `x-portal-access`, `*.password`, `*.token`…); Caddy logs drop cookies/tokens; placeholder secrets are rejected at start |
| Container hardening | non-root user, Postgres/Redis/API/web unpublished, only Caddy exposes 80/443, `init` PID 1, health checks, log rotation |
| Safe first run | `/api/auth/setup` only works while no users exist (advisory-locked, rate limited) |

## 3. Public links are credentials

Anyone with the portal URL can upload to that portal (and, only if the portal allows it, list/delete files from their own session). Treat links like passwords:

- send them over a channel you trust; prefer **portal passwords** and **expiry dates** for sensitive projects;
- use one portal per client/project so a leaked link has a small blast radius;
- **Regenerate** a link (portal → Regenerate) to revoke it instantly; the old URL returns 404;
- set per-portal size/quota/extension limits so a leaked link cannot fill the disk;
- the link is never logged (`/u/[token]`, `/portals/[token]` are masked in API and Caddy logs) and never placed in a `Referer` to third parties (`Referrer-Policy: strict-origin-when-cross-origin`, no third-party assets on the portal page).

Upload session tokens are separate and short-lived; they cannot be used on another portal.

## 4. Rate limits

Opt-in per route, keyed by client IP, stored in Redis (shared across restarts/replicas). Disable only for tests (`RATE_LIMIT_ENABLED=false`).

| Endpoint | Limit |
|---|---|
| `POST /api/auth/login` | 10 / minute / IP, plus account lockout (10 failures → 15 min) |
| `POST /api/auth/setup` | 5 / minute / IP (and only while no user exists) |
| `POST /api/public/portals/:token/unlock` (portal password) | 5 / minute / IP |
| `POST /api/public/portals/:token/sessions` | 30 / minute / IP |
| `POST /api/public/portals/:token/preflight` | 60 / minute / IP |
| `GET /api/public/portals/:token` and `/logo` | 120 / minute / IP |
| `PATCH /api/tus/*` (the data) | **none** — throttling would break large uploads; abuse is bounded by quotas, size limits and the need for a valid session token |

Exceeding a limit returns `429` with `{ "error": { "code": "rate_limited", … } }`. Put a network-level limiter (Cloudflare, fail2ban on Caddy logs) in front if you face determined floods.

## 5. Data retention and privacy

What is stored about uploaders (see also [PRIVACY.md](PRIVACY.md)):

| Data | Where | Purpose |
|---|---|---|
| Uploader name, e-mail, company, message (only if the portal asks) | `upload_sessions` | tell you who sent what |
| IP address, user agent | `upload_sessions`, `sessions`, `activity_logs`, `portal_access_tokens` | abuse investigation, audit |
| File name, folder path, size, MIME, checksum, timestamps | `files` | the product |
| File content | `STORAGE_PATH` on disk (never in the DB) | the product |
| Notification e-mail bodies | `notifications` | delivery log |

Retention (Settings → Retention): abandoned/incomplete uploads **72 h**, export ZIPs **24 h**, activity log **365 days**; upload sessions expire after `portalSessionHours` (72 h); admin sessions after 12 h. Files themselves are kept until an admin deletes them (or deletes the client/portal) — there is no automatic deletion of finished uploads. Deleting a client cascades to portals, sessions and file rows and removes the files from disk.

## 6. Hardening checklist for operators

- [ ] SSH: key-only, no root login; `unattended-upgrades` on
- [ ] `ufw` allows only 22, 80, 443/tcp, 443/udp; cloud firewall mirrors it
- [ ] `.env` mode 600, backed up encrypted; secrets generated with `openssl rand -hex 32`
- [ ] Owner account has a long unique password (password manager); create named accounts for staff instead of sharing
- [ ] Two domains: admin domain not exposed to clients (`UPLOAD_HOST` set)
- [ ] Backups are off-box, encrypted, and restore-tested
- [ ] Optional: full-disk encryption (LUKS / provider-level) if client data is regulated
- [ ] Optional: enable ClamAV (`--profile clamav`)
- [ ] Keep images current: `deploy/scripts/update.sh` regularly; `docker compose pull` for caddy/postgres/redis updates
- [ ] Monitor `/api/ready` and disk usage

## 7. Security testing checklist

Run against a **staging** instance (or your own production with throw-away data). `T` = a valid portal token, `H=https://upload.example.com`.

| Test | How | Expected |
|---|---|---|
| **Path traversal (filename)** | tus create with `filename` = `../../etc/passwd`, `..\\..\\x.txt`, `a/b/c.txt`, `%2e%2e%2f`, NUL byte | stored as a sanitised base name; nothing outside `uploads/` created; on-disk name is a UUID |
| **Path traversal (folder)** | `relativePath` = `../../x`, `/abs`, `C:\\x` | sanitised or rejected |
| **Path traversal (download/ids)** | `GET /api/files/..%2f..%2fetc%2fpasswd/download` | 404 (ids must be UUIDs) |
| **Direct disk access** | `curl -I https://APP/data/…`, `/storage/…`, `/.env`, `/.git/config` | 404 |
| **Unauthorised admin API** | `curl -i https://APP/api/files`, `/api/clients`, `/api/settings` without cookie | 401 |
| **Privilege escalation** | log in as `viewer`/`member`; call create/delete/settings endpoints | 403 |
| **Invalid portal token** | `GET /api/public/portals/AAAAAAAAAAAAAAAAAAAAAAAA` | 404 `not_found`, identical body for malformed/unknown/revoked |
| **Expired / disabled portal** | set `expiresAt` in the past; start a session; try tus create | 403 `portal_expired` / `portal_disabled` |
| **Wrong / missing upload session** | tus POST/PATCH/HEAD with no `x-upload-session`, a tampered one, one from another portal | 401 / 404 |
| **Portal password** | wrong password ×6 within a minute | 401 then 429 |
| **Brute force login** | 12 wrong passwords for one account | 429 and/or lockout message; correct password rejected for 15 min |
| **Oversized file** | declare `Upload-Length` above `max_file_size_bytes` / quota | 413 at creation, zero bytes accepted |
| **Lying about size** | create with length N, PATCH more than N bytes; or finish with fewer | tus rejects; size mismatch → 422, file failed |
| **Blocked types** | upload `x.exe`, `x.ps1`, `x.bat`; `x.EXE`; `x.pdf.exe` | rejected (case-insensitive, last extension) |
| **MIME spoofing** | rename `evil.exe` → `evil.jpg`; send `filetype: image/jpeg` | accepted by extension rules but `detected_mime` shows the real type; with ClamAV it is scanned; downloaded as attachment |
| **Malformed tus** | missing `Tus-Resumable`, negative `Upload-Offset`, offset ≠ server offset, absurd `Upload-Metadata` | 4xx, no crash, server still healthy |
| **Malformed JSON / huge JSON** | send invalid JSON and a 5 MB body to `POST /api/auth/login` | 400 / 413, no stack trace in the body |
| **CSRF** | from another origin, `fetch('https://APP/api/clients', {method:'POST', credentials:'include'})`; or a forged-origin `curl -H 'Origin: https://evil.test' -b cookie …` | 403 `Request origin not allowed` |
| **XSS** | client name / portal title / uploader message / filename = `<img src=x onerror=alert(1)>` | rendered as text everywhere (admin tables, e-mail, portal); no script runs |
| **SQL injection** | `?q=' OR 1=1--`, `sort=name;drop table files`, `%` and `_` in search | no error, literal search, invalid sort rejected |
| **Header injection** | filename with `"`, `\r\n` in download | `Content-Disposition` correctly encoded; no extra headers |
| **Cookie flags** | inspect `Set-Cookie` on login over HTTPS | `HttpOnly; Secure; SameSite=Lax; Expires=…` |
| **Headers** | `curl -sI https://APP/` and `/api/health` | HSTS, nosniff, referrer policy, permissions policy, no `Server` |
| **Log hygiene** | grep API and Caddy logs for a real portal token, cookie value or password | none found (`/u/[token]`) |
| **Open ports** | `nmap -Pn -p- <server>` | only 22, 80, 443 (tcp) and 443 (udp) |
| **Secrets in repo** | `git log -p \| grep -i -E 'secret\|password\|key'`; `trufflehog`/`gitleaks` | no real secrets |

Automated tests covering authentication, clients, portals, settings and users run in CI (`pnpm --filter @scenox/api test`).

## 8. Reporting a vulnerability

Please report privately — do **not** open a public issue. Use the repository's *Security → Report a vulnerability* (private advisory) feature, or contact the maintainer at the address published in the repository profile. Include affected version/commit, reproduction steps, and impact. Expect an acknowledgement within a few days. Please give a reasonable time to fix before disclosure.
