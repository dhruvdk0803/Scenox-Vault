import { getExtension, type SignedUrlResponse } from '@scenox/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config';
import type { FileRow } from '../db/schema';

export type Disposition = 'inline' | 'attachment';

export const signedUrlSchema = z.strictObject({
  expiresIn: z.number('expiresIn must be a number of seconds.').int('expiresIn must be a whole number of seconds.').min(60, 'expiresIn must be at least 60 seconds.').max(604_800, 'expiresIn can be at most 604800 seconds (7 days).').default(3600),
  disposition: z.enum(['inline', 'attachment']).default('inline'),
});

/** Domain-separated key derived from SESSION_SECRET, so the raw secret is never used directly for URLs. */
const signingKey = () => createHmac('sha256', config().sessionSecret).update('scenox-vault:signed-file-url:v1').digest();

export function signFileUrl(fileId: string, exp: number, disposition: Disposition): string {
  return createHmac('sha256', signingKey()).update(`${fileId}.${exp}.${disposition}`).digest('base64url');
}

export function verifyFileSignature(fileId: string, exp: number, disposition: Disposition, sig: string): boolean {
  const expected = Buffer.from(signFileUrl(fileId, exp, disposition));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Cosmetic last path segment (so the URL ends in the real extension). Never affects the signature. */
export function urlFileName(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (encoded.length <= 160) return encoded;
  const ext = getExtension(name);
  return /^[a-z0-9]{1,10}$/.test(ext) ? `file.${ext}` : 'file';
}

export function buildSignedUrl(file: Pick<FileRow, 'id' | 'originalFilename'>, expiresIn: number, disposition: Disposition, nowMs = Date.now()): SignedUrlResponse {
  const exp = Math.floor(nowMs / 1000) + expiresIn;
  const sig = signFileUrl(file.id, exp, disposition);
  const query = disposition === 'attachment' ? '?d=a' : '';
  return {
    url: `${config().appUrl}/api/public/files/${file.id}/${exp}/${sig}/${urlFileName(file.originalFilename)}${query}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}
