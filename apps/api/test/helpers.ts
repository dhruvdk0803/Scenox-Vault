import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import fs from 'node:fs/promises';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { getDb } from '../src/db';
import { runMigrations } from '../src/db/migrate';
import { users } from '../src/db/schema';
import { hashPassword } from '../src/lib/password';
import { initStorage } from '../src/storage';
import { invalidateSettings } from '../src/services/settings';

let migrated = false;

/** Build a fresh app against a clean database + storage dir. */
export async function setupTestApp(): Promise<FastifyInstance> {
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
  await resetDatabase();
  await fs.rm(config().storage.path, { recursive: true, force: true });
  await initStorage();
  invalidateSettings();
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function resetDatabase() {
  await getDb().execute(sql`
    TRUNCATE users, sessions, clients, portals, portal_access_tokens, upload_sessions, files,
             export_jobs, activity_logs, notifications, settings, api_keys, webhooks, webhook_deliveries RESTART IDENTITY CASCADE`);
}

export const ORIGIN = { origin: 'http://localhost:3000' };

/** Create a user directly and return a session cookie header for it. */
export async function loginAs(app: FastifyInstance, role: 'owner' | 'admin' | 'member' | 'viewer' = 'owner') {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = 'correct-horse-battery-staple';
  const [user] = await getDb()
    .insert(users)
    .values({ email, name: `${role} user`, role, passwordHash: await hashPassword(password) })
    .returning();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: ORIGIN, payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  return { user, cookie, headers: { cookie, ...ORIGIN } };
}
