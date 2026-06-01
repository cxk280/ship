/**
 * Bearer-token middleware for the public `/api/v1` edge.
 *
 * Validates an OAuth access token and populates req.platformAuth with
 * { appId, clientId, userId, workspaceId, scopes, tokenId }. Failures return the
 * public ApiError shape (401) plus an RFC 6750 WWW-Authenticate header. Expired
 * tokens are distinguished from invalid/missing via details.reason — the MVP's
 * "distinct error code" for expiry, kept inside the closed ApiError code set.
 *
 * This module is platform glue (imports the OAuth store / db) — it is INJECTED
 * into the sealed v1 router as deps.bearerAuth, never imported by v1 directly.
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors.js';
import { sha256 } from './crypto.js';
import { getAccessTokenWithApp, touchAccessToken } from './store.js';

export async function bearerAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    next(ApiError.unauthorized('Missing bearer token', { reason: 'token_missing' }));
    return;
  }
  const raw = header.slice('Bearer '.length).trim();
  if (!raw) {
    res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
    next(ApiError.unauthorized('Malformed bearer token', { reason: 'token_invalid' }));
    return;
  }

  try {
    const found = await getAccessTokenWithApp(sha256(raw));
    if (!found || !found.app.is_active || found.token.revoked_at) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      next(ApiError.unauthorized('Invalid access token', { reason: 'token_invalid' }));
      return;
    }
    if (new Date(found.token.expires_at).getTime() < Date.now()) {
      res.setHeader(
        'WWW-Authenticate',
        'Bearer error="invalid_token", error_description="The access token expired"',
      );
      next(ApiError.unauthorized('Access token expired', { reason: 'token_expired' }));
      return;
    }

    req.platformAuth = {
      appId: found.token.app_id,
      clientId: found.app.client_id,
      userId: found.token.user_id,
      workspaceId: found.token.workspace_id,
      scopes: found.token.scopes,
      tokenId: found.token.id,
    };
    // Best-effort usage stamp; never blocks the request.
    void touchAccessToken(found.token.id).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
}
