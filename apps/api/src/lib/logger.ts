import pino from 'pino';

/** Paths redacted from every structured log line. Secrets must never reach logs. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-upload-session"]',
  'req.headers["x-portal-access"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.sessionToken',
  '*.accessToken',
];

/** Strip portal tokens from URLs before logging: /api/public/portals/<token>/… → /api/public/portals/[token]/… */
export function redactUrl(url: string): string {
  return url.replace(/(\/public\/portals\/)[^/?#]+/, '$1[token]').replace(/(\/u\/)[^/?#]+/, '$1[token]');
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: process.env.SERVICE_NAME ?? 'api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(process.env.NODE_ENV === 'development' && process.stdout.isTTY
    ? { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});
