-- Plugforge — webhooks: subscriptions, the event log, and the delivery log.
--
-- An event is recorded once; it fans out to one delivery row per matching
-- subscription. Deliveries record EVERY attempt's outcome (queryable per app),
-- and a delivery that exhausts its retries is dead-lettered (status='dead').

-- Per-app, per-event-type subscriptions. The signing_secret is a SHARED HMAC
-- secret (the platform signs with it, the subscriber verifies with it), shown to
-- the subscriber exactly once on creation — so it is stored, not hashed.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,                 -- must be a registered event type
  target_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,             -- whsec_<hex>; shared symmetric secret
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_app ON webhook_subscriptions(app_id);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_event ON webhook_subscriptions(event_type) WHERE active;

-- The event log — one row per domain event, regardless of fan-out. Carries the
-- idempotency key that travels with every delivery (and survives replay).
CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON webhook_events(event_type);

-- The delivery log — one row per (event × subscription) attempt-chain. status:
-- pending → delivered | dead. attempt_number counts tries; response_* + latency
-- record the last attempt. idempotency_key is replayed verbatim on manual replay.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'dead')),
  response_status INTEGER,
  response_excerpt TEXT,
  latency_ms INTEGER,
  idempotency_key TEXT NOT NULL,
  next_attempt_at TIMESTAMPTZ,              -- when the next retry is due (NULL when terminal)
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub ON webhook_deliveries(subscription_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);

COMMENT ON TABLE webhook_subscriptions IS 'Per-app per-event webhook subscriptions; signing_secret is a shared HMAC secret shown once.';
COMMENT ON TABLE webhook_deliveries IS 'Every webhook delivery attempt-chain; status=dead is the DLQ, replayable from the portal.';
