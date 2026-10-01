export interface ChunkConfig {
  defaultChunkSize: number;
  minChunkSize: number;
  maxChunkSize: number;
}

const MIB = 1024 * 1024;
export const MAX_CHUNKS = 10_000;

/**
 * Chunk size for one file.
 * - Files that fit in `defaultChunkSize` go up in a single request (chunk = file size).
 * - Larger files use `defaultChunkSize`, scaled up so the chunk count stays <= MAX_CHUNKS,
 *   rounded up to whole MiB and clamped to [minChunkSize, maxChunkSize].
 * Each request stays bounded so proxies never see an endless body and a failed request retries one chunk.
 */
export function chooseChunkSize(fileSize: number, cfg: ChunkConfig): number {
  const size = Math.max(0, Math.floor(fileSize));
  if (size <= cfg.defaultChunkSize) return Math.max(1, size);
  let chunk = cfg.defaultChunkSize;
  if (Math.ceil(size / chunk) > MAX_CHUNKS) chunk = Math.ceil(size / MAX_CHUNKS);
  chunk = Math.ceil(chunk / MIB) * MIB;
  return Math.max(cfg.minChunkSize, Math.min(cfg.maxChunkSize, chunk));
}
