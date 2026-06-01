/**
 * Express request augmentation for the public platform edge.
 *
 * These fields are populated only by public-edge middleware (request-id, bearer
 * auth). Internal `/api/*` routes never set them. Keeping the augmentation here
 * (rather than in middleware/auth.ts) keeps the public contract self-contained.
 */
import 'express';

/**
 * The authenticated principal behind a `/api/v1/*` request, populated by the
 * bearer-token middleware. `userId` is null for the client-credentials grant
 * (machine-to-machine, no delegating human — e.g. the Epic 7 agent).
 */
export interface PlatformAuthContext {
  /** oauth_apps.id of the calling app. */
  appId: string;
  /** Public client identifier (appears in the audit trail). */
  clientId: string;
  /** Delegating user, or null for client-credentials tokens. */
  userId: string | null;
  /** Workspace the token is scoped to, if any. */
  workspaceId: string | null;
  /** Scopes actually granted on this token. */
  scopes: string[];
  /** oauth_access_tokens.id (for audit correlation). */
  tokenId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Stable id for this request, set by requestIdMiddleware on the public edge. */
      requestId?: string;
      /** Authenticated platform principal, set by the bearer-token middleware. */
      platformAuth?: PlatformAuthContext;
    }
  }
}
