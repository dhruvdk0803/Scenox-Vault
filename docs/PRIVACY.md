# Privacy

Scenox Vault is self-hosted: **you** (the operator) are the data controller; nothing is sent to the project authors or any third-party service by default (no analytics, no external fonts or scripts on the portal, no telemetry; Next.js telemetry is disabled in the images).

## What is collected

| About | Data | Why | Where |
|---|---|---|---|
| Uploaders (your clients' staff) | name, e-mail, company, message — *only the fields a portal is configured to ask for* | identify the sender | `upload_sessions` |
| Uploaders | IP address, browser user agent | security, abuse handling, audit | `upload_sessions`, `activity_logs` |
| Uploaders | file names, folder paths, sizes, types, checksums, timestamps; **file contents** | the service itself | database (metadata) and the storage volume (content) |
| Admin users | name, e-mail, Argon2id password hash, role, sign-in times, IP and user agent of sessions | accounts and audit | `users`, `sessions`, `activity_logs` |
| Everyone | notification e-mails sent (recipient, subject, body) | delivery log | `notifications` |

No cookies are set for clients; admins get one session cookie (`sv_session`). The upload page keeps upload progress (queue, resume URLs, session token) in the browser's IndexedDB so uploads can resume; it never leaves the device except as upload requests to your server.

## Who can see it

Only people you give an account to, according to their role (owner / admin / member / viewer). Portal links give clients write access to their own portal only. The VPS provider and anyone with root access to the server can technically read everything on it; use disk encryption if that matters.

## Retention

Configurable in **Settings → Retention**: incomplete uploads (default 72 h), export ZIPs (24 h), activity log (365 days). Uploaded files and their metadata stay until an admin deletes them. Deleting a client removes its portals, sessions, file records and files. Backups keep data until the backup retention (`RETENTION_DAYS`, default 14) expires.

## Operator responsibilities

Tell uploaders what you collect (a link to your own privacy notice can be placed in the portal's instructions text), honour access/erasure requests by deleting the relevant client/files (and remember backups), use a lawful basis for processing, and sign data-processing agreements with your hosting and e-mail providers where required. This document describes the software's behaviour; it is not legal advice.
