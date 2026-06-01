-- Plugforge — scope webhook subscriptions to the workspace of the token that
-- created them. Matching on the owning app's workspace was wrong for multi-
-- workspace public apps (e.g. the CLI, whose app workspace_id is NULL): a
-- subscription created with a token in workspace W must receive W's events.

ALTER TABLE webhook_subscriptions
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

-- Backfill existing rows from the owning app's workspace (best effort).
UPDATE webhook_subscriptions s
  SET workspace_id = a.workspace_id
  FROM oauth_apps a
  WHERE s.app_id = a.id AND s.workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_subs_workspace_event
  ON webhook_subscriptions(workspace_id, event_type) WHERE active;
