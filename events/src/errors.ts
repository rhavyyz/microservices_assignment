/**
 * Expected business/authorization failure. The HTTP layer turns it into a problem+json response with the
 * given status and stable `code`; anything that is not an AppError is an unexpected 500.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export const unauthorized = (message = 'authentication is required (X-User-Id header)') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message: string) => new AppError(403, 'FORBIDDEN', message);

/** Also used for resources the caller may not see, so their existence never leaks (RN07). */
export const notFound = (what: 'event' | 'activity') => new AppError(404, 'NOT_FOUND', `${what} not found`);

export const conflict = (code: string, message: string) => new AppError(409, code, message);

export const unprocessable = (code: string, message: string) => new AppError(422, code, message);
