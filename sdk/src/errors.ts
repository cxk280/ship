/**
 * Typed, discriminated-union SDK errors.
 *
 * Consumers switch exhaustively on `kind` — no try/catch guessing, no string
 * matching. Mirrors the public ApiError codes but groups them into the handful
 * of cases a consumer actually branches on.
 */
export type ShipErrorKind = 'auth' | 'rate_limit' | 'not_found' | 'validation' | 'server' | 'network';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  request_id?: string;
}

export class ShipError extends Error {
  readonly kind: ShipErrorKind;
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(input: {
    kind: ShipErrorKind;
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  }) {
    super(input.message);
    this.name = 'ShipError';
    this.kind = input.kind;
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
    this.requestId = input.requestId;
  }

  /** Map an HTTP status + ApiError body to a discriminated SDK error. */
  static fromResponse(status: number, body: ApiErrorBody): ShipError {
    const kind: ShipErrorKind =
      status === 401 ? 'auth'
      : status === 403 ? 'auth'
      : status === 404 ? 'not_found'
      : status === 422 || status === 400 ? 'validation'
      : status === 429 ? 'rate_limit'
      : 'server';
    return new ShipError({
      kind,
      status,
      code: body.code ?? 'server_error',
      message: body.message ?? `HTTP ${status}`,
      details: body.details,
      requestId: body.request_id,
    });
  }

  static network(message: string): ShipError {
    return new ShipError({ kind: 'network', status: 0, code: 'network_error', message });
  }
}
