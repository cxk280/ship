-- Plugforge — public OAuth app for the CLI (`ship login` device flow).
--
-- A PUBLIC client (app_type='public') uses the Device Authorization Grant and
-- needs no secret; the token's workspace comes from the user who approves the
-- device. client_secret_hash is NOT NULL, so we store a never-used placeholder.
-- Idempotent. The CLI defaults SHIP_CLIENT_ID to this client_id.

INSERT INTO oauth_apps (
  client_id, client_secret_hash, name, description,
  redirect_uris, requested_scopes, app_type, owner_user_id, workspace_id
)
VALUES (
  'ship_app_cli',
  '$2b$12$hAo4lb8wo.LKzsWoqqEtGuaeru05Om0xdZjDcupaKpi4Ygy8G8/zG', -- placeholder; public client uses no secret
  'Ship CLI',
  'First-party CLI (device flow). Public client — no secret.',
  ARRAY[]::text[],
  ARRAY['documents:read', 'documents:write', 'webhooks:manage'],
  'public',
  NULL,
  NULL
)
ON CONFLICT (client_id) DO NOTHING;
