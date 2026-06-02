// Layer 2 — graph-path + HITL integration tests against a real (truncated) DB.
// Hermetic: FLEETGRAPH_DISABLE_LLM forces deterministic fallbacks (no tokens, repeatable).
// Asserts each path's side effects and the autonomy boundary (no mutation before approval).
//
// Epic 7 (Platform Citizen): when PLUGFORGE_AGENT_VIA_SDK=1 the graph routes
// workspace-wide issue fetches through fetch-sdk.ts (→ /api/v1 client_credentials).
// There is no live server in unit tests, so we stub fetchIssuesViaSdk to fall
// back to the direct DB query — this keeps integration tests hermetic regardless
// of flag state without changing their semantics.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { pool } from '../../db/client.js';
import { runProactiveForEntity, runDigest, resumeApproval } from '../runner.js';
import { fetchIssues, fetchDocumentCensus, fetchDocumentIndex, fetchPersonUserId } from '../fetch.js';
import { claimPendingApproval, revertPendingApprovalClaim } from '../findings-store.js';
import type { Scope } from '../types.js';

// Stub the SDK adapter so integration tests remain hermetic with or without
// PLUGFORGE_AGENT_VIA_SDK set. The stub delegates back to the real DB fetch,
// preserving all real data semantics — only the transport layer differs.
vi.mock('../fetch-sdk.js', () => ({
  fetchIssuesViaSdk: async (workspaceId: string, scope: Scope) => fetchIssues(workspaceId, scope),
}));

process.env.FLEETGRAPH_DISABLE_LLM = '1';

let WS: string;
let USER: string;
let PERSON: string;
let ticket = 9000;

async function insertIssue(props: Record<string, unknown>, title = 'Test issue'): Promise<string> {
  const r = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, ticket_number, properties, created_by, content, visibility)
     VALUES ($1,'issue',$2,$3,$4,$5,'{}','workspace') RETURNING id`,
    [WS, title, ticket++, JSON.stringify(props), USER],
  );
  return r.rows[0].id;
}
const findingsFor = async (entityId: string, status = 'open') =>
  (await pool.query(`SELECT finding_type FROM fleetgraph_findings WHERE entity_id=$1 AND status=$2`, [entityId, status])).rows.map((x) => x.finding_type);
const issueProps = async (id: string) => (await pool.query(`SELECT properties FROM documents WHERE id=$1`, [id])).rows[0]?.properties ?? {};
const pendingFor = async (entityId: string) =>
  (await pool.query(`SELECT thread_id, status, proposed_action FROM fleetgraph_pending_approvals WHERE entity_id=$1 ORDER BY created_at DESC LIMIT 1`, [entityId])).rows[0];

describe('FleetGraph graph integration', () => {
  beforeAll(async () => {
    WS = (await pool.query(`INSERT INTO workspaces (name) VALUES ('FG Test WS') RETURNING id`)).rows[0].id;
    USER = (await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ($1,'h','Tester') RETURNING id`, [`fg-${randomUUID()}@t.local`])).rows[0].id;
    await pool.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'admin')`, [WS, USER]);
    PERSON = (await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, visibility)
       VALUES ($1,'person','Tester',$2,'workspace') RETURNING id`,
      [WS, JSON.stringify({ user_id: USER, capacity_hours: 20 })],
    )).rows[0].id;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM fleetgraph_pending_approvals WHERE workspace_id=$1`, [WS]);
    await pool.query(`DELETE FROM fleetgraph_findings WHERE workspace_id=$1`, [WS]);
    await pool.query(`DELETE FROM document_associations WHERE document_id IN (SELECT id FROM documents WHERE workspace_id=$1 AND document_type IN ('issue','project'))`, [WS]);
    await pool.query(`DELETE FROM documents WHERE workspace_id=$1 AND document_type IN ('issue','project')`, [WS]);
  });

  it('quiet path: a healthy issue produces no finding', async () => {
    const id = await insertIssue({ state: 'todo', priority: 'medium', assignee_id: USER, estimate: 3, source: 'internal' });
    await runProactiveForEntity({ workspaceId: WS, entityId: id, entityType: 'issue' });
    expect(await findingsFor(id)).toEqual([]);
  });

  it('autonomous path: unassigned + unestimated surfaces open findings', async () => {
    const id = await insertIssue({ state: 'todo', priority: 'none', source: 'internal' }); // no assignee, no estimate
    await runProactiveForEntity({ workspaceId: WS, entityId: id, entityType: 'issue' });
    const found = (await findingsFor(id)).sort();
    expect(found).toContain('unassigned');
    expect(found).toContain('unestimated');
    // autonomous findings have no pending approval
    expect(await pendingFor(id)).toBeUndefined();
  });

  it('auto-resolves an autonomous finding once its condition clears', async () => {
    const id = await insertIssue({ state: 'todo', priority: 'medium', estimate: 3, source: 'internal' }); // unassigned (has estimate)
    await runProactiveForEntity({ workspaceId: WS, entityId: id, entityType: 'issue' });
    expect(await findingsFor(id)).toContain('unassigned'); // open

    // fix it — assign the issue; the next run should clear the finding
    await pool.query(`UPDATE documents SET properties = jsonb_set(properties, '{assignee_id}', to_jsonb($2::text)) WHERE id=$1`, [id, USER]);
    await runProactiveForEntity({ workspaceId: WS, entityId: id, entityType: 'issue' });

    expect(await findingsFor(id)).not.toContain('unassigned'); // gone from the open inbox
    const status = (await pool.query(`SELECT status FROM fleetgraph_findings WHERE entity_id=$1 AND finding_type='unassigned'`, [id])).rows[0]?.status;
    expect(status).toBe('resolved');
  });

  it('HITL approve: overdue → pending approval, no mutation until approved, then PATCH + audit', async () => {
    const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const id = await insertIssue({ state: 'todo', priority: 'medium', assignee_id: USER, estimate: 3, due_date: past, source: 'internal' });
    await runProactiveForEntity({ workspaceId: WS, entityId: id, entityType: 'issue' });

    const pending = await pendingFor(id);
    expect(pending).toBeDefined();
    expect(pending.status).toBe('pending');
    // AUTONOMY BOUNDARY: nothing mutated before approval
    expect((await issueProps(id)).priority).toBe('medium');

    await resumeApproval({ threadId: pending.thread_id, decision: 'approve', userId: USER });
    expect((await issueProps(id)).priority).toBe('urgent');
    expect((await issueProps(id)).state).toBe('todo'); // ONLY priority changed (boundary)

    const audit = (await pool.query(`SELECT field, new_value, automated_by FROM document_history WHERE document_id=$1 AND automated_by='fleetgraph'`, [id])).rows;
    expect(audit).toEqual([{ field: 'priority', new_value: 'urgent', automated_by: 'fleetgraph' }]);
    expect((await pendingFor(id)).status).toBe('approved');
  });

  it('HITL dismiss: no mutation, finding suppressed', async () => {
    const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const id = await insertIssue({ state: 'todo', priority: 'medium', assignee_id: USER, estimate: 3, due_date: past, source: 'internal' });
    await runProactiveForEntity({ workspaceId: WS, entityId: id, entityType: 'issue' });
    const pending = await pendingFor(id);
    await resumeApproval({ threadId: pending.thread_id, decision: 'dismiss', userId: USER });
    expect((await issueProps(id)).priority).toBe('medium'); // unchanged
    const dismissed = (await pool.query(`SELECT status FROM fleetgraph_findings WHERE entity_id=$1`, [id])).rows[0]?.status;
    expect(dismissed).toBe('dismissed');
  });

  it('HITL snooze: no mutation, snooze_until set', async () => {
    const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const id = await insertIssue({ state: 'todo', priority: 'medium', assignee_id: USER, estimate: 3, due_date: past, source: 'internal' });
    await runProactiveForEntity({ workspaceId: WS, entityId: id, entityType: 'issue' });
    const pending = await pendingFor(id);
    await resumeApproval({ threadId: pending.thread_id, decision: 'snooze', snoozeUntil: new Date(Date.now() + 7 * 86400000).toISOString(), userId: USER });
    expect((await issueProps(id)).priority).toBe('medium');
    const row = (await pool.query(`SELECT status, snooze_until FROM fleetgraph_findings WHERE entity_id=$1`, [id])).rows[0];
    expect(row.status).toBe('snoozed');
    expect(row.snooze_until).not.toBeNull();
  });

  it('digest path: one finding per project, deduped per day', async () => {
    const proj = (await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, visibility)
       VALUES ($1,'project','Test Project',$2,'workspace') RETURNING id`,
      [WS, JSON.stringify({ owner_id: PERSON })],
    )).rows[0].id;
    const issue = await insertIssue({ state: 'todo', priority: 'medium', assignee_id: USER, estimate: 3, source: 'internal' });
    await pool.query(`INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1,$2,'project')`, [issue, proj]);

    await runDigest(WS);
    const c1 = (await pool.query(`SELECT count(*)::int n FROM fleetgraph_findings WHERE workspace_id=$1 AND finding_type='digest'`, [WS])).rows[0].n;
    expect(c1).toBe(1);
    await runDigest(WS); // same day → dedup, no new digest
    const c2 = (await pool.query(`SELECT count(*)::int n FROM fleetgraph_findings WHERE workspace_id=$1 AND finding_type='digest'`, [WS])).rows[0].n;
    expect(c2).toBe(1);
  });

  it('on-demand scoping: fetchIssues narrows by project / program / assignee (everything-is-a-document)', async () => {
    const mkDoc = async (type: string, title: string) =>
      (await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, content, visibility)
         VALUES ($1,$2,$3,'{}','{}','workspace') RETURNING id`,
        [WS, type, title],
      )).rows[0].id;
    const projA = await mkDoc('project', 'Proj A');
    const projB = await mkDoc('project', 'Proj B');
    const prog = await mkDoc('program', 'Prog 1');
    const OTHER = (await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1,'h','Other') RETURNING id`,
      [`fg-${randomUUID()}@t.local`],
    )).rows[0].id;

    const issueA = await insertIssue({ state: 'todo', priority: 'medium', assignee_id: USER, estimate: 3 }, 'A');
    const issueB = await insertIssue({ state: 'todo', priority: 'medium', assignee_id: OTHER, estimate: 3 }, 'B');
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1,$2,'project'),($3,$4,'project'),($1,$5,'program')`,
      [issueA, projA, issueB, projB, prog],
    );

    const ids = async (scope: Scope) => (await fetchIssues(WS, scope)).map((i) => i.id).sort();

    expect(await ids({ projectId: projA })).toEqual([issueA]);
    expect(await ids({ projectId: projB })).toEqual([issueB]);
    expect(await ids({ programId: prog })).toEqual([issueA]);
    expect(await ids({ assigneeId: USER })).toEqual([issueA]);
    expect(await ids({ assigneeId: OTHER })).toEqual([issueB]);

    // cleanup the program doc (beforeEach only wipes issue/project docs)
    await pool.query(`DELETE FROM document_associations WHERE related_id=$1`, [prog]);
    await pool.query(`DELETE FROM documents WHERE id=$1`, [prog]);
  });

  it('document census + index cover all document types (everything-is-a-document)', async () => {
    const mkDoc = async (type: string, title: string) =>
      (await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, content, visibility)
         VALUES ($1,$2,$3,'{}','{}','workspace') RETURNING id`,
        [WS, type, title],
      )).rows[0].id;
    await insertIssue({ state: 'todo', priority: 'medium' }, 'Census Issue');
    const proj = await mkDoc('project', 'Census Project');
    const wiki = await mkDoc('wiki', 'Census Wiki');
    // a 'person' doc (Tester) already exists from beforeAll

    const census = await fetchDocumentCensus(WS);
    expect(census.byType.issue).toBeGreaterThanOrEqual(1);
    expect(census.byType.project).toBeGreaterThanOrEqual(1);
    expect(census.byType.wiki).toBeGreaterThanOrEqual(1);
    expect(census.byType.person).toBeGreaterThanOrEqual(1);
    // total is the sum of the per-type counts
    expect(census.total).toBe(Object.values(census.byType).reduce((a, b) => a + b, 0));

    const index = await fetchDocumentIndex(WS);
    const titles = index.map((d) => d.title);
    expect(titles).toContain('Census Wiki');
    expect(titles).toContain('Census Project');
    expect(index.find((d) => d.title === 'Census Wiki')?.type).toBe('wiki');

    // cleanup the wiki (beforeEach only wipes issue/project docs); proj is cleaned by beforeEach
    await pool.query(`DELETE FROM documents WHERE id=$1`, [wiki]);
    void proj;
  });

  it('fetchPersonUserId is workspace-scoped (no cross-tenant person lookup)', async () => {
    expect(await fetchPersonUserId(WS, PERSON)).toBe(USER);
    // A person doc must not resolve for a different workspace, even with the right doc id.
    expect(await fetchPersonUserId(randomUUID(), PERSON)).toBeNull();
  });

  it('claimPendingApproval is atomic: a double-submit can only claim once', async () => {
    const threadId = `test:${randomUUID()}`;
    await pool.query(
      `INSERT INTO fleetgraph_pending_approvals (workspace_id, thread_id, summary, status)
       VALUES ($1,$2,'test','pending')`,
      [WS, threadId],
    );
    expect(await claimPendingApproval(threadId, WS)).toBe(true);
    expect(await claimPendingApproval(threadId, WS)).toBe(false); // already processing → no double-resume
    // a failed resume releases the claim so the human can retry
    await revertPendingApprovalClaim(threadId);
    expect(await claimPendingApproval(threadId, WS)).toBe(true);
    // a different workspace can't claim it
    await revertPendingApprovalClaim(threadId);
    expect(await claimPendingApproval(threadId, randomUUID())).toBe(false);
  });
});
