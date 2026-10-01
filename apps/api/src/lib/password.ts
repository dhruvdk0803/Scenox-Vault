import { hash, verify } from '@node-rs/argon2';

// Argon2id (algorithm 2) — OWASP recommended parameters (m=19 MiB, t=2, p=1).
const OPTS = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

export async function verifyPassword(hashStr: string, password: string): Promise<boolean> {
  try {
    return await verify(hashStr, password);
  } catch {
    return false;
  }
}

/** A valid hash used to equalise timing when the user does not exist. */
let dummy: Promise<string> | null = null;
export async function dummyVerify(password: string) {
  dummy ??= hashPassword('scenox-dummy-password-for-timing');
  await verifyPassword(await dummy, password);
}

export function passwordProblems(password: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 256) return 'Password is too long.';
  return null;
}
