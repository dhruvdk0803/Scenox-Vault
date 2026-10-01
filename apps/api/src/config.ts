import path from 'node:path';
import { z } from 'zod';
import { UPLOAD_DEFAULTS } from '@scenox/shared';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** Accepts "50GB", "512MB", "1.5TB", or raw bytes. Empty → undefined. */
const bytes = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === '' || v === '0') return null;
    const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb)?$/i.exec(v);
    if (!m) {
      ctx.addIssue({ code: 'custom', message: `Invalid size "${v}"` });
      return z.NEVER;
    }
    const mult: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15 };
    return Math.floor(Number(m[1]) * mult[(m[2] ?? 'b').toLowerCase()]);
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4000),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().default(20),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  /** Admin dashboard origin, e.g. https://app.example.com */
  APP_URL: z.string().url().default('http://localhost:3000'),
  /** Public client upload origin, e.g. https://upload.example.com (may equal APP_URL) */
  UPLOAD_URL: z.string().url().default('http://localhost:3000'),
  /** Extra allowed CORS origins (comma separated). APP_URL and UPLOAD_URL are always allowed. */
  CORS_ORIGINS: z.string().default(''),
  /** Number of trusted reverse proxies in front of the API (Caddy = 1). */
  TRUST_PROXY: z.coerce.number().int().default(1),

  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_PATH: z.string().default('./.data/storage'),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  /** 32-byte key, hex (64 chars) or base64, used for AES-256-GCM encryption of portal tokens. */
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY must be 32 bytes (64 hex chars)'),
  COOKIE_SECURE: bool.optional(),

  MAX_FILE_SIZE: bytes.prefault('0'),
  MAX_PORTAL_SIZE: bytes.prefault('0'),
  MAX_CONCURRENT_UPLOADS: z.coerce.number().int().min(1).max(16).default(UPLOAD_DEFAULTS.maxConcurrentUploads),
  DEFAULT_CHUNK_SIZE: bytes.prefault(String(UPLOAD_DEFAULTS.defaultChunkSize)),
  MAX_CHUNK_SIZE: bytes.prefault(String(UPLOAD_DEFAULTS.maxChunkSize)),
  MIN_CHUNK_SIZE: bytes.prefault(String(UPLOAD_DEFAULTS.minChunkSize)),
  RETRY_COUNT: z.coerce.number().int().min(0).max(20).default(UPLOAD_DEFAULTS.retryCount),
  /** Idle socket timeout for upload requests (ms). Long, because chunks can be large. */
  UPLOAD_TIMEOUT: z.coerce.number().int().default(10 * 60 * 1000),
  /** Public URL path of the tus endpoint as seen by browsers. */
  TUS_PATH: z.string().default('/api/tus'),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool.prefault('false'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().default('Scenox Vault <no-reply@localhost>'),

  CLAMAV_ENABLED: bool.prefault('false'),
  CLAMAV_HOST: z.string().default('clamav'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  RATE_LIMIT_ENABLED: bool.prefault('true'),
  WORKER_CONCURRENCY: z.coerce.number().int().default(2),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const storagePath = path.resolve(e.STORAGE_PATH);
  const isProd = e.NODE_ENV === 'production';
  const origins = new Set(
    [e.APP_URL, e.UPLOAD_URL, ...e.CORS_ORIGINS.split(',')]
      .map((o) => o.trim())
      .filter(Boolean)
      .map((o) => new URL(o).origin),
  );
  return {
    env: e.NODE_ENV,
    isProd,
    isTest: e.NODE_ENV === 'test',
    logLevel: e.LOG_LEVEL,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    redisUrl: e.REDIS_URL,
    appUrl: e.APP_URL.replace(/\/$/, ''),
    uploadUrl: e.UPLOAD_URL.replace(/\/$/, ''),
    allowedOrigins: [...origins],
    trustProxy: e.TRUST_PROXY,
    storage: {
      driver: e.STORAGE_DRIVER,
      path: storagePath,
    },
    sessionSecret: e.SESSION_SECRET,
    encryptionKey: e.ENCRYPTION_KEY,
    cookieSecure: e.COOKIE_SECURE ?? e.APP_URL.startsWith('https://'),
    limits: {
      maxFileSize: e.MAX_FILE_SIZE,
      maxPortalSize: e.MAX_PORTAL_SIZE,
    },
    upload: {
      tusPath: e.TUS_PATH,
      maxConcurrentUploads: e.MAX_CONCURRENT_UPLOADS,
      defaultChunkSize: e.DEFAULT_CHUNK_SIZE ?? UPLOAD_DEFAULTS.defaultChunkSize,
      maxChunkSize: e.MAX_CHUNK_SIZE ?? UPLOAD_DEFAULTS.maxChunkSize,
      minChunkSize: e.MIN_CHUNK_SIZE ?? UPLOAD_DEFAULTS.minChunkSize,
      retryCount: e.RETRY_COUNT,
      timeoutMs: e.UPLOAD_TIMEOUT,
    },
    smtp: {
      enabled: e.SMTP_HOST !== '',
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      secure: e.SMTP_SECURE,
      user: e.SMTP_USER,
      password: e.SMTP_PASSWORD,
      from: e.SMTP_FROM,
    },
    clamav: { enabled: e.CLAMAV_ENABLED, host: e.CLAMAV_HOST, port: e.CLAMAV_PORT },
    rateLimitEnabled: e.RATE_LIMIT_ENABLED,
    workerConcurrency: e.WORKER_CONCURRENCY,
    version: process.env.npm_package_version ?? '1.0.0',
  };
}

let cached: AppConfig | null = null;
export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
/** Test helper: reset memoised config after mutating process.env. */
export function resetConfig() {
  cached = null;
}
