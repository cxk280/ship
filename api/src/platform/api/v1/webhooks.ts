/**
 * /api/v1/webhooks — manage subscriptions, browse the delivery log, replay from
 * the DLQ. All gated by the webhooks:manage scope.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ApiError } from '../../errors.js';
import { requireScope } from '../../scopes/require-scope.js';
import { SCOPES } from '../../scopes/registry.js';
import { publicRoutes } from './route-meta.js';
import { CreateSubscriptionSchema, SubscriptionIdParamSchema, DeliveryIdParamSchema } from './schemas.js';
import type { PlatformDeps } from './router.js';

function requireApp(req: Request): string {
  const appId = req.platformAuth?.appId;
  if (!appId) throw ApiError.forbidden('This token has no app context');
  return appId;
}

publicRoutes.register({ method: 'post', path: '/webhooks', scope: SCOPES.WEBHOOKS_MANAGE, paginated: false, summary: 'Create a webhook subscription' });
publicRoutes.register({ method: 'get', path: '/webhooks', scope: SCOPES.WEBHOOKS_MANAGE, paginated: false, summary: 'List webhook subscriptions' });
publicRoutes.register({ method: 'delete', path: '/webhooks/{id}', scope: SCOPES.WEBHOOKS_MANAGE, paginated: false, summary: 'Delete a webhook subscription' });
publicRoutes.register({ method: 'get', path: '/webhooks/deliveries', scope: SCOPES.WEBHOOKS_MANAGE, paginated: false, summary: 'List webhook deliveries' });
publicRoutes.register({ method: 'post', path: '/webhooks/deliveries/{id}/replay', scope: SCOPES.WEBHOOKS_MANAGE, paginated: false, summary: 'Replay a webhook delivery' });

export function createWebhooksRouter(deps: PlatformDeps): Router {
  const router = Router();
  const scope = requireScope(SCOPES.WEBHOOKS_MANAGE);

  // POST /webhooks — create a subscription; signing_secret shown once.
  router.post('/', scope, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = CreateSubscriptionSchema.parse(req.body);
      if (!deps.webhooks.eventTypes().includes(body.event_type)) {
        throw ApiError.validation(`Unknown event_type: ${body.event_type}`, {
          allowed: deps.webhooks.eventTypes(),
        });
      }
      const { subscription, signing_secret } = await deps.webhooks.createSubscription({
        appId: requireApp(req),
        eventType: body.event_type,
        targetUrl: body.target_url,
      });
      res.status(201).json({
        ...subscription,
        signing_secret, // returned ONCE — store it to verify deliveries
        warning: 'Save this signing_secret now. It will not be shown again.',
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /webhooks — list (no secrets).
  router.get('/', scope, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await deps.webhooks.listSubscriptions(requireApp(req)) });
    } catch (err) {
      next(err);
    }
  });

  // GET /webhooks/deliveries — the delivery log (mounted before /:id so it isn't shadowed).
  router.get('/deliveries', scope, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ data: await deps.webhooks.listDeliveries(requireApp(req)) });
    } catch (err) {
      next(err);
    }
  });

  // POST /webhooks/deliveries/:id/replay
  router.post('/deliveries/:id/replay', scope, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = DeliveryIdParamSchema.parse(req.params);
      const ok = await deps.webhooks.replay({ appId: requireApp(req), deliveryId: id });
      if (!ok) throw ApiError.notFound('Delivery not found');
      res.status(202).json({ status: 'replaying', delivery_id: id });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /webhooks/:id
  router.delete('/:id', scope, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = SubscriptionIdParamSchema.parse(req.params);
      const ok = await deps.webhooks.deactivateSubscription({ appId: requireApp(req), id });
      if (!ok) throw ApiError.notFound('Subscription not found');
      res.json({ status: 'deleted' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
