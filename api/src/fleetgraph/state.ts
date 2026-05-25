// The LangGraph state schema shared by both modes.
// Reducer choices: `raw` shallow-merges (parallel fetch nodes each own a key);
// signals/findings/emitted concat (accumulate); scalars are last-write.
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  Mode, TriggerKind, Scope, Signal, Finding, ProposedAction, ApprovalDecision, CostTally,
} from './types.js';

export interface KnownFinding {
  dedupKey: string;
  status: string;
  contentHash: string | null;
  snoozeUntil: string | null;
}

export const FleetGraphState = Annotation.Root({
  // ---- entry / identity (set by the trigger) ----
  mode: Annotation<Mode>({ reducer: (_a, b) => b, default: () => 'proactive' }),
  triggerKind: Annotation<TriggerKind>({ reducer: (_a, b) => b, default: () => 'cron' }),
  workspaceId: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  actorUserId: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  scope: Annotation<Scope>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  userMessage: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  runId: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),

  // ---- parallel fetch fan-in (shallow-merge) ----
  raw: Annotation<Record<string, unknown>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),

  // ---- detection / dedup ----
  signals: Annotation<Signal[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  knownFindings: Annotation<KnownFinding[]>({ reducer: (_a, b) => b, default: () => [] }),
  novelSignals: Annotation<Signal[]>({ reducer: (_a, b) => b, default: () => [] }),

  // ---- reasoning ----
  keptSignals: Annotation<Signal[]>({ reducer: (_a, b) => b, default: () => [] }),
  findings: Annotation<Finding[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  answer: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),

  // ---- action / HITL ----
  proposedActions: Annotation<ProposedAction[]>({ reducer: (_a, b) => b, default: () => [] }),
  approvalDecision: Annotation<ApprovalDecision | null>({ reducer: (_a, b) => b, default: () => null }),
  snoozeUntil: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),

  // ---- output / bookkeeping ----
  emitted: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  cost: Annotation<CostTally>({
    reducer: (a, b) => ({
      tier1Tokens: a.tier1Tokens + b.tier1Tokens,
      tier2Tokens: a.tier2Tokens + b.tier2Tokens,
      usd: a.usd + b.usd,
    }),
    default: () => ({ tier1Tokens: 0, tier2Tokens: 0, usd: 0 }),
  }),
});

export type FleetGraphStateType = typeof FleetGraphState.State;
