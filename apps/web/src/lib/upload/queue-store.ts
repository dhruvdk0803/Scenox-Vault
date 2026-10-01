import type { KV } from './kv';
import { TUS_PREFIX } from './url-storage';

/** Metadata about a file that was queued but not finished — used for the "Resume previous upload?" card. */
export interface PendingRecord {
  fingerprint: string;
  name: string;
  relativePath: string;
  size: number;
  lastModified: number;
  addedAt: number;
}

export interface PendingSummary {
  count: number;
  bytes: number;
}

export function summarizePending(records: PendingRecord[]): PendingSummary {
  let bytes = 0;
  for (const r of records) bytes += r.size;
  return { count: records.length, bytes };
}

/** Persistent per-portal queue metadata (never file contents; browsers can't re-open files without user action). */
export class QueueStore {
  constructor(private readonly kv: KV, private readonly portalToken: string) {}

  private key(fp: string) {
    return `pending:${this.portalToken}:${fp}`;
  }
  private get prefix() {
    return `pending:${this.portalToken}:`;
  }

  async put(records: PendingRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.kv.setMany(records.map((r) => [this.key(r.fingerprint), r]));
  }

  async remove(fingerprints: string[]): Promise<void> {
    if (fingerprints.length === 0) return;
    await this.kv.delMany(fingerprints.map((f) => this.key(f)));
  }

  async list(): Promise<PendingRecord[]> {
    return (await this.kv.entries<PendingRecord>(this.prefix)).map(([, v]) => v);
  }

  /** Forget everything about unfinished uploads for this portal (queue metadata + stored tus URLs). */
  async clear(): Promise<void> {
    const pending = await this.kv.entries(this.prefix);
    const tus = await this.kv.entries(`${TUS_PREFIX}${this.portalToken}|`);
    await this.kv.delMany([...pending.map(([k]) => k), ...tus.map(([k]) => k)]);
  }
}

export interface StoredSession {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
}

export async function loadStoredSession(kv: KV, portalToken: string): Promise<StoredSession | null> {
  const s = await kv.get<StoredSession>(`session:${portalToken}`);
  if (!s || !s.sessionToken) return null;
  if (s.expiresAt && Date.parse(s.expiresAt) <= Date.now()) return null;
  return s;
}
export function saveStoredSession(kv: KV, portalToken: string, s: StoredSession): Promise<void> {
  return kv.set(`session:${portalToken}`, s);
}
export function clearStoredSession(kv: KV, portalToken: string): Promise<void> {
  return kv.del(`session:${portalToken}`);
}
