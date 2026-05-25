// The unified FleetGraph: one StateGraph for both proactive and on-demand modes.
// Control flow (see FLEETGRAPH.md for the diagram):
//   START → prepare → [ondemand: resolveContext] → dispatch → (4 parallel fetch) → merge
//     ondemand → answer → respond → END
//     proactive → detect → dedup →(novel=0: END)→ triage →(kept=0: END)→ reason
//        → classify → surfaceAuto →(no hitl: END)→ humanGate(INTERRUPT)
//        → approve: executeApproved | dismiss: recordDismiss | snooze: recordSnooze → END
import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { FleetGraphState, type FleetGraphStateType } from './state.js';
import { fetchIssues, fetchWeeks, fetchTeam, fetchProjects, fetchWorkspaceAdmins, type PersonRow } from './fetch.js';
import { detectSignals } from './detectors.js';
import { invokeTier, extractJson, isLlmAvailable } from './llm.js';
import { loadKnownFindings, recordFinding, setFindingStatusByDedup, upsertPendingApproval, resolvePendingApproval } from './findings-store.js';
import { broadcastToUser } from '../collaboration/index.js';
import { pool } from '../db/client.js';
import { logDocumentChange } from '../utils/document-crud.js';
import type { IssueRow, Signal, Finding, ProposedAction } from './types.js';

type S = FleetGraphStateType;
type Update = Partial<S>;

// ---------------------------------------------------------------- context
async function prepare(state: S): Promise<Update> {
  const admins = await fetchWorkspaceAdmins(state.workspaceId);
  const known = await loadKnownFindings(state.workspaceId, state.scope.entityIds);
  return { knownFindings: known, raw: { admins } };
}

async function resolveContext(state: S): Promise<Update> {
  const { documentType, documentId } = state.scope;
  if (documentType === 'issue' && documentId) {
    return { scope: { ...state.scope, entityIds: [documentId] } };
  }
  if (documentType === 'sprint' && documentId) {
    return { scope: { ...state.scope, sprintId: documentId } };
  }
  return {};
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
function merge(_state: S): Update {
  return {}; // fan-in join; the `raw` reducer already merged the four fetches
}

// ---------------------------------------------------------------- detection + dedup
function detect(state: S): Update {
  const issues = (state.raw.issues as IssueRow[]) ?? [];
  const admins = (state.raw.admins as string[]) ?? [];
  const signals = detectSignals(issues, { fallbackRecipients: admins });
  return { signals };
}

function dedup(state: S): Update {
  const known = new Map(state.knownFindings.map((k) => [k.dedupKey, k]));
  const now = Date.now();
  const novel = state.signals.filter((sig) => {
    const prior = known.get(sig.dedupKey);
    if (!prior) return true;                                   // never seen
    if (prior.status === 'dismissed') return false;            // permanently suppressed
    if (prior.status === 'snoozed') {
      return prior.snoozeUntil ? new Date(prior.snoozeUntil).getTime() < now : false;
    }
    // open/acted: re-surface only if the situation materially changed
    return prior.contentHash !== sig.contentHash;
  });
  return { novelSignals: novel };
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
  const titles: Record<string, string> = {
    stale_in_progress: `Stalled: ${sig.entityLabel}`,
    overdue: `Overdue: ${sig.entityLabel}`,
    unassigned: `Unassigned: ${sig.entityLabel}`,
    unestimated: `No estimate: ${sig.entityLabel}`,
  };
  const details: Record<string, string> = {
    stale_in_progress: `${sig.entityLabel} has been in progress with no activity for ${(sig.evidence as { idleDays?: number }).idleDays} days.`,
    overdue: `${sig.entityLabel} is past its due date (${(sig.evidence as { overdueDays?: number }).overdueDays} days) and still open.`,
    unassigned: `${sig.entityLabel} is open work with no assignee.`,
    unestimated: `${sig.entityLabel} is open work with no estimate.`,
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
async function answer(state: S): Promise<Update> {
  const issues = (state.raw.issues as IssueRow[]) ?? [];
  const weeks = state.raw.weeks ?? [];
  const question = state.userMessage ?? '';
  if (!isLlmAvailable()) {
    const open = issues.length;
    return { answer: `FleetGraph (offline reasoning): ${open} open issue(s) in scope. Enable Bedrock for full answers. Your question: "${question}"` };
  }
  const sys = `You are FleetGraph, an assistant embedded in the Ship project tool. Answer the user's question about the CURRENT view using only the provided data. Be concise and concrete. If you spot a risk (stalled, overdue, unassigned, overloaded), say so and suggest the next action — but do NOT claim to have changed anything.`;
  const user = `Scope: ${JSON.stringify(state.scope)}\nIssues in scope:\n${JSON.stringify(
    issues.slice(0, 60).map((i) => ({ id: i.ticketNumber, title: i.title, state: i.state, priority: i.priority, assignee: i.assigneeName, due: i.dueDate, estimate: i.estimate, idleSince: i.lastActivityAt })),
  )}\nWeeks: ${JSON.stringify(weeks)}\n\nQuestion: ${question}`;
  const res = await invokeTier(2, sys, user);
  if (!res) return { answer: 'FleetGraph could not reach the model. Please try again.' };
  return { answer: res.text, cost: { tier1Tokens: 0, tier2Tokens: res.inputTokens + res.outputTokens, usd: res.usd } };
}
function respond(_state: S): Update {
  return {};
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

function pickHitlFinding(state: S): Finding | undefined {
  const order = { high: 0, medium: 1, low: 2, info: 3 } as const;
  return [...state.findings]
    .filter((f) => f.proposedAction?.autonomy === 'hitl')
    .sort((a, b) => order[a.severity] - order[b.severity])[0];
}

// HUMAN-IN-THE-LOOP gate: persists a pending approval, notifies, then interrupts.
async function humanGate(state: S): Promise<Update> {
  const finding = pickHitlFinding(state)!;
  const action = finding.proposedAction!;
  const recipients = finding.recipients.length ? finding.recipients : ((state.raw.admins as string[]) ?? []);

  const findingId = await recordFinding(state.workspaceId, finding, state.runId, 'open');
  const { created } = await upsertPendingApproval({
    workspaceId: state.workspaceId,
    threadId: state.runId,
    findingId,
    entityId: finding.entityId,
    entityType: finding.entityType,
    summary: action.summary,
    proposedAction: action,
    recipientId: recipients[0] ?? null,
  });
  if (created) {
    for (const uid of recipients) {
      broadcastToUser(uid, 'fleetgraph:interrupt', {
        threadId: state.runId, title: finding.title, detail: finding.detail,
        summary: action.summary, severity: finding.severity, entityId: finding.entityId,
      });
    }
  }

  // Pause here until a human resumes with a decision.
  const resume = interrupt({ kind: 'approval', finding, action }) as {
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
  const finding = pickHitlFinding(state)!;
  const action = finding.proposedAction!;
  const actor = state.actorUserId; // the approver

  if (action.kind === 'set_state' || action.kind === 'set_priority') {
    const field = action.kind === 'set_state' ? 'state' : 'priority';
    const newValue = String((action.payload ?? {})[field]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT properties FROM documents WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [action.entityId, state.workspaceId],
      );
      if (cur.rows.length > 0) {
        const props = cur.rows[0].properties || {};
        const oldValue = props[field] ?? null;
        props[field] = newValue;
        await client.query(
          `UPDATE documents SET properties = $1, updated_at = now() WHERE id = $2 AND workspace_id = $3`,
          [JSON.stringify(props), action.entityId, state.workspaceId],
        );
        await logDocumentChange(action.entityId, field, oldValue, newValue, actor ?? '00000000-0000-0000-0000-000000000000', 'fleetgraph', client);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  await recordFinding(state.workspaceId, finding, state.runId, 'acted');
  await resolvePendingApproval(state.runId, 'approved');
  for (const uid of finding.recipients) {
    broadcastToUser(uid, 'fleetgraph:finding', { dedupKey: finding.dedupKey, title: `Applied: ${action.summary}`, detail: finding.detail, severity: finding.severity, entityId: finding.entityId, entityType: finding.entityType, resolved: true });
    broadcastToUser(uid, 'accountability:updated', { issueId: finding.entityId });
  }
  return { emitted: [finding.dedupKey] };
}

async function recordDismiss(state: S): Promise<Update> {
  const finding = pickHitlFinding(state)!;
  await setFindingStatusByDedup(state.workspaceId, finding.dedupKey, 'dismissed');
  await resolvePendingApproval(state.runId, 'dismissed');
  return {};
}

async function recordSnooze(state: S): Promise<Update> {
  const finding = pickHitlFinding(state)!;
  await setFindingStatusByDedup(state.workspaceId, finding.dedupKey, 'snoozed', state.snoozeUntil);
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
    .addNode('merge', merge)
    .addNode('answerNode', answer)
    .addNode('respond', respond)
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
  g.addEdge('fetchIssues', 'merge');
  g.addEdge('fetchWeeks', 'merge');
  g.addEdge('fetchTeam', 'merge');
  g.addEdge('fetchProjects', 'merge');

  g.addConditionalEdges('merge', (s: S) => (s.mode === 'ondemand' ? 'answerNode' : 'detect'), {
    answerNode: 'answerNode',
    detect: 'detect',
  });
  g.addEdge('answerNode', 'respond');
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
