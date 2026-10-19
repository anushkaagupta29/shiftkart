export class HttpError extends Error {
  issues?: unknown;
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string) => new HttpError(400, code, msg);
export const unauthorized = (msg = 'Please log in again.') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission to do this.') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, 'not_found', msg);
export const conflict = (code: string, msg: string) => new HttpError(409, code, msg);
export const tooMany = (code: string, msg: string, retryAfterSec: number) =>
  new HttpError(429, code, msg, { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSec))) });
