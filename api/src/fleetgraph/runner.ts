// Compiles the graph once and exposes the four ways it runs.
import { randomUUID } from 'crypto';
import { Command, isGraphInterrupt } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { buildGraph } from './graph.js';
import { getCheckpointer } from './checkpointer.js';
import { getPendingApproval } from './findings-store.js';
import type { Scope, ApprovalDecision } from './types.js';

let compiledPromise: ReturnType<typeof compile> | null = null;
async function compile() {
  const checkpointer = await getCheckpointer();
  return buildGraph().compile({ checkpointer });
}
function getGraph() {
  if (!compiledPromise) compiledPromise = compile();
  return compiledPromise;
}

function cfg(threadId: string, tags: string[], metadata: Record<string, unknown>): RunnableConfig {
  return { configurable: { thread_id: threadId }, runName: `fleetgraph-${tags[tags.length - 1]}`, tags, metadata };
}

/** Proactive run scoped to a single changed entity (mutation trigger). */
export async function runProactiveForEntity(params: {
  workspaceId: string;
  entityId: string;
  entityType: string;
  changedFields?: string[];
}): Promise<void> {
  const graph = await getGraph();
  const runId = `mut:${randomUUID()}`;
  const scope: Scope = { entityIds: [params.entityId], documentType: params.entityType, changedFields: params.changedFields };
  try {
    await graph.invoke(
      { mode: 'proactive', triggerKind: 'mutation', workspaceId: params.workspaceId, actorUserId: null, runId, scope },
      cfg(runId, ['fleetgraph', 'proactive', 'mutation'], { workspaceId: params.workspaceId, entityId: params.entityId }),
    );
  } catch (err) {
    if (!isGraphInterrupt(err)) throw err; // interrupt = expected pause (HITL); side-effects already persisted
  }
}

/** Proactive sweep over a workspace's open work (cron trigger). */
export async function runCronSweep(workspaceId: string): Promise<void> {
  const graph = await getGraph();
  const runId = `cron:${randomUUID()}`;
  try {
    await graph.invoke(
      { mode: 'proactive', triggerKind: 'cron', workspaceId, actorUserId: null, runId, scope: {} },
      cfg(runId, ['fleetgraph', 'proactive', 'cron'], { workspaceId }),
    );
  } catch (err) {
    if (!isGraphInterrupt(err)) throw err;
  }
}

/** On-demand chat scoped to the current view. Returns the answer + the run id. */
export async function runOndemandChat(params: {
  workspaceId: string;
  userId: string;
  scope: Scope;
  message: string;
}): Promise<{ answer: string; runId: string; pendingApproval?: { threadId: string; summary: string } }> {
  const graph = await getGraph();
  const runId = `chat:${randomUUID()}`;
  const config = cfg(runId, ['fleetgraph', 'ondemand', 'chat'], { workspaceId: params.workspaceId, userId: params.userId });
  let final: Record<string, unknown> | undefined;
  try {
    final = await graph.invoke(
      { mode: 'ondemand', triggerKind: 'chat', workspaceId: params.workspaceId, actorUserId: params.userId, userMessage: params.message, runId, scope: params.scope },
      config,
    );
  } catch (err) {
    if (!isGraphInterrupt(err)) throw err; // interrupt = paused for approval (chat proposed an action)
  }
  let answer = (final?.answer as string) ?? '';
  if (!answer) {
    // The run paused at the HITL gate before returning; read the answer from the checkpoint.
    const snap = await graph.getState(config);
    answer = (snap?.values?.answer as string) ?? 'FleetGraph prepared an action for your approval.';
  }
  const pending = await getPendingApproval(runId);
  if (pending && pending.status === 'pending') {
    return { answer, runId, pendingApproval: { threadId: runId, summary: String(pending.summary ?? 'Proposed action') } };
  }
  return { answer: answer || 'No response.', runId };
}

/** Resume a paused HITL run with the human's decision. */
export async function resumeApproval(params: {
  threadId: string;
  decision: ApprovalDecision;
  snoozeUntil?: string | null;
  userId: string;
}): Promise<void> {
  const graph = await getGraph();
  try {
    await graph.invoke(
      new Command({ resume: { decision: params.decision, snoozeUntil: params.snoozeUntil ?? undefined, userId: params.userId } }),
      cfg(params.threadId, ['fleetgraph', 'resume', params.decision], { threadId: params.threadId }),
    );
  } catch (err) {
    if (!isGraphInterrupt(err)) throw err;
  }
}
