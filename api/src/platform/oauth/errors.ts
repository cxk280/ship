/**
 * OAuth 2.0 error responses (RFC 6749 §5.2, RFC 8628 §3.5).
 *
 * The token/authorize endpoints are NOT under /api/v1, so they return the
 * standard OAuth `{ error, error_description }` body — NOT the ApiError shape.
 * Keeping these distinct is deliberate: clients/SDKs parse OAuth errors per the
 * RFCs, and the public resource API parses ApiError. Two contracts, on purpose.
 */
import type { Response } from 'express';

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  // RFC 8628 device-flow polling states
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token';

const STATUS_BY_ERROR: Partial<Record<OAuthErrorCode, number>> = {
  invalid_client: 401,
  // device polling pseudo-errors are 400 per RFC 8628
};

export class OAuthError extends Error {
  readonly error: OAuthErrorCode;
  readonly status: number;
  readonly description?: string;

  constructor(error: OAuthErrorCode, description?: string) {
    super(description ?? error);
    this.name = 'OAuthError';
    this.error = error;
    this.description = description;
    this.status = STATUS_BY_ERROR[error] ?? 400;
  }
}

/** Write an OAuthError as an RFC-compliant JSON response. */
export function sendOAuthError(res: Response, err: OAuthError): void {
  // invalid_client per RFC 6749 §5.2 SHOULD include a WWW-Authenticate header.
  if (err.error === 'invalid_client') {
    res.setHeader('WWW-Authenticate', 'Basic realm="oauth"');
  }
  res.status(err.status).json({
    error: err.error,
    ...(err.description ? { error_description: err.description } : {}),
  });
}
