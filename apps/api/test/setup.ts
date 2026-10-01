// Test environment — uses the scenox_test database and a throwaway storage dir.
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'warn';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://scenox:scenox@localhost:5432/scenox_test';
process.env.REDIS_URL ??= 'redis://localhost:6379/15';
process.env.APP_URL = 'http://localhost:3000';
process.env.UPLOAD_URL = 'http://localhost:3000';
process.env.STORAGE_PATH = path.join(os.tmpdir(), `scenox-test-${process.pid}`);
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef0123456789';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.RATE_LIMIT_ENABLED = 'false';
