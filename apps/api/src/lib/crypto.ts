import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

/** URL-safe random token from a CSPRNG. 32 bytes → 43 chars (256 bits of entropy). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Deterministic lookup hash for secrets (tokens). Keyed with SESSION_SECRET so a DB leak alone is insufficient. */
export function hashToken(token: string): string {
  return createHmac('sha256', config().sessionSecret).update(token).digest('hex');
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function key(): Buffer {
  const raw = config().encryptionKey.trim();
  let k: Buffer;
  if (/^[0-9a-f]{64}$/i.test(raw)) k = Buffer.from(raw, 'hex');
  else {
    k = Buffer.from(raw, 'base64');
    if (k.length !== 32) k = createHash('sha256').update(raw).digest();
  }
  return k;
}

/** AES-256-GCM. Output: base64url(iv).base64url(tag).base64url(ciphertext) */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload: string): string | null {
  try {
    const [iv, tag, ct] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
