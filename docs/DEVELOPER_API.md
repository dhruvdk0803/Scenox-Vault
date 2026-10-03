# Scenox Vault Developer API

Scenox Vault stores files that your clients upload through secret portal links. This API lets a script or an AI agent
list those uploads, get public time-limited download URLs (for example to hand to Shopify), tag files as processed,
and react to new uploads through webhooks.

This document is self-contained: everything an agent needs is below.

- Base URL: `https://<your-domain>/api`
- Machine-readable copy of this guide: `GET https://<your-domain>/api/docs` (Markdown, no auth)
- All request and response bodies are JSON (`Content-Type: application/json`) unless a file is streamed.
- All timestamps are ISO 8601 UTC strings. All sizes are bytes. All ids are UUIDs.

## 1. Authentication

Create an API key in the web app (Developers page, owner/admin/member). The full key (`svk_...`) is shown **once**; store it
as a secret. Send it on every request:

```bash
curl -H "Authorization: Bearer svk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" https://<your-domain>/api/clients
# equivalent:
curl -H "x-api-key: svk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" https://<your-domain>/api/clients
```

Keys are never accepted in the query string. No cookies, no `Origin` header and no CSRF token are needed.

A key acts as the user who created it, limited by its scopes. A request is allowed only if the user's role **and**
the key's scopes both allow it.

| Scope | Allows |
|---|---|
| `read` | list/get clients, portals, files, uploads, folders, messages inbox, activity; download files; create signed URLs; create exports |
| `write` | everything in `read`, plus create/update clients and portals, rename/move/tag files, post replies, delete files and uploads |

API keys can **never** manage team members, settings, API keys or webhooks (those answer `403`), whatever the scope.
`write` keys created by a `member` cannot delete files (members lack the delete permission); owner/admin keys can.

Key problems answer `401` `{"error":{"code":"unauthorized","message":"Invalid or expired API key."}}` (unknown,
revoked, expired, or the creating user was disabled). A missing permission answers `403` `{"error":{"code":"forbidden", ...}}`.

## 2. Conventions

**Errors** always look like this; `message` is safe to show to people:

```json
{ "error": { "code": "validation_error", "message": "Some fields are invalid.", "details": { "fields": { "tags": "..." } }, "requestId": "..." } }
```

Common codes: `bad_request`/`validation_error` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404),
`file_not_ready` (409, still processing), `name_taken` (409), `link_expired` (410), `rate_limited` (429).

**Rate limit:** 600 requests per minute per API key. When exceeded you get `429` with a `Retry-After` header (seconds);
wait and retry. Responses carry `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`. Prefer filters and
`pageSize=200` over many small requests.

**Pagination:** list endpoints take `page` (default 1) and `pageSize` (default 25, max 200) and return

```json
{ "items": [ ... ], "total": 137, "page": 1, "pageSize": 25 }
```

Loop until `page * pageSize >= total`. Lists also accept `sort` and `order=asc|desc`.

**File status:** `processing` (checksum/scan running, not downloadable yet) → `ready` (downloadable) or `quarantined`
(virus found; never downloadable). Only act on `ready` files.

## 3. Clients and portals

A **client** is a customer. Each client has one or more **portals** (upload links). Files belong to a client and keep the
folder structure the client uploaded (`relativePath`, e.g. `SKU-1001/front`). `relativePath` is `""` for the root.

### List / get clients

```bash
curl -H "Authorization: Bearer $KEY" "https://<your-domain>/api/clients?q=acme&status=active&sort=name&order=asc&pageSize=50"
curl -H "Authorization: Bearer $KEY" "https://<your-domain>/api/clients/$CLIENT_ID"
```

Query: `q` (name/company/email), `status=active|disabled`, `sort=name|createdAt|storageUsedBytes|lastUploadAt|fileCount`.

```json
{
  "id": "6f1c...", "name": "Acme Co", "company": "Acme Co Ltd", "email": "ops@acme.test", "phone": null, "notes": null,
  "status": "active", "quotaBytes": null, "storageUsedBytes": 18350080, "fileCount": 42, "uploadCount": 3,
  "portalCount": 1, "lastUploadAt": "2026-10-01T09:30:12.000Z", "createdAt": "2026-09-01T08:00:00.000Z", "updatedAt": "2026-10-01T09:30:12.000Z"
}
```

Create a client (`write`): `POST /api/clients` with `{ "name": "Acme Co", "company": null, "email": null, "phone": null, "notes": null, "quotaBytes": null }`
(only `name` is required) → `201` ClientDTO. Update: `PATCH /api/clients/:id` (same fields plus `status`).

### List / get / create portals

```bash
curl -H "Authorization: Bearer $KEY" "https://<your-domain>/api/portals?clientId=$CLIENT_ID&status=active"
curl -H "Authorization: Bearer $KEY" "https://<your-domain>/api/portals/$PORTAL_ID"
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"clientId":"'$CLIENT_ID'","name":"Spring 2027 product photos","allowFolders":true,"requireName":true}' \
  https://<your-domain>/api/portals
```

Only `clientId` and `name` are required when creating. Response (`PortalDTO`, abridged):

```json
{ "id": "a1b2...", "clientId": "6f1c...", "clientName": "Acme Co", "name": "Spring 2027 product photos", "status": "active",
  "url": "https://<your-domain>/u/AbC...", "title": null, "expiresAt": null, "maxFileSizeBytes": null, "maxTotalBytes": null,
  "allowedExtensions": null, "allowFolders": true, "allowClientViewFiles": false, "allowClientMessages": true,
  "storageUsedBytes": 0, "fileCount": 0, "sessionCount": 0, "lastUploadAt": null, "createdAt": "..." }
```

`url` is the secret link to give your client. Treat it like a password.

## 4. Files

### List files (with filters)

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://<your-domain>/api/files?clientId=$CLIENT_ID&status=ready&type=image&notTag=shopify&sort=completedAt&order=asc&pageSize=200"
```

| Query | Meaning |
|---|---|
| `clientId`, `portalId`, `uploadSessionId` | restrict to a client / portal / upload batch |
| `status` | `ready` (use this), `processing`, `quarantined`, ... Default lists processing + ready + quarantined |
| `type` | `image`, `video`, `audio`, `document`, `spreadsheet`, `archive`, `other` |
| `path` | exact folder, e.g. `SKU-1001` or `SKU-1001/front` (`""` = root only) |
| `q` | substring of file name or folder path |
| `tag` | has this tag |
| `notTag` | does NOT have this tag (e.g. `notTag=shopify` = not pushed yet) |
| `since` | only files completed (uploaded) **after** this ISO timestamp, for incremental sync |
| `from`, `to` | created between (ISO dates) |
| `minSize`, `maxSize` | bytes |
| `sort` | `name`, `size`, `createdAt`, `completedAt` (default `createdAt`); `order=asc|desc` |

`tag` and `notTag` are normalised like tags (lowercase, spaces become `-`). Incremental sync tip: files become `ready` a few
seconds after `completedAt`, so query `since=<last sync minus 10 minutes>&status=ready&notTag=shopify` and rely on the tag for
de-duplication.

A `FileDTO`:

```json
{
  "id": "0b9e...", "clientId": "6f1c...", "clientName": "Acme Co", "portalId": "a1b2...", "portalName": "Spring 2027 product photos",
  "uploadSessionId": "c3d4...", "name": "front.jpg", "relativePath": "SKU-1001", "extension": "jpg",
  "mimeType": "image/jpeg", "detectedMime": "image/jpeg", "size": 482113, "checksumSha256": "9f86...",
  "status": "ready", "scanStatus": "clean", "scanResult": null, "duplicateOfId": null,
  "uploaderName": "Jane", "uploaderEmail": "jane@acme.test",
  "tags": ["hero"], "meta": { "shopifyProductId": "gid://shopify/Product/123" },
  "createdAt": "2026-10-01T09:29:50.000Z", "completedAt": "2026-10-01T09:29:55.000Z"
}
```

`detectedMime` is the real type found by inspecting the bytes; trust it over `mimeType` (which the uploader declared).
`duplicateOfId` is set when the same bytes already exist for that client.

### Browse folders

```bash
curl -H "Authorization: Bearer $KEY" "https://<your-domain>/api/files/browse?clientId=$CLIENT_ID&path=&pageSize=200"
curl -H "Authorization: Bearer $KEY" "https://<your-domain>/api/files/browse?clientId=$CLIENT_ID&path=SKU-1001"
```

`path` is the folder (empty = root); optional `portalId`, `q`, `page`, `pageSize` (max 200). Response:

```json
{
  "path": "SKU-1001",
  "breadcrumbs": [ { "name": "SKU-1001", "path": "SKU-1001" } ],
  "folders": [ { "name": "front", "path": "SKU-1001/front", "fileCount": 3, "totalBytes": 1204411 } ],
  "files": { "items": [ /* FileDTO, files directly in this folder */ ], "total": 5, "page": 1, "pageSize": 50 }
}
```

Folders are derived from file paths; the folder list is not paginated. Use `files.total`/`page` for the files in it.

### Get one file / download

```bash
curl -H "Authorization: Bearer $KEY" https://<your-domain>/api/files/$FILE_ID
curl -L -H "Authorization: Bearer $KEY" -o front.jpg https://<your-domain>/api/files/$FILE_ID/download   # supports Range
```

Downloads need the API key header, so they cannot be handed to third parties. Use a signed URL for that.

### Signed (public, time-limited) URL

Use this whenever another service must fetch the file (Shopify `originalSource`, a CDN, a render farm). The URL needs no
headers or cookies and stops working at the expiry time.

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"expiresIn": 86400, "disposition": "inline"}' \
  https://<your-domain>/api/files/$FILE_ID/signed-url
```

- `expiresIn`: seconds, 60 to 604800 (7 days), default 3600.
- `disposition`: `inline` (default, best for images) or `attachment`.
- The file must be `ready` (409 `file_not_ready` while processing, 403 if quarantined).

```json
{ "url": "https://<your-domain>/api/public/files/0b9e.../1790000000/3Hq.../front.jpg", "expiresAt": "2026-10-04T09:30:00.000Z" }
```

The URL supports `GET`, `HEAD` and `Range`. Image types are served inline with their real MIME type; anything that could
run script (SVG, HTML) is always served as a download. After expiry it answers `410`; a modified URL answers `403`.
Mint a fresh URL right before use; for slow consumers use a long `expiresIn` such as 86400.

### Tags and meta

Tags are labels such as `shopify` or `sku:1001`. Normalised server-side: trimmed, lowercased, spaces become `-`; then 1 to 50
characters of `a-z 0-9 : _ - .`; at most 20 tags per file. `meta` is free-form JSON for your integration (at most 16 KB).

```bash
curl -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"addTags":["shopify"],"meta":{"shopifyProductId":"gid://shopify/Product/123","pushedAt":"2026-10-03T10:00:00Z"}}' \
  https://<your-domain>/api/files/$FILE_ID
```

`PATCH /api/files/:id` (needs `write`) accepts any of:

| Field | Effect |
|---|---|
| `name` | rename (the file keeps its folder; 409 `name_taken` on clash) |
| `tags` | replace the whole tag set |
| `addTags`, `removeTags` | applied after `tags` (replace, then add, then remove) |
| `meta` | shallow merge into existing meta; a `null` value deletes that key |

It returns the updated `FileDTO`. Bulk tagging (up to 1000 files per call):

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"fileIds":["id1","id2"],"addTags":["shopify"],"removeTags":["todo"]}' \
  https://<your-domain>/api/files/tags
# → { "updated": 2 }   (number of the given ids that exist; unknown ids are ignored)
```

### Move, delete

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"fileIds":["id1"],"relativePath":"SKU-1002"}' https://<your-domain>/api/files/move      # 204
curl -X DELETE -H "Authorization: Bearer $KEY" https://<your-domain>/api/files/$FILE_ID                                                                      # 204, permanent
curl -X POST   -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"fileIds":["id1","id2"]}' https://<your-domain>/api/files/delete      # 204
```

Deleting is permanent and removes the bytes. Ask a human before deleting client files.

### Exports (ZIP)

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"fileIds":["id1","id2"]}' https://<your-domain>/api/exports   # 201
curl -H "Authorization: Bearer $KEY" https://<your-domain>/api/exports/$EXPORT_ID                                                                  # poll until "status":"ready"
curl -L -H "Authorization: Bearer $KEY" -o export.zip https://<your-domain>/api/exports/$EXPORT_ID/download
```

`ExportJobDTO`: `{ "id", "status": "queued|processing|ready|failed|expired", "fileCount", "totalBytes", "progress", "downloadUrl", "expiresAt", ... }`.
Up to 10 000 files per export; exports expire after a while.

## 5. Uploads (batches)

One upload session = one batch a client sent through a portal.

```bash
curl -H "Authorization: Bearer $KEY" "https://<your-domain>/api/uploads?clientId=$CLIENT_ID&status=completed&pageSize=20"
curl -H "Authorization: Bearer $KEY" https://<your-domain>/api/uploads/$UPLOAD_ID
curl -X DELETE -H "Authorization: Bearer $KEY" https://<your-domain>/api/uploads/$UPLOAD_ID    # needs write; deletes the batch AND all its files; 204
```

```json
{ "id": "c3d4...", "clientId": "6f1c...", "clientName": "Acme Co", "portalId": "a1b2...", "portalName": "Spring 2027 product photos",
  "status": "completed", "uploaderName": "Jane", "uploaderEmail": "jane@acme.test", "uploaderCompany": null, "message": "Photos for the spring range",
  "totalFiles": 12, "totalBytes": 9104411, "uploadedFiles": 12, "uploadedBytes": 9104411, "failedFiles": 0,
  "startedAt": "...", "lastActivityAt": "...", "completedAt": "..." }
```

Filters: `clientId`, `portalId`, `status=active|completed|abandoned|failed`, `q`. List the files of a batch with
`GET /api/files?uploadSessionId=<id>&status=ready`.

## 6. Messages

Clients can leave messages (and comments on files) in their portal. Staff replies are emailed to the client if they gave an address.

```bash
curl -H "Authorization: Bearer $KEY" https://<your-domain>/api/messages/inbox
curl -H "Authorization: Bearer $KEY" "https://<your-domain>/api/portals/$PORTAL_ID/messages?limit=50"
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"body":"Thanks, the photos are live on the store.","fileId":null}' \
  https://<your-domain>/api/portals/$PORTAL_ID/messages     # needs write → 201 MessageDTO
```

Inbox (one row per portal with messages, newest first):
`{ "items": [ { "portalId", "portalName", "clientId", "clientName", "unread": 2, "total": 5, "lastMessage": MessageDTO } ], "unreadTotal": 3 }`.

`MessageDTO`: `{ "id", "portalId", "fileId", "fileName", "authorType": "client|staff", "authorName", "body", "createdAt", "readAt" }`.
`body` is plain text (max 5000 chars): never render it as HTML. Thread query: `before=<ISO>`, `limit` (max 100), optional `fileId`;
the response is `{ "items": [...oldest to newest], "hasMore": false }`.

## 7. Webhooks

Webhooks push events to your server (or an automation endpoint) so you do not need to poll. They are managed in the web app
(Developers page, owner/admin only) and cannot be managed with an API key.

Create one with: a name, an `https://` URL (plain `http` only in non-production setups), the events to receive (or `*`), and an
optional client filter. A signing secret `whsec_...` is shown **once**.

### Events

| Event | Fires when | `data` |
|---|---|---|
| `upload.completed` | a client finished an upload batch and its files were processed | `{ upload: UploadSessionDTO, files: FileDTO[] (first 500 ready files), fileCount }` |
| `file.ready` | a file finished processing and can be downloaded | `FileDTO` |
| `file.quarantined` | the virus scanner flagged a file | `FileDTO` |
| `file.deleted` | a file was deleted (by staff, an API key or the client) | `{ id, name, relativePath, clientId, portalId, size }` |
| `message.created` | a client sent a message or file comment | `MessageDTO & { clientId, clientName, portalName }` |
| `client.created` | a client was created | `ClientDTO` |
| `portal.created` | a portal was created | `PortalDTO` without `url` and `tokenPreview` |
| `webhook.test` | you pressed "Send test" | `{ message, webhookId, webhookName }` |

### Request your endpoint receives

`POST` with `Content-Type: application/json` and these headers:

| Header | Value |
|---|---|
| `User-Agent` | `ScenoxVault-Webhooks/1.0` |
| `X-Scenox-Event` | event name, e.g. `upload.completed` |
| `X-Scenox-Delivery` | delivery id (same as `id` in the body); use it to de-duplicate |
| `X-Scenox-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` |

Body:

```json
{
  "id": "5d0f6c1e-3b6f-4c0a-9e8e-0e2f1b7a9c11",
  "event": "upload.completed",
  "createdAt": "2026-10-03T10:00:00.000Z",
  "data": {
    "upload": { "id": "c3d4...", "clientId": "6f1c...", "clientName": "Acme Co", "portalId": "a1b2...", "status": "completed", "uploaderName": "Jane", "message": "Photos for the spring range", "uploadedFiles": 2, "...": "..." },
    "files": [ { "id": "0b9e...", "name": "front.jpg", "relativePath": "SKU-1001", "status": "ready", "tags": [], "meta": {}, "...": "..." } ],
    "fileCount": 2
  }
}
```

`file.deleted` example data: `{ "id": "0b9e...", "name": "front.jpg", "relativePath": "SKU-1001", "clientId": "6f1c...", "portalId": "a1b2...", "size": 482113 }`.

### Verify the signature

The HMAC key is the **entire secret string exactly as shown, including the `whsec_` prefix**. The signed message is the
timestamp, a dot, and the **raw request body bytes** (before any JSON parsing): `"<t>.<rawBody>"`. Compare in constant time
and reject timestamps older than 5 minutes to stop replays.

Node.js (Express; keep the raw body):

```js
import crypto from 'node:crypto';
import express from 'express';

const SECRET = process.env.SCENOX_WEBHOOK_SECRET; // "whsec_..." (the full string)
const app = express();

app.post('/scenox', express.raw({ type: 'application/json', limit: '10mb' }), (req, res) => {
  const header = String(req.get('X-Scenox-Signature') || '');
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${req.body.toString('utf8')}`).digest('hex');
  const ok =
    Number.isFinite(t) &&
    Math.abs(Date.now() / 1000 - t) < 300 &&
    parts.v1 && parts.v1.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  if (!ok) return res.status(400).send('bad signature');

  const event = JSON.parse(req.body.toString('utf8'));
  // de-duplicate on event.id (== X-Scenox-Delivery), then handle event.event / event.data
  res.sendStatus(204); // reply 2xx quickly; do slow work asynchronously
});
```

Python (Flask):

```python
import hashlib, hmac, os, time
from flask import Flask, request, abort

SECRET = os.environ["SCENOX_WEBHOOK_SECRET"].encode()  # "whsec_..." (the full string)
app = Flask(__name__)

@app.post("/scenox")
def scenox():
    header = request.headers.get("X-Scenox-Signature", "")
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        abort(400)
    raw = request.get_data()  # raw bytes, not request.json
    expected = hmac.new(SECRET, f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
    if abs(time.time() - t) > 300 or not hmac.compare_digest(parts.get("v1", ""), expected):
        abort(400)
    event = request.get_json(force=True)
    # de-duplicate on event["id"], then handle event["event"] / event["data"]
    return "", 204
```

### Delivery behaviour

- Reply with any `2xx` within 10 seconds to acknowledge. Anything else (non-2xx, timeout, connection error) is retried up to
  8 attempts with exponential backoff starting at 10 seconds (about 40 minutes in total). Redirects are not followed.
- Delivery is at least once and not strictly ordered: de-duplicate on `id` and make handlers idempotent.
- After 50 consecutive failed deliveries the webhook is disabled automatically and the team is notified in the app.
- Delivery history (status, attempts, response status and first 1 KB of the response, error) is kept 30 days and can be
  redelivered from the web app.
- Destinations resolving to private, loopback, link-local or cloud-metadata addresses are refused (SSRF protection), so the
  endpoint must be publicly reachable. Use a tunnel such as ngrok when developing locally.
- Because files are processed after upload, `file.ready` fires a few seconds after the upload; `upload.completed` fires once the
  whole batch has been processed. A webhook with a `clientId` filter only receives events for that client.

## 8. Recipe: push a client's product images to Shopify

Assumption: the client uploads one folder per product (the folder name is the SKU or handle), for example
`SKU-1001/front.jpg`, `SKU-1001/side.jpg`, `SKU-1002/front.jpg`. Files already pushed are tagged `shopify`.

Steps:

1. **Find the client**: `GET /api/clients?q=acme` → take `items[0].id`.
2. **List product folders**: `GET /api/files/browse?clientId=<id>&path=` → `folders[]` (each `name` is a SKU).
3. **List images not yet pushed** in a folder (use `type=image` and `status=ready`):
   `GET /api/files?clientId=<id>&path=SKU-1001&type=image&status=ready&notTag=shopify&sort=name&order=asc&pageSize=200`
   (omit `path` to get all folders at once and group by `relativePath`).
4. **Create a signed URL for each image** with a generous lifetime because Shopify fetches asynchronously:
   `POST /api/files/<fileId>/signed-url` with `{"expiresIn":86400}` → `url`.
5. **Create the product in Shopify** (Admin GraphQL, API 2025-01 or newer) and attach the images with `originalSource=<signed url>`.
6. **Mark the files done**: `PATCH /api/files/<fileId>` with `{"addTags":["shopify"],"meta":{"shopifyProductId":"gid://shopify/Product/123"}}`,
   or in bulk with `POST /api/files/tags`. Do this only after Shopify accepted the media.

Shopify Admin GraphQL (POST `https://<shop>.myshopify.com/admin/api/2025-01/graphql.json`, header `X-Shopify-Access-Token`):

```graphql
mutation CreateProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
  productCreate(product: $product, media: $media) {
    product { id handle media(first: 20) { nodes { id status } } }
    userErrors { field message }
  }
}
```

```json
{
  "product": { "title": "SKU-1001", "handle": "sku-1001", "status": "DRAFT", "productOptions": [] },
  "media": [
    { "originalSource": "https://<your-domain>/api/public/files/0b9e.../1790000000/3Hq.../front.jpg", "mediaContentType": "IMAGE", "alt": "SKU-1001 front" },
    { "originalSource": "https://<your-domain>/api/public/files/7a41.../1790000000/Zk9.../side.jpg",  "mediaContentType": "IMAGE", "alt": "SKU-1001 side" }
  ]
}
```

If the product already exists, add images with `productCreateMedia` (older API versions use the same shape inside `media`):

```graphql
mutation AddImages($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media { id status }
    mediaUserErrors { field message }
  }
}
```

(`productSet` also works for create-or-update by handle; pass the same `originalSource` URLs under `files`.)

Complete script (Node 20+, no dependencies):

```js
const VAULT = 'https://<your-domain>/api';
const KEY = process.env.SCENOX_API_KEY;
const SHOP = process.env.SHOPIFY_SHOP; // e.g. my-store.myshopify.com
const TOKEN = process.env.SHOPIFY_TOKEN;

const vault = async (path, init = {}) => {
  const res = await fetch(VAULT + path, { ...init, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...init.headers } });
  if (res.status === 429) { await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') || 5) * 1000)); return vault(path, init); }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};
const shopify = async (query, variables) => {
  const res = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
    method: 'POST', headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
};

const CREATE = `mutation($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
  productCreate(product: $product, media: $media) { product { id } userErrors { field message } } }`;

async function pushClient(clientId) {
  // 1. all ready, un-pushed images for the client, oldest first
  const images = [];
  for (let page = 1; ; page++) {
    const r = await vault(`/files?clientId=${clientId}&type=image&status=ready&notTag=shopify&sort=completedAt&order=asc&pageSize=200&page=${page}`);
    images.push(...r.items);
    if (page * r.pageSize >= r.total) break;
  }
  // 2. one product per folder (the folder name is the SKU)
  const bySku = new Map();
  for (const f of images) {
    const sku = f.relativePath.split('/')[0];
    if (!sku) continue; // files in the root have no product
    (bySku.get(sku) ?? bySku.set(sku, []).get(sku)).push(f);
  }
  for (const [sku, files] of bySku) {
    const media = [];
    for (const f of files) {
      const { url } = await vault(`/files/${f.id}/signed-url`, { method: 'POST', body: JSON.stringify({ expiresIn: 86400 }) });
      media.push({ originalSource: url, mediaContentType: 'IMAGE', alt: `${sku} ${f.name}` });
    }
    const data = await shopify(CREATE, { product: { title: sku, handle: sku.toLowerCase(), status: 'DRAFT' }, media });
    const { product, userErrors } = data.productCreate;
    if (userErrors.length) { console.error(sku, userErrors); continue; } // leave untagged → retried next run
    // 3. tag as done (+ remember the product id)
    for (const f of files) {
      await vault(`/files/${f.id}`, { method: 'PATCH', body: JSON.stringify({ addTags: ['shopify'], meta: { shopifyProductId: product.id } }) });
    }
    console.log('pushed', sku, product.id, files.length, 'images');
  }
}
await pushClient(process.argv[2]);
```

Notes for agents:

- Idempotency comes from the `shopify` tag: run the script as often as you like. If it fails halfway the untagged files are
  simply picked up next time (at worst a product is created twice: check by handle first for safety).
- Shopify downloads the media asynchronously after the mutation returns; the signed URL must stay valid until then, which is why
  `expiresIn: 86400` is recommended. Check `media.nodes[].status` (`UPLOADED`, `READY`, `FAILED`) if you need confirmation.
- Never print or store signed URLs in public places: anyone with the URL can download the file until it expires.
- Respect Shopify's rate limits (GraphQL cost-based); sleep and retry on `THROTTLED`.
- Quarantined files are never listed as `ready`, so they are skipped automatically.

### Variant: react to uploads with a webhook

Instead of polling, create a webhook for `upload.completed` (optionally restricted to one client) pointing at your service. On
each delivery:

1. Verify the signature (section 7) and de-duplicate on `id`.
2. `data.files` already contains up to 500 ready `FileDTO`s of the batch; group them by `relativePath` (SKU) as above. If
   `data.fileCount > data.files.length`, fetch the rest with `GET /api/files?uploadSessionId=<data.upload.id>&status=ready&notTag=shopify&page=2...`.
3. For each SKU create a signed URL per file, call Shopify `productCreate`, then tag with `PATCH /api/files/:id` (`addTags`, `meta`).
4. Reply `204` immediately and do steps 2 and 3 in a background job, because the delivery times out after 10 seconds.

For per-file reactions use `file.ready` (fires as each file finishes processing; `data` is the `FileDTO`).

## 9. Endpoint index

All paths are under `/api`. "Scope" is the minimum API key scope; `session` means a signed-in browser user only.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/clients`, `/clients/:id` | read | list/get clients |
| POST | `/clients` | write | create client |
| PATCH | `/clients/:id` | write | update client |
| GET | `/portals`, `/portals/:id` | read | list/get portals |
| POST | `/portals` | write | create portal (response includes the secret `url`) |
| PATCH | `/portals/:id` | write | update portal |
| GET | `/files` | read | list files with filters |
| GET | `/files/browse` | read | folders + files of a folder |
| GET | `/files/:id` | read | get a file |
| GET | `/files/:id/download` | read | stream file bytes (needs the key header) |
| POST | `/files/:id/signed-url` | read | create a public time-limited URL |
| PATCH | `/files/:id` | write | rename, tags, meta |
| POST | `/files/tags` | write | bulk add/remove tags |
| POST | `/files/move` | write | move files to another folder |
| DELETE | `/files/:id`, POST `/files/delete` | write (owner/admin keys) | delete files |
| GET | `/uploads`, `/uploads/:id` | read | upload batches |
| DELETE | `/uploads/:id` | write (owner/admin keys) | delete a batch and its files |
| GET | `/messages/inbox` | read | threads overview |
| GET | `/portals/:id/messages` | read | a portal's thread |
| POST | `/portals/:id/messages` | write | post a staff reply |
| POST/GET | `/exports`, `/exports/:id`, `/exports/:id/download` | read | ZIP exports |
| GET | `/activity` | read | activity log |
| GET | `/docs` | none | this guide (Markdown) |
| GET | `/public/files/:id/:exp/:sig/:name` | none | the signed URL itself |
| * | `/developer/*` (API keys, webhooks) | session | managed in the web app only |
