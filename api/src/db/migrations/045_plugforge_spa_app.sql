-- Plugforge — public OAuth app for the browser SPA (Authorization Code + PKCE).
--
-- A PUBLIC client uses Auth Code + PKCE; no client_secret is needed during the
-- code exchange (public client). We store a placeholder hash so the NOT NULL
-- constraint is satisfied. redirect_uris includes localhost dev ports used by
-- the integrations/browser-spa Vite dev server.
-- Idempotent. The SPA defaults SHIP_CLIENT_ID to this client_id.

INSERT INTO oauth_apps (
  client_id, client_secret_hash, name, description,
  redirect_uris, requested_scopes, app_type, owner_user_id, workspace_id
)
VALUES (
  'ship_app_spa',
  '$2b$12$hAo4lb8wo.LKzsWoqqEtGuaeru05Om0xdZjDcupaKpi4Ygy8G8/zG', -- placeholder; public client uses no secret
  'Ship Browser SPA',
  'First-party browser SPA demo (Authorization Code + PKCE). Public client — no secret.',
  ARRAY['http://localhost:5180/callback', 'http://localhost:5181/callback', 'http://localhost:5182/callback'],
  ARRAY['documents:read'],
  'public',
  NULL,
  NULL
)
ON CONFLICT (client_id) DO NOTHING;
