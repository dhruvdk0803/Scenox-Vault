export interface FingerprintParts {
  portalToken: string;
  relativePath: string;
  name: string;
  size: number;
  lastModified: number;
}

/** Stable identity of a local file for resuming: portal + folder + name + size + mtime. */
export function makeFingerprint(p: FingerprintParts): string {
  return `${p.portalToken}|${p.relativePath}|${p.name}|${p.size}|${p.lastModified}`;
}

let counter = 0;
export function makeClientKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* insecure context */
  }
  counter += 1;
  return `c${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Key identifying a selected file within one selection (de-duplication). */
export function selectionKey(relativePath: string, name: string, size: number, lastModified: number): string {
  return `${relativePath}/${name}|${size}|${lastModified}`;
}
