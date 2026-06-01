-- Plugforge — OAuth 2.0 server (RFC 6749 + 7636 PKCE + 8628 Device Grant).
--
-- These tables back the public platform's authentication. They are intentionally
-- separate from api_tokens (the internal CLI tokens) so the public token model
-- can evolve independently. Raw secrets/tokens are NEVER stored — only hashes.

-- --------------------------------------------------------------------------
-- OAuth apps (clients). A confidential client holds a secret; a public client
-- (browser SPA) relies on PKCE. first_party apps (the agent) use client_creds.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT UNIQUE NOT NULL,                 -- public identifier, e.g. ship_app_<hex>
  client_secret_hash TEXT NOT NULL,               -- bcrypt hash; raw shown once on create/rotate
  name TEXT NOT NULL,
  description TEXT,
  redirect_uris TEXT[] NOT NULL DEFAULT '{}',     -- exact-match allowlist for the auth-code flow
  requested_scopes TEXT[] NOT NULL DEFAULT '{}',  -- scopes this app may request
  app_type TEXT NOT NULL DEFAULT 'confidential'
    CHECK (app_type IN ('confidential', 'public', 'first_party')),
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  secret_rotated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_apps_client_id ON oauth_apps(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_apps_owner ON oauth_apps(owner_user_id);

-- --------------------------------------------------------------------------
-- Authorization codes (short-lived, single-use). Records the PKCE challenge.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT UNIQUE NOT NULL,                 -- sha256 of the issued code
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256'
    CHECK (code_challenge_method IN ('S256', 'plain')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,                         -- single-use marker
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_hash ON oauth_authorization_codes(code_hash);

-- --------------------------------------------------------------------------
-- Access tokens (short-lived bearer tokens). user_id NULL = client_credentials.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT UNIQUE NOT NULL,                -- sha256 of the bearer token
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,   -- NULL for client_credentials
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  grant_type TEXT NOT NULL
    CHECK (grant_type IN ('authorization_code', 'refresh_token', 'client_credentials', 'device_code')),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_hash ON oauth_access_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_app ON oauth_access_tokens(app_id);

-- --------------------------------------------------------------------------
-- Refresh tokens — one-time-use with rotation. Reusing a CONSUMED token (theft
-- signal) revokes the whole family. family_id ties a rotation chain together.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT UNIQUE NOT NULL,
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  family_id UUID NOT NULL,                         -- rotation family
  replaced_by UUID REFERENCES oauth_refresh_tokens(id) ON DELETE SET NULL,
  consumed_at TIMESTAMPTZ,                          -- one-time-use marker
  revoked_at TIMESTAMPTZ,                           -- family revocation (theft response)
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_hash ON oauth_refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family ON oauth_refresh_tokens(family_id);

-- --------------------------------------------------------------------------
-- Device authorization grant (RFC 8628). user_code is shown to the human; the
-- device polls /oauth/token with device_code. last_polled_at enforces slow_down.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_device_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash TEXT UNIQUE NOT NULL,
  user_code TEXT UNIQUE NOT NULL,                  -- e.g. WDJB-MJHT
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,        -- set on approval
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied')),
  interval_sec INTEGER NOT NULL DEFAULT 5,
  last_polled_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_device_codes_user_code ON oauth_device_codes(user_code);
CREATE INDEX IF NOT EXISTS idx_oauth_device_codes_hash ON oauth_device_codes(device_code_hash);

COMMENT ON TABLE oauth_apps IS 'Plugforge OAuth clients. client_secret stored as bcrypt hash; raw shown once.';
COMMENT ON TABLE oauth_refresh_tokens IS 'One-time-use refresh tokens with rotation; reuse of a consumed token revokes the family.';
