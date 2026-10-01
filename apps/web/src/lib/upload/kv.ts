import { createStore, del, delMany, entries, get, set, setMany, type UseStore } from 'idb-keyval';

/** Minimal async key-value interface (IndexedDB in the browser, a Map in tests / private mode). */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  setMany(entries: [string, unknown][]): Promise<void>;
  delMany(keys: string[]): Promise<void>;
  entries<T>(prefix: string): Promise<[string, T][]>;
}

export function createMemoryKV(): KV {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) {
      return m.get(k) as T | undefined;
    },
    async set(k, v) {
      m.set(k, v);
    },
    async del(k) {
      m.delete(k);
    },
    async setMany(es) {
      for (const [k, v] of es) m.set(k, v);
    },
    async delMany(ks) {
      for (const k of ks) m.delete(k);
    },
    async entries<T>(prefix: string) {
      return [...m.entries()].filter(([k]) => k.startsWith(prefix)) as [string, T][];
    },
  };
}

/** IndexedDB-backed KV (idb-keyval). Falls back to memory when IndexedDB is unavailable or throws. */
export function createIdbKV(dbName = 'scenox-vault-upload', storeName = 'kv'): KV {
  const fallback = createMemoryKV();
  let store: UseStore | null = null;
  let broken = typeof indexedDB === 'undefined';
  const getStore = () => (store ??= createStore(dbName, storeName));

  async function run<T>(op: (s: UseStore) => Promise<T>, fb: () => Promise<T>): Promise<T> {
    if (broken) return fb();
    try {
      return await op(getStore());
    } catch {
      broken = true;
      return fb();
    }
  }

  return {
    get: <T,>(k: string) => run(() => get<T>(k, getStore()), () => fallback.get<T>(k)),
    set: (k, v) => run(() => set(k, v, getStore()), () => fallback.set(k, v)),
    del: (k) => run(() => del(k, getStore()), () => fallback.del(k)),
    setMany: (es) => run(() => setMany(es, getStore()), () => fallback.setMany(es)),
    delMany: (ks) => run(() => delMany(ks, getStore()), () => fallback.delMany(ks)),
    entries: <T,>(prefix: string) =>
      run(
        async () => ((await entries(getStore())) as [string, T][]).filter(([k]) => typeof k === 'string' && k.startsWith(prefix)),
        () => fallback.entries<T>(prefix),
      ),
  };
}

let shared: KV | null = null;
export function getDefaultKV(): KV {
  return (shared ??= createIdbKV());
}
