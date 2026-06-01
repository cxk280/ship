/**
 * Public API error contract.
 *
 * Every failure on a `/api/v1/*` route ships exactly this shape:
 *   { code, message, details?, request_id }
 *
 * This is intentionally DISTINCT from the internal API's error shape
 * (`{ success: false, error: { code, message } }`). The public/internal split
 * is a one-way door — the two shapes must never be conflated. A fitness test
 * (see platform/__tests__) asserts this shape on every public failure path.
 */
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { ZodError } from 'zod';

/** The closed set of public error codes (PRD: Interface Definitions). */
export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'rate_limited'
  | 'server_error';

/** The wire shape returned to every public client on failure. */
export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}

/** HTTP status mapped from each public error code. */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  rate_limited: 429,
  server_error: 500,
};

/**
 * An error that the public error middleware serializes into the {@link ApiErrorBody}
 * shape. Throw one of the static helpers from a handler (or pass it to `next()`),
 * never construct an ad-hoc response object.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  /** Serialize to the public wire shape, stamping the per-request id. */
  toBody(requestId: string): ApiErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      request_id: requestId,
    };
  }

  static unauthorized(message = 'Authentication required', details?: Record<string, unknown>) {
    return new ApiError('unauthorized', message, details);
  }
  static forbidden(message = 'Forbidden', details?: Record<string, unknown>) {
    return new ApiError('forbidden', message, details);
  }
  static notFound(message = 'Not found', details?: Record<string, unknown>) {
    return new ApiError('not_found', message, details);
  }
  static validation(message = 'Validation failed', details?: Record<string, unknown>) {
    return new ApiError('validation_failed', message, details);
  }
  static rateLimited(message = 'Rate limit exceeded', details?: Record<string, unknown>) {
    return new ApiError('rate_limited', message, details);
  }
  static server(message = 'Internal server error', details?: Record<string, unknown>) {
    return new ApiError('server_error', message, details);
  }
}

/**
 * Per-request id middleware for the public edge.
 *
 * Honors an inbound `X-Request-Id` (so a client/SDK can correlate), otherwise
 * mints a uuid. Echoes it on the response header and stashes it on the request
 * so the error middleware and audit trail can reference the same id.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  const id = (typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 200)
    ? inbound
    : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/**
 * Terminal 404 for the public edge: any unmatched `/api/v1/*` path returns the
 * ApiError shape rather than Express's default HTML.
 */
export function publicNotFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`No such route: ${req.method} ${req.baseUrl}${req.path}`));
}

/**
 * The single error middleware for the public edge. Guarantees the {@link ApiErrorBody}
 * shape on EVERY failure: explicit ApiErrors pass through, ZodErrors become
 * `validation_failed`, and anything unexpected becomes `server_error` (never leaking
 * internal error text to clients).
 */
export function apiErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const requestId = req.requestId ?? randomUUID();

  if (err instanceof ApiError) {
    res.status(err.status).json(err.toBody(requestId));
    return;
  }

  if (err instanceof ZodError) {
    const apiErr = ApiError.validation('Request validation failed', {
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    res.status(apiErr.status).json(apiErr.toBody(requestId));
    return;
  }

  // Unknown / unexpected: log server-side, return an opaque server_error.
  console.error(`[api/v1] unhandled error (request_id=${requestId}):`, err);
  const apiErr = ApiError.server();
  res.status(apiErr.status).json(apiErr.toBody(requestId));
}
