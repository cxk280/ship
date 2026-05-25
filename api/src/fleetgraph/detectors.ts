// Deterministic detection rules. No LLM — cheap, fast, and the cost gate before reasoning.
// Each rule emits a Signal with a stable dedupKey and a content hash bucketed so it
// re-surfaces only on material change.
import { createHash } from 'crypto';
import type { IssueRow, Signal, Severity, ProposedAction } from './types.js';

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
