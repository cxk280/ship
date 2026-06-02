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
 *   GET  /api/oauth/portal/apps/:appId/signing-keys    — Ed25519 public key(s) for an app (active + retiring)
 *   GET  /api/oauth/portal/apps/:appId/usage/stats     — aggregate usage analytics over a window
 *   POST /api/oauth/portal/deliveries/:deliveryId/replay — replay a delivery
 *   POST /api/oauth/portal/apps/:appId/subscriptions/:subId/test — send a synthetic test event
 */
import { Router, type Request, type Response } from 'express';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import { authMiddleware } from '../../middleware/auth.js';
import { getAppById } from '../oauth/store.js';
import { listSubscriptions, listDeliveries, getDelivery, getSubscription } from '../webhooks/store.js';
import { getPublicKeys } from '../webhooks/signing-keys.js';
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

/**
 * Map a `window` query param to a Postgres interval string.
 * Only a fixed allowlist is accepted (the value is interpolated into the
 * query as a literal interval, so it must never come from raw user input).
 * Defaults to 24h. Returns both the interval and a normalized label.
 */
type UsageWindow = { interval: string; label: string };

const DEFAULT_WINDOW: UsageWindow = { interval: '24 hours', label: '24h' };

const USAGE_WINDOWS: Record<string, UsageWindow> = {
  '1h': { interval: '1 hour', label: '1h' },
  '24h': DEFAULT_WINDOW,
  '7d': { interval: '7 days', label: '7d' },
  '30d': { interval: '30 days', label: '30d' },
};

function resolveUsageWindow(raw: unknown): UsageWindow {
  const key = typeof raw === 'string' ? raw : '';
  return USAGE_WINDOWS[key] ?? DEFAULT_WINDOW;
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

  // GET /api/oauth/portal/apps/:appId/signing-keys
  // Returns active + retiring Ed25519 PUBLIC keys for the app (never private keys).
  router.get('/apps/:appId/signing-keys', async (req: Request, res: Response): Promise<void> => {
    const app = await resolveOwnedApp(req, res, String(req.params.appId));
    if (!app) return;

    const keys = await getPublicKeys(app.id);
    res.json({ success: true, data: keys });
  });

  // GET /api/oauth/portal/apps/:appId/usage/stats?window=24h
  // Aggregate analytics over api.v1.call audit rows for an owned app:
  //   - total calls, error rate (status >= 400)
  //   - p50 / p95 latency (ms), from rows that recorded latency_ms
  //   - top routes by call count (with per-route count + error rate)
  // Rows that predate latency/status capture simply contribute null and are
  // skipped by the percentile aggregate; counts still work via COALESCE.
  router.get('/apps/:appId/usage/stats', async (req: Request, res: Response): Promise<void> => {
    const app = await resolveOwnedApp(req, res, String(req.params.appId));
    if (!app) return;

    const win = resolveUsageWindow(req.query.window);

    // Cap the row scan so a noisy app can't run an unbounded aggregate.
    const SCAN_CAP = 100_000;

    // Pull the windowed rows once (capped), then aggregate in two passes.
    // Using a CTE keeps it a single round-trip and lets both the summary and
    // the top-routes breakdown read the same bounded row set.
    const sql = `
      WITH calls AS (
        SELECT
          details->>'route'   AS route,
          (details->>'status')::int      AS status,
          (details->>'latency_ms')::numeric AS latency_ms
        FROM audit_logs
        WHERE action = 'api.v1.call'
          AND details->>'app_id' = $1
          AND created_at >= now() - ($2)::interval
        ORDER BY created_at DESC
        LIMIT ${SCAN_CAP}
      ),
      summary AS (
        SELECT
          count(*)                                              AS total_calls,
          count(*) FILTER (WHERE status >= 400)                 AS error_calls,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
        FROM calls
      ),
      routes AS (
        SELECT
          COALESCE(route, '(unknown)')          AS route,
          count(*)                              AS calls,
          count(*) FILTER (WHERE status >= 400) AS errors
        FROM calls
        GROUP BY COALESCE(route, '(unknown)')
        ORDER BY calls DESC, route ASC
        LIMIT 10
      )
      SELECT
        (SELECT total_calls FROM summary) AS total_calls,
        (SELECT error_calls FROM summary) AS error_calls,
        (SELECT p50 FROM summary)         AS p50,
        (SELECT p95 FROM summary)         AS p95,
        COALESCE(
          (SELECT json_agg(json_build_object(
             'route', route, 'calls', calls, 'errors', errors
           )) FROM routes),
          '[]'::json
        ) AS top_routes
    `;

    const result = await pool.query(sql, [app.id, win.interval]);
    const row = result.rows[0] ?? {};

    const totalCalls = Number(row.total_calls ?? 0);
    const errorCalls = Number(row.error_calls ?? 0);
    const errorRate = totalCalls > 0 ? errorCalls / totalCalls : 0;

    type RawRoute = { route: string; calls: number | string; errors: number | string };
    const topRoutes = (row.top_routes as RawRoute[] | null ?? []).map((r) => {
      const calls = Number(r.calls);
      const errors = Number(r.errors);
      return {
        route: r.route,
        calls,
        errors,
        error_rate: calls > 0 ? errors / calls : 0,
      };
    });

    res.json({
      success: true,
      data: {
        window: win.label,
        total_calls: totalCalls,
        error_calls: errorCalls,
        error_rate: errorRate,
        // Round latency to whole ms; null when no rows recorded latency.
        p50_ms: row.p50 != null ? Math.round(Number(row.p50)) : null,
        p95_ms: row.p95 != null ? Math.round(Number(row.p95)) : null,
        top_routes: topRoutes,
      },
    });
  });

  // POST /api/oauth/portal/apps/:appId/subscriptions/:subId/test
  // Sends a synthetic signed test event to the subscription's target URL and
  // returns the delivery record (so the portal can show the HTTP response).
  router.post('/apps/:appId/subscriptions/:subId/test', async (req: Request, res: Response): Promise<void> => {
    const app = await resolveOwnedApp(req, res, String(req.params.appId));
    if (!app) return;

    // Verify the subscription belongs to this app.
    const sub = await getSubscription(String(req.params.subId));
    if (!sub || sub.app_id !== app.id) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: 'Subscription not found' },
      });
      return;
    }

    const delivery = await getPortalEventBus().sendTestEvent(sub.id);
    if (!delivery) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: { code: 'TEST_EVENT_FAILED', message: 'Failed to enqueue test event' },
      });
      return;
    }

    res.json({ success: true, data: delivery });
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
import { getOrCreateActiveKey } from '../webhooks/signing-keys.js';

let _portalBus: InMemoryEventBus | null = null;

export function getPortalEventBus(): InMemoryEventBus {
  if (!_portalBus) {
    const isTest = process.env.NODE_ENV === 'test' || process.env.E2E_TEST === '1';
    const deliverer = new QueueWebhookDeliverer({
      clock: systemClock,
      transport: fetchTransport(),
      jitter: isTest ? () => 0 : () => Math.floor(Math.random() * 1000),
    });
    _portalBus = new InMemoryEventBus({
      deliverer,
      clock: systemClock,
      ed25519KeyResolver: async (appId) => {
        try {
          const key = await getOrCreateActiveKey(appId);
          return key.private_key;
        } catch {
          return undefined;
        }
      },
    });
  }
  return _portalBus;
}

/**
 * Override the portal event bus — used by tests to inject a bus backed by a
 * deterministic fake transport (no real HTTP).  Should be called in
 * beforeAll before any route is exercised.
 */
export function setPortalEventBusForTest(bus: InMemoryEventBus): void {
  _portalBus = bus;
}
