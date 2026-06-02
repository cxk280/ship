/**
 * Developer Portal — session-authed read/replay surface for webhook data + audit trail.
 *
 * Mounted at /api/oauth/portal.  This is platform GLUE (not under api/src/platform/api/v1)
 * so it may freely import the webhook store, event-bus, and internal middleware.
 *
 * Endpoints (all require a valid session cookie + conditionalCsrf in app.ts):
 *   GET  /api/oauth/portal/apps/:appId/subscriptions  — list webhook subscriptions for an app
 *   GET  /api/oauth/portal/apps/:appId/deliveries      — delivery log for an app (last 50)
 *   GET  /api/oauth/portal/apps/:appId/audit           — API call audit log for an app (last 50)
 *   POST /api/oauth/portal/deliveries/:deliveryId/replay — replay a delivery
 */
import { Router, type Request, type Response } from 'express';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import { authMiddleware } from '../../middleware/auth.js';
import { getAppById } from '../oauth/store.js';
import { listSubscriptions, listDeliveries, getDelivery, getSubscription } from '../webhooks/store.js';
import { pool } from '../../db/client.js';

type RouterT = ReturnType<typeof Router>;

/** Verify the caller owns the app. Returns the app row or sends a 404. */
async function resolveOwnedApp(
  req: Request,
  res: Response,
  appId: string,
) {
  const app = await getAppById(appId);
  if (!app || app.owner_user_id !== req.userId) {
    res.status(HTTP_STATUS.NOT_FOUND).json({
      success: false,
      error: { code: ERROR_CODES.NOT_FOUND, message: 'App not found' },
    });
    return null;
  }
  return app;
}

export function createPortalRouter(): RouterT {
  const router = Router();

  // All portal routes require a valid session.
  router.use(authMiddleware);

  // GET /api/oauth/portal/apps/:appId/subscriptions
  router.get('/apps/:appId/subscriptions', async (req: Request, res: Response): Promise<void> => {
    const app = await resolveOwnedApp(req, res, String(req.params.appId));
    if (!app) return;

    const subs = await listSubscriptions(app.id, app.workspace_id);
    res.json({ success: true, data: subs });
  });

  // GET /api/oauth/portal/apps/:appId/deliveries?limit=50
  router.get('/apps/:appId/deliveries', async (req: Request, res: Response): Promise<void> => {
    const app = await resolveOwnedApp(req, res, String(req.params.appId));
    if (!app) return;

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const deliveries = await listDeliveries(app.id, app.workspace_id, limit);
    res.json({ success: true, data: deliveries });
  });

  // GET /api/oauth/portal/apps/:appId/audit?limit=50
  // Returns API-call audit rows for an owned app, newest first.
  router.get('/apps/:appId/audit', async (req: Request, res: Response): Promise<void> => {
    const app = await resolveOwnedApp(req, res, String(req.params.appId));
    if (!app) return;

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const result = await pool.query(
      `SELECT id, workspace_id, actor_user_id, action, resource_type, details, ip_address, user_agent, created_at
       FROM audit_logs
       WHERE action = 'api.v1.call'
         AND details->>'app_id' = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [app.id, limit],
    );
    res.json({ success: true, data: result.rows });
  });

  // POST /api/oauth/portal/deliveries/:deliveryId/replay
  router.post('/deliveries/:deliveryId/replay', async (req: Request, res: Response): Promise<void> => {
    // Fetch the delivery then verify the caller owns the app it belongs to.
    const delivery = await getDelivery(String(req.params.deliveryId));
    if (!delivery) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: 'Delivery not found' },
      });
      return;
    }

    const sub = await getSubscription(delivery.subscription_id);
    if (!sub) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: 'Subscription not found' },
      });
      return;
    }

    const app = await getAppById(sub.app_id);
    if (!app || app.owner_user_id !== req.userId) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: 'App not found' },
      });
      return;
    }

    // Use the shared bus singleton so replays go through the live deliverer pipeline.
    const fresh = await getPortalEventBus().replay(delivery.id);
    if (!fresh) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: { code: 'REPLAY_FAILED', message: 'Replay failed — delivery or event no longer available' },
      });
      return;
    }

    res.json({ success: true, data: fresh });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Lazy singleton event-bus for the portal replay path.
//
// The portal is platform glue so it is allowed to own an event-bus instance.
// We keep a dedicated instance here rather than calling buildPlatform() again,
// which would create an orphan. The deliverer below handles actual HTTP
// transport for replayed events.
// ---------------------------------------------------------------------------
import { InMemoryEventBus } from '../webhooks/event-bus.js';
import { QueueWebhookDeliverer, fetchTransport } from '../webhooks/deliverer.js';
import { systemClock } from '../webhooks/clock.js';

let _portalBus: InMemoryEventBus | null = null;

export function getPortalEventBus(): InMemoryEventBus {
  if (!_portalBus) {
    const isTest = process.env.NODE_ENV === 'test' || process.env.E2E_TEST === '1';
    const deliverer = new QueueWebhookDeliverer({
      clock: systemClock,
      transport: fetchTransport(),
      jitter: isTest ? () => 0 : () => Math.floor(Math.random() * 1000),
    });
    _portalBus = new InMemoryEventBus({ deliverer, clock: systemClock });
  }
  return _portalBus;
}
