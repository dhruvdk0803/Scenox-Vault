import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config';
import * as schema from './schema';

export type Database = ReturnType<typeof createDb>['db'];

export function createDb(url = config().databaseUrl, max = config().databasePoolMax) {
  const client = postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
  const db = drizzle(client, { schema });
  return { db, client };
}

let instance: ReturnType<typeof createDb> | null = null;

export function getDb() {
  if (!instance) instance = createDb();
  return instance.db;
}

export function getSql() {
  if (!instance) instance = createDb();
  return instance.client;
}

export async function closeDb() {
  if (instance) {
    await instance.client.end({ timeout: 5 });
    instance = null;
  }
}

export { schema };
