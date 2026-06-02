-- Plugforge Epic 7 — first-party OAuth app for the FleetGraph agent.
--
-- The agent ("ship_app_agent") authenticates via client_credentials (RFC 6749 §4.4)
-- and consumes /api/v1 behind the PLUGFORGE_AGENT_VIA_SDK feature flag.
-- Seeded here so the app is guaranteed in every env (local dev, CI, prod).
-- Idempotent: guarded by ON CONFLICT DO NOTHING.
--
--   client_id:     ship_app_agent
--   client_secret: ship_secret_agent_readonly          (bcrypt hash stored below)
--   scopes:        documents:read, issues:read, sprints:read
--   grant:         client_credentials (M2M, no user, no refresh token)
--
-- NOTE: workspace_id is intentionally NULL here. The agent resolves its workspace
-- at runtime via AGENT_WORKSPACE_ID env var (see fetch-sdk.ts). In production,
-- set the agent app's workspace_id to the target workspace after seeding, or rely
-- on the env var. This is noted as a known limitation in the Epic 7 PR.

INSERT INTO oauth_apps (
  client_id, client_secret_hash, name, description,
  redirect_uris, requested_scopes, app_type, owner_user_id, workspace_id
)
VALUES (
  'ship_app_agent',
  '$2b$12$ydx67Vgc9Gb.TTXgnk9GaOac25hDD6BIuImTnoiGrZfjSw0fJK1bu',
  'FleetGraph Agent (first-party)',
  'First-party M2M app — the FleetGraph agent reads Ship data via client_credentials. Secret: ship_secret_agent_readonly',
  ARRAY[]::text[],
  ARRAY['documents:read', 'issues:read', 'sprints:read'],
  'confidential',
  NULL,
  NULL
)
ON CONFLICT (client_id) DO NOTHING;
