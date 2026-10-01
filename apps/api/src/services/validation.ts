import { notFound } from '../lib/errors';
import { z } from 'zod';

/** Shared Zod fragments for the admin API. */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long.')
  .pipe(z.email('Enter a valid email address.'));

export const uuidSchema = z.uuid('Invalid id.');

/** Optional text: "" and whitespace become null. */
export const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters.`)
    .nullable()
    .transform((v) => (v === '' ? null : v));

/** Positive safe integer or null (used for byte limits). */
export const positiveIntOrNull = z
  .number('Must be a number.')
  .int('Must be a whole number.')
  .positive('Must be greater than zero.')
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #4F46E5.');

/** Lowercase, strip leading dots, validate, dedupe. */
export function normalizeExtensions(list: string[]): string[] {
  return [...new Set(list.map((e) => e.trim().toLowerCase().replace(/^\.+/, '')).filter((e) => e !== ''))];
}

export const extensionList = (max = 200) =>
  z
    .array(z.string().trim().min(1).max(20))
    .max(max, `At most ${max} entries.`)
    .transform(normalizeExtensions)
    .pipe(z.array(z.string().regex(/^[a-z0-9][a-z0-9_+-]{0,15}$/, 'Extensions may only contain letters, numbers, "-", "_" and "+".')));

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).transform((v) => Math.min(v, 200)).default(25),
});

export const orderSchema = z.enum(['asc', 'desc']).default('desc');

/** Escape LIKE/ILIKE wildcards so user input is matched literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}

export function paginated<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, total, page, pageSize };
}

/** Postgres unique-violation detection (postgres.js errors may be wrapped by drizzle). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Route :id param — a malformed id can never match a row, so answer 404 rather than 400. */
export function idParam(id: string): string {
  if (!UUID_RE.test(id)) throw notFound();
  return id;
}
