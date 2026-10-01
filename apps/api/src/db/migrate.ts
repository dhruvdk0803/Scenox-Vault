import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { closeDb, getDb } from './index';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/db → ../../drizzle ; dist → ../drizzle
const candidates = [path.resolve(here, '../../drizzle'), path.resolve(here, '../drizzle'), path.resolve(process.cwd(), 'drizzle')];

export async function runMigrations() {
  const fs = await import('node:fs');
  const folder = candidates.find((p) => fs.existsSync(path.join(p, 'meta', '_journal.json')));
  if (!folder) throw new Error('Migrations folder not found');
  await migrate(getDb(), { migrationsFolder: folder });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runMigrations()
    .then(async () => {
      console.log('✓ Database migrations applied');
      await closeDb();
    })
    .catch(async (err) => {
      console.error('✗ Migration failed:', err);
      await closeDb();
      process.exit(1);
    });
}
