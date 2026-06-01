-- Plugforge — pre-registered READ-ONLY OAuth app for graders (MVP requirement:
-- "at least one OAuth app pre-registered with read-only scopes for graders").
--
-- Seeded via migration so it is GUARANTEED to exist in every deployed
-- environment. Idempotent (guarded by WHERE NOT EXISTS / ON CONFLICT) so re-runs
-- are safe. Credentials are published in the README — this is a read-only sandbox.
--
--   client_id:     ship_app_grader
--   client_secret: ship_secret_grader_readonly_demo   (bcrypt hash stored below)
--   scopes:        documents:read, issues:read, sprints:read
--   grant:         client_credentials (M2M) — graders get a token in one call:
--     curl -X POST $BASE/oauth/token -d grant_type=client_credentials \
--          -d client_id=ship_app_grader -d client_secret=ship_secret_grader_readonly_demo

-- 1) Grader sandbox workspace.
INSERT INTO workspaces (name)
SELECT 'Plugforge Grader Sandbox'
WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE name = 'Plugforge Grader Sandbox');

-- 2) Grader user (owns the app).
INSERT INTO users (email, name, is_super_admin)
SELECT 'grader@plugforge.dev', 'Plugforge Grader', FALSE
ON CONFLICT (email) DO NOTHING;

-- 3) Membership.
INSERT INTO workspace_memberships (workspace_id, user_id, role)
SELECT w.id, u.id, 'member'
FROM workspaces w, users u
WHERE w.name = 'Plugforge Grader Sandbox' AND u.email = 'grader@plugforge.dev'
  AND NOT EXISTS (
    SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = w.id AND m.user_id = u.id
  );

-- 4) A couple of sample documents so GET /api/v1/documents returns data.
INSERT INTO documents (workspace_id, document_type, title, created_by)
SELECT w.id, 'wiki', 'Welcome to the Plugforge Grader Sandbox', u.id
FROM workspaces w, users u
WHERE w.name = 'Plugforge Grader Sandbox' AND u.email = 'grader@plugforge.dev'
  AND NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.workspace_id = w.id AND d.title = 'Welcome to the Plugforge Grader Sandbox'
  );

INSERT INTO documents (workspace_id, document_type, title, created_by)
SELECT w.id, 'issue', 'Sample issue for the public API', u.id
FROM workspaces w, users u
WHERE w.name = 'Plugforge Grader Sandbox' AND u.email = 'grader@plugforge.dev'
  AND NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.workspace_id = w.id AND d.title = 'Sample issue for the public API'
  );

-- 5) The read-only OAuth app (confidential client → client_credentials grant).
INSERT INTO oauth_apps (
  client_id, client_secret_hash, name, description,
  redirect_uris, requested_scopes, app_type, owner_user_id, workspace_id
)
SELECT
  'ship_app_grader',
  '$2b$12$de1XH.2evqjKA9/cwWVM4uqnc8f12BrDD6S4lVoFidL6F2A34qwwC',
  'Plugforge Grader (read-only)',
  'Pre-registered read-only app for graders. Credentials in README.',
  ARRAY[]::text[],
  ARRAY['documents:read', 'issues:read', 'sprints:read'],
  'confidential',
  u.id,
  w.id
FROM workspaces w, users u
WHERE w.name = 'Plugforge Grader Sandbox' AND u.email = 'grader@plugforge.dev'
ON CONFLICT (client_id) DO NOTHING;
