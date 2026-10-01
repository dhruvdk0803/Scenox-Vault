import type { ZodType } from 'zod';
import { validationError } from './errors';

/** Parse untrusted input with a Zod schema, throwing a 400 with field errors on failure. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] ??= i.message;
    throw validationError({ fields });
  }
  return r.data;
}
