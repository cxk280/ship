-- Migration 047: partial index for the public-API-call audit query.
--
-- The developer portal queries audit_logs filtered by action='api.v1.call' and
-- details->>'app_id', ordered by created_at DESC. Without an index this scan is
-- O(total audit rows); the partial index keeps it O(api.v1.call rows for app).
--
-- Idempotent: IF NOT EXISTS ensures re-running is safe.

CREATE INDEX IF NOT EXISTS idx_audit_api_v1_app
  ON audit_logs ((details->>'app_id'), created_at DESC)
  WHERE action = 'api.v1.call';
