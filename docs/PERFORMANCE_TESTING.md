# Performance testing

Goal: find out what *your* server and network actually deliver, and which link in the chain limits it. No numbers are published here because they depend entirely on the target VPS, its network and where the test runs from — **fill in the results table yourself** (§6).

## 1. The harness

`scripts/upload-bench.mjs` is a dependency-free Node (≥ 20) script that talks the real tus protocol to a real portal:

1. creates an upload session (`POST /api/public/portals/:token/sessions`),
2. uploads *N* synthetic files of a given size over tus (`POST` create, chunked `PATCH`, `HEAD` to resume) with configurable concurrency and chunk size,
3. generates file bytes on the fly (incompressible, unique per file) and streams them — **no file or chunk is ever held in memory**,
4. reports per-file and aggregate throughput (MB/s and Mbps on server-acknowledged bytes), total time, retries, failed chunks and its own RSS.

```bash
node scripts/upload-bench.mjs --help
node scripts/upload-bench.mjs --url https://upload.example.com/u/<TOKEN> --files 1 --size 1GB
```

Key options: `--files`, `--size` (`100MB`, `5GB`, `50KB`…), `--concurrency` (default 4), `--chunk` (default 64MB), `--cwu` (creation-with-upload for small files), `--password`, `--json out.json`, `--verbose`. Sizes are decimal (MB = 10⁶) like the app config; `MiB/GiB` accepted.

### Prepare a safe target

- Create a dedicated client *“Benchmark”* and a portal with **no quota**, no extension restrictions and no password (or pass `--password`). Note the link.
- Benchmark uploads are real: they use disk, trigger checksum jobs and notifications. Disable notification e-mails for the run, and **delete the client afterwards** (admin → Clients → Delete) to free space.
- Make sure the portal's `maxFileSize`/quota and `MAX_FILE_SIZE` allow the sizes below, and that free disk ≥ 2× the test volume.
- Run the client from a machine whose network you understand. For a server-capacity measurement run it from a **different datacentre host** with a fat pipe (e.g. another VPS) — a home uplink measures your uplink, not the server. For a real-world measurement run it from where your clients are.

## 2. Test matrix

Run each, 3 repetitions, note the median.

**Size ladder (single file → how big files behave)**

```bash
URL=https://upload.example.com/u/<TOKEN>
node scripts/upload-bench.mjs --url $URL --files 1 --size 100MB  --concurrency 1
node scripts/upload-bench.mjs --url $URL --files 1 --size 1GB    --concurrency 1
node scripts/upload-bench.mjs --url $URL --files 1 --size 5GB    --concurrency 1
node scripts/upload-bench.mjs --url $URL --files 1 --size 10GB   --concurrency 1
node scripts/upload-bench.mjs --url $URL --files 1 --size 25GB   --concurrency 1   # and larger if disk allows
```

**Count ladder (many files → per-request overhead, DB, queue)**

```bash
node scripts/upload-bench.mjs --url $URL --files 1     --size 1GB   --concurrency 1
node scripts/upload-bench.mjs --url $URL --files 100   --size 10MB  --concurrency 4  --cwu
node scripts/upload-bench.mjs --url $URL --files 1000  --size 1MB   --concurrency 8  --cwu
node scripts/upload-bench.mjs --url $URL --files 10000 --size 50KB  --concurrency 8  --cwu
```

**Concurrency and chunk sweeps (tuning)**

```bash
for c in 1 2 4 8;   do node scripts/upload-bench.mjs --url $URL --files 8 --size 1GB --concurrency $c --json c$c.json; done
for k in 16MB 64MB 128MB; do node scripts/upload-bench.mjs --url $URL --files 4 --size 2GB --chunk $k --json k$k.json; done
```

**Resilience** (not a speed test): start a 5 GB upload and, midway, `docker compose restart api`, or block 443 with `ufw` for 20 s. Expect retries > 0, `Files 1 ok`, and no restart from zero.

## 3. What to measure, and how

Open 3–4 terminals on the **server** while a test runs.

| Metric | Command | Look for |
|---|---|---|
| Aggregate MB/s, Mbps, retries, failed chunks | the harness summary (`--json` for later) | steady throughput; retries ≈ 0 on a healthy link |
| CPU and RAM per container | `docker stats --no-stream` (loop: `watch -n1 docker stats --no-stream`) | `caddy` CPU (TLS), `api` CPU (stream copy), `api` memory flat (streaming!), `worker` CPU during checksums |
| Disk write throughput and saturation | `iostat -xz 1` (package `sysstat`) — columns `wMB/s`, `w_await`, `%util` | `%util` near 100 or `w_await` climbing ⇒ disk-bound |
| Disk free during/after | `watch -n5 df -h /var/lib/docker` | `tus/` + `staging/` transient usage matches expectations |
| Network in/out | `nload -u M eth0` or `ifstat -i eth0 1` (`-u M` = MB/s) | NIC at the plan limit ⇒ network-bound |
| TCP health / retransmits | `ss -ti dst <client-ip>` or `nstat -az TcpRetransSegs` | retransmits point at the path, not the server |
| QUIC vs TCP | browser dev tools protocol column (`h3`/`h2`), `docker compose logs caddy` | compare h2 vs h3 on lossy links |
| Post-processing lag | System page queues, or `docker compose logs worker` | time from "upload finished" to `ready`; checksum MB/s |
| API errors | `docker compose logs api \| grep -E '"level":(50\|60)'` | none expected |
| Client RSS | harness summary | tens of MB, flat regardless of file size |

Baseline the pipes **before** blaming the app: `iperf3 -c <server>` from the client for raw network capacity; `fio --name=w --rw=write --bs=1M --size=4G --direct=1 --directory=/var/lib/docker/volumes/scenox-vault_upload_data/_data` for raw disk write speed. A healthy Scenox upload should reach ≈ min(client uplink, iperf3, fio) minus modest overhead; if it doesn't, look at the proxy, TLS CPU or chunk/concurrency settings ([UPLOAD_ENGINE.md §10](UPLOAD_ENGINE.md#10-throughput-bottleneck-analysis)).

## 4. Interpreting results

| Observation | Likely cause |
|---|---|
| Throughput ≈ client's known uplink | client-bound — the server is not the limit |
| Throughput ≈ 110 MB/s from a fast host, NIC graph flat at the cap | VPS 1 Gbps NIC |
| `%util` ≈ 100, high `w_await`, NIC not saturated | disk-bound (network-attached volume, noisy neighbour) |
| Caddy at ~100 % of one core | TLS/QUIC CPU-bound — more vCPU; try forcing h2 to compare |
| Per-file speed low but aggregate scales with `--concurrency` | high latency / per-connection limits — use more parallel files |
| Many `failed chunks`, retries | unstable path, proxy timeouts, or server restarts — check `docker compose logs`, MTU, Cloudflare |
| `api` memory grows with file size | a streaming bug — report it; it should stay flat |
| Many small files slow, MB/s tiny but req/s high | per-file overhead (DB insert + tus create); use `--cwu`, raise concurrency |
| Throughput decays after a few GB | write cache exhausted on the disk/VPS; compare with `fio` |

## 5. Pass criteria (suggested)

- 25 GB single file completes with zero data loss: checksum in the admin equals `sha256sum` of the source if you upload a real file (synthetic files are generated, so compare size and `ready` status instead).
- Restart/blip test completes with retries > 0 and no restart from zero.
- `api` RSS stays flat (± tens of MB) during a 25 GB upload.
- 10,000 small files complete with no failures; admin file list and search remain responsive.
- Throughput within ~10–15 % of the lower of (`iperf3`, `fio`) on the same path.

## 6. Results template (to be filled on target VPS)

Environment — server: `________` (vCPU / RAM / disk type / NIC) · client host: `________` · path RTT: `___ ms` · iperf3: `___ Mbps` · fio write: `___ MB/s` · version/commit: `________` · date: `________`

| Scenario | Files × size | Concurrency | Chunk | Time | MB/s | Mbps | Retries | Failed chunks | API CPU % | API RAM | Caddy CPU % | Disk wMB/s (`iostat`) | NIC MB/s | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 MB | 1 × 100MB | 1 | 64MB | to be filled on target VPS | | | | | | | | | | |
| 1 GB | 1 × 1GB | 1 | 64MB | to be filled on target VPS | | | | | | | | | | |
| 5 GB | 1 × 5GB | 1 | 64MB | to be filled on target VPS | | | | | | | | | | |
| 10 GB | 1 × 10GB | 1 | 64MB | to be filled on target VPS | | | | | | | | | | |
| 25 GB+ | 1 × 25GB | 1 | 64MB | to be filled on target VPS | | | | | | | | | | |
| 100 files | 100 × 10MB | 4 | 64MB | to be filled on target VPS | | | | | | | | | | |
| 1,000 files | 1000 × 1MB | 8 | 64MB | to be filled on target VPS | | | | | | | | | | |
| 10,000 files | 10000 × 50KB | 8 | 64MB | to be filled on target VPS | | | | | | | | | | |
| Concurrency sweep | 8 × 1GB | 1 / 2 / 4 / 8 | 64MB | to be filled on target VPS | | | | | | | | | | |
| Chunk sweep | 4 × 2GB | 4 | 16 / 64 / 128MB | to be filled on target VPS | | | | | | | | | | |
| Resilience | 1 × 5GB, api restart | 1 | 64MB | to be filled on target VPS | | | | | | | | | | |

Post-processing: time from last byte to `ready` for the 10 GB file: `___ s` (checksum `___ MB/s`); with ClamAV: `___ s`.
