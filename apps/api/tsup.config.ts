import { copyFile, mkdir } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts', 'src/db/migrate.ts', 'src/db/seed.ts', 'src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  splitting: true,
  // bundle the source-only workspace package; keep real deps external
  noExternal: ['@scenox/shared'],
  // GET /api/docs serves the developer guide; the Docker image only ships dist/, so bundle it there
  async onSuccess() {
    await mkdir('dist', { recursive: true });
    await copyFile('../../docs/DEVELOPER_API.md', 'dist/DEVELOPER_API.md');
  },
});
