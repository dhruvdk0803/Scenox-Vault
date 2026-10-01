/** Application error with a user-safe message. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message = 'The request was invalid.', details?: unknown) => new AppError(400, 'bad_request', message, details);
export const validationError = (details: unknown, message = 'Some fields are invalid.') => new AppError(400, 'validation_error', message, details);
export const unauthorized = (message = 'Please sign in to continue.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = "You don't have permission to do that.") => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
export const gone = (message: string, code = 'gone') => new AppError(410, code, message);
export const payloadTooLarge = (message: string, code = 'too_large') => new AppError(413, code, message);
export const tooManyRequests = (message = 'Too many attempts. Please wait a moment and try again.') => new AppError(429, 'rate_limited', message);
export const quotaExceeded = (message = 'This upload would exceed the available storage for this portal.') => new AppError(413, 'quota_exceeded', message);
