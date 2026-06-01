/**
 * GET /api/v1/me — the authenticated principal.
 *
 * Identity route: requires a valid bearer token but no specific scope (it returns
 * who you are, derived from the token itself). For a user-delegated token it
 * returns the user; for a client_credentials token (the agent) user is null and
 * the app identity stands in. The SDK's `ShipClient.me()` calls this.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ApiError } from '../../errors.js';
import type { PlatformDeps } from './router.js';

export function createMeRouter(deps: PlatformDeps): Router {
  const router = Router();

  router.get('/', deps.bearerAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = req.platformAuth!;
      const user = auth.userId ? await deps.identity.getUser(auth.userId) : null;
      res.json({
        user,
        app: { client_id: auth.clientId },
        scopes: auth.scopes,
        workspace_id: auth.workspaceId,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
