// Deterministic detection rules. No LLM — cheap, fast, and the cost gate before reasoning.
// Each rule emits a Signal with a stable dedupKey and a content hash bucketed so it
// re-surfaces only on material change.
import { createHash } from 'crypto';
import type { IssueRow, Signal, Severity, ProposedAction } from './types.js';
import type { WeekRow, PersonRow, SprintProgress, WorkspaceMeta } from './fetch.js';

const STALE_DAYS = Number(process.env.FLEETGRAPH_STALE_DAYS ?? 3);
const OPEN_WORK = new Set(['todo', 'in_progress', 'in_review']);

function hash(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

function label(issue: IssueRow): string {
  const tn = issue.ticketNumber ? `#${issue.ticketNumber} ` : '';
  return `${tn}${issue.title}`;
}

function daysBetween(fromIso: string | null, to: Date): number {
  if (!fromIso) return 0;
  return Math.floor((to.getTime() - new Date(fromIso).getTime()) / 86_400_000);
}

export interface DetectOptions {
  now?: Date;
  fallbackRecipients?: string[]; // e.g. workspace admins / sprint owner
}

/** Run all deterministic detectors over the in-scope issues. */
export function detectSignals(issues: IssueRow[], opts: DetectOptions = {}): Signal[] {
  const now = opts.now ?? new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const fallback = opts.fallbackRecipients ?? [];
  const signals: Signal[] = [];

  const recipientsFor = (issue: IssueRow): string[] =>
    issue.assigneeId ? [issue.assigneeId] : fallback;

  for (const issue of issues) {
    // 1) Stale in-progress: work that's started but gone quiet. (HITL: propose parking it.)
    if (issue.state === 'in_progress') {
      const idleDays = daysBetween(issue.lastActivityAt, now);
      if (idleDays >= STALE_DAYS) {
        const severity: Severity = idleDays >= STALE_DAYS * 2 ? 'high' : 'medium';
        const action: ProposedAction = {
          kind: 'set_state',
          entityId: issue.id,
          entityType: 'issue',
          payload: { state: 'todo' },
          summary: `Move ${label(issue)} back to To Do (no activity for ${idleDays} days)`,
          autonomy: 'hitl',
          rationale: 'Started but no updates — likely stalled or blocked. Parking it keeps the board honest.',
        };
        signals.push({
          type: 'stale_in_progress',
          severity,
          entityId: issue.id,
          entityType: 'issue',
          entityLabel: label(issue),
          evidence: { idleDays, lastActivityAt: issue.lastActivityAt, assigneeName: issue.assigneeName },
          dedupKey: `stale_in_progress:${issue.id}`,
          contentHash: hash({ t: 'stale', d: idleDays }),
          recipients: recipientsFor(issue),
          suggestedAction: action,
        });
      }
    }

    // 2) Overdue: past due_date and not closed. (HITL: propose bumping priority.)
    if (issue.dueDate && issue.dueDate < todayStr && !['done', 'cancelled'].includes(issue.state)) {
      const overdueDays = daysBetween(issue.dueDate, now);
      const action: ProposedAction = {
        kind: 'set_priority',
        entityId: issue.id,
        entityType: 'issue',
        payload: { priority: 'urgent' },
        summary: `Raise ${label(issue)} to Urgent (overdue by ${overdueDays} days)`,
        autonomy: 'hitl',
        rationale: 'Past its due date and still open — needs attention or a new date.',
      };
      signals.push({
        type: 'overdue',
        severity: 'high',
        entityId: issue.id,
        entityType: 'issue',
        entityLabel: label(issue),
        evidence: { dueDate: issue.dueDate, overdueDays, state: issue.state },
        dedupKey: `overdue:${issue.id}`,
        contentHash: hash({ t: 'overdue', d: overdueDays }),
        recipients: recipientsFor(issue),
        suggestedAction: action,
      });
    }

    // 3) Unassigned open work. (Auto: flag + comment — agent can't pick an owner.)
    if (OPEN_WORK.has(issue.state) && !issue.assigneeId) {
      signals.push({
        type: 'unassigned',
        severity: issue.state === 'in_progress' ? 'medium' : 'low',
        entityId: issue.id,
        entityType: 'issue',
        entityLabel: label(issue),
        evidence: { state: issue.state },
        dedupKey: `unassigned:${issue.id}`,
        contentHash: hash({ t: 'unassigned', s: issue.state }),
        recipients: fallback,
      });
    }

    // 4) Unestimated open work. (Auto: flag.)
    if (OPEN_WORK.has(issue.state) && issue.estimate == null) {
      signals.push({
        type: 'unestimated',
        severity: 'low',
        entityId: issue.id,
        entityType: 'issue',
        entityLabel: label(issue),
        evidence: { state: issue.state },
        dedupKey: `unestimated:${issue.id}`,
        contentHash: hash({ t: 'unestimated', s: issue.state }),
        recipients: issue.assigneeId ? [issue.assigneeId] : fallback,
      });
    }
  }

  return signals;
}

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/**
 * Cross-entity: forecast sprint slip. For active sprints, compare how far through the
 * window we are vs. how much work is done; flag a lagging sprint (worse when confidence is high).
 */
export function detectSprintSlip(
  weeks: WeekRow[],
  progress: SprintProgress[],
  team: PersonRow[],
  meta: WorkspaceMeta,
  opts: DetectOptions = {},
): Signal[] {
  if (!meta.sprintStartDate) return [];
  const now = opts.now ?? new Date();
  const fallback = opts.fallbackRecipients ?? [];
  const progressById = new Map(progress.map((p) => [p.sprintId, p]));
  const ownerUserId = (personId: string | null) =>
    (personId ? team.find((t) => t.personId === personId)?.userId : null) ?? null;
  const start = new Date(meta.sprintStartDate + 'T00:00:00Z').getTime();
  const durMs = meta.sprintDuration * 86_400_000;
  const pct = (x: number) => Math.round(x * 100);
  const signals: Signal[] = [];

  for (const w of weeks) {
    if (w.status !== 'active' || w.sprintNumber == null) continue;
    const p = progressById.get(w.id);
    if (!p || p.total === 0) continue;
    const sprintStart = start + (w.sprintNumber - 1) * durMs;
    const elapsed = Math.max(0, Math.min(1, (now.getTime() - sprintStart) / durMs));
    if (elapsed < 0.4) continue; // too early to judge
    const prog = p.done / p.total;
    const gap = elapsed - prog;
    if (gap < 0.25) continue; // on track
    const confidence = w.confidence;
    const highConfidenceMismatch = confidence != null && confidence >= 70 && gap >= 0.4;
    const severity: Severity = highConfidenceMismatch || gap >= 0.5 ? 'high' : 'medium';
    const owner = ownerUserId(w.ownerId);
    signals.push({
      type: 'sprint_slip',
      severity,
      entityId: w.id,
      entityType: 'sprint',
      entityLabel: w.title,
      evidence: { elapsedPct: pct(elapsed), progressPct: pct(prog), done: p.done, total: p.total, confidence },
      dedupKey: `sprint_slip:${w.id}`,
      contentHash: hash({ t: 'slip', e: Math.round(elapsed * 4), p: Math.round(prog * 4) }),
      recipients: owner ? [owner] : fallback,
    });
  }
  return signals;
}

/**
 * Cross-entity: capacity overload. Sum the estimate of each person's open assigned work and
 * compare to capacity_hours; when over, propose reassigning the lowest-priority item to the
 * teammate with the most slack (HITL), and notify the person + their reports_to.
 */
export function detectCapacity(team: PersonRow[], issues: IssueRow[], opts: DetectOptions = {}): Signal[] {
  const fallback = opts.fallbackRecipients ?? [];
  const openByUser = new Map<string, IssueRow[]>();
  for (const i of issues) {
    if (!i.assigneeId || !OPEN_WORK.has(i.state)) continue;
    const arr = openByUser.get(i.assigneeId) ?? [];
    arr.push(i);
    openByUser.set(i.assigneeId, arr);
  }
  const loadOf = (userId: string) => (openByUser.get(userId) ?? []).reduce((s, i) => s + (i.estimate ?? 0), 0);
  const withCap = team.filter((t): t is PersonRow & { userId: string; capacityHours: number } =>
    !!t.userId && typeof t.capacityHours === 'number' && t.capacityHours > 0);

  const signals: Signal[] = [];
  for (const person of withCap) {
    const load = loadOf(person.userId);
    const cap = person.capacityHours;
    if (load <= cap) continue;
    const severity: Severity = load > cap * 1.5 ? 'high' : 'medium';

    let best: { user: string; name: string; slack: number } | null = null;
    for (const t of withCap) {
      if (t.userId === person.userId) continue;
      const slack = t.capacityHours - loadOf(t.userId);
      if (slack > 0 && (!best || slack > best.slack)) best = { user: t.userId, name: t.name, slack };
    }
    const mine = [...(openByUser.get(person.userId) ?? [])].sort(
      (a, b) => (PRIORITY_ORDER[b.priority] ?? 4) - (PRIORITY_ORDER[a.priority] ?? 4),
    );
    const overflow = mine[0];

    let suggestedAction: ProposedAction | undefined;
    if (best && overflow) {
      suggestedAction = {
        kind: 'reassign',
        entityId: overflow.id,
        entityType: 'issue',
        payload: { assignee_id: best.user },
        summary: `Reassign #${overflow.ticketNumber ?? '?'} from ${person.name} to ${best.name} (${person.name}: ${load}h assigned vs ${cap}h capacity)`,
        autonomy: 'hitl',
        rationale: `${person.name} is over capacity; ${best.name} has ${best.slack}h of slack.`,
      };
    }
    signals.push({
      type: 'capacity_overload',
      severity,
      entityId: person.personId,
      entityType: 'person',
      entityLabel: person.name,
      evidence: { load, capacity: cap, openCount: (openByUser.get(person.userId) ?? []).length },
      dedupKey: `capacity_overload:${person.userId}`,
      contentHash: hash({ t: 'cap', r: Math.round((load / cap) * 4) }),
      recipients: [person.userId, ...(person.reportsTo ? [person.reportsTo] : [])],
      suggestedAction,
    });
  }
  return signals;
}
