-- Migration 038: ShipShape Performance Indexes
--
-- Indexes for the Phase 1 audit hot paths:
-- - Document/sidebar lists filtered by workspace, type, parent, and active state.
-- - Accountability grids filtered by sprint_number ranges.
-- - Weekly plan/retro and standup accountability lookups.

CREATE INDEX IF NOT EXISTS idx_documents_active_list_order
ON documents(workspace_id, document_type, parent_id, position ASC, created_at DESC)
WHERE archived_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_sprint_number_active
ON documents(workspace_id, ((properties->>'sprint_number')::int))
WHERE document_type = 'sprint'
  AND archived_at IS NULL
  AND deleted_at IS NULL
  AND properties ? 'sprint_number';

CREATE INDEX IF NOT EXISTS idx_documents_weekly_person_week_active
ON documents(workspace_id, document_type, (properties->>'person_id'), ((properties->>'week_number')::int))
WHERE document_type IN ('weekly_plan', 'weekly_retro')
  AND archived_at IS NULL
  AND deleted_at IS NULL
  AND properties ? 'person_id'
  AND properties ? 'week_number';

CREATE INDEX IF NOT EXISTS idx_documents_standup_author_parent_created
ON documents(workspace_id, (properties->>'author_id'), parent_id, created_at DESC)
WHERE document_type = 'standup'
  AND deleted_at IS NULL
  AND properties ? 'author_id';
