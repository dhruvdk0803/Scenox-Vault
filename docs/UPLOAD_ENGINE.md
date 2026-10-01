# Upload engine

How a 100 GB upload survives a flaky connection, and which knobs change its behaviour.

- Browser side: `apps/web/src/lib/upload/` (tus-js-client + queue, adaptive concurrency, IndexedDB persistence)
- Server side: `apps/api/src/services/tus.ts` (`@tus/server` + `@tus/file-store`), mounted at `/api/tus`
- Shared defaults: `UPLOAD_DEFAULTS` in `packages/shared/src/constants.ts`, overridable by env and returned to the portal

## 1. tus protocol usage

[tus 1.0.0](https://tus.io/protocols/resumable-upload) with the **creation**, **creation-with-upload**, **termination** and **expiration** extensions.

| Request | Purpose |
|---|---|
| `POST /api/tus` + `Upload-Length`, `Upload-Metadata` (`filename`, `filetype`, `relativePath`, `sessionId`, `clientKey`, `duplicateAction`, `lastModified`) | create the upload; files that fit in one chunk also send their bytes in this request (creation-with-upload) |
| `PATCH /api/tus/<id>` + `Upload-Offset`, `Content-Type: application/offset+octet-stream` | append one chunk; the body is streamed straight to disk |
| `HEAD /api/tus/<id>` | ask "how many bytes do you have?" — the resume primitive |
| `DELETE /api/tus/<id>` | cancel and delete partial data |

Every request carries `Tus-Resumable: 1.0.0` and the `x-upload-session` bearer header. Tokens are never put in the URL, so they stay out of access logs.

On the server, one upload is one regular file `tus/<id>` plus a `tus/<id>.json` sidecar. The offset **is** the file size, so a crash or restart cannot desynchronise state. A `HEAD` for an upload that already finished (its last response was lost) reports it complete, so the client stops instead of re-sending.

## 2. Validation before bytes (`onUploadCreate`)

Before the first byte is accepted the API checks, in order: the session token and portal state (active, not expired, client enabled), declared size present, `sessionId` metadata matches the token, file name sanitised (directories, control characters and traversal stripped), the portal's extension allow-list and the global block-list (`exe scr bat cmd ps1 …`), per-file size limit (`MAX_FILE_SIZE`, portal `max_file_size_bytes`), and **quota** (client and portal, counting uploads still in flight). Quota checks run under a per-client Postgres advisory lock so parallel creates cannot over-commit. Duplicates follow the client's choice: `replace`, `keep_both` (auto-renamed) or `skip`.

Rejections use proper statuses (`413 too_large/quota_exceeded`, `400 blocked_type`, `409 duplicate_skipped`, `401 session_invalid`, `403 portal_expired/portal_disabled`) with a JSON body the portal turns into a human message. A client can also call `…/preflight` for a whole selection (up to 5,000 files) to learn verdicts before queuing.

## 3. Chunking

Each file is sent as a series of bounded `PATCH` requests instead of one endless stream. Why: a failed request costs at most one chunk, proxies and CDNs see finite bodies, and progress/ETA are accurate.

`chooseChunkSize(fileSize)` (`chunk-size.ts`):

1. File ≤ `DEFAULT_CHUNK_SIZE` → one request, chunk = file size (a 5 MB photo is one POST).
2. Otherwise start at `DEFAULT_CHUNK_SIZE` (**64 MiB**).
3. If that would exceed **10,000 chunks**, scale up to `ceil(size / 10,000)`.
4. Round up to whole MiB and clamp to `[MIN_CHUNK_SIZE, MAX_CHUNK_SIZE]` (**8 MiB – 256 MiB**).

| File size | Chunk | Chunks |
|---|---|---|
| 50 MB | 50 MB (single request) | 1 |
| 1 GB | 64 MiB | 15 |
| 25 GB | 64 MiB | ~373 |
| 100 GB | 64 MiB | ~1,490 |
| 1 TB | 96 MiB | ~9,950 |

A bigger chunk means fewer round trips and less per-request overhead; a smaller one means less re-sending after a failure and compatibility with proxies that cap body size (see §9). 64 MiB is a balance for 100 Mbps–1 Gbps uplinks.

## 4. Parallelism

- **Files in parallel**, not chunks of one file in parallel. Default `MAX_CONCURRENT_UPLOADS=4` (range 1–16). One large file already saturates most uplinks with one TCP/QUIC stream per request; parallel files help with many small and medium files and hide per-request latency.
- **Adaptive:** `AdaptiveConcurrency` starts at `min(max, 4)`. Two failures within 30 s step it down by one (minimum 1); after 60 s with no error it steps back up by one (up to the max). A bad connection therefore degrades gracefully instead of thrashing.
- The browser queue is virtualised, so selecting 10,000 files stays smooth. Folder structure is preserved via `relativePath`.

## 5. Retries and backoff

Three layers:

1. **Per request (tus-js-client):** `RETRY_COUNT` retries (default 6) with delays `0.5 s → 1 → 2 → 4 → 8 → 16 s` (final delay repeats). Retried: network errors and status ≥ 500, plus 408, 409, 423 and 429. Never retried: other 4xx (401 session expired, 403, 413 too large, 422…) — retrying cannot help, so the user gets a clear message.
2. **Stall watchdog:** a request that makes no progress for 60 s is aborted and restarted (up to 5 times) — this catches half-open TCP connections after Wi-Fi changes.
3. **File-level auto-retry:** when a file exhausts layer 1 it moves to *failed (retrying)* and is retried automatically after 15 s, 30 s, 60 s, 120 s, 120 s; the user can also press Retry. Going back online (`online` event) or waking from sleep triggers an immediate attempt.

Every retry first issues `HEAD` and continues from the **server's** offset, so a retry never restarts a file and never duplicates bytes.

## 6. Resumability

| Situation | What happens |
|---|---|
| Network drop, Wi-Fi switch, laptop sleep | automatic — same tab, same in-memory upload; `HEAD` → continue at the server offset |
| Page refresh or tab closed, same browser | the upload URL is stored in **IndexedDB** keyed by a *fingerprint* `portal token | folder | name | size | lastModified`; the session token is stored too and validated with `GET …/sessions/current`. When the user selects the same files again, the engine finds the stored URL and resumes instead of re-uploading |
| Browser/computer restart | same as above — IndexedDB persists |
| Different browser or device | not resumable; the partial upload expires and the file starts again |
| Server restart / deploy mid-upload | clients see a failed request, retry with backoff, and resume once the API is back (offsets are on disk) |

**Honest limitation:** browsers deliberately never give a web page persistent access to a file on disk. After a refresh or restart the page does *not* know which files you were uploading and cannot re-read them by itself — the user must **select the same files (or folder) again**. The portal shows "unfinished uploads" and asks for them, and matching is by fingerprint, so picking the same files continues where it left off; picking a modified file (different size or modified time) starts fresh. Within a single tab session no re-selection is needed. This is a platform security rule, not a gap that can be engineered away (the File System Access API's persistent handles exist only in some Chromium browsers and are not relied on).

Abandoned partial uploads expire after **Retention → incomplete uploads** (default 72 h) and are deleted by the cleanup job.

## 7. After the last byte (post-processing pipeline)

```
PATCH completes → onUploadFinish
   1. stat tus/<id>: size must equal the declared (and validated) size, else 422 + delete
   2. rename tus/<id> → staging/<uuid>             (O(1), same filesystem)
   3. DB: status = processing, counters ++, duplicate "replace" applied
   4. enqueue process-file
worker: process-file
   5. SHA-256 (streamed)  6. magic-byte MIME sniff  7. duplicate detection by checksum
   8. ClamAV INSTREAM scan (if CLAMAV_ENABLED)
   9. clean    → rename → uploads/{clientId}/{portalId}/{sessionId}/{fileId}, status = ready
      infected → rename → quarantine/, status = quarantined (not downloadable), admins notified
      scan error → job retried by BullMQ (5 attempts, exponential backoff); file marked failed if all attempts fail
```

The client sees "uploaded" at step 3; admins see the file as *processing* until step 9. Large checksums run in the worker, never in the request.

## 8. Failure modes

| Failure | Detected by | Result |
|---|---|---|
| Connection drops mid-chunk | request error | retry with backoff; `HEAD` → resume at server offset |
| Half-open connection (no error, no data) | 60 s stall watchdog | request aborted and restarted |
| Proxy returns 502/503/504 | status ≥ 500 | retried; adaptive concurrency steps down |
| Chunk larger than a proxy allows (`413`) | status 413 | **not** retried — file marked rejected with "larger than this link allows". Lower `MAX_CHUNK_SIZE`, see §9 |
| Session token expired | 401 `session_invalid` | portal asks the user to refresh; the stored upload URLs survive and resume on re-selection |
| Portal expired / disabled mid-upload | 403 | stop, clear message |
| Quota exceeded | 413 `quota_exceeded` at creation | rejected before any bytes |
| Disk full | write error on server | 500 → retries fail → file failed; `/api/ready` and the System page report storage; disk alerts at warning/critical thresholds |
| API crash / restart | connection reset | retries until API is back; offsets persisted on disk |
| Lost final response | client retries, `HEAD` shows complete | server reports the finished upload; client marks it done (no duplicate) |
| Two tabs upload the same file | creation supersedes the stale *uploading* attempt of the same session | newest wins; no corrupted file |
| Size mismatch after finish | `onUploadFinish` stat | 422, partial deleted, file `failed`, client retries from scratch |
| Worker down | queue grows | files stay *processing*; they complete when the worker returns (stuck ones are re-queued by cleanup) |
| Infected file | ClamAV | quarantined, never served |
| User cancels | `DELETE /api/tus/<id>` | partial removed, file `cancelled` |

## 9. Tuning knobs

All in `.env` (sizes accept `64MB`, `1.5GB`, bytes; empty/0 = unlimited where applicable). Restart `api` after changes: `docker compose up -d`.

| Variable | Default | Effect |
|---|---|---|
| `MAX_CONCURRENT_UPLOADS` | 4 | upper bound of parallel files per browser (1–16) |
| `DEFAULT_CHUNK_SIZE` | 64MB | normal chunk; also the "single request" threshold |
| `MAX_CHUNK_SIZE` | 256MB | ceiling used when a file is so large that chunks must grow |
| `MIN_CHUNK_SIZE` | 8MB | floor |
| `RETRY_COUNT` | 6 | per-request retries before the file is marked failed (then auto-retried) |
| `UPLOAD_TIMEOUT` | 600000 (ms) | idle socket timeout on the API for upload requests |
| `MAX_FILE_SIZE` / `MAX_PORTAL_SIZE` | 0 (unlimited) | global limits; portals and clients can set tighter ones |
| `WORKER_CONCURRENCY` | 2 | parallel checksum/scan/ZIP jobs — raise only if disk and CPU are idle |

Rules of thumb: slow/unstable uplink (< 20 Mbps) → `DEFAULT_CHUNK_SIZE=16MB`, `MAX_CONCURRENT_UPLOADS=2`. Fast fibre + 10 GbE server → 128MB chunks, 6–8 files. Behind Cloudflare → see below.

### Cloudflare proxy caveat (important)

If the upload domain is **proxied** (orange cloud) through Cloudflare:

- The **Free and Pro plans limit request bodies to 100 MB** (Business 200 MB, Enterprise 500 MB). A 64 MB chunk fits; the default `MAX_CHUNK_SIZE=256MB` does **not**, and very large files can legitimately need chunks above 64 MB. Set `DEFAULT_CHUNK_SIZE=64MB` and **`MAX_CHUNK_SIZE=95MB`** (keep ≤ 95 MB to leave room for overhead) — files up to ~950 GB still fit in the 10,000-chunk target (beyond that the chunk count simply grows past the target; it still works).
- Symptom of a too-large chunk: uploads stall or fail at exactly 100 MB with HTTP 413.
- Cloudflare also times out requests that take too long to answer (100 s); slow uplinks should use smaller chunks (16–32 MB).
- Alternatively keep `upload.` as **DNS only** (grey cloud): Caddy then serves it directly with no body limit, and you can still proxy the admin domain.

## 10. Throughput bottleneck analysis

Throughput is the minimum of a chain. Find the narrowest link first:

| # | Link | Typical limit | How to tell | Fix |
|---|---|---|---|---|
| 1 | **Client uplink** | home/office upload 20–1000 Mbps; this is almost always the bottleneck | bench from a datacentre host reaches much higher speeds | nothing server-side; larger chunks and 2–4 parallel files help fill it |
| 2 | **Internet path / latency** | RTT × TCP window; long-haul links need parallelism | per-file speed low, aggregate scales with files | more parallel files; HTTP/3 (QUIC) helps on lossy links |
| 3 | **VPS network interface** | 1 Gbps (≈ 110 MB/s) on most VPS plans, sometimes shared/capped lower | `nload`/`ifstat` saturated at the plan limit | bigger plan; or direct-to-object-storage uploads (stage 2 of the scaling path) |
| 4 | **Disk write** | NVMe 500–3000 MB/s sequential; VPS network storage 100–400 MB/s; `iostat -x` `%util` ~100 | `iostat -xz 1`, `await` rising | faster volume; limit `WORKER_CONCURRENCY` (checksums read the same disk) |
| 5 | **TLS / TCP CPU** | AES-NI makes TLS cheap (~1–2 GB/s/core), but small vCPU counts or no AES-NI hurt | one core at 100 % in Caddy (`docker stats`) | HTTP/2 is already used; more vCPU |
| 6 | **Reverse proxy buffering** | Nginx default buffers whole bodies to temp files | disk write doubles, latency before first byte reaches API | Caddy defaults / `proxy_request_buffering off` (provided configs) |
| 7 | **Node API** | streaming copy; one core handles hundreds of MB/s | `api` container CPU pegged | rarely the limit; raise `NODE` resources, scale out (stage 3) |
| 8 | **Post-processing** | SHA-256 ≈ 400–800 MB/s/core; ClamAV ≈ 50–200 MB/s | queue length grows after uploads end | does not slow the upload itself; add worker CPU |

Measure with [PERFORMANCE_TESTING.md](PERFORMANCE_TESTING.md) rather than guessing.
