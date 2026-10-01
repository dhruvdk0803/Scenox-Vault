# Scenox Vault — HTTP API

Base path: `/api` (same origin as the web app; Caddy routes `/api/*` to the API service).
All request/response types live in [`packages/shared/src/types.ts`](../packages/shared/src/types.ts).

- **Auth (admin):** HttpOnly cookie `sv_session` set by `POST /api/auth/login`. State-changing requests must come from an allowed `Origin` (CSRF defence).
- **Auth (public portal):** the portal token in the URL path, plus optional `x-portal-access` (password-protected portals) and `x-upload-session` (upload batch) headers.
- **Errors:** `{ "error": { "code": string, "message": string, "details"?: any, "requestId"?: string } }` — `message` is always safe to show to end users.
- **Lists:** `?page=1&pageSize=25&q=&sort=&order=asc|desc` → `Paginated<T>` (`{ items, total, page, pageSize }`).
- **Rate limits:** login, setup, portal unlock, portal lookup and session creation are rate limited per IP. tus `PATCH` (the actual bytes) is never rate limited.

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health`, `/api/health` | liveness |
| GET | `/ready`, `/api/ready` | DB + Redis + storage writable; 503 when not ready |

## Auth & team

| Method | Path | Permission | Body → Response |
|---|---|---|---|
| GET | `/api/auth/setup-status` | public | → `SetupStatusDTO` |
| POST | `/api/auth/setup` | public, only when no users exist | `SetupRequest` → `MeDTO` (sets cookie) |
| POST | `/api/auth/login` | public (rate limited, lockout after 10 failures/15 min) | `LoginRequest` → `MeDTO` |
| POST | `/api/auth/logout` | signed in | → 204 |
| GET | `/api/auth/me` | signed in | → `MeDTO` |
| POST | `/api/auth/password` | signed in | `ChangePasswordRequest` → 204 (revokes other sessions) |
| GET | `/api/users` | team.view | → `UserDTO[]` |
| POST | `/api/users` | team.manage | `CreateUserRequest` → `UserDTO` |
| PATCH | `/api/users/:id` | team.manage (+ role hierarchy) | `UpdateUserRequest` → `UserDTO` |
| DELETE | `/api/users/:id` | team.manage | → 204 (cannot delete last owner / self) |

## Clients

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/clients` | clients.view | `?q=&status=&sort=name|createdAt|storageUsedBytes|lastUploadAt` → `Paginated<ClientDTO>` |
| POST | `/api/clients` | clients.manage | `CreateClientRequest` → `ClientDTO` |
| GET | `/api/clients/:id` | clients.view | → `ClientDTO` |
| PATCH | `/api/clients/:id` | clients.manage | `UpdateClientRequest` → `ClientDTO` |
| DELETE | `/api/clients/:id` | clients.manage + files.delete | permanently deletes client, portals, files on disk → 204 |

## Portals

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/portals` | portals.view | `?clientId=&status=active|expired|disabled&q=` → `Paginated<PortalDTO>` |
| POST | `/api/portals` | portals.manage | `CreatePortalRequest` → `PortalDTO` (includes `url`) |
| GET | `/api/portals/:id` | portals.view | → `PortalDTO` |
| PATCH | `/api/portals/:id` | portals.manage | `UpdatePortalRequest` → `PortalDTO` |
| POST | `/api/portals/:id/regenerate` | portals.manage | new secret link; the old link stops working immediately → `PortalDTO` |
| POST | `/api/portals/:id/logo` | portals.manage | multipart `file` (png/jpg/svg/webp ≤ 2 MB) → `PortalDTO` |
| DELETE | `/api/portals/:id/logo` | portals.manage | → `PortalDTO` |
| DELETE | `/api/portals/:id` | portals.manage + files.delete | deletes portal and its files → 204 |

## Upload sessions (admin view)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/uploads` | files.view | `?clientId=&portalId=&status=&q=` → `Paginated<UploadSessionDTO>` |
| GET | `/api/uploads/:id` | files.view | → `UploadSessionDTO` |

## Files

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/files` | files.view | `FileListQuery` → `Paginated<FileDTO>` (server-side search on filename/path) |
| GET | `/api/files/browse` | files.view | `?clientId=(required)&portalId=&path=&page=&q=` → `BrowseResponse` (folders derived from `relativePath`) |
| GET | `/api/files/:id` | files.view | → `FileDTO` |
| GET | `/api/files/:id/download` | files.download | streams the file; supports `Range`; `?inline=1` for preview of safe types. Quarantined files refused. |
| PATCH | `/api/files/:id` | files.manage | `RenameFileRequest` → `FileDTO` (metadata rename; disk key unchanged) |
| POST | `/api/files/move` | files.manage | `MoveFilesRequest` → 204 |
| POST | `/api/files/delete` | files.delete | `BulkFilesRequest` → 204 |
| DELETE | `/api/files/:id` | files.delete | → 204 |
| POST | `/api/exports` | files.download | `BulkFilesRequest` (≤ 10 000 files) → `ExportJobDTO` (ZIP built by background job) |
| GET | `/api/exports` | files.download | → `ExportJobDTO[]` (current user's recent exports) |
| GET | `/api/exports/:id` | files.download | → `ExportJobDTO` (poll for `status: ready`) |
| GET | `/api/exports/:id/download` | files.download | streams the ZIP |

## Activity, audit, notifications

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/activity` | activity.view | `?clientId=&portalId=&action=&actorType=&from=&to=` → `Paginated<ActivityDTO>` |
| GET | `/api/audit` | audit.view | same shape; admin (user) actions with IP + result |
| GET | `/api/notifications` | signed in | → `Paginated<NotificationDTO>` (in-app channel) |
| POST | `/api/notifications/read` | signed in | `{ ids?: string[] }` (omit = all) → 204 |

## Dashboard, analytics, storage, system

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/dashboard` | signed in | → `DashboardDTO` |
| GET | `/api/analytics` | activity.view | `?days=30` → `AnalyticsDTO` |
| GET | `/api/storage` | system.view | → `StorageDTO` |
| GET | `/api/system` | system.view | → `SystemHealthDTO` |

## Settings & branding

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/settings` | settings.view | → `SettingsDTO` |
| PATCH | `/api/settings` | settings.manage | `UpdateSettingsRequest` → `SettingsDTO` |
| POST | `/api/settings/logo` | settings.manage | multipart `file` → `SettingsDTO` |
| DELETE | `/api/settings/logo` | settings.manage | → `SettingsDTO` |
| POST | `/api/settings/favicon` | settings.manage | multipart `file` → `SettingsDTO` |
| POST | `/api/settings/test-email` | settings.manage | `{ to }` → `{ ok, message }` |
| GET | `/api/public/branding` | public | → `Branding` |
| GET | `/api/public/branding/logo` · `/favicon` | public | image |

## Public portal (client side)

All paths are relative to `/api/public/portals/:token`. A wrong or revoked token always returns 404 `not_found` (no information leak).

| Method | Path | Headers | Notes |
|---|---|---|---|
| GET | `/` | `x-portal-access?` | → `PublicPortalDTO` (`state`: ok / password_required / expired / disabled). Logs `portal.accessed`. |
| GET | `/logo` | – | portal logo image |
| POST | `/unlock` | – | `PortalUnlockRequest` → `PortalUnlockResponse` (rate limited, 5/min/IP) |
| POST | `/sessions` | `x-portal-access?` | `StartSessionRequest` → `StartSessionResponse`; validates required intake fields |
| GET | `/sessions/current` | `x-upload-session` | → `{ sessionId, status, expiresAt }` — used to check a stored session is still valid when resuming |
| POST | `/preflight` | `x-upload-session` | `PreflightRequest` → `PreflightResponse` (type/size/quota checks + duplicate detection) |
| POST | `/sessions/complete` | `x-upload-session` | `CompleteSessionRequest` → 204; triggers notifications |
| GET | `/files` | `x-upload-session` | portal must allow client view → `PublicFileDTO[]` (this session's/portal's files) |
| DELETE | `/files/:fileId` | `x-upload-session` | portal must allow client delete; only files from this session |

## tus upload endpoint

`/api/tus` implements [tus 1.0.0](https://tus.io/protocols/resumable-upload) with the `creation`, `creation-with-upload`, `termination` and `expiration` extensions.

- Every request must carry `x-upload-session: <sessionToken>` (and `Tus-Resumable: 1.0.0`).
- `POST /api/tus` with `Upload-Length` and `Upload-Metadata` (`filename`, `filetype`, `relativePath`, `sessionId`, `clientKey`, `duplicateAction`, `lastModified`) creates an upload. The server re-checks type, size and quota **before** accepting any bytes.
- `PATCH /api/tus/:id` with `Upload-Offset` appends bytes, which are streamed straight to disk.
- `HEAD /api/tus/:id` returns the current `Upload-Offset` and is used to resume.
- `DELETE /api/tus/:id` cancels the upload.

See [UPLOAD_ENGINE.md](UPLOAD_ENGINE.md) for how the protocol behaves.
