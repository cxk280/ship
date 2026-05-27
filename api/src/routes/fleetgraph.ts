import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { listFindings, listPendingApprovals, getPendingApproval, setFindingStatusById, claimPendingApproval, revertPendingApprovalClaim } from '../fleetgraph/findings-store.js';
import { runOndemandChat, resumeApproval } from '../fleetgraph/runner.js';
import type { Scope } from '../fleetgraph/types.js';

type RouterType = ReturnType<typeof Router>;
export const fleetgraphRouter: RouterType = Router();

// GET /api/fleetgraph/inbox — open findings + pending HITL approvals for the workspace.
fleetgraphRouter.get('/inbox', authMiddleware, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.workspaceId!;
    const [findings, approvals] = await Promise.all([
      listFindings(workspaceId, ['open']),
      listPendingApprovals(workspaceId),
    ]);
    res.json({
      findings: findings.map((f) => ({
        id: f.id, dedupKey: f.dedup_key, type: f.finding_type, severity: f.severity,
        title: f.title, detail: f.detail, entityId: f.entity_id, entityType: f.entity_type,
        proposedAction: f.proposed_action, lastSeenAt: f.last_seen_at,
      })),
      approvals: approvals.map((a) => ({
        threadId: a.thread_id, summary: a.summary, proposedAction: a.proposed_action,
        entityId: a.entity_id, entityType: a.entity_type, createdAt: a.created_at,
      })),
    });
  } catch (err) {
    console.error('FleetGraph inbox error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/fleetgraph/chat — on-demand, context-aware reasoning over the current view.
const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  documentId: z.string().uuid().optional(),
  documentType: z.string().optional(),
  projectId: z.string().uuid().optional(),
  sprintId: z.string().uuid().optional(),
});
fleetgraphRouter.post('/chat', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.errors });
      return;
    }
    const { message, documentId, documentType, projectId, sprintId } = parsed.data;
    const scope: Scope = { documentId, documentType, projectId, sprintId };
    const result = await runOndemandChat({
      workspaceId: req.workspaceId!, userId: req.userId!, scope, message,
    });
    res.json(result);
  } catch (err) {
    console.error('FleetGraph chat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/fleetgraph/approvals/:threadId/resume — human decision on a paused HITL run.
const resumeSchema = z.object({
  decision: z.enum(['approve', 'dismiss', 'snooze']),
  snoozeDays: z.number().int().min(1).max(90).optional(),
});
fleetgraphRouter.post('/approvals/:threadId/resume', authMiddleware, async (req: Request, res: Response) => {
  try {
    const threadId = String(req.params.threadId);
    const parsed = resumeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.errors });
      return;
    }

    // Verify the pending approval belongs to this workspace.
    const pending = await getPendingApproval(threadId);
    if (!pending || pending.workspace_id !== req.workspaceId) {
      res.status(404).json({ error: 'Approval not found' });
      return;
    }
    if (pending.status !== 'pending') {
      res.status(409).json({ error: 'Approval already resolved', status: pending.status });
      return;
    }

    // Atomically claim the approval (pending → processing) so a double-submit / concurrent request
    // can't resume the same HITL run twice and double-apply the mutation.
    const claimed = await claimPendingApproval(threadId, req.workspaceId!);
    if (!claimed) {
      res.status(409).json({ error: 'Approval already being processed' });
      return;
    }

    const snoozeUntil = parsed.data.decision === 'snooze'
      ? new Date(Date.now() + (parsed.data.snoozeDays ?? 7) * 86_400_000).toISOString()
      : null;

    try {
      await resumeApproval({ threadId, decision: parsed.data.decision, snoozeUntil, userId: req.userId! });
    } catch (err) {
      // Resuming the graph failed before it could record a terminal decision — release the claim so
      // the human can retry instead of leaving the approval stuck.
      await revertPendingApprovalClaim(threadId).catch(() => {});
      throw err;
    }
    res.json({ success: true, decision: parsed.data.decision });
  } catch (err) {
    console.error('FleetGraph resume error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/fleetgraph/findings/:id/resolve — manually dismiss or snooze an autonomous finding.
const findingResolveSchema = z.object({
  decision: z.enum(['dismiss', 'snooze']),
  snoozeDays: z.number().int().min(1).max(90).optional(),
});
fleetgraphRouter.post('/findings/:id/resolve', authMiddleware, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!z.string().uuid().safeParse(id).success) {
      res.status(404).json({ error: 'Finding not found' });
      return;
    }
    const parsed = findingResolveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.errors });
      return;
    }
    const snoozeUntil = parsed.data.decision === 'snooze'
      ? new Date(Date.now() + (parsed.data.snoozeDays ?? 7) * 86_400_000).toISOString()
      : null;
    await setFindingStatusById(
      req.workspaceId!,
      id,
      parsed.data.decision === 'snooze' ? 'snoozed' : 'dismissed',
      snoozeUntil,
    );
    res.json({ success: true, decision: parsed.data.decision });
  } catch (err) {
    console.error('FleetGraph finding resolve error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default fleetgraphRouter;
