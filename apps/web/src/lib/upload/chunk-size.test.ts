import { describe, expect, it } from 'vitest';
import { chooseChunkSize, MAX_CHUNKS } from './chunk-size';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const cfg = { defaultChunkSize: 64 * MB, minChunkSize: 8 * MB, maxChunkSize: 256 * MB };

describe('chooseChunkSize', () => {
  it('uploads files up to defaultChunkSize in a single request', () => {
    expect(chooseChunkSize(1, cfg)).toBe(1);
    expect(chooseChunkSize(5 * MB, cfg)).toBe(5 * MB);
    expect(chooseChunkSize(64 * MB, cfg)).toBe(64 * MB);
  });
  it('handles empty files', () => {
    expect(chooseChunkSize(0, cfg)).toBe(1);
  });
  it('uses the default chunk size for ordinary large files', () => {
    expect(chooseChunkSize(65 * MB, cfg)).toBe(64 * MB);
    expect(chooseChunkSize(50 * GB, cfg)).toBe(64 * MB);
  });
  it('scales up so the chunk count stays <= 10,000', () => {
    const size = 2 * 1024 * GB; // 2 TiB
    const chunk = chooseChunkSize(size, cfg);
    expect(chunk).toBeGreaterThan(64 * MB);
    expect(Math.ceil(size / chunk)).toBeLessThanOrEqual(MAX_CHUNKS);
    expect(chunk % MB).toBe(0);
  });
  it('clamps to [min, max]', () => {
    expect(chooseChunkSize(10 * GB, { ...cfg, defaultChunkSize: 1 * MB, minChunkSize: 8 * MB })).toBe(8 * MB);
    expect(chooseChunkSize(10_000 * GB, cfg)).toBe(256 * MB);
  });
});
