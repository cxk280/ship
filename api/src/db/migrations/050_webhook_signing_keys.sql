-- Migration 049: per-app Ed25519 keypairs for asymmetric webhook signing.
-- A new `webhook_signing_keys` table stores one or more keypairs per app;
-- `status` can be 'active' (used for signing + verification) or 'retiring'
-- (used for verification only, during the rotation overlap window).
-- Deliveries are always signed with the single 'active' key; both active and
-- retiring keys are valid for verification so subscribers that cached the old
-- public key keep working until the retiring key is deleted.

CREATE TABLE IF NOT EXISTS webhook_signing_keys (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid        NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  public_key  text        NOT NULL,
  private_key text        NOT NULL,
  status      text        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'retiring')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_signing_keys_app_id_idx
  ON webhook_signing_keys (app_id);
