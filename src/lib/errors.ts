/**
 * Stripe-like error envelope:
 *   { "error": { "type": "invalid_request_error", "code": "...", "message": "..." } }
 */
export type ApiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'idempotency_error';

export class ApiError extends Error {
  statusCode: number;
  type: ApiErrorType;
  code: string | undefined;
  param: string | undefined;

  constructor(
    statusCode: number,
    type: ApiErrorType,
    message: string,
    opts: { code?: string; param?: string } = {},
  ) {
    super(message);
    this.statusCode = statusCode;
    this.type = type;
    this.code = opts.code;
    this.param = opts.param;
  }

  toJSON() {
    return {
      error: {
        type: this.type,
        code: this.code,
        param: this.param,
        message: this.message,
      },
    };
  }
}

export const badRequest = (message: string, opts?: { code?: string; param?: string }) =>
  new ApiError(400, 'invalid_request_error', message, opts);

export const unauthorized = (message = 'Invalid API key provided.') =>
  new ApiError(401, 'authentication_error', message, { code: 'invalid_api_key' });

export const notFound = (message: string) =>
  new ApiError(404, 'invalid_request_error', message, { code: 'resource_missing' });

export const conflict = (message: string, code = 'state_conflict') =>
  new ApiError(409, 'invalid_request_error', message, { code });
