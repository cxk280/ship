// Client helpers for the FleetGraph agent API.
import { apiGet, apiPost } from './api';

export type Severity = 'info' | 'low' | 'medium' | 'high';

export interface FgProposedAction {
  kind: string;
  summary: string;
  autonomy: 'auto' | 'hitl';
  rationale?: string;
}

export interface FgFinding {
  id: string;
  dedupKey: string;
  type: string;
  severity: Severity;
  title: string;
  detail: string;
  entityId: string | null;
  entityType: string | null;
  proposedAction: FgProposedAction | null;
  lastSeenAt: string;
}

export interface FgApproval {
  threadId: string;
  summary: string;
  proposedAction: FgProposedAction | null;
  entityId: string | null;
  entityType: string | null;
  createdAt: string;
}

export interface FgInbox {
  findings: FgFinding[];
  approvals: FgApproval[];
}

export async function getInbox(): Promise<FgInbox> {
  const res = await apiGet('/api/fleetgraph/inbox');
  if (!res.ok) throw new Error('Failed to load FleetGraph inbox');
  return res.json();
}

export type Decision = 'approve' | 'dismiss' | 'snooze';

export async function resumeApproval(threadId: string, decision: Decision, snoozeDays?: number): Promise<void> {
  const res = await apiPost(`/api/fleetgraph/approvals/${threadId}/resume`, { decision, snoozeDays });
  if (!res.ok) throw new Error('Failed to submit decision');
}

export interface FgChatScope {
  documentId?: string;
  documentType?: string;
  projectId?: string;
  sprintId?: string;
}

export async function chat(message: string, scope: FgChatScope): Promise<{ answer: string; runId: string }> {
  const res = await apiPost('/api/fleetgraph/chat', { message, ...scope });
  if (!res.ok) throw new Error('FleetGraph chat failed');
  return res.json();
}
