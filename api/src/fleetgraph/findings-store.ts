// Persistence for FleetGraph findings (cross-run dedup memory) and pending HITL approvals.
import { pool } from '../db/client.js';
import type { Finding, ProposedAction } from './types.js';
import type { KnownFinding } from './state.js';

export async function loadKnownFindings(
  workspaceId: string,
  entityIds?: string[],
): Promise<KnownFinding[]> {
  const params: unknown[] = [workspaceId];
  let where = 'workspace_id = $1';
  if (entityIds && entityIds.length > 0) {
    params.push(entityIds);
    where += ` AND entity_id = ANY($2::uuid[])`;
  }
  const result = await pool.query(
    `SELECT dedup_key, status, content_hash, snooze_until
     FROM fleetgraph_findings WHERE ${where}`,
    params,
  );
  return result.rows.map((r) => ({
    dedupKey: r.dedup_key,
    status: r.status,
    contentHash: r.content_hash,
    snoozeUntil: r.snooze_until ? new Date(r.snooze_until).toISOString() : null,
  }));
}

/** How many distinct findings of each type the workspace has dismissed (for adaptive suppression). */
export async function loadDismissalCounts(workspaceId: string): Promise<Record<string, number>> {
  const r = await pool.query(
    `SELECT finding_type, COUNT(*)::int AS n FROM fleetgraph_findings
     WHERE workspace_id = $1 AND status = 'dismissed' GROUP BY finding_type`,
    [workspaceId],
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.finding_type] = row.n;
  return out;
}

/** Upsert a finding row. Opens (or re-opens) the finding and refreshes its evidence hash. */
export async function recordFinding(
  workspaceId: string,
  finding: Finding,
  runId: string,
  status: 'open' | 'acted' | 'dismissed' | 'snoozed' = 'open',
  snoozeUntil: string | null = null,
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO fleetgraph_findings
       (workspace_id, dedup_key, finding_type, entity_id, entity_type, severity, status,
        title, detail, proposed_action, recipients, content_hash, run_id, snooze_until, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid[],$12,$13,$14, now())
     ON CONFLICT (workspace_id, dedup_key) DO UPDATE SET
       severity = EXCLUDED.severity,
       status = EXCLUDED.status,
       title = EXCLUDED.title,
       detail = EXCLUDED.detail,
       proposed_action = EXCLUDED.proposed_action,
       recipients = EXCLUDED.recipients,
       content_hash = EXCLUDED.content_hash,
       run_id = EXCLUDED.run_id,
       snooze_until = EXCLUDED.snooze_until,
       last_seen_at = now()
     RETURNING id`,
    [
      workspaceId, finding.dedupKey, finding.type, finding.entityId, finding.entityType,
      finding.severity, status, finding.title, finding.detail,
      finding.proposedAction ? JSON.stringify(finding.proposedAction) : null,
      finding.recipients, finding.contentHash, runId, snoozeUntil,
    ],
  );
  return result.rows[0].id;
}

export async function setFindingStatusByDedup(
  workspaceId: string,
  dedupKey: string,
  status: string,
  snoozeUntil: string | null = null,
): Promise<void> {
  await pool.query(
    `UPDATE fleetgraph_findings SET status = $3, snooze_until = $4, last_seen_at = now()
     WHERE workspace_id = $1 AND dedup_key = $2`,
    [workspaceId, dedupKey, status, snoozeUntil],
  );
}

/** Manual dismiss/snooze of a single finding from the inbox (by id). */
export async function setFindingStatusById(
  workspaceId: string,
  findingId: string,
  status: string,
  snoozeUntil: string | null = null,
): Promise<void> {
  await pool.query(
    `UPDATE fleetgraph_findings SET status = $3, snooze_until = $4, last_seen_at = now()
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, findingId, status, snoozeUntil],
  );
}

/** Auto-resolve: close open findings of the given (autonomous) types whose condition no longer
 *  fires — i.e. the issue was assigned/estimated/closed. `entityIds` scopes it to the entities a
 *  run actually examined (a single-issue mutation run must not touch other entities' findings);
 *  pass null for a workspace-wide sweep. Returns the resolved rows so callers can notify. */
export async function resolveClearedFindings(
  workspaceId: string,
  firingDedupKeys: string[],
  entityIds: string[] | null,
  types: string[],
): Promise<Array<{ dedup_key: string; recipients: string[] | null; title: string; severity: string; entity_id: string | null; entity_type: string | null }>> {
  const r = await pool.query(
    `UPDATE fleetgraph_findings
        SET status = 'resolved', last_seen_at = now()
      WHERE workspace_id = $1
        AND status = 'open'
        AND finding_type = ANY($2::text[])
        AND ($3::text[] IS NULL OR entity_id::text = ANY($3::text[]))
        AND NOT (dedup_key = ANY($4::text[]))
      RETURNING dedup_key, recipients, title, severity, entity_id, entity_type`,
    [workspaceId, types, entityIds, firingDedupKeys],
  );
  return r.rows;
}

export async function listFindings(
  workspaceId: string,
  statuses: string[] = ['open'],
): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT id, dedup_key, finding_type, entity_id, entity_type, severity, status,
            title, detail, proposed_action, recipients, snooze_until, first_seen_at, last_seen_at
     FROM fleetgraph_findings f
     WHERE workspace_id = $1 AND status = ANY($2)
       AND NOT EXISTS (
         SELECT 1 FROM fleetgraph_pending_approvals pa
         WHERE pa.finding_id = f.id AND pa.status = 'pending'
       )
     ORDER BY
       CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
       last_seen_at DESC
     LIMIT 100`,
    [workspaceId, statuses],
  );
  return result.rows;
}

// ---- pending approvals (HITL inbox projection) ----

export async function upsertPendingApproval(params: {
  workspaceId: string;
  threadId: string;
  findingId?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  summary: string;
  proposedAction: ProposedAction;
  recipientId?: string | null;
}): Promise<{ created: boolean; id: string }> {
  const result = await pool.query(
    `INSERT INTO fleetgraph_pending_approvals
       (workspace_id, thread_id, finding_id, entity_id, entity_type, summary, proposed_action, recipient_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (thread_id) DO UPDATE SET summary = EXCLUDED.summary
     RETURNING id, (xmax = 0) AS created`,
    [
      params.workspaceId, params.threadId, params.findingId ?? null,
      params.entityId ?? null, params.entityType ?? null, params.summary,
      JSON.stringify(params.proposedAction), params.recipientId ?? null,
    ],
  );
  return { created: result.rows[0].created === true, id: result.rows[0].id };
}

/** Atomically claim a pending approval (pending → processing) so a double-submit can't resume the
 *  same HITL run twice (which would double-apply the mutation + duplicate the audit/notify). Returns
 *  false if it wasn't pending (already claimed/resolved). Scoped to the workspace. */
export async function claimPendingApproval(threadId: string, workspaceId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE fleetgraph_pending_approvals SET status = 'processing'
      WHERE thread_id = $1 AND workspace_id = $2 AND status = 'pending'
      RETURNING id`,
    [threadId, workspaceId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Release a claim (processing → pending) so the user can retry if resuming the graph failed. */
export async function revertPendingApprovalClaim(threadId: string): Promise<void> {
  await pool.query(
    `UPDATE fleetgraph_pending_approvals SET status = 'pending'
      WHERE thread_id = $1 AND status = 'processing'`,
    [threadId],
  );
}

export async function resolvePendingApproval(threadId: string, status: string): Promise<void> {
  await pool.query(
    `UPDATE fleetgraph_pending_approvals SET status = $2, resolved_at = now() WHERE thread_id = $1`,
    [threadId, status],
  );
}

export async function getPendingApproval(threadId: string): Promise<Record<string, unknown> | null> {
  const result = await pool.query(
    `SELECT * FROM fleetgraph_pending_approvals WHERE thread_id = $1`,
    [threadId],
  );
  return result.rows[0] ?? null;
}

export async function listPendingApprovals(workspaceId: string): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT id, thread_id, finding_id, entity_id, entity_type, summary, proposed_action, recipient_id, created_at
     FROM fleetgraph_pending_approvals
     WHERE workspace_id = $1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 100`,
    [workspaceId],
  );
  return result.rows;
}
