// Read-only fetch functions against real Ship data. These back the parallel fetch nodes.
import { pool } from '../db/client.js';
import type { IssueRow, Scope } from './types.js';

/**
 * Feature flag: PLUGFORGE_AGENT_VIA_SDK
 *
 * When truthy (non-empty, non-"0", non-"false") the agent's issue fetch is
 * routed through the @ship/sdk + /api/v1 (client_credentials) path instead
 * of the direct DB query. Both paths produce the same IssueRow shape; the
 * graph nodes and LLM prompts are unchanged (token-neutral).
 *
 * Default OFF — existing behaviour and tests are unaffected when the var is
 * absent or falsy.
 */
export function isAgentViaSdkEnabled(): boolean {
  const v = process.env.PLUGFORGE_AGENT_VIA_SDK;
  return !!v && v !== '0' && v.toLowerCase() !== 'false';
}

/**
 * Fetch issues in scope as normalized rows (incl. last-activity for staleness).
 * Mutation scope → the specific entityIds. Cron scope → open work in the workspace.
 */
export async function fetchIssues(workspaceId: string, scope: Scope): Promise<IssueRow[]> {
  const params: unknown[] = [workspaceId];
  let scopeClause = `AND i.properties->>'state' NOT IN ('done', 'cancelled')`;
  if (scope.entityIds && scope.entityIds.length > 0) {
    params.push(scope.entityIds);
    scopeClause = `AND i.id = ANY($2::uuid[])`;
  } else if (scope.sprintId) {
    params.push(scope.sprintId);
    scopeClause += ` AND EXISTS (SELECT 1 FROM document_associations da
        WHERE da.document_id = i.id AND da.relationship_type = 'sprint' AND da.related_id = $2)`;
  } else if (scope.projectId) {
    params.push(scope.projectId);
    scopeClause += ` AND EXISTS (SELECT 1 FROM document_associations da
        WHERE da.document_id = i.id AND da.relationship_type = 'project' AND da.related_id = $2)`;
  } else if (scope.programId) {
    params.push(scope.programId);
    scopeClause += ` AND EXISTS (SELECT 1 FROM document_associations da
        WHERE da.document_id = i.id AND da.relationship_type = 'program' AND da.related_id = $2)`;
  } else if (scope.assigneeId) {
    params.push(scope.assigneeId);
    scopeClause += ` AND (i.properties->>'assignee_id')::uuid = $2`;
  }

  const result = await pool.query(
    `SELECT
        i.id, i.title, i.ticket_number, i.properties, i.started_at, i.updated_at,
        u.name AS assignee_name,
        GREATEST(i.updated_at, COALESCE(h.last_history, i.updated_at)) AS last_activity_at,
        sa.sprint_id, s.properties->>'sprint_number' AS sprint_number,
        pa.project_id
     FROM documents i
     LEFT JOIN LATERAL (SELECT MAX(created_at) AS last_history FROM document_history WHERE document_id = i.id) h ON true
     LEFT JOIN LATERAL (SELECT related_id AS sprint_id FROM document_associations
        WHERE document_id = i.id AND relationship_type = 'sprint' LIMIT 1) sa ON true
     LEFT JOIN documents s ON s.id = sa.sprint_id
     LEFT JOIN LATERAL (SELECT related_id AS project_id FROM document_associations
        WHERE document_id = i.id AND relationship_type = 'project' LIMIT 1) pa ON true
     LEFT JOIN users u ON u.id = (i.properties->>'assignee_id')::uuid
     WHERE i.workspace_id = $1
       AND i.document_type = 'issue'
       AND i.deleted_at IS NULL
       AND i.archived_at IS NULL
       ${scopeClause}
     ORDER BY i.updated_at DESC
     LIMIT 500`,
    params,
  );

  return result.rows.map((r): IssueRow => {
    const p = r.properties || {};
    return {
      id: r.id,
      title: r.title || 'Untitled',
      ticketNumber: r.ticket_number ?? null,
      state: p.state || 'triage',
      priority: p.priority || 'none',
      assigneeId: p.assignee_id || null,
      assigneeName: r.assignee_name || null,
      estimate: typeof p.estimate === 'number' ? p.estimate : null,
      dueDate: p.due_date || null,
      source: p.source || null,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null,
      sprintId: r.sprint_id || null,
      sprintNumber: r.sprint_number ? parseInt(r.sprint_number, 10) : null,
      projectId: r.project_id || null,
    };
  });
}

export interface PersonRow {
  personId: string;
  userId: string | null;
  name: string;
  role: string | null;
  capacityHours: number | null;
  reportsTo: string | null;
}

export async function fetchTeam(workspaceId: string): Promise<PersonRow[]> {
  const result = await pool.query(
    `SELECT id, title, properties FROM documents
     WHERE workspace_id = $1 AND document_type = 'person'
       AND deleted_at IS NULL AND archived_at IS NULL
     LIMIT 200`,
    [workspaceId],
  );
  return result.rows.map((r) => {
    const p = r.properties || {};
    return {
      personId: r.id,
      userId: p.user_id || null,
      name: r.title || p.email || 'Unknown',
      role: p.role || null,
      capacityHours: typeof p.capacity_hours === 'number' ? p.capacity_hours : null,
      reportsTo: p.reports_to || null,
    };
  });
}

/** Resolve a person document's linked user id (issues are assigned by user id, not person-doc id).
 *  Scoped to the workspace so a chat scope can't reference a person doc in another tenant. */
export async function fetchPersonUserId(workspaceId: string, personDocId: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT properties->>'user_id' AS user_id FROM documents
     WHERE id = $1 AND workspace_id = $2 AND document_type = 'person'`,
    [personDocId, workspaceId],
  );
  return r.rows[0]?.user_id || null;
}

export interface DocumentCensus {
  total: number;
  byType: Record<string, number>;
}

/** Workspace-wide document counts (total + per type) — lets the chat answer landscape questions
 *  like "how many documents are there?" that the issue-only fetch can't. */
export async function fetchDocumentCensus(workspaceId: string): Promise<DocumentCensus> {
  const r = await pool.query(
    `SELECT document_type, COUNT(*)::int AS n FROM documents
     WHERE workspace_id = $1 AND deleted_at IS NULL AND archived_at IS NULL
     GROUP BY document_type`,
    [workspaceId],
  );
  const byType: Record<string, number> = {};
  let total = 0;
  for (const row of r.rows) {
    byType[row.document_type] = row.n;
    total += row.n;
  }
  return { total, byType };
}

export interface DocIndexEntry {
  id: string;
  type: string;
  title: string;
}

/** A lightweight title+type directory of the workspace's documents (capped, most-recent first) —
 *  lets the chat list/name documents of any type and answer "is there a doc about X?". */
export async function fetchDocumentIndex(workspaceId: string, limit = 200): Promise<DocIndexEntry[]> {
  const r = await pool.query(
    `SELECT id, document_type, title FROM documents
     WHERE workspace_id = $1 AND deleted_at IS NULL AND archived_at IS NULL
     ORDER BY updated_at DESC NULLS LAST
     LIMIT $2`,
    [workspaceId, limit],
  );
  return r.rows.map((x) => ({ id: x.id, type: x.document_type, title: x.title || 'Untitled' }));
}

export interface WeekRow {
  id: string;
  title: string;
  sprintNumber: number | null;
  status: string | null;
  ownerId: string | null;
  confidence: number | null;
}

export async function fetchWeeks(workspaceId: string): Promise<WeekRow[]> {
  const result = await pool.query(
    `SELECT id, title, properties FROM documents
     WHERE workspace_id = $1 AND document_type = 'sprint'
       AND deleted_at IS NULL AND archived_at IS NULL
     ORDER BY (properties->>'sprint_number')::int DESC NULLS LAST LIMIT 50`,
    [workspaceId],
  );
  return result.rows.map((r) => {
    const p = r.properties || {};
    return {
      id: r.id,
      title: r.title || `Week ${p.sprint_number ?? '?'}`,
      sprintNumber: p.sprint_number ?? null,
      status: p.status ?? null,
      ownerId: p.owner_id ?? null,
      confidence: typeof p.confidence === 'number' ? p.confidence : null,
    };
  });
}

export interface ProjectRow {
  id: string;
  title: string;
  impact: number | null;
  confidence: number | null;
  ease: number | null;
  ownerId: string | null;
  accountableId: string | null;
}

export async function fetchProjects(workspaceId: string): Promise<ProjectRow[]> {
  const result = await pool.query(
    `SELECT id, title, properties FROM documents
     WHERE workspace_id = $1 AND document_type = 'project'
       AND deleted_at IS NULL AND archived_at IS NULL LIMIT 100`,
    [workspaceId],
  );
  return result.rows.map((r) => {
    const p = r.properties || {};
    return {
      id: r.id,
      title: r.title || 'Untitled',
      impact: p.impact ?? null,
      confidence: p.confidence ?? null,
      ease: p.ease ?? null,
      ownerId: p.owner_id ?? null,
      accountableId: p.accountable_id ?? null,
    };
  });
}

/** Resolve the workspace admins/owners — fallback notification recipients. */
export async function fetchWorkspaceAdmins(workspaceId: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT user_id FROM workspace_memberships WHERE workspace_id = $1 AND role = 'admin'`,
    [workspaceId],
  );
  return result.rows.map((r) => r.user_id);
}

export interface WorkspaceMeta {
  sprintStartDate: string | null; // ISO date (YYYY-MM-DD)
  sprintDuration: number; // days
}

export async function fetchWorkspaceMeta(workspaceId: string): Promise<WorkspaceMeta> {
  const r = await pool.query(`SELECT sprint_start_date FROM workspaces WHERE id = $1`, [workspaceId]);
  const raw = r.rows[0]?.sprint_start_date ?? null;
  let iso: string | null = null;
  if (raw instanceof Date) iso = raw.toISOString().slice(0, 10);
  else if (typeof raw === 'string') iso = raw.slice(0, 10);
  return { sprintStartDate: iso, sprintDuration: 7 };
}

export interface SprintProgress {
  sprintId: string;
  total: number;
  done: number;
}

/** Per-sprint issue counts (incl. done) for slip detection. */
export async function fetchSprintProgress(workspaceId: string): Promise<SprintProgress[]> {
  const r = await pool.query(
    `SELECT sa.related_id AS sprint_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE i.properties->>'state' = 'done')::int AS done
     FROM documents i
     JOIN document_associations sa ON sa.document_id = i.id AND sa.relationship_type = 'sprint'
     JOIN documents s ON s.id = sa.related_id AND s.document_type = 'sprint' AND s.workspace_id = $1
     WHERE i.document_type = 'issue' AND i.deleted_at IS NULL AND i.archived_at IS NULL
     GROUP BY sa.related_id`,
    [workspaceId],
  );
  return r.rows.map((x) => ({ sprintId: x.sprint_id, total: x.total, done: x.done }));
}

