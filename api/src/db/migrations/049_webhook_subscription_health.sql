-- Webhook subscription health tracking (auto-disable failing endpoints).
-- Tracks consecutive delivery failures so the deliverer can auto-disable a
-- subscription after a configurable threshold.

ALTER TABLE webhook_subscriptions
  ADD COLUMN IF NOT EXISTS consecutive_failures INT NOT NULL DEFAULT 0;

ALTER TABLE webhook_subscriptions
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

ALTER TABLE webhook_subscriptions
  ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ;
