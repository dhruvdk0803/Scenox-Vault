import { Upload } from 'tus-js-client';
import { UPLOAD_DEFAULTS, UPLOAD_SESSION_HEADER, type UploadEngineConfig } from '@scenox/shared';
import { AdaptiveConcurrency } from './adaptive-concurrency';
import { chooseChunkSize } from './chunk-size';
import { classifyError, errorStatus, MESSAGES, rejectedMessage, shouldRetryStatus, type ErrorKind, type TusErrorLike } from './errors';
import { makeClientKey, makeFingerprint } from './fingerprint';
import { getDefaultKV } from './kv';
import { QueueStore, type PendingRecord } from './queue-store';
import { computeEta, SpeedMeter } from './speed-meter';
import type { AddInput, UploadFileSnapshot, UploadItemStatus, UploadSession, UploadSnapshot, UploadStats } from './types';
import { createTusUrlStorage, type TusUrlStorage } from './url-storage';

/** The slice of tus-js-client's Upload that the manager uses (lets tests inject a fake). */
export interface TusUploadLike {
  start(): void;
  abort(shouldTerminate?: boolean): Promise<void>;
  findPreviousUploads(): Promise<unknown[]>;
  resumeFromPreviousUpload(previous: never): void;
}
export type TusFactory = (file: File, options: Record<string, unknown>) => TusUploadLike;

const defaultTusFactory: TusFactory = (file, options) => new Upload(file, options as never) as unknown as TusUploadLike;

export interface UploadManagerOptions {
  portalToken: string;
  config?: Partial<UploadEngineConfig>;
  session?: UploadSession | null;
  /** Called on a 401: return a fresh session (or null) so affected files can continue. */
  renewSession?: () => Promise<UploadSession | null>;
  /** Persist resumable state (tus URLs + queue metadata). Default true. */
  allowResume?: boolean;
  /** Minimum ms between change notifications (default 150 ≈ 6–7/s). 0 = synchronous. */
  throttleMs?: number;
  /** A request with no progress for this long is considered stalled and restarted. Default 60s. */
  stallMs?: number;
  now?: () => number;
  tusFactory?: TusFactory;
  urlStorage?: TusUrlStorage;
  queueStore?: QueueStore | null;
}

type PausedBy = 'user' | 'global' | 'offline';

interface Item {
  id: string;
  clientKey: string;
  file: File;
  name: string;
  relativePath: string;
  size: number;
  type: string;
  lastModified: number;
  fingerprint: string;
  duplicateAction?: 'replace' | 'keep_both';
  status: UploadItemStatus;
  bytes: number;
  error: string | null;
  errorKind: ErrorKind | null;
  warning: string | null;
  autoRetries: number;
  autoRetryAt: number | null;
  stallRestarts: number;
  pausedBy: PausedBy | null;
  upload: TusUploadLike | null;
  runToken: number;
  meter: SpeedMeter | null;
  avgSpeed: number;
  lastProgressAt: number;
  inPending: boolean;
  snap: UploadFileSnapshot | null;
  dirty: boolean;
}

const AUTO_RETRY_DELAYS = [15_000, 30_000, 60_000, 120_000, 120_000];
const MAX_STALL_RESTARTS = 5;
const EMPTY_STATS: UploadStats = {
  totalFiles: 0, totalBytes: 0, bytesUploaded: 0, percent: 0, completedFiles: 0, completedBytes: 0, failedFiles: 0, cancelledFiles: 0,
  activeFiles: 0, queuedFiles: 0, pausedFiles: 0, speed: 0, avgSpeed: 0, etaSeconds: null, running: false, finished: false,
};

export const EMPTY_SNAPSHOT: UploadSnapshot = {
  version: 0, items: [], stats: EMPTY_STATS, offline: false, paused: false, sessionExpired: false,
  concurrency: { current: UPLOAD_DEFAULTS.maxConcurrentUploads, max: UPLOAD_DEFAULTS.maxConcurrentUploads }, runId: 0,
};

/**
 * Framework-agnostic upload engine: one tus Upload per file, an adaptive concurrency pool, resumable via an
 * IndexedDB url store, throttled immutable snapshots for `useSyncExternalStore`. Never reads files into memory.
 */
export class UploadManager {
  private readonly cfg: UploadEngineConfig;
  private readonly now: () => number;
  private readonly tus: TusFactory;
  private readonly urlStorage: TusUrlStorage;
  private readonly queueStore: QueueStore | null;
  private readonly throttleMs: number;
  private readonly stallMs: number;
  private readonly allowResume: boolean;
  private readonly portalToken: string;
  private readonly renewSession?: () => Promise<UploadSession | null>;
  readonly concurrency: AdaptiveConcurrency;

  private session: UploadSession | null;
  private items = new Map<string, Item>();
  private order: Item[] = [];
  private pending: Item[] = [];
  private pendingHead = 0;
  private active = new Set<Item>();
  private listeners = new Set<() => void>();
  private snapshot: UploadSnapshot = EMPTY_SNAPSHOT;
  private version = 0;
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private offline = false;
  private globalPaused = false;
  private sessionExpired = false;
  private renewing = false;
  private lastRenewAt = 0;
  private drained = true;
  private runId = 0;
  private sumBytes = 0;
  private meter = new SpeedMeter();
  private seq = 0;
  private removals: string[] = [];
  private removalTimer: ReturnType<typeof setTimeout> | null = null;
  private detachEnv: (() => void) | null = null;

  constructor(opts: UploadManagerOptions) {
    this.portalToken = opts.portalToken;
    this.now = opts.now ?? (() => Date.now());
    this.cfg = {
      endpoint: opts.config?.endpoint ?? '/api/tus',
      maxConcurrentUploads: opts.config?.maxConcurrentUploads ?? UPLOAD_DEFAULTS.maxConcurrentUploads,
      defaultChunkSize: opts.config?.defaultChunkSize ?? UPLOAD_DEFAULTS.defaultChunkSize,
      maxChunkSize: opts.config?.maxChunkSize ?? UPLOAD_DEFAULTS.maxChunkSize,
      minChunkSize: opts.config?.minChunkSize ?? UPLOAD_DEFAULTS.minChunkSize,
      retryDelays: opts.config?.retryDelays?.length ? opts.config.retryDelays : UPLOAD_DEFAULTS.retryDelays,
    };
    this.tus = opts.tusFactory ?? defaultTusFactory;
    this.allowResume = opts.allowResume ?? true;
    const kv = !opts.urlStorage || opts.queueStore === undefined ? getDefaultKV() : null;
    this.urlStorage = opts.urlStorage ?? createTusUrlStorage(kv!);
    this.queueStore = opts.queueStore !== undefined ? opts.queueStore : new QueueStore(kv!, opts.portalToken);
    this.throttleMs = opts.throttleMs ?? 150;
    this.stallMs = opts.stallMs ?? 60_000;
    this.session = opts.session ?? null;
    this.renewSession = opts.renewSession;
    this.concurrency = new AdaptiveConcurrency({ max: this.cfg.maxConcurrentUploads }, this.now());
    this.snapshot = { ...EMPTY_SNAPSHOT, concurrency: { current: this.concurrency.current, max: this.concurrency.max } };
  }

  /* ───────────────────────── public API ───────────────────────── */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): UploadSnapshot => this.snapshot;

  setSession(session: UploadSession | null): void {
    this.session = session;
    if (session) this.sessionExpired = false;
    this.touch();
  }

  getSession(): UploadSession | null {
    return this.session;
  }

  /** Queue files. Uploading begins on start() (or immediately if already started). Returns the new item ids. */
  add(inputs: AddInput[]): string[] {
    const ids: string[] = [];
    const records: PendingRecord[] = [];
    const t = this.now();
    for (const input of inputs) {
      const { file } = input;
      const name = input.name ?? file.name;
      const id = `f${++this.seq}`;
      const fingerprint = makeFingerprint({
        portalToken: this.portalToken, relativePath: input.relativePath, name, size: file.size, lastModified: file.lastModified ?? 0,
      });
      const item: Item = {
        id, clientKey: input.clientKey ?? makeClientKey(), file, name, relativePath: input.relativePath, size: file.size,
        type: file.type || '', lastModified: file.lastModified ?? 0, fingerprint, duplicateAction: input.duplicateAction,
        status: 'queued', bytes: 0, error: null, errorKind: null, warning: null, autoRetries: 0, autoRetryAt: null,
        stallRestarts: 0, pausedBy: null, upload: null, runToken: 0, meter: null, avgSpeed: 0, lastProgressAt: 0,
        inPending: false, snap: null, dirty: true,
      };
      this.items.set(id, item);
      this.order.push(item);
      this.enqueue(item);
      ids.push(id);
      records.push({ fingerprint, name, relativePath: input.relativePath, size: file.size, lastModified: item.lastModified, addedAt: t });
    }
    if (ids.length) {
      this.noteWork();
      if (this.allowResume && this.queueStore) void this.queueStore.put(records).catch(() => undefined);
      this.touch();
      this.pump();
    }
    return ids;
  }

  start(): void {
    this.globalPaused = false;
    this.pump();
    this.touch();
  }

  pauseAll(): void {
    this.globalPaused = true;
    for (const item of [...this.active]) this.suspend(item, 'global');
    this.touch();
  }

  resumeAll(): void {
    this.globalPaused = false;
    const resumed: Item[] = [];
    for (const item of this.order) {
      if (item.status === 'paused' && (item.pausedBy === 'global' || item.pausedBy === 'offline')) resumed.push(item);
    }
    for (const item of resumed.reverse()) this.requeue(item, true);
    this.pump();
    this.touch();
  }

  cancelAll(): void {
    for (const item of this.order) {
      if (item.status !== 'completed' && item.status !== 'cancelled') this.cancelItem(item);
    }
    this.touch();
    this.pump();
  }

  pause(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    if (item.status === 'uploading' || item.status === 'processing') this.suspend(item, 'user');
    else if (item.status === 'queued') {
      this.setStatus(item, 'paused');
      item.pausedBy = 'user';
    }
    this.touch(item);
    this.pump();
  }

  resume(id: string): void {
    const item = this.items.get(id);
    if (!item || item.status !== 'paused') return;
    this.requeue(item, true);
    this.touch(item);
    this.pump();
  }

  cancel(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.cancelItem(item);
    this.touch(item);
    this.pump();
  }

  /** Retry a failed (or cancelled) file; resumes from the server offset — never restarts the whole file. */
  retry(id: string): void {
    const item = this.items.get(id);
    if (!item || (item.status !== 'failed' && item.status !== 'cancelled')) return;
    item.autoRetries = 0;
    item.stallRestarts = 0;
    this.noteWork();
    this.requeue(item, false);
    if (this.sessionExpired && this.session) this.sessionExpired = false;
    this.touch(item);
    this.pump();
  }

  retryFailed(): number {
    let n = 0;
    for (const item of this.order) {
      if (item.status === 'failed') {
        item.autoRetries = 0;
        item.stallRestarts = 0;
        this.requeue(item, false);
        n++;
      }
    }
    if (n) {
      this.noteWork();
      this.touch();
      this.pump();
    }
    return n;
  }

  /** Remove every file from the manager (only when nothing is running). */
  reset(): void {
    if (this.snapshot.stats.running) return;
    this.items.clear();
    this.order = [];
    this.pending = [];
    this.pendingHead = 0;
    this.active.clear();
    this.sumBytes = 0;
    this.drained = true;
    this.touch();
  }

  /** Window online/offline wiring. Returns a detach function. */
  attach(win: Pick<Window, 'addEventListener' | 'removeEventListener'> & { navigator?: { onLine: boolean } } = window): () => void {
    this.detachEnv?.();
    const on = () => this.setOnline(true);
    const off = () => this.setOnline(false);
    win.addEventListener('online', on);
    win.addEventListener('offline', off);
    if (win.navigator && win.navigator.onLine === false) this.setOnline(false);
    this.detachEnv = () => {
      win.removeEventListener('online', on);
      win.removeEventListener('offline', off);
      this.detachEnv = null;
    };
    return this.detachEnv;
  }

  setOnline(online: boolean): void {
    if (online === !this.offline) return;
    if (!online) {
      this.offline = true;
      for (const item of [...this.active]) this.suspend(item, 'offline');
      this.touch();
      return;
    }
    this.offline = false;
    for (const item of [...this.order].reverse()) {
      if (item.status === 'paused' && item.pausedBy === 'offline') this.requeue(item, true);
      else if (item.status === 'failed' && (item.errorKind === 'network' || item.autoRetryAt !== null)) {
        item.autoRetryAt = null;
        this.requeue(item, true);
      }
    }
    this.touch();
    this.pump();
  }

  /** Emit pending changes now (flushes the throttle). */
  flush(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.emit();
  }

  /** Stop timers and flush persisted bookkeeping; in-flight uploads are paused (they resume on the next visit). */
  dispose(): void {
    this.detachEnv?.();
    for (const item of [...this.active]) this.suspend(item, 'global');
    this.stopTick();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    void this.flushRemovals();
  }

  /* ───────────────────────── scheduling ───────────────────────── */

  private enqueue(item: Item, front = false): void {
    if (item.inPending) return;
    item.inPending = true;
    if (front && this.pendingHead > 0) this.pending[--this.pendingHead] = item;
    else if (front) this.pending.unshift(item);
    else this.pending.push(item);
  }

  private shift(): Item | undefined {
    while (this.pendingHead < this.pending.length) {
      const item = this.pending[this.pendingHead++]!;
      item.inPending = false;
      if (this.pendingHead > 4096 && this.pendingHead * 2 > this.pending.length) {
        this.pending = this.pending.slice(this.pendingHead);
        this.pendingHead = 0;
      }
      if (item.status === 'queued') return item;
    }
    return undefined;
  }

  private canRun(): boolean {
    return !this.globalPaused && !this.offline && !this.sessionExpired && this.session !== null;
  }

  private pump(): void {
    if (!this.canRun()) return;
    while (this.active.size < this.concurrency.current) {
      const item = this.shift();
      if (!item) break;
      this.launch(item);
    }
    if (this.active.size > 0) this.startTick();
  }

  private setStatus(item: Item, status: UploadItemStatus): void {
    item.status = status;
    item.dirty = true;
  }

  private setBytes(item: Item, bytes: number): void {
    const b = Math.max(0, Math.min(item.size, bytes));
    this.sumBytes += b - item.bytes;
    item.bytes = b;
  }

  private requeue(item: Item, front: boolean): void {
    item.error = null;
    item.errorKind = null;
    item.pausedBy = null;
    item.autoRetryAt = null;
    this.setStatus(item, 'queued');
    this.enqueue(item, front);
    this.noteWork();
  }

  private noteWork(): void {
    if (this.drained) {
      this.drained = false;
      this.runId += 1;
    }
  }

  /* ───────────────────────── one file ───────────────────────── */

  private launch(item: Item): void {
    const t = this.now();
    const token = ++item.runToken;
    this.setStatus(item, 'uploading');
    item.error = null;
    item.errorKind = null;
    item.pausedBy = null;
    item.meter = new SpeedMeter();
    item.lastProgressAt = t;
    if (this.active.size === 0 && t - this.lastActivity > 2000) this.meter.reset();
    this.active.add(item);
    this.recordOverall(t);

    const meta: Record<string, string> = {
      filename: item.name,
      filetype: item.type || 'application/octet-stream',
      relativePath: item.relativePath,
      sessionId: this.session!.sessionId,
      clientKey: item.clientKey,
      lastModified: String(item.lastModified),
    };
    if (item.duplicateAction) meta.duplicateAction = item.duplicateAction;

    const current = () => item.runToken === token && (item.status === 'uploading' || item.status === 'processing');

    const upload = this.tus(item.file, {
      endpoint: this.cfg.endpoint,
      chunkSize: chooseChunkSize(item.size, this.cfg),
      retryDelays: this.cfg.retryDelays,
      metadata: meta,
      uploadDataDuringCreation: true,
      fingerprint: async () => item.fingerprint,
      urlStorage: this.urlStorage,
      storeFingerprintForResuming: this.allowResume,
      removeFingerprintOnSuccess: true,
      onBeforeRequest: (req: { setHeader(k: string, v: string): void }) => {
        if (this.session) req.setHeader(UPLOAD_SESSION_HEADER, this.session.sessionToken);
        if (current()) item.lastProgressAt = this.now();
      },
      onAfterResponse: (req: { getMethod(): string }, res: { getStatus(): number }) => {
        if (current()) item.lastProgressAt = this.now();
        // tus-js-client treats ANY non-2xx answer to the resume HEAD (even a 502/503 while the
        // server restarts) as "upload gone" and silently starts the file over from byte 0.
        // Throwing here turns server-side/transient failures into a normal retryable error, so the
        // retry loop keeps the upload URL and resumes from the server offset. Real 4xx still restart.
        const status = res.getStatus();
        if (req.getMethod() === 'HEAD' && (status === 0 || status >= 500 || status === 408 || status === 429)) {
          throw new Error(`tus: resume check failed with HTTP ${status}; will retry`);
        }
      },
      onProgress: (sent: number, total: number) => {
        if (!current()) return;
        const now = this.now();
        item.lastProgressAt = now;
        this.setBytes(item, sent);
        item.meter?.record(sent, now);
        this.recordOverall(now);
        if (total > 0 && sent >= total && item.status === 'uploading') this.setStatus(item, 'processing');
        this.touch(item);
      },
      onChunkComplete: () => {
        if (!current()) return;
        if (item.warning) {
          item.warning = null;
          this.touch(item);
        }
      },
      onShouldRetry: (err: TusErrorLike) => {
        if (!current()) return false;
        const status = errorStatus(err);
        if (!shouldRetryStatus(status)) return false;
        if (this.isOffline()) return false; // handled in onError → paused until back online
        item.warning = MESSAGES.retrying;
        this.concurrency.recordFailure(this.now());
        this.touch(item);
        return true;
      },
      onSuccess: () => {
        if (item.runToken !== token || item.status === 'cancelled') return;
        this.finish(item);
      },
      onError: (err: TusErrorLike) => {
        if (item.runToken !== token || (item.status !== 'uploading' && item.status !== 'processing')) return;
        void this.handleError(item, err);
      },
    });
    item.upload = upload;

    const begin = async () => {
      if (this.allowResume) {
        try {
          const previous = await upload.findPreviousUploads();
          if (item.runToken !== token || item.status !== 'uploading') return;
          if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0] as never);
        } catch {
          /* no stored state: start fresh */
        }
      }
      if (item.runToken !== token || item.status !== 'uploading') return;
      upload.start();
    };
    void begin();
    this.touch(item);
  }

  private finish(item: Item): void {
    const t = this.now();
    this.setBytes(item, item.size);
    item.avgSpeed = item.meter?.average() ?? 0;
    item.meter = null;
    item.upload = null;
    item.warning = null;
    item.error = null;
    this.active.delete(item);
    this.setStatus(item, 'completed');
    this.recordOverall(t);
    this.queueRemoval(item.fingerprint);
    this.touch(item);
    this.pump();
  }

  private isOffline(): boolean {
    if (this.offline) return true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setOnline(false);
      return true;
    }
    return false;
  }

  private async handleError(item: Item, err: TusErrorLike): Promise<void> {
    const { kind, status } = classifyError(err);
    const t = this.now();
    if (kind === 'network' && this.isOffline()) {
      this.suspend(item, 'offline');
      this.touch(item);
      return;
    }
    if (kind === 'auth') {
      await this.handleAuthError(item);
      return;
    }
    item.avgSpeed = item.meter?.average() ?? 0;
    item.meter = null;
    item.upload = null;
    this.active.delete(item);
    item.warning = null;
    this.setStatus(item, 'failed');
    item.errorKind = kind;
    if (kind === 'rejected') {
      item.error = rejectedMessage(status);
      item.autoRetryAt = null;
    } else {
      item.error = MESSAGES.exhausted;
      this.concurrency.recordFailure(t);
      if (item.autoRetries < AUTO_RETRY_DELAYS.length) {
        item.autoRetryAt = t + AUTO_RETRY_DELAYS[item.autoRetries]!;
        item.autoRetries += 1;
      }
    }
    this.touch(item);
    this.pump();
  }

  private async handleAuthError(item: Item): Promise<void> {
    const t = this.now();
    const canRenew = !!this.renewSession && !this.renewing && t - this.lastRenewAt > 30_000;
    if (canRenew) {
      this.renewing = true;
      this.lastRenewAt = t;
      // Park every in-flight upload; they restart under the new session.
      for (const it of [...this.active]) this.suspend(it, 'global');
      try {
        const fresh = await this.renewSession!();
        if (fresh) {
          this.session = fresh;
          this.renewing = false;
          for (const it of [...this.order].reverse()) if (it.status === 'paused' && it.pausedBy === 'global' && !this.globalPaused) this.requeue(it, true);
          this.touch();
          this.pump();
          return;
        }
      } catch {
        /* fall through */
      }
      this.renewing = false;
    }
    for (const it of [...this.active, item]) {
      if (it.status === 'paused' && it.pausedBy === 'global') continue;
      it.runToken += 1;
      void it.upload?.abort(false).catch(() => undefined);
      it.meter = null;
      it.upload = null;
      this.active.delete(it);
      this.setStatus(it, 'failed');
      it.error = MESSAGES.sessionExpired;
      it.errorKind = 'auth';
      it.autoRetryAt = null;
    }
    for (const it of this.order) {
      if (it.status === 'paused' && it.pausedBy === 'global' && !this.globalPaused) {
        this.setStatus(it, 'failed');
        it.error = MESSAGES.sessionExpired;
        it.errorKind = 'auth';
      }
    }
    this.sessionExpired = true;
    this.touch();
  }

  /** Stop the network request but keep server state; the file can continue from the server offset. */
  private suspend(item: Item, by: PausedBy): void {
    const upload = item.upload;
    item.runToken += 1; // invalidate callbacks of the aborted run
    item.upload = null;
    item.avgSpeed = item.meter?.average() ?? item.avgSpeed;
    item.meter = null;
    this.active.delete(item);
    this.setStatus(item, 'paused');
    item.pausedBy = by;
    item.warning = null;
    if (upload) void upload.abort(false).catch(() => undefined);
    this.recordOverall(this.now());
  }

  private lastActivity = 0;
  private recordOverall(t: number): void {
    this.lastActivity = t;
    this.meter.record(this.sumBytes, t);
  }

  private cancelItem(item: Item): void {
    const upload = item.upload;
    item.runToken += 1;
    item.upload = null;
    item.meter = null;
    this.active.delete(item);
    this.setBytes(item, 0);
    this.setStatus(item, 'cancelled');
    item.error = null;
    item.warning = null;
    item.autoRetryAt = null;
    if (upload) void upload.abort(true).catch(() => undefined); // DELETE on the server + forget stored URL
    else void this.urlStorage.removeUpload(`tus:${item.fingerprint}`).catch(() => undefined);
    this.queueRemoval(item.fingerprint);
  }

  /* ───────────────────────── maintenance ───────────────────────── */

  private startTick(): void {
    if (this.tickTimer) return;
    this.lastTick = this.now();
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  private stopTick(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** 1 Hz housekeeping: stall watchdog, sleep detection, auto-retry, adaptive concurrency, speed decay. */
  tick(): void {
    const t = this.now();
    const slept = t - this.lastTick > 15_000; // laptop sleep / tab frozen: in-flight sockets are dead
    this.lastTick = t;
    for (const item of [...this.active]) {
      item.dirty = true;
      if (this.offline) continue;
      const stalled = t - item.lastProgressAt > this.stallMs;
      if (!slept && !stalled) continue;
      if (item.stallRestarts >= MAX_STALL_RESTARTS) {
        this.active.delete(item);
        item.upload?.abort(false).catch(() => undefined);
        item.runToken += 1;
        item.upload = null;
        item.meter = null;
        this.setStatus(item, 'failed');
        item.errorKind = 'network';
        item.error = MESSAGES.exhausted;
        continue;
      }
      item.stallRestarts += 1;
      this.concurrency.recordFailure(t);
      this.suspend(item, 'global');
      this.requeue(item, true);
    }
    for (const item of this.order) {
      if (item.status === 'failed' && item.autoRetryAt !== null && item.autoRetryAt <= t && !this.offline) {
        this.requeue(item, false);
      }
    }
    this.concurrency.tick(t);
    this.pump();
    if (this.active.size === 0 && !this.hasAutoRetryPending()) this.stopTick();
    this.touch();
  }

  private hasAutoRetryPending(): boolean {
    for (const item of this.order) if (item.status === 'failed' && item.autoRetryAt !== null) return true;
    return false;
  }

  private queueRemoval(fingerprint: string): void {
    if (!this.queueStore) return;
    this.removals.push(fingerprint);
    if (!this.removalTimer) this.removalTimer = setTimeout(() => void this.flushRemovals(), 2000);
  }

  private async flushRemovals(): Promise<void> {
    if (this.removalTimer) clearTimeout(this.removalTimer);
    this.removalTimer = null;
    const batch = this.removals;
    this.removals = [];
    if (batch.length && this.queueStore) {
      try {
        await this.queueStore.remove(batch);
      } catch {
        /* best effort */
      }
    }
  }

  /* ───────────────────────── snapshots ───────────────────────── */

  private touch(item?: Item): void {
    if (item) item.dirty = true;
    const t = this.now();
    const since = t - this.lastEmit;
    if (this.throttleMs <= 0 || since >= this.throttleMs) {
      if (this.emitTimer) {
        clearTimeout(this.emitTimer);
        this.emitTimer = null;
      }
      this.emit();
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.emit();
      }, this.throttleMs - since);
    }
  }

  private snapItem(item: Item, t: number): UploadFileSnapshot {
    const uploading = item.status === 'uploading' || item.status === 'processing';
    const speed = uploading && item.meter ? item.meter.speed(t) : 0;
    const remaining = item.size - item.bytes;
    const eta = uploading && item.meter ? computeEta(remaining, speed, item.meter.stableMs(t)) : null;
    return {
      id: item.id, name: item.name, relativePath: item.relativePath, size: item.size, status: item.status,
      bytesUploaded: item.bytes, progress: item.size > 0 ? (item.bytes / item.size) * 100 : item.status === 'completed' ? 100 : 0,
      speed, avgSpeed: uploading && item.meter ? item.meter.average() : item.avgSpeed, etaSeconds: eta,
      error: item.error, errorKind: item.errorKind, warning: item.warning,
      autoRetrying: item.status === 'failed' && item.autoRetryAt !== null, pausedBy: item.status === 'paused' ? item.pausedBy : null,
    };
  }

  private emit(): void {
    const t = this.now();
    this.lastEmit = t;
    const n = this.order.length;
    const items = new Array<UploadFileSnapshot>(n);
    let totalBytes = 0, completedFiles = 0, completedBytes = 0, failed = 0, cancelled = 0, activeFiles = 0, queued = 0, paused = 0;
    let remaining = 0, waitingRetry = 0, uploaded = 0;
    for (let i = 0; i < n; i++) {
      const it = this.order[i]!;
      if (it.dirty || !it.snap) {
        it.snap = this.snapItem(it, t);
        it.dirty = false;
      }
      items[i] = it.snap;
      switch (it.status) {
        case 'completed': completedFiles++; completedBytes += it.size; break;
        case 'failed': failed++; if (it.autoRetryAt !== null) waitingRetry++; break;
        case 'cancelled': cancelled++; continue;
        case 'uploading': case 'processing': activeFiles++; break;
        case 'queued': queued++; break;
        case 'paused': paused++; break;
      }
      totalBytes += it.size;
      uploaded += it.bytes;
      if (it.status !== 'failed' || it.autoRetryAt !== null) remaining += it.size - it.bytes;
    }
    const inFlight = activeFiles > 0;
    const speed = inFlight ? this.meter.speed(t) : 0;
    const running = activeFiles + queued + paused + waitingRetry > 0;
    const finished = n > 0 && !running;
    if (finished) this.drained = true;
    const stats: UploadStats = {
      totalFiles: n - cancelled, totalBytes, bytesUploaded: uploaded,
      percent: totalBytes > 0 ? Math.min(100, (uploaded / totalBytes) * 100) : n - cancelled > 0 ? (completedFiles / (n - cancelled)) * 100 : 0,
      completedFiles, completedBytes, failedFiles: failed, cancelledFiles: cancelled, activeFiles, queuedFiles: queued, pausedFiles: paused,
      speed, avgSpeed: inFlight ? this.meter.average() : 0,
      etaSeconds: inFlight ? computeEta(remaining, speed, this.meter.stableMs(t)) : null, running, finished,
    };
    this.snapshot = {
      version: ++this.version, items, stats, offline: this.offline, paused: this.globalPaused, sessionExpired: this.sessionExpired,
      concurrency: { current: this.concurrency.current, max: this.concurrency.max }, runId: this.runId,
    };
    for (const l of [...this.listeners]) l();
    if (!running && this.active.size === 0) this.stopTick();
  }
}
