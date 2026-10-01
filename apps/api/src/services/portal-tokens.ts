import type { PortalStatus } from '@scenox/shared';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { getDb } from '../db';
import { portals, type Portal } from '../db/schema';
import { decrypt, encrypt, hashToken, randomToken } from '../lib/crypto';

/**
 * Portal links are bearer credentials: /u/<token>, 256-bit CSPRNG token.
 * Stored as HMAC-SHA256 (lookup) + AES-256-GCM ciphertext (so admins can re-copy the link).
 */
export function generatePortalToken() {
  const token = randomToken(24); // 192 bits → 32 url-safe chars
  return { token, tokenHash: hashToken(token), tokenEncrypted: encrypt(token), tokenPreview: token.slice(0, 6) };
}

export function portalUrl(token: string) {
  return `${config().uploadUrl}/u/${token}`;
}

export function decryptPortalUrl(p: Pick<Portal, 'tokenEncrypted'>): string | null {
  const t = decrypt(p.tokenEncrypted);
  return t ? portalUrl(t) : null;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export async function findPortalByToken(token: string): Promise<Portal | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [p] = await getDb().select().from(portals).where(eq(portals.tokenHash, hashToken(token))).limit(1);
  return p ?? null;
}

export function portalEffectiveStatus(p: Pick<Portal, 'status' | 'expiresAt'>, now = new Date()): PortalStatus {
  if (p.status === 'disabled') return 'disabled';
  if (p.expiresAt && p.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}
