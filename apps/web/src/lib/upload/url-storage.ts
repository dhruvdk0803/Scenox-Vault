import type { KV } from './kv';

/** Structural copies of tus-js-client's (unexported) UrlStorage / PreviousUpload types. */
export interface PreviousUploadRecord {
  size: number | null;
  metadata: { [key: string]: string };
  creationTime: string;
  urlStorageKey: string;
  uploadUrl: string | null;
  parallelUploadUrls: string[] | null;
}

export interface TusUrlStorage {
  findAllUploads(): Promise<PreviousUploadRecord[]>;
  findUploadsByFingerprint(fingerprint: string): Promise<PreviousUploadRecord[]>;
  removeUpload(urlStorageKey: string): Promise<void>;
  addUpload(fingerprint: string, upload: PreviousUploadRecord): Promise<string>;
}

export const TUS_PREFIX = 'tus:';

/** tus URL storage on top of IndexedDB: one record per fingerprint (the latest upload URL for that file). */
export function createTusUrlStorage(kv: KV): TusUrlStorage {
  const key = (fp: string) => `${TUS_PREFIX}${fp}`;
  return {
    async findAllUploads() {
      return (await kv.entries<PreviousUploadRecord>(TUS_PREFIX)).map(([, v]) => v);
    },
    async findUploadsByFingerprint(fp) {
      const v = await kv.get<PreviousUploadRecord>(key(fp));
      return v ? [v] : [];
    },
    async removeUpload(k) {
      await kv.del(k);
    },
    async addUpload(fp, upload) {
      const k = key(fp);
      await kv.set(k, { ...upload, urlStorageKey: k });
      return k;
    },
  };
}
