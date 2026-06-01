/**
 * OAuth app management (mounted at /api/oauth/apps).
 *
 * This is the developer-portal BOOTSTRAP surface: a logged-in Ship user (session
 * or internal API token) registers OAuth apps and rotates secrets. It is the one
 * acknowledged "privileged internal endpoint" (PRD 2.5) — app registration can't
 * itself be gated by an OAuth token (chicken-and-egg). Resource + webhook data
 * still flow through the public bearer API.
 *
 * Uses the INTERNAL response shape ({success,data} / {success:false,error}) — it
 * is not a /api/v1 route, so it does not use the public ApiError contract.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import { authMiddleware } from '../../middleware/auth.js';
import { logAuditEvent } from '../../services/audit.js';
import { scopeRegistry } from '../scopes/registry.js';
import { generate, hashClientSecret } from '../oauth/crypto.js';
import {
  createApp,
  listAppsByOwner,
  getAppById,
  rotateAppSecret,
  deactivateApp,
} from '../oauth/store.js';

type RouterT = ReturnType<typeof Router>;

const createAppSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  redirect_uris: z.array(z.string().url()).max(10).default([]),
  requested_scopes: z
    .array(z.string())
    .max(20)
    .default([])
    .refine((arr) => arr.every((s) => scopeRegistry.has(s)), {
      message: 'Contains an unknown scope',
    }),
  app_type: z.enum(['confidential', 'public', 'first_party']).default('confidential'),
});

function publicAppView(row: {
  id: string;
  client_id: string;
  name: string;
  description: string | null;
  redirect_uris: string[];
  requested_scopes: string[];
  app_type: string;
  is_active: boolean;
  created_at: string;
}) {
  return {
    id: row.id,
    client_id: row.client_id,
    name: row.name,
    description: row.description,
    redirect_uris: row.redirect_uris,
    requested_scopes: row.requested_scopes,
    app_type: row.app_type,
    is_active: row.is_active,
    created_at: row.created_at,
  };
}

export function createAppsRouter(): RouterT {
  const router = Router();

  // POST /api/oauth/apps — register an app; raw secret shown EXACTLY ONCE.
  router.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const parsed = createAppSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Invalid request', details: parsed.error.flatten() },
      });
      return;
    }
    const { name, description, redirect_uris, requested_scopes, app_type } = parsed.data;
    const clientId = generate.clientId();
    const clientSecret = generate.clientSecret();
    const clientSecretHash = await hashClientSecret(clientSecret);

    const row = await createApp({
      clientId,
      clientSecretHash,
      name,
      description: description ?? null,
      redirectUris: redirect_uris,
      requestedScopes: requested_scopes,
      appType: app_type,
      ownerUserId: req.userId ?? null,
      workspaceId: req.workspaceId ?? null,
    });

    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.userId!,
      action: 'oauth_app.created',
      resourceType: 'oauth_app',
      resourceId: row.id,
      details: { client_id: clientId, name, app_type, requested_scopes },
      req,
    });

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      data: {
        ...publicAppView(row),
        client_secret: clientSecret, // ONLY returned here — never recoverable.
        warning: 'Save this client_secret now. It will not be shown again.',
      },
    });
  });

  // GET /api/oauth/apps — list the caller's apps (no secrets).
  router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const rows = await listAppsByOwner(req.userId!);
    res.json({ success: true, data: rows.map(publicAppView) });
  });

  // POST /api/oauth/apps/:id/rotate-secret — new secret shown ONCE.
  router.post('/:id/rotate-secret', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const app = await getAppById(String(req.params.id));
    if (!app || app.owner_user_id !== req.userId) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: 'App not found' },
      });
      return;
    }
    const clientSecret = generate.clientSecret();
    await rotateAppSecret(app.id, await hashClientSecret(clientSecret));
    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.userId!,
      action: 'oauth_app.secret_rotated',
      resourceType: 'oauth_app',
      resourceId: app.id,
      details: { client_id: app.client_id },
      req,
    });
    res.json({
      success: true,
      data: {
        client_id: app.client_id,
        client_secret: clientSecret,
        warning: 'Save this client_secret now. The previous secret is now invalid.',
      },
    });
  });

  // DELETE /api/oauth/apps/:id — deactivate.
  router.delete('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const app = await getAppById(String(req.params.id));
    if (!app || app.owner_user_id !== req.userId) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: 'App not found' },
      });
      return;
    }
    await deactivateApp(app.id);
    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.userId!,
      action: 'oauth_app.deactivated',
      resourceType: 'oauth_app',
      resourceId: app.id,
      details: { client_id: app.client_id },
      req,
    });
    res.json({ success: true, data: { message: 'App deactivated' } });
  });

  return router;
}
