// The unified FleetGraph: one StateGraph for both proactive and on-demand modes.
// Control flow (see FLEETGRAPH.md for the diagram):
//   START → prepare → [ondemand: resolveContext] → dispatch → (4 parallel fetch) → merge
//     ondemand → answer → respond → END
//     proactive → detect → dedup →(novel=0: END)→ triage →(kept=0: END)→ reason
//        → classify → surfaceAuto →(no hitl: END)→ humanGate(INTERRUPT)
//        → approve: executeApproved | dismiss: recordDismiss | snooze: recordSnooze → END
import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { FleetGraphState, type FleetGraphStateType } from './state.js';
import {
  fetchIssues, fetchWeeks, fetchTeam, fetchProjects, fetchWorkspaceAdmins,
  fetchWorkspaceMeta, fetchSprintProgress, fetchPersonUserId,
  type PersonRow, type WeekRow, type SprintProgress, type WorkspaceMeta, type ProjectRow,
} from './fetch.js';
import { detectSignals, detectSprintSlip, detectCapacity } from './detectors.js';
import { invokeTier, extractJson, isLlmAvailable } from './llm.js';
import { loadKnownFindings, loadDismissalCounts, recordFinding, setFindingStatusByDedup, upsertPendingApproval, resolvePendingApproval } from './findings-store.js';
import { filterNovel } from './dedup.js';
import { broadcastToUser } from '../collaboration/index.js';
import { pool } from '../db/client.js';
import { logDocumentChange } from '../utils/document-crud.js';
import type { IssueRow, Signal, Finding, ProposedAction, Scope } from './types.js';

type S = FleetGraphStateType;
type Update = Partial<S>;

// ---------------------------------------------------------------- context
async function prepare(state: S): Promise<Update> {
  const [admins, known, dismissals] = await Promise.all([
    fetchWorkspaceAdmins(state.workspaceId),
    loadKnownFindings(state.workspaceId, state.scope.entityIds),
    loadDismissalCounts(state.workspaceId),
  ]);
  return { knownFindings: known, raw: { admins, dismissals } };
}

// Everything in Ship is a document, so the chat scopes to whatever document the user is viewing.
// Each doc type narrows the issues the agent reasons over (issue→that issue, sprint/project/program
// →their issues, person→their assigned work). Unhandled types fall back to workspace-wide.
async function resolveContext(state: S): Promise<Update> {
  const { documentType, documentId } = state.scope;
  if (!documentId) return {};
  switch (documentType) {
    case 'issue':
      return { scope: { ...state.scope, entityIds: [documentId] } };
    case 'sprint':
      return { scope: { ...state.scope, sprintId: documentId } };
    case 'project':
      return { scope: { ...state.scope, projectId: documentId } };
    case 'program':
      return { scope: { ...state.scope, programId: documentId } };
    case 'person': {
      const userId = await fetchPersonUserId(documentId);
      return userId ? { scope: { ...state.scope, assigneeId: userId } } : {};
    }
    default:
      return {};
  }
}

// ---------------------------------------------------------------- parallel fetch
async function nodeFetchIssues(state: S): Promise<Update> {
  return { raw: { issues: await fetchIssues(state.workspaceId, state.scope) } };
}
async function nodeFetchWeeks(state: S): Promise<Update> {
  return { raw: { weeks: await fetchWeeks(state.workspaceId) } };
}
async function nodeFetchTeam(state: S): Promise<Update> {
  return { raw: { team: await fetchTeam(state.workspaceId) } };
}
async function nodeFetchProjects(state: S): Promise<Update> {
  return { raw: { projects: await fetchProjects(state.workspaceId) } };
}
async function nodeFetchMeta(state: S): Promise<Update> {
  const [meta, sprintProgress] = await Promise.all([
    fetchWorkspaceMeta(state.workspaceId),
    fetchSprintProgress(state.workspaceId),
  ]);
  return { raw: { meta, sprintProgress } };
}
function merge(_state: S): Update {
  return {}; // fan-in join; the `raw` reducer already merged the four fetches
}

// ---------------------------------------------------------------- detection + dedup
function detect(state: S): Update {
  const issues = (state.raw.issues as IssueRow[]) ?? [];
  const admins = (state.raw.admins as string[]) ?? [];
  let signals = detectSignals(issues, { fallbackRecipients: admins });

  // Cross-entity detectors (sprint slip, capacity) only on workspace-wide (cron/digest) runs —
  // not on a single-issue mutation trigger.
  const workspaceWide = !state.scope.entityIds || state.scope.entityIds.length === 0;
  if (workspaceWide) {
    const weeks = (state.raw.weeks as WeekRow[]) ?? [];
    const team = (state.raw.team as PersonRow[]) ?? [];
    const sprintProgress = (state.raw.sprintProgress as SprintProgress[]) ?? [];
    const meta = (state.raw.meta as WorkspaceMeta) ?? { sprintStartDate: null, sprintDuration: 7 };
    signals = signals
      .concat(detectSprintSlip(weeks, sprintProgress, team, meta, { fallbackRecipients: admins }))
      .concat(detectCapacity(team, issues, { fallbackRecipients: admins }));
  }
  return { signals };
}

function dedup(state: S): Update {
  const dismissals = (state.raw.dismissals as Record<string, number>) ?? {};
  return { novelSignals: filterNovel(state.signals, state.knownFindings, dismissals) };
}

// ---------------------------------------------------------------- triage (tier 1)
async function triage(state: S): Promise<Update> {
  const signals = state.novelSignals;
  if (!isLlmAvailable()) {
    // Deterministic fallback: surface everything except pure low-severity noise singletons.
    return { keptSignals: signals };
  }
  const sys = `You are FleetGraph's triage step for a project-management tool. Given candidate signals about issues, decide which are worth a human's attention RIGHT NOW. Drop noise. Respond ONLY with JSON: {"keep":["<dedupKey>", ...]}.`;
  const user = `Signals:\n${JSON.stringify(
    signals.map((s) => ({ dedupKey: s.dedupKey, type: s.type, severity: s.severity, label: s.entityLabel, evidence: s.evidence })),
    null, 2,
  )}`;
  const res = await invokeTier(1, sys, user);
  if (!res) return { keptSignals: signals };
  const parsed = extractJson<{ keep: string[] }>(res.text);
  const keepSet = new Set(parsed?.keep ?? signals.map((s) => s.dedupKey));
  return {
    keptSignals: signals.filter((s) => keepSet.has(s.dedupKey)),
    cost: { tier1Tokens: res.inputTokens + res.outputTokens, tier2Tokens: 0, usd: res.usd },
  };
}

// ---------------------------------------------------------------- reason (tier 2)
function templateFinding(sig: Signal): Finding {
  const ev = sig.evidence as Record<string, number | null | undefined>;
  const titles: Record<string, string> = {
    stale_in_progress: `Stalled: ${sig.entityLabel}`,
    overdue: `Overdue: ${sig.entityLabel}`,
    unassigned: `Unassigned: ${sig.entityLabel}`,
    unestimated: `No estimate: ${sig.entityLabel}`,
    sprint_slip: `At risk of slipping: ${sig.entityLabel}`,
    capacity_overload: `Overloaded: ${sig.entityLabel}`,
  };
  const details: Record<string, string> = {
    stale_in_progress: `${sig.entityLabel} has been in progress with no activity for ${ev.idleDays} days.`,
    overdue: `${sig.entityLabel} is past its due date (${ev.overdueDays} days) and still open.`,
    unassigned: `${sig.entityLabel} is open work with no assignee.`,
    unestimated: `${sig.entityLabel} is open work with no estimate.`,
    sprint_slip: `${sig.entityLabel} is ${ev.elapsedPct}% through its window but only ${ev.progressPct}% done (${ev.done}/${ev.total})${ev.confidence != null ? `, confidence ${ev.confidence}%` : ''}. Likely to slip — consider cutting scope or resetting confidence.`,
    capacity_overload: `${sig.entityLabel} has ${ev.load}h of open work assigned vs ${ev.capacity}h capacity (${ev.openCount} open issues).`,
  };
  return {
    dedupKey: sig.dedupKey,
    type: sig.type,
    severity: sig.severity,
    entityId: sig.entityId,
    entityType: sig.entityType,
    title: titles[sig.type] ?? sig.entityLabel,
    detail: details[sig.type] ?? `${sig.entityLabel}: ${sig.type}`,
    recipients: sig.recipients,
    contentHash: sig.contentHash,
    proposedAction: sig.suggestedAction,
  };
}

async function reason(state: S): Promise<Update> {
  const kept = state.keptSignals;
  if (!isLlmAvailable()) {
    return { findings: kept.map(templateFinding) };
  }
  const sys = `You are FleetGraph reasoning about project-management signals. For each signal, write a crisp one-line title and a 1-2 sentence explanation a busy PM/engineer can act on. Respond ONLY with JSON: {"findings":[{"dedupKey":"...","title":"...","detail":"..."}]}.`;
  const user = `Signals:\n${JSON.stringify(
    kept.map((s) => ({ dedupKey: s.dedupKey, type: s.type, severity: s.severity, label: s.entityLabel, evidence: s.evidence })),
    null, 2,
  )}`;
  const res = await invokeTier(2, sys, user);
  if (!res) return { findings: kept.map(templateFinding) };
  const parsed = extractJson<{ findings: { dedupKey: string; title: string; detail: string }[] }>(res.text);
  const byKey = new Map((parsed?.findings ?? []).map((f) => [f.dedupKey, f]));
  const findings = kept.map((sig) => {
    const base = templateFinding(sig);
    const drafted = byKey.get(sig.dedupKey);
    return drafted ? { ...base, title: drafted.title || base.title, detail: drafted.detail || base.detail } : base;
  });
  return { findings, cost: { tier1Tokens: 0, tier2Tokens: res.inputTokens + res.outputTokens, usd: res.usd } };
}

// ---------------------------------------------------------------- on-demand answer (tier 2)
const CHAT_ACTION_KINDS = new Set(['set_state', 'set_priority', 'reassign', 'set_estimate', 'set_due_date']);

async function answer(state: S): Promise<Update> {
  const issues = (state.raw.issues as IssueRow[]) ?? [];
  const team = (state.raw.team as PersonRow[]) ?? [];
  const weeks = state.raw.weeks ?? [];
  const question = state.userMessage ?? '';
  if (!isLlmAvailable()) {
    return { answer: `FleetGraph (offline reasoning): ${issues.length} open issue(s) in scope. Enable a model for full answers. Your question: "${question}"` };
  }
  const sys = `You are FleetGraph, embedded in the Ship project tool. Answer the user's question about the CURRENT view using only the provided data; be concise and concrete.
If — and only if — the user clearly requests a change to a specific issue, include ONE concrete "action". "entityId" is the issue's "id" from Issues in scope; NEVER invent ids. Do NOT claim to have made the change — it needs the user's approval.
The "payload" MUST match the kind exactly:
- reassign      -> {"assignee_id":"<userId from Team>"}
- set_state     -> {"state":"triage|backlog|todo|in_progress|in_review|done|cancelled"}
- set_priority  -> {"priority":"urgent|high|medium|low|none"}
- set_estimate  -> {"estimate":<number>}
- set_due_date  -> {"due_date":"YYYY-MM-DD"}
Respond ONLY with JSON: {"reply":"<answer>","action":{"kind":"...","entityId":"<issue id>","payload":{...},"summary":"<what will happen>"}} — omit "action" entirely if no change was requested.
Example: {"reply":"Reassigning to Alice.","action":{"kind":"reassign","entityId":"3f...","payload":{"assignee_id":"6e..."},"summary":"Reassign #12 to Alice"}}`;
  const user = `Scope: ${JSON.stringify(state.scope)}
Issues in scope: ${JSON.stringify(issues.slice(0, 60).map((i) => ({ id: i.id, num: i.ticketNumber, title: i.title, state: i.state, priority: i.priority, assignee: i.assigneeName, assigneeId: i.assigneeId, estimate: i.estimate, due: i.dueDate })))}
Team: ${JSON.stringify(team.map((t) => ({ name: t.name, userId: t.userId, role: t.role, capacityHours: t.capacityHours })))}
Weeks: ${JSON.stringify(weeks)}

User: ${question}`;
  const res = await invokeTier(2, sys, user);
  if (!res) return { answer: 'FleetGraph could not reach the model. Please try again.' };
  const cost = { tier1Tokens: 0, tier2Tokens: res.inputTokens + res.outputTokens, usd: res.usd };
  const parsed = extractJson<{ reply?: string; action?: { kind: string; entityId: string; payload?: Record<string, unknown>; summary?: string } }>(res.text);
  if (!parsed) return { answer: res.text, cost }; // model returned prose; use as-is
  const reply = parsed.reply ?? res.text;
  const a = parsed.action;
  const validIssueIds = new Set(issues.map((i) => i.id));
  const teamUserIds = new Set(team.map((t) => t.userId).filter(Boolean));
  const payloadOk = (kind: string, p: Record<string, unknown>): boolean => {
    switch (kind) {
      case 'reassign': return typeof p.assignee_id === 'string' && teamUserIds.has(p.assignee_id as string);
      case 'set_state': return typeof p.state === 'string';
      case 'set_priority': return typeof p.priority === 'string';
      case 'set_estimate': return Number.isFinite(Number(p.estimate));
      case 'set_due_date': return typeof p.due_date === 'string';
      default: return false;
    }
  };
  if (a && CHAT_ACTION_KINDS.has(a.kind) && validIssueIds.has(a.entityId) && payloadOk(a.kind, a.payload ?? {})) {
    const action: ProposedAction = {
      kind: a.kind as ProposedAction['kind'],
      entityId: a.entityId,
      entityType: 'issue',
      payload: a.payload ?? {},
      summary: a.summary || `${a.kind.replace('_', ' ')} on issue`,
      autonomy: 'hitl',
      rationale: 'Requested via FleetGraph chat.',
    };
    return { answer: reply, proposedActions: [action], cost };
  }
  return { answer: reply, cost };
}
function respond(_state: S): Update {
  return {};
}

// ---------------------------------------------------------------- daily digest (tier 2 synthesis)
async function synthesizeDigests(
  projects: ProjectRow[],
  issuesByProject: Map<string, IssueRow[]>,
  weeks: WeekRow[],
  team: PersonRow[],
): Promise<{ texts: Map<string, string>; cost?: { tier1Tokens: number; tier2Tokens: number; usd: number } }> {
  const texts = new Map<string, string>();
  const fallback = (p: ProjectRow) => {
    const iss = issuesByProject.get(p.id) ?? [];
    const unassigned = iss.filter((i) => !i.assigneeId).length;
    return `${iss.length} open issue(s)${unassigned ? `, ${unassigned} unassigned` : ''}.`;
  };
  if (!isLlmAvailable()) {
    for (const p of projects) texts.set(p.id, fallback(p));
    return { texts };
  }
  // Chunk so each response fits within the token cap (one big call truncates the JSON).
  const sys = `You are FleetGraph writing a short DAILY DIGEST for each project. For each project, in 2-4 sentences: what's moving, what's at risk (stale/overdue/unassigned/overloaded), and the single most important next action. Be concrete and reference issue numbers (num). Respond ONLY with JSON: {"digests":[{"projectId":"<id>","text":"<digest>"}]}.`;
  const CHUNK = 5;
  let tier2Tokens = 0, usd = 0, anyOk = false;
  for (let k = 0; k < projects.length; k += CHUNK) {
    const chunk = projects.slice(k, k + CHUNK);
    const user = `Projects: ${JSON.stringify(chunk.map((p) => ({
      id: p.id, title: p.title,
      issues: (issuesByProject.get(p.id) ?? []).slice(0, 15).map((i) => ({ num: i.ticketNumber, title: i.title, state: i.state, priority: i.priority, assignee: i.assigneeName, due: i.dueDate, estimate: i.estimate })),
    })))}
Weeks: ${JSON.stringify(weeks)}
Team: ${JSON.stringify(team.map((t) => ({ name: t.name, capacity: t.capacityHours })))}`;
    const res = await invokeTier(2, sys, user);
    if (!res) continue;
    anyOk = true;
    tier2Tokens += res.inputTokens + res.outputTokens;
    usd += res.usd;
    const parsed = extractJson<{ digests: { projectId: string; text: string }[] }>(res.text);
    for (const d of parsed?.digests ?? []) texts.set(d.projectId, d.text);
  }
  for (const p of projects) if (!texts.has(p.id)) texts.set(p.id, fallback(p)); // fill gaps
  return anyOk ? { texts, cost: { tier1Tokens: 0, tier2Tokens, usd } } : { texts };
}

async function digest(state: S): Promise<Update> {
  const issues = (state.raw.issues as IssueRow[]) ?? [];
  const projects = (state.raw.projects as ProjectRow[]) ?? [];
  const weeks = (state.raw.weeks as WeekRow[]) ?? [];
  const team = (state.raw.team as PersonRow[]) ?? [];
  const admins = (state.raw.admins as string[]) ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const known = new Set(state.knownFindings.map((k) => k.dedupKey));

  const byProject = new Map<string, IssueRow[]>();
  for (const i of issues) {
    if (!i.projectId) continue;
    const arr = byProject.get(i.projectId) ?? [];
    arr.push(i);
    byProject.set(i.projectId, arr);
  }
  // Projects with open work that haven't been digested today (one digest per project per day).
  const targets = projects.filter((p) => (byProject.get(p.id)?.length ?? 0) > 0 && !known.has(`digest:${p.id}:${today}`));
  if (targets.length === 0) return {};

  const { texts, cost } = await synthesizeDigests(targets, byProject, weeks, team);
  const ownerUserId = (personId: string | null) => (personId ? team.find((t) => t.personId === personId)?.userId : null) ?? null;
  const findings: Finding[] = targets.map((p) => ({
    dedupKey: `digest:${p.id}:${today}`,
    type: 'digest',
    severity: 'info',
    entityId: p.id,
    entityType: 'project',
    title: `Daily digest — ${p.title}`,
    detail: texts.get(p.id) ?? `${(byProject.get(p.id) ?? []).length} open issue(s).`,
    recipients: [ownerUserId(p.ownerId), p.accountableId, ...admins].filter((x): x is string => !!x),
    contentHash: today,
  }));
  return cost ? { findings, cost } : { findings };
}

// ---------------------------------------------------------------- classify + act
function classify(state: S): Update {
  const actions: ProposedAction[] = state.findings.map((f) => f.proposedAction).filter((a): a is ProposedAction => !!a);
  return { proposedActions: actions };
}

/** Surface every AUTONOMOUS finding (those without a HITL mutation): persist + notify. */
async function surfaceAuto(state: S): Promise<Update> {
  const emitted: string[] = [];
  for (const f of state.findings) {
    const isHitl = f.proposedAction?.autonomy === 'hitl';
    if (isHitl) continue; // handled by the gate
    await recordFinding(state.workspaceId, f, state.runId, 'open');
    for (const uid of f.recipients) {
      broadcastToUser(uid, 'fleetgraph:finding', { dedupKey: f.dedupKey, title: f.title, detail: f.detail, severity: f.severity, entityId: f.entityId, entityType: f.entityType });
    }
    emitted.push(f.dedupKey);
  }
  return { emitted };
}

// Returns the top HITL action to gate on. Proactive findings carry the action; on-demand chat
// supplies a standalone proposedAction (no finding). Finding is optional in the result.
function pickHitlAction(state: S): { action: ProposedAction; finding?: Finding } | undefined {
  const order = { high: 0, medium: 1, low: 2, info: 3 } as const;
  const f = [...state.findings]
    .filter((x) => x.proposedAction?.autonomy === 'hitl')
    .sort((a, b) => order[a.severity] - order[b.severity])[0];
  if (f) return { action: f.proposedAction!, finding: f };
  const standalone = state.proposedActions.find((a) => a.autonomy === 'hitl');
  return standalone ? { action: standalone } : undefined;
}

// HUMAN-IN-THE-LOOP gate: persists a pending approval, notifies, then interrupts.
async function humanGate(state: S): Promise<Update> {
  const { action, finding } = pickHitlAction(state)!;
  const recipients = finding?.recipients?.length
    ? finding.recipients
    : (state.actorUserId ? [state.actorUserId] : ((state.raw.admins as string[]) ?? []));

  const findingId = finding ? await recordFinding(state.workspaceId, finding, state.runId, 'open') : null;
  const { created } = await upsertPendingApproval({
    workspaceId: state.workspaceId,
    threadId: state.runId,
    findingId,
    entityId: finding?.entityId ?? action.entityId,
    entityType: finding?.entityType ?? action.entityType,
    summary: action.summary,
    proposedAction: action,
    recipientId: recipients[0] ?? null,
  });
  if (created) {
    for (const uid of recipients) {
      broadcastToUser(uid, 'fleetgraph:interrupt', {
        threadId: state.runId, title: finding?.title ?? action.summary, detail: finding?.detail ?? action.rationale ?? '',
        summary: action.summary, severity: finding?.severity ?? 'medium', entityId: action.entityId,
      });
    }
  }

  // Pause here until a human resumes with a decision.
  const resume = interrupt({ kind: 'approval', action, finding }) as {
    decision: 'approve' | 'dismiss' | 'snooze';
    snoozeUntil?: string;
    userId?: string;
  };

  return {
    approvalDecision: resume.decision,
    snoozeUntil: resume.snoozeUntil ?? null,
    actorUserId: resume.userId ?? state.actorUserId,
  };
}

async function executeApproved(state: S): Promise<Update> {
  const { action, finding } = pickHitlAction(state)!;
  const actor = state.actorUserId; // the approver

  const FIELD_BY_KIND: Record<string, string> = {
    set_state: 'state', set_priority: 'priority', reassign: 'assignee_id',
    set_estimate: 'estimate', set_due_date: 'due_date',
  };
  const field = FIELD_BY_KIND[action.kind];
  if (field) {
    const rawVal = (action.payload ?? {})[field];
    const newValue: string | number | null =
      action.kind === 'set_estimate'
        ? (Number.isFinite(Number(rawVal)) ? Number(rawVal) : null)
        : (rawVal == null || rawVal === '' ? null : String(rawVal));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT properties FROM documents WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [action.entityId, state.workspaceId],
      );
      if (cur.rows.length > 0) {
        const props = cur.rows[0].properties || {};
        const oldValue = props[field] != null ? String(props[field]) : null;
        if (newValue == null) delete props[field];
        else props[field] = newValue;
        await client.query(
          `UPDATE documents SET properties = $1, updated_at = now() WHERE id = $2 AND workspace_id = $3`,
          [JSON.stringify(props), action.entityId, state.workspaceId],
        );
        await logDocumentChange(action.entityId, field, oldValue, newValue == null ? null : String(newValue), actor ?? '00000000-0000-0000-0000-000000000000', 'fleetgraph', client);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    // Notify the new assignee on reassignment.
    if (action.kind === 'reassign') {
      const newAssignee = String((action.payload ?? {}).assignee_id ?? '');
      if (newAssignee) broadcastToUser(newAssignee, 'accountability:updated', { issueId: action.entityId });
    }
  }

  if (finding) await recordFinding(state.workspaceId, finding, state.runId, 'acted');
  await resolvePendingApproval(state.runId, 'approved');
  const dedupKey = finding?.dedupKey ?? `chat:${state.runId}`;
  const recipients = finding?.recipients?.length ? finding.recipients : (state.actorUserId ? [state.actorUserId] : []);
  for (const uid of recipients) {
    broadcastToUser(uid, 'fleetgraph:finding', { dedupKey, title: `Applied: ${action.summary}`, detail: finding?.detail ?? '', severity: finding?.severity ?? 'info', entityId: action.entityId, entityType: action.entityType, resolved: true });
    broadcastToUser(uid, 'accountability:updated', { issueId: action.entityId });
  }
  return { emitted: [dedupKey] };
}

async function recordDismiss(state: S): Promise<Update> {
  const { finding } = pickHitlAction(state)!;
  if (finding) await setFindingStatusByDedup(state.workspaceId, finding.dedupKey, 'dismissed');
  await resolvePendingApproval(state.runId, 'dismissed');
  return {};
}

async function recordSnooze(state: S): Promise<Update> {
  const { finding } = pickHitlAction(state)!;
  if (finding) await setFindingStatusByDedup(state.workspaceId, finding.dedupKey, 'snoozed', state.snoozeUntil);
  await resolvePendingApproval(state.runId, 'snoozed');
  return {};
}

// ---------------------------------------------------------------- assembly
export function buildGraph() {
  const g = new StateGraph(FleetGraphState)
    .addNode('prepare', prepare)
    .addNode('resolveContext', resolveContext)
    .addNode('dispatch', (_s: S) => ({}))
    .addNode('fetchIssues', nodeFetchIssues)
    .addNode('fetchWeeks', nodeFetchWeeks)
    .addNode('fetchTeam', nodeFetchTeam)
    .addNode('fetchProjects', nodeFetchProjects)
    .addNode('fetchMeta', nodeFetchMeta)
    .addNode('merge', merge)
    .addNode('answerNode', answer)
    .addNode('respond', respond)
    .addNode('digest', digest)
    .addNode('detect', detect)
    .addNode('dedup', dedup)
    .addNode('triage', triage)
    .addNode('reason', reason)
    .addNode('classify', classify)
    .addNode('surfaceAuto', surfaceAuto)
    .addNode('humanGate', humanGate)
    .addNode('executeApproved', executeApproved)
    .addNode('recordDismiss', recordDismiss)
    .addNode('recordSnooze', recordSnooze);

  g.addEdge(START, 'prepare');
  g.addConditionalEdges('prepare', (s: S) => (s.mode === 'ondemand' ? 'resolveContext' : 'dispatch'), {
    resolveContext: 'resolveContext',
    dispatch: 'dispatch',
  });
  g.addEdge('resolveContext', 'dispatch');

  // fan-out / fan-in
  g.addEdge('dispatch', 'fetchIssues');
  g.addEdge('dispatch', 'fetchWeeks');
  g.addEdge('dispatch', 'fetchTeam');
  g.addEdge('dispatch', 'fetchProjects');
  g.addEdge('dispatch', 'fetchMeta');
  g.addEdge('fetchIssues', 'merge');
  g.addEdge('fetchWeeks', 'merge');
  g.addEdge('fetchTeam', 'merge');
  g.addEdge('fetchProjects', 'merge');
  g.addEdge('fetchMeta', 'merge');

  g.addConditionalEdges(
    'merge',
    (s: S) => (s.triggerKind === 'digest' ? 'digest' : s.mode === 'ondemand' ? 'answerNode' : 'detect'),
    { digest: 'digest', answerNode: 'answerNode', detect: 'detect' },
  );
  g.addEdge('digest', 'surfaceAuto'); // digest findings are autonomous → recorded + notified
  // On-demand: if the chat proposed a write, route it through the SAME HITL gate; else just respond.
  g.addConditionalEdges(
    'answerNode',
    (s: S) => (s.proposedActions.some((a) => a.autonomy === 'hitl') ? 'humanGate' : 'respond'),
    { humanGate: 'humanGate', respond: 'respond' },
  );
  g.addEdge('respond', END);

  g.addEdge('detect', 'dedup');
  g.addConditionalEdges('dedup', (s: S) => (s.novelSignals.length === 0 ? END : 'triage'), {
    [END]: END,
    triage: 'triage',
  });
  g.addConditionalEdges('triage', (s: S) => (s.keptSignals.length === 0 ? END : 'reason'), {
    [END]: END,
    reason: 'reason',
  });
  g.addEdge('reason', 'classify');
  g.addEdge('classify', 'surfaceAuto');
  g.addConditionalEdges(
    'surfaceAuto',
    (s: S) => (s.proposedActions.some((a) => a.autonomy === 'hitl') ? 'humanGate' : END),
    { humanGate: 'humanGate', [END]: END },
  );
  g.addConditionalEdges(
    'humanGate',
    (s: S) => (s.approvalDecision === 'approve' ? 'executeApproved' : s.approvalDecision === 'snooze' ? 'recordSnooze' : 'recordDismiss'),
    { executeApproved: 'executeApproved', recordSnooze: 'recordSnooze', recordDismiss: 'recordDismiss' },
  );
  g.addEdge('executeApproved', END);
  g.addEdge('recordDismiss', END);
  g.addEdge('recordSnooze', END);

  return g;
}

// ---------------------------------------------------------------- eval wrappers
// Thin, test-only entry points that exercise the real node logic with plain inputs.
// (The nodes read only the fields each wrapper supplies, so the partial-state cast is safe.)
export const evalTriage = (signals: Signal[]): Promise<Update> =>
  triage({ novelSignals: signals } as S);

export const evalReason = (signals: Signal[]): Promise<Update> =>
  reason({ keptSignals: signals } as S);

export const evalAnswer = (input: { scope: Scope; raw: Record<string, unknown>; userMessage: string }): Promise<Update> =>
  answer({ scope: input.scope, raw: input.raw, userMessage: input.userMessage } as S);
