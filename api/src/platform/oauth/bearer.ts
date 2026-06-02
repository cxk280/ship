/**
 * Token middleware for the public `/api/v1` edge.
 *
 * Validates an OAuth access token and populates req.platformAuth with
 * { appId, clientId, userId, workspaceId, scopes, tokenId }. Failures return the
 * public ApiError shape (401) plus an RFC 6750 WWW-Authenticate header. Expired
 * tokens are distinguished from invalid/missing via details.reason — the MVP's
 * "distinct error code" for expiry, kept inside the closed ApiError code set.
 *
 * Two authentication schemes are supported:
 *   - `Authorization: Bearer  <token>`  — RFC 6750 (plain). Works as it always has.
 *   - `Authorization: DPoP    <token>`  — RFC 9449 (sender-constrained). Requires a
 *     fresh `DPoP` proof header whose key thumbprint matches the token's stored jkt.
 *
 * Binding rule (the whole point of DPoP): a token MINTED with a jkt may ONLY be
 * used with the DPoP scheme + a valid proof. Presenting it as plain `Bearer` (no
 * proof) is rejected. A plain (jkt-NULL) token keeps working exactly as today.
 *
 * This module is platform glue (imports the OAuth store / db) — it is INJECTED
 * into the sealed v1 router as deps.bearerAuth, never imported by v1 directly.
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors.js';
import { sha256 } from './crypto.js';
import { getAccessTokenWithApp, touchAccessToken } from './store.js';
import { verifyDpopProof, DpopError } from './dpop.js';
import { registerJti } from './dpop-replay.js';

/** Proof freshness window (seconds). */
const DPOP_PROOF_MAX_AGE_SEC = 300;

function parseAuthScheme(header: string | undefined): { scheme: string; token: string } | null {
  if (!header) return null;
  const sp = header.indexOf(' ');
  if (sp < 0) return null;
  const scheme = header.slice(0, sp);
  const token = header.slice(sp + 1).trim();
  if (!token) return null;
  return { scheme, token };
}

/**
 * Reconstruct the request's HTTP target URI (htu) for DPoP binding. Honors the
 * proxy headers the edge already trusts (x-forwarded-proto/host) and strips the
 * query string + fragment, per RFC 9449 §4.3.
 */
function requestHtu(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'localhost';
  const path = req.originalUrl.split('?')[0];
  return `${proto}://${host}${path}`;
}

export async function bearerAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const parsed = parseAuthScheme(header);
  if (!parsed) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    next(ApiError.unauthorized('Missing bearer token', { reason: 'token_missing' }));
    return;
  }
  const { scheme, token: raw } = parsed;
  const schemeLower = scheme.toLowerCase();
  if (schemeLower !== 'bearer' && schemeLower !== 'dpop') {
    res.setHeader('WWW-Authenticate', 'Bearer');
    next(ApiError.unauthorized('Unsupported authorization scheme', { reason: 'token_missing' }));
    return;
  }
  const isDpopScheme = schemeLower === 'dpop';
  // WWW-Authenticate scheme echoes the request scheme so clients self-correct.
  const wwwScheme = isDpopScheme ? 'DPoP' : 'Bearer';

  const rejectInvalid = (msg: string) => {
    res.setHeader('WWW-Authenticate', `${wwwScheme} error="invalid_token"`);
    next(ApiError.unauthorized(msg, { reason: 'token_invalid' }));
  };

  try {
    const found = await getAccessTokenWithApp(sha256(raw));
    if (!found || !found.app.is_active || found.token.revoked_at) {
      rejectInvalid('Invalid access token');
      return;
    }
    if (new Date(found.token.expires_at).getTime() < Date.now()) {
      res.setHeader(
        'WWW-Authenticate',
        `${wwwScheme} error="invalid_token", error_description="The access token expired"`,
      );
      next(ApiError.unauthorized('Access token expired', { reason: 'token_expired' }));
      return;
    }

    const boundJkt = found.token.dpop_jkt;

    if (boundJkt) {
      // Sender-constrained token: the DPoP scheme + a valid matching proof are
      // mandatory. Presenting it as plain Bearer (or without a proof) is the
      // exact attack DPoP defends against — reject.
      if (!isDpopScheme) {
        res.setHeader('WWW-Authenticate', 'DPoP error="invalid_token", error_description="DPoP-bound token requires the DPoP scheme"');
        next(ApiError.unauthorized('Token is DPoP-bound; use the DPoP scheme', { reason: 'token_invalid' }));
        return;
      }
      const proofHeaderRaw = req.headers['dpop'];
      const proof = Array.isArray(proofHeaderRaw) ? proofHeaderRaw[0] : proofHeaderRaw;
      if (!proof) {
        rejectInvalid('Missing DPoP proof');
        return;
      }
      let claims;
      try {
        claims = verifyDpopProof({
          proof,
          htm: req.method,
          htu: requestHtu(req),
          maxAgeSec: DPOP_PROOF_MAX_AGE_SEC,
          accessToken: raw, // RFC 9449: ath must bind the proof to this token.
        });
      } catch (err) {
        if (err instanceof DpopError) {
          rejectInvalid('Invalid DPoP proof');
          return;
        }
        throw err;
      }
      if (claims.jkt !== boundJkt) {
        rejectInvalid('DPoP proof key does not match the token binding');
        return;
      }
      // Single-use proof: a replayed jti within the freshness window is rejected.
      if (!registerJti(claims.jti, DPOP_PROOF_MAX_AGE_SEC)) {
        rejectInvalid('DPoP proof replay detected');
        return;
      }
    } else if (isDpopScheme) {
      // A non-bound token presented under the DPoP scheme is not DPoP — reject so
      // a stolen plain token can't be smuggled past with a fabricated proof.
      rejectInvalid('Token is not DPoP-bound');
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
