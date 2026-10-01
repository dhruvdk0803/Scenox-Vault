#!/usr/bin/env node
/**
 * Scenox Vault — upload performance harness.
 *
 * Creates an upload session on a portal, then uploads N synthetic files over the real tus 1.0
 * endpoint (POST create -> PATCH chunks -> HEAD to resume) with configurable concurrency and
 * chunk size, and reports throughput, retries and client memory.
 *
 * File contents are generated on the fly by a deterministic generator and streamed to the
 * network: neither a whole file nor a whole chunk is ever held in memory.
 * Zero dependencies — Node >= 20 (global fetch + streams).
 *
 *   node scripts/upload-bench.mjs --help
 */
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const HELP = `
Scenox Vault upload benchmark

USAGE
  node scripts/upload-bench.mjs --url <portal-url> [options]

REQUIRED
  --url <url>            Portal link, e.g. https://upload.example.com/u/<token>
                         (or the API origin + --token)

OPTIONS
  --files <n>            Number of files to upload                         [default: 1]
  --size <size>          Size of each file: 100MB, 1GB, 25GB, 4096 ...      [default: 100MB]
  --concurrency <n>      Files uploaded in parallel                         [default: 4]
  --chunk <size>         tus chunk (PATCH body) size                        [default: 64MB]
  --retries <n>          Retries per request before the file fails          [default: 6]
  --prefix <path>        relativePath (folder) for the files, e.g. bench/run1  [default: bench]
  --token <token>        Portal token (when --url is just the origin)
  --password <pw>        Portal password (calls /unlock to get an access token)
  --access-token <t>     Existing x-portal-access token
  --name/--email/--company/--message <s>   Uploader details for the session (for portals that require them)
  --tus-path <path>      tus endpoint path                                  [default: /api/tus]
  --cwu                  Use creation-with-upload for files that fit in one chunk
  --no-complete          Do not call /sessions/complete at the end
  --piece <size>         Generator piece size (memory/CPU trade-off)        [default: 1MiB]
  --json <file>          Write full results as JSON
  --verbose              Print a line per file (default when files <= 20)
  -h, --help             Show this help

SIZES accept B, KB, MB, GB, TB (decimal, like the app config) and KiB, MiB, GiB, TiB (binary).
Throughput is reported in MB/s (decimal) and Mbps (megabits/s) on server-acknowledged bytes.

EXAMPLES
  # 1 x 1 GB, 64 MB chunks
  node scripts/upload-bench.mjs --url https://upload.example.com/u/TOKEN --files 1 --size 1GB

  # 100 files x 100 MB, 4 parallel
  node scripts/upload-bench.mjs --url https://upload.example.com/u/TOKEN --files 100 --size 100MB --concurrency 4

  # 10,000 tiny files
  node scripts/upload-bench.mjs --url https://upload.example.com/u/TOKEN --files 10000 --size 50KB --concurrency 8 --cwu

NOTE  Upload to a throw-away portal/client: benchmark files are real uploads, count against quotas and
      trigger post-processing. Delete the client afterwards. The RSS reported is this script's, not the server's
      (watch the server with \`docker stats\`, see docs/PERFORMANCE_TESTING.md).
`;

// ───────────────────────── helpers ─────────────────────────

const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
function parseSize(v, flag) {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|kib|mib|gib|tib)?$/i.exec(String(v).trim());
  if (!m) fail(`Invalid size for ${flag}: "${v}"`);
  return Math.floor(Number(m[1]) * UNITS[(m[2] ?? 'b').toLowerCase()]);
}
function fail(msg) {
  console.error(`error: ${msg}\n(run with --help)`);
  process.exit(2);
}
const MB = (b) => b / 1e6;
const fmtBytes = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} KB` : `${b} B`);
const fmtDur = (s) => (s < 60 ? `${s.toFixed(1)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 16000];

// ───────────────────────── args ─────────────────────────

const { values: a } = parseArgs({
  options: {
    url: { type: 'string' }, token: { type: 'string' }, files: { type: 'string', default: '1' }, size: { type: 'string', default: '100MB' },
    concurrency: { type: 'string', default: '4' }, chunk: { type: 'string', default: '64MB' }, retries: { type: 'string', default: '6' },
    prefix: { type: 'string', default: 'bench' }, password: { type: 'string' }, 'access-token': { type: 'string' },
    name: { type: 'string' }, email: { type: 'string' }, company: { type: 'string' }, message: { type: 'string' },
    'tus-path': { type: 'string', default: '/api/tus' }, cwu: { type: 'boolean', default: false }, 'no-complete': { type: 'boolean', default: false },
    piece: { type: 'string', default: '1MiB' }, json: { type: 'string' }, verbose: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});
if (a.help) {
  console.log(HELP);
  process.exit(0);
}
if (!a.url) fail('--url is required');

const FILES = Number.parseInt(a.files, 10);
const SIZE = parseSize(a.size, '--size');
const CONC = Number.parseInt(a.concurrency, 10);
const CHUNK = parseSize(a.chunk, '--chunk');
const RETRIES = Number.parseInt(a.retries, 10);
const PIECE = Math.max(4096, Math.min(parseSize(a.piece, '--piece'), CHUNK));
if (!(FILES >= 1) || !(CONC >= 1) || !(CHUNK >= 1) || !(RETRIES >= 0)) fail('--files, --concurrency, --chunk must be positive and --retries >= 0');

let origin;
let token = a.token;
try {
  const u = new URL(a.url);
  origin = u.origin;
  if (!token) {
    const m = /\/u\/([^/?#]+)/.exec(u.pathname) ?? /\/([^/?#]+)\/?$/.exec(u.pathname);
    token = m?.[1];
  }
} catch {
  fail(`--url is not a valid URL: ${a.url}`);
}
if (!token) fail('could not find the portal token in --url; pass --token');
const tusUrl = `${origin}${a['tus-path']}`;
const portalApi = `${origin}/api/public/portals/${encodeURIComponent(token)}`;
const commonHeaders = { origin, 'user-agent': 'scenox-upload-bench/1.0' };

// ───────────────────────── synthetic data ─────────────────────────

// One incompressible random block; each emitted piece is a copy stamped with (file, offset) so that
// every file differs and a resumed chunk regenerates identical bytes.
const BASE = randomBytes(PIECE);
function pieceFor(fileIndex, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  BASE.copy(buf, 0, 0, length);
  if (length >= 16) {
    buf.writeUInt32LE(fileIndex >>> 0, 0);
    buf.writeDoubleLE(offset, 8);
  }
  return buf;
}

/** Stream `length` bytes of file `fileIndex` starting at `start`, PIECE bytes at a time, with back-pressure. */
function chunkStream(fileIndex, start, length, onPull) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= length) return controller.close();
      const n = Math.min(PIECE, length - sent);
      const piece = pieceFor(fileIndex, start + sent, n);
      sent += n;
      onPull(n);
      controller.enqueue(piece);
    },
  });
}

// ───────────────────────── stats ─────────────────────────

const stats = {
  bytesQueued: 0, // pulled by the HTTP client (about to be sent)
  bytesAcked: 0, // acknowledged by the server via Upload-Offset
  retries: 0,
  failedChunks: 0,
  requests: 0,
  filesDone: 0,
  filesFailed: 0,
  rssMax: 0,
  rssSum: 0,
  rssN: 0,
  perFile: [],
};

async function request(url, init) {
  stats.requests++;
  return fetch(url, { redirect: 'manual', ...init });
}

// ───────────────────────── session ─────────────────────────

async function createSession() {
  let accessToken = a['access-token'];
  if (!accessToken && a.password) {
    const r = await request(`${portalApi}/unlock`, {
      method: 'POST', headers: { ...commonHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ password: a.password }),
    });
    if (!r.ok) throw new Error(`unlock failed: HTTP ${r.status} ${await r.text()}`);
    accessToken = (await r.json()).accessToken;
  }
  const headers = { ...commonHeaders, 'content-type': 'application/json', ...(accessToken ? { 'x-portal-access': accessToken } : {}) };
  const r = await request(`${portalApi}/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: a.name ?? 'Upload Bench', email: a.email, company: a.company, message: a.message ?? 'synthetic benchmark upload',
      totalFiles: FILES, totalBytes: FILES * SIZE,
    }),
  });
  if (!r.ok) throw new Error(`could not create upload session: HTTP ${r.status} ${await r.text()}`);
  const s = await r.json();
  return { ...s, accessToken };
}

// ───────────────────────── one file over tus ─────────────────────────

class Fatal extends Error {}

function sameOrigin(location) {
  // Proxies sometimes emit http:// or an internal host in Location; always talk to the origin we were given.
  const u = new URL(location, tusUrl);
  return `${origin}${u.pathname}${u.search}`;
}

async function withRetry(label, fn, state) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err instanceof Fatal || attempt >= RETRIES) throw err instanceof Fatal ? err : new Fatal(`${label}: ${err.message} (gave up after ${attempt} retries)`);
      state.retries++;
      stats.retries++;
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    }
  }
}

async function uploadFile(index, session) {
  const name = `bench-${String(index).padStart(6, '0')}.bin`;
  const state = { name, size: SIZE, retries: 0, failedChunks: 0, start: performance.now(), end: 0, ok: false, error: null };
  const h = (extra = {}) => ({ ...commonHeaders, 'tus-resumable': '1.0.0', 'x-upload-session': session.sessionToken, ...extra });
  const meta = [
    `filename ${b64(name)}`, `filetype ${b64('application/octet-stream')}`, `relativePath ${b64(a.prefix)}`,
    `sessionId ${b64(session.sessionId)}`, `clientKey ${b64(`bench-${index}-${Date.now()}`)}`, `lastModified ${b64(String(Date.now()))}`,
  ].join(',');

  try {
    let location = null;
    let offset = 0;

    // 1) create (optionally with the first/only chunk in the same request)
    const inline = a.cwu && SIZE > 0 && SIZE <= CHUNK;
    await withRetry('create', async () => {
      const r = await request(tusUrl, {
        method: 'POST',
        headers: h({
          'upload-length': String(SIZE), 'upload-metadata': meta,
          ...(inline ? { 'content-type': 'application/offset+octet-stream', 'content-length': String(SIZE) } : { 'content-length': '0' }),
        }),
        ...(inline ? { body: chunkStream(index, 0, SIZE, (n) => (stats.bytesQueued += n)), duplex: 'half' } : {}),
      });
      if (r.status === 201) {
        location = sameOrigin(r.headers.get('location') ?? '');
        if (inline) {
          offset = Number(r.headers.get('upload-offset') ?? SIZE);
          stats.bytesAcked += offset;
        }
        return;
      }
      const text = await r.text().catch(() => '');
      if (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408) throw new Fatal(`create rejected: HTTP ${r.status} ${text.slice(0, 200)}`);
      throw new Error(`create HTTP ${r.status}`);
    }, state);
    if (!location) throw new Fatal('server did not return a Location header');

    // 2) chunks
    while (offset < SIZE) {
      await withRetry(`PATCH@${offset}`, async (attempt) => {
        if (attempt > 0) {
          // resume point: ask the server how much it really has
          const hr = await request(location, { method: 'HEAD', headers: h() });
          if (hr.status === 404 || hr.status === 410 || hr.status === 403) throw new Fatal(`upload vanished on server (HEAD ${hr.status})`);
          if (!hr.ok) throw new Error(`HEAD ${hr.status}`);
          const srv = Number(hr.headers.get('upload-offset'));
          if (Number.isFinite(srv) && srv >= 0 && srv <= SIZE) {
            stats.bytesAcked += srv - offset;
            offset = srv;
          }
          if (offset >= SIZE) return;
        }
        const thisLen = Math.min(CHUNK, SIZE - offset);
        let r;
        try {
          r = await request(location, {
            method: 'PATCH',
            headers: h({ 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream', 'content-length': String(thisLen) }),
            body: chunkStream(index, offset, thisLen, (n) => { stats.bytesQueued += n; }),
            duplex: 'half',
          });
        } catch (err) {
          state.failedChunks++;
          stats.failedChunks++;
          throw err;
        }
        if (r.status === 204 || r.status === 200) {
          const next = Number(r.headers.get('upload-offset'));
          if (!Number.isFinite(next) || next <= offset) throw new Error(`server returned bad Upload-Offset "${r.headers.get('upload-offset')}"`);
          stats.bytesAcked += next - offset;
          offset = next;
          return;
        }
        const text = await r.text().catch(() => '');
        state.failedChunks++;
        stats.failedChunks++;
        if (r.status >= 400 && r.status < 500 && ![408, 409, 423, 429].includes(r.status)) throw new Fatal(`PATCH rejected: HTTP ${r.status} ${text.slice(0, 200)}`);
        throw new Error(`PATCH HTTP ${r.status}`);
      }, state);
    }
    state.ok = true;
    stats.filesDone++;
  } catch (err) {
    state.error = err.message;
    stats.filesFailed++;
  } finally {
    state.end = performance.now();
    stats.perFile.push(state);
  }
  return state;
}

// ───────────────────────── main ─────────────────────────

async function main() {
  console.log(`Scenox upload bench → ${origin}`);
  console.log(`  files=${FILES} size=${fmtBytes(SIZE)} total=${fmtBytes(FILES * SIZE)} concurrency=${CONC} chunk=${fmtBytes(CHUNK)} retries=${RETRIES}${a.cwu ? ' cwu' : ''}`);

  const session = await createSession();
  console.log(`  session ${session.sessionId} created\n`);

  const sampleRss = () => {
    const rss = process.memoryUsage().rss;
    stats.rssMax = Math.max(stats.rssMax, rss);
    stats.rssSum += rss;
    stats.rssN++;
  };
  sampleRss();
  const rssTimer = setInterval(sampleRss, 1000);

  const verbose = a.verbose || FILES <= 20;
  const t0 = performance.now();
  let lastBytes = 0;
  let lastT = t0;
  const progress = setInterval(() => {
    const now = performance.now();
    const inst = ((stats.bytesAcked - lastBytes) / ((now - lastT) / 1000)) || 0;
    lastBytes = stats.bytesAcked;
    lastT = now;
    const pct = (stats.bytesAcked / (FILES * SIZE)) * 100;
    process.stderr.write(`\r\x1b[2K  ${pct.toFixed(1).padStart(5)}%  ${stats.filesDone + stats.filesFailed}/${FILES} files  ${MB(inst).toFixed(1)} MB/s  retries=${stats.retries}   `);
  }, 2000);

  let next = 0;
  const workers = Array.from({ length: Math.min(CONC, FILES) }, async () => {
    while (true) {
      const i = next++;
      if (i >= FILES) return;
      const r = await uploadFile(i, session);
      if (verbose || !r.ok) {
        const secs = (r.end - r.start) / 1000;
        process.stderr.write('\r\x1b[2K');
        console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}  ${fmtBytes(r.size)}  ${fmtDur(secs)}  ${MB(r.ok ? r.size / secs : 0).toFixed(1)} MB/s  retries=${r.retries}${r.error ? `  ${r.error}` : ''}`);
      }
    }
  });
  await Promise.all(workers);
  const wall = (performance.now() - t0) / 1000;
  clearInterval(progress);
  clearInterval(rssTimer);
  sampleRss();
  process.stderr.write('\r\x1b[2K');

  if (!a['no-complete']) {
    await request(`${portalApi}/sessions/complete`, {
      method: 'POST',
      headers: { ...commonHeaders, 'content-type': 'application/json', 'x-upload-session': session.sessionToken, ...(session.accessToken ? { 'x-portal-access': session.accessToken } : {}) },
      body: JSON.stringify({ filesUploaded: stats.filesDone, bytesUploaded: stats.bytesAcked, filesFailed: stats.filesFailed }),
    }).catch(() => {});
  }

  const okFiles = stats.perFile.filter((f) => f.ok);
  const speeds = okFiles.map((f) => f.size / ((f.end - f.start) / 1000));
  const bps = stats.bytesAcked / wall;
  const result = {
    target: origin, files: FILES, fileSizeBytes: SIZE, concurrency: CONC, chunkBytes: CHUNK,
    totalBytesAcked: stats.bytesAcked, wallSeconds: wall,
    aggregateMBps: MB(bps), aggregateMbps: (bps * 8) / 1e6,
    perFileMBps: speeds.length ? { min: MB(Math.min(...speeds)), avg: MB(speeds.reduce((x, y) => x + y, 0) / speeds.length), max: MB(Math.max(...speeds)) } : null,
    filesOk: stats.filesDone, filesFailed: stats.filesFailed, retries: stats.retries, failedChunks: stats.failedChunks, httpRequests: stats.requests,
    clientRssMaxMB: stats.rssMax / 1e6, clientRssAvgMB: stats.rssN ? stats.rssSum / stats.rssN / 1e6 : null,
    errors: stats.perFile.filter((f) => !f.ok).slice(0, 20).map((f) => ({ file: f.name, error: f.error })),
    startedAt: new Date(Date.now() - wall * 1000).toISOString(),
  };

  console.log('\n──────────── Summary ────────────');
  console.log(`  Files          ${result.filesOk} ok, ${result.filesFailed} failed (of ${FILES})`);
  console.log(`  Data           ${fmtBytes(result.totalBytesAcked)} acknowledged`);
  console.log(`  Time           ${fmtDur(wall)}`);
  console.log(`  Throughput     ${result.aggregateMBps.toFixed(1)} MB/s  =  ${result.aggregateMbps.toFixed(0)} Mbps  (aggregate)`);
  if (result.perFileMBps) console.log(`  Per file       min ${result.perFileMBps.min.toFixed(1)} / avg ${result.perFileMBps.avg.toFixed(1)} / max ${result.perFileMBps.max.toFixed(1)} MB/s`);
  console.log(`  Retries        ${result.retries}   failed chunks ${result.failedChunks}   HTTP requests ${result.httpRequests}`);
  console.log(`  Client RSS     max ${result.clientRssMaxMB.toFixed(0)} MB, avg ${result.clientRssAvgMB?.toFixed(0) ?? '?'} MB (this script only)`);
  if (result.errors.length) console.log(`  Errors         ${result.errors.map((e) => `${e.file}: ${e.error}`).join('\n                 ')}`);

  if (a.json) {
    writeFileSync(a.json, JSON.stringify({ ...result, perFile: stats.perFile.map((f) => ({ name: f.name, ok: f.ok, seconds: (f.end - f.start) / 1000, retries: f.retries, failedChunks: f.failedChunks, error: f.error })) }, null, 2));
    console.log(`  JSON           ${a.json}`);
  }
  process.exit(stats.filesFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nfatal: ${err.message}`);
  process.exit(1);
});
