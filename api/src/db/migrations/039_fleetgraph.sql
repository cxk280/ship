-- FleetGraph: project-intelligence agent state.
-- Two tables beyond the LangGraph PostgresSaver checkpointer (which creates its own tables via setup()):
--   fleetgraph_findings        — dedup + lifecycle of surfaced findings (the cross-run memory)
--   fleetgraph_pending_approvals — inbox projection of interrupted (awaiting-approval) graph runs

CREATE TABLE IF NOT EXISTS fleetgraph_findings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dedup_key     TEXT NOT NULL,            -- stable per (finding_type, entity) e.g. "stale_in_progress:<uuid>"
  finding_type  TEXT NOT NULL,
  entity_id     UUID,                      -- the document the finding is about (nullable for workspace-level)
  entity_type   TEXT,
  severity      TEXT NOT NULL DEFAULT 'info',   -- info | low | medium | high
  status        TEXT NOT NULL DEFAULT 'open',   -- open | acted | dismissed | snoozed
  title         TEXT,
  detail        TEXT,
  proposed_action JSONB,
  recipients    UUID[] NOT NULL DEFAULT '{}',
  snooze_until  TIMESTAMPTZ,
  content_hash  TEXT,                      -- hash of the evidence; re-surface only on material change
  run_id        TEXT,                      -- last graph thread that touched this finding
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_fleetgraph_findings_ws_status
  ON fleetgraph_findings (workspace_id, status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_fleetgraph_findings_entity
  ON fleetgraph_findings (entity_id);

CREATE TABLE IF NOT EXISTS fleetgraph_pending_approvals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id     TEXT NOT NULL UNIQUE,      -- = LangGraph checkpointer thread_id (the run that is paused)
  finding_id    UUID REFERENCES fleetgraph_findings(id) ON DELETE SET NULL,
  entity_id     UUID,
  entity_type   TEXT,
  summary       TEXT,
  proposed_action JSONB,
  recipient_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | dismissed | snoozed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fleetgraph_pending_ws_status
  ON fleetgraph_pending_approvals (workspace_id, status, created_at DESC);
