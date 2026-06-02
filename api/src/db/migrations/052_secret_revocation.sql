-- Plugforge — leaked-secret detection + automatic revocation (B13).
--
-- When a client secret leaks (e.g. pushed to a public GitHub repo) GitHub's
-- secret-scanning partner program POSTs us the leaked token. We auto-revoke the
-- secret and cascade-revoke the app's live tokens. These columns record that an
-- app's secret was administratively/automatically killed and WHY, so the owner
-- can see it in the portal and must rotate (or re-issue) before the app works
-- again.
--
-- Additive + NULLABLE: existing rows leave both columns NULL and behave exactly
-- as before. A non-NULL secret_revoked_at means the secret is dead even though
-- the app row may still be is_active = TRUE (the app is not deleted — its secret
-- is simply invalid until rotated).

ALTER TABLE oauth_apps
  ADD COLUMN IF NOT EXISTS secret_revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS secret_revoked_reason TEXT;

COMMENT ON COLUMN oauth_apps.secret_revoked_at IS
  'Non-NULL when the client secret was auto/administratively revoked (e.g. leaked-secret detection). Client authentication fails until the secret is rotated.';
COMMENT ON COLUMN oauth_apps.secret_revoked_reason IS
  'Human-readable reason for secret_revoked_at, e.g. "leaked_secret:github_secret_scanning".';
