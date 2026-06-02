-- Idempotency keys table for public API writes.
--
-- Rows are keyed by (app_id, idempotency_key).  The `status` column starts as
-- 'in_progress' and transitions to 'completed' when the response is captured.
-- The `fingerprint` column is a SHA-256 of (method + url + stable-JSON body)
-- so we can detect key-reuse with a different request payload.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  app_id            uuid        NOT NULL,
  idempotency_key   text        NOT NULL,
  fingerprint       text        NOT NULL,
  status            text        NOT NULL DEFAULT 'in_progress',
  response_status   int,
  response_body     jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, idempotency_key)
);

-- Support TTL range scans on stale in-progress / old completed rows.
CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx
  ON idempotency_keys (created_at);
