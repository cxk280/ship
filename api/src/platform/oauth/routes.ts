/**
 * OAuth 2.0 server routes (mounted at /oauth, OUTSIDE /api/v1).
 *
 *   GET  /oauth/authorize            consent screen (Auth Code + PKCE)
 *   POST /oauth/authorize/decision   approve/deny → issues code, redirects back
 *   POST /oauth/token                token endpoint (all four grant types)
 *   POST /oauth/introspect           token introspection (RFC 7662)
 *   POST /oauth/device/code          device authorization request (RFC 8628)
 *   GET  /oauth/device               device verification / consent page
 *   POST /oauth/device/decision      approve/deny a device
 *
 * These endpoints authenticate a Ship *user* via session cookie (consent) or a
 * *client* via client_id/secret (token). They return RFC OAuth error bodies, not
 * the /api/v1 ApiError shape.
 *
 * DPoP (RFC 9449): the token endpoint optionally accepts a `DPoP` proof header.
 * When present, the issued access token is sender-constrained to the proof key's
 * JWK thumbprint and returned with token_type "DPoP". Absent ⇒ plain Bearer.
 */
import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { OAuthError, sendOAuthError } from './errors.js';
import * as service from './service.js';
import { verifyDpopProof, DpopError, DPOP_ALGS } from './dpop.js';
import { registerJti } from './dpop-replay.js';
import {
  getAppByClientId,
  getAppById,
  getDeviceByUserCode,
  approveDevice,
  denyDevice,
} from './store.js';
import { getSessionUser } from './session.js';
import { consentPage, deviceVerifyPage, devicePostedPage } from './consent-page.js';
import { logAuditEvent } from '../../services/audit.js';

type RouterT = ReturnType<typeof Router>;

// ---- helpers --------------------------------------------------------------

function baseUrl(req: Request): string {
  const envBase = process.env.PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function genCsrf(req: Request): string {
  const token = crypto.randomBytes(24).toString('hex');
  // express-session is enabled app-wide; stash a per-session consent token.
  (req.session as unknown as { oauthCsrf?: string }).oauthCsrf = token;
  return token;
}

function checkCsrf(req: Request): boolean {
  const expected = (req.session as unknown as { oauthCsrf?: string }).oauthCsrf;
  const got = req.body?.csrf_token;
  return Boolean(expected) && typeof got === 'string' && got === expected;
}

function frameBust(res: Response): void {
  // Anti-clickjacking for the consent surface (overrides the app-wide SAMEORIGIN).
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
}

function parseScopes(scope: unknown): string[] {
  if (typeof scope !== 'string' || scope.trim() === '') return [];
  return scope.trim().split(/\s+/);
}

/** Extract client credentials from HTTP Basic or the request body. */
function extractClientCreds(req: Request): { clientId?: string; clientSecret?: string } {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx >= 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, idx)),
        clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
      };
    }
  }
  return {
    clientId: typeof req.body?.client_id === 'string' ? req.body.client_id : undefined,
    clientSecret: typeof req.body?.client_secret === 'string' ? req.body.client_secret : undefined,
  };
}

/** Proof freshness window for token-endpoint DPoP proofs (seconds). */
const DPOP_PROOF_MAX_AGE_SEC = 300;

/**
 * If the request carries a `DPoP` header, verify the proof (RFC 9449 §5) against
 * this endpoint (htm=POST, htu=the token endpoint URL) and return the binding to
 * apply to the issued token. No header ⇒ undefined (plain Bearer). A malformed /
 * invalid proof is a hard `invalid_dpop_proof` error per the RFC.
 */
function dpopBindingFromRequest(req: Request): service.DpopBinding | undefined {
  const raw = req.headers['dpop'];
  if (raw === undefined) return undefined;
  const proof = Array.isArray(raw) ? raw[0] : raw;
  if (!proof) throw new OAuthError('invalid_dpop_proof', 'Empty DPoP proof header');
  const htu = `${baseUrl(req)}/oauth/token`;
  let claims;
  try {
    claims = verifyDpopProof({ proof, htm: 'POST', htu, maxAgeSec: DPOP_PROOF_MAX_AGE_SEC });
  } catch (err) {
    if (err instanceof DpopError) throw new OAuthError('invalid_dpop_proof', err.message);
    throw err;
  }
  if (!registerJti(claims.jti, DPOP_PROOF_MAX_AGE_SEC)) {
    throw new OAuthError('invalid_dpop_proof', 'DPoP proof replay detected');
  }
  return { jkt: claims.jkt };
}

// ---------------------------------------------------------------------------

export function createOAuthRouter(): RouterT {
  const router = Router();

  // ---- Authorization Code + PKCE: consent screen --------------------------
  router.get('/authorize', async (req: Request, res: Response) => {
    const { response_type, client_id, redirect_uri, scope, state } = req.query as Record<string, string>;
    const codeChallenge = (req.query.code_challenge as string) || '';
    const method = ((req.query.code_challenge_method as string) || 'S256') as 'S256' | 'plain';

    const app = client_id ? await getAppByClientId(client_id) : null;
    if (!app) {
      res.status(400).send(devicePostedPage('Unknown or inactive client_id.', false));
      return;
    }
    if (!redirect_uri || !app.redirect_uris.includes(redirect_uri)) {
      res.status(400).send(devicePostedPage('redirect_uri is not registered for this app.', false));
      return;
    }
    // From here, param errors are reported by redirecting back to the (trusted) redirect_uri.
    const redirectErr = (error: string) => {
      const u = new URL(redirect_uri);
      u.searchParams.set('error', error);
      if (state) u.searchParams.set('state', state);
      res.redirect(u.toString());
    };
    if (response_type !== 'code') return redirectErr('unsupported_response_type');
    if (!codeChallenge) return redirectErr('invalid_request');
    if (method !== 'S256' && method !== 'plain') return redirectErr('invalid_request');

    let scopes: string[];
    try {
      scopes = service.resolveScopes(app, parseScopes(scope));
    } catch {
      return redirectErr('invalid_scope');
    }

    const sessionUser = await getSessionUser(req);
    if (!sessionUser) {
      res
        .status(401)
        .send(devicePostedPage('Please log into Ship first, then retry the authorization link.', false));
      return;
    }

    frameBust(res);
    res.send(
      consentPage({
        appName: app.name,
        scopes,
        csrfToken: genCsrf(req),
        action: `${baseUrl(req)}/oauth/authorize/decision`,
        hidden: {
          response_type: 'code',
          client_id: app.client_id,
          redirect_uri,
          scope: scopes.join(' '),
          state: state || '',
          code_challenge: codeChallenge,
          code_challenge_method: method,
        },
      }),
    );
  });

  // ---- Authorization Code: the consent decision ---------------------------
  router.post('/authorize/decision', async (req: Request, res: Response) => {
    const { client_id, redirect_uri, scope, state, decision } = req.body as Record<string, string>;
    const codeChallenge = req.body.code_challenge as string;
    const method = (req.body.code_challenge_method as 'S256' | 'plain') || 'S256';

    const sessionUser = await getSessionUser(req);
    if (!sessionUser) {
      res.status(401).send(devicePostedPage('Session expired. Please log in and retry.', false));
      return;
    }
    if (!checkCsrf(req)) {
      res.status(403).send(devicePostedPage('Invalid CSRF token.', false));
      return;
    }

    const app = client_id ? await getAppByClientId(client_id) : null;
    if (!app || !redirect_uri || !app.redirect_uris.includes(redirect_uri)) {
      res.status(400).send(devicePostedPage('Invalid client_id or redirect_uri.', false));
      return;
    }

    const redirectWith = (params: Record<string, string>) => {
      const u = new URL(redirect_uri);
      for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
      if (state) u.searchParams.set('state', state);
      res.redirect(u.toString());
    };

    if (decision !== 'approve') return redirectWith({ error: 'access_denied' });

    let scopes: string[];
    try {
      scopes = service.resolveScopes(app, parseScopes(scope));
    } catch {
      return redirectWith({ error: 'invalid_scope' });
    }

    const code = await service.issueAuthorizationCode({
      app,
      userId: sessionUser.userId,
      workspaceId: sessionUser.workspaceId,
      redirectUri: redirect_uri,
      scopes,
      codeChallenge,
      codeChallengeMethod: method,
    });
    await logAuditEvent({
      workspaceId: sessionUser.workspaceId,
      actorUserId: sessionUser.userId,
      action: 'oauth.authorization_code.issued',
      resourceType: 'oauth_app',
      resourceId: app.id,
      details: { client_id: app.client_id, scopes },
      req,
    });
    return redirectWith({ code });
  });

  // ---- Token endpoint (all grant types) -----------------------------------
  router.post('/token', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const grantType = req.body?.grant_type;
    try {
      const { clientId, clientSecret } = extractClientCreds(req);
      // Opt-in, additive: undefined unless the client sent a (valid) DPoP proof.
      const dpop = dpopBindingFromRequest(req);

      if (grantType === 'authorization_code') {
        const app = await service.authenticateClient(clientId, clientSecret);
        const tokens = await service.exchangeAuthorizationCode({
          app,
          code: req.body.code,
          redirectUri: req.body.redirect_uri,
          codeVerifier: req.body.code_verifier,
          dpop,
        });
        res.json(tokens);
        return;
      }

      if (grantType === 'refresh_token') {
        const app = await service.authenticateClient(clientId, clientSecret);
        const tokens = await service.refresh({
          app,
          refreshToken: req.body.refresh_token,
          requestedScopes: parseScopes(req.body.scope),
          dpop,
        });
        res.json(tokens);
        return;
      }

      if (grantType === 'client_credentials') {
        const app = await service.authenticateClient(clientId, clientSecret);
        const tokens = await service.clientCredentials({
          app,
          requestedScopes: parseScopes(req.body.scope),
          dpop,
        });
        res.json(tokens);
        return;
      }

      if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
        // Device clients are public; secret is optional, client_id identifies the app.
        const app = await service.authenticateClient(clientId, clientSecret);
        const tokens = await service.pollDeviceToken({ app, deviceCode: req.body.device_code, dpop });
        res.json(tokens);
        return;
      }

      throw new OAuthError('unsupported_grant_type', `Unsupported grant_type: ${grantType}`);
    } catch (err) {
      if (err instanceof OAuthError) {
        sendOAuthError(res, err);
        return;
      }
      console.error('[oauth/token] unexpected error:', err);
      sendOAuthError(res, new OAuthError('server_error', 'Internal error'));
    }
  });

  // ---- Token introspection (RFC 7662) -------------------------------------
  // The requesting client authenticates exactly like the token endpoint
  // (client_id/secret, Basic or body). It then posts token=<access|refresh>. The
  // response never reveals WHY an inactive token is inactive (RFC 7662 §2.2).
  router.post('/introspect', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    try {
      const { clientId, clientSecret } = extractClientCreds(req);
      // Authenticate the caller; a bad/absent secret is invalid_client (401).
      await service.authenticateClient(clientId, clientSecret);

      const token = typeof req.body?.token === 'string' ? req.body.token : '';
      const result = await service.introspect(token);
      res.json(result);
    } catch (err) {
      if (err instanceof OAuthError) {
        sendOAuthError(res, err);
        return;
      }
      console.error('[oauth/introspect] unexpected error:', err);
      sendOAuthError(res, new OAuthError('server_error', 'Internal error'));
    }
  });

  // ---- Device authorization request ---------------------------------------
  router.post('/device/code', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const clientId = req.body?.client_id;
      const app = clientId ? await getAppByClientId(clientId) : null;
      if (!app) throw new OAuthError('invalid_client', 'Unknown or inactive client');
      const result = await service.startDeviceAuthorization({
        app,
        requestedScopes: parseScopes(req.body.scope),
        verificationBaseUrl: baseUrl(req),
      });
      res.json(result);
    } catch (err) {
      if (err instanceof OAuthError) {
        sendOAuthError(res, err);
        return;
      }
      console.error('[oauth/device/code] unexpected error:', err);
      sendOAuthError(res, new OAuthError('server_error', 'Internal error'));
    }
  });

  // ---- Device verification page -------------------------------------------
  router.get('/device', async (req: Request, res: Response) => {
    frameBust(res);
    const sessionUser = await getSessionUser(req);
    if (!sessionUser) {
      res.status(401).send(devicePostedPage('Please log into Ship first, then reopen this link.', false));
      return;
    }
    const userCode = (req.query.user_code as string) || '';
    if (!userCode) {
      // No code yet: show the code-entry form (GETs back here with ?user_code=).
      res.send(deviceVerifyPage({ csrfToken: genCsrf(req), action: `${baseUrl(req)}/oauth/device` }));
      return;
    }
    const device = await getDeviceByUserCode(userCode.toUpperCase());
    if (!device || device.status !== 'pending' || new Date(device.expires_at).getTime() < Date.now()) {
      res.status(400).send(devicePostedPage('That code is invalid or has expired.', false));
      return;
    }
    // Render consent for this device's app + scopes.
    const appRow = await getAppById(device.app_id);
    res.send(
      consentPage({
        appName: appRow?.name ?? 'a device',
        scopes: device.scopes,
        csrfToken: genCsrf(req),
        action: `${baseUrl(req)}/oauth/device/decision`,
        subtitle: `Approve sign-in for code ${userCode.toUpperCase()}?`,
        hidden: { user_code: userCode.toUpperCase() },
      }),
    );
  });

  // ---- Device decision ----------------------------------------------------
  router.post('/device/decision', async (req: Request, res: Response) => {
    frameBust(res);
    const sessionUser = await getSessionUser(req);
    if (!sessionUser) {
      res.status(401).send(devicePostedPage('Session expired. Please log in and retry.', false));
      return;
    }
    if (!checkCsrf(req)) {
      res.status(403).send(devicePostedPage('Invalid CSRF token.', false));
      return;
    }
    const userCode = String(req.body.user_code || '').toUpperCase();
    const device = await getDeviceByUserCode(userCode);
    if (!device || device.status !== 'pending' || new Date(device.expires_at).getTime() < Date.now()) {
      res.status(400).send(devicePostedPage('That code is invalid or has expired.', false));
      return;
    }
    if (req.body.decision === 'deny') {
      await denyDevice(device.id);
      res.send(devicePostedPage('Request denied. You can close this window.', false));
      return;
    }
    await approveDevice(device.id, sessionUser.userId, sessionUser.workspaceId, device.scopes);
    await logAuditEvent({
      workspaceId: sessionUser.workspaceId,
      actorUserId: sessionUser.userId,
      action: 'oauth.device.approved',
      resourceType: 'oauth_app',
      resourceId: device.app_id,
      details: { user_code: userCode, scopes: device.scopes },
      req,
    });
    res.send(devicePostedPage('Device approved. Return to your terminal — you are signed in.', true));
  });

  return router;
}
