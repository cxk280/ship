// Shared FleetGraph types: the vocabulary the graph carries between nodes.

export type Mode = 'proactive' | 'ondemand';
export type TriggerKind = 'mutation' | 'cron' | 'chat' | 'digest';
export type Severity = 'info' | 'low' | 'medium' | 'high';
export type ApprovalDecision = 'approve' | 'dismiss' | 'snooze';

/** What the agent is looking at. Proactive: the changed/scanned entities. On-demand: the open view. */
export interface Scope {
  documentId?: string;
  documentType?: string;
  projectId?: string;
  sprintId?: string;
  programId?: string;
  /** Resolved user id when the current view is a person document (scopes issues to their work). */
  assigneeId?: string;
  /** Entity ids the run should consider (mutation: one issue; cron: active-sprint issues). */
  entityIds?: string[];
  changedFields?: string[];
}

/** A normalized issue row the detectors + reasoning operate on. */
export interface IssueRow {
  id: string;
  title: string;
  ticketNumber: number | null;
  state: string;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  estimate: number | null;
  dueDate: string | null;
  source: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  lastActivityAt: string | null; // max(document_history.created_at, updated_at)
  sprintId: string | null;
  sprintNumber: number | null;
  projectId: string | null;
}

/** Deterministic detector output. */
export interface Signal {
  type: string;            // e.g. "stale_in_progress"
  severity: Severity;
  entityId: string;
  entityType: string;      // "issue" | "sprint" | "project"
  entityLabel: string;     // human label e.g. "#142 Fix login"
  evidence: Record<string, unknown>;
  dedupKey: string;        // `${type}:${entityId}`
  contentHash: string;     // hash of evidence — re-surface only on material change
  recipients: string[];    // user ids to notify
  /** Concrete change the agent could propose (drives HITL classification). */
  suggestedAction?: ProposedAction;
}

/** A reasoned, human-facing finding (post-triage, post-LLM). */
export interface Finding {
  dedupKey: string;
  type: string;
  severity: Severity;
  entityId: string;
  entityType: string;
  title: string;
  detail: string;
  recipients: string[];
  contentHash: string;
  proposedAction?: ProposedAction;
}

/** An action the agent might take. autonomy decides whether it needs a human. */
export interface ProposedAction {
  kind: 'comment' | 'set_state' | 'set_priority' | 'reassign' | 'set_estimate' | 'set_due_date';
  entityId: string;
  entityType: string;
  /** The mutating payload, e.g. { state: 'todo' } — only used for non-comment kinds. */
  payload?: Record<string, unknown>;
  /** Human-readable description shown in the approval card. */
  summary: string;
  autonomy: 'auto' | 'hitl';
  rationale?: string;
}

export interface CostTally {
  tier1Tokens: number;
  tier2Tokens: number;
  usd: number;
}
