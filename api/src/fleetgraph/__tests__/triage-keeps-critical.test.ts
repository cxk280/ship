// Regression: triage must never drop a high-severity ("critical") signal, even when the Tier-1
// model returns a keep-list that omits it. High signals are kept by construction; the model only
// prunes lower-severity noise. This is what makes the LLM keeps_critical eval deterministic.
import { describe, it, expect, vi } from 'vitest';
import type { Signal } from '../types.js';

// Mock the LLM: pretend it's available and have it keep only candidate #1 (drop the rest).
vi.mock('../llm.js', async (orig) => {
  const actual = await orig<typeof import('../llm.js')>();
  return {
    ...actual,
    isLlmAvailable: () => true,
    invokeTier: async () => ({ text: '{"keep":[1]}', inputTokens: 1, outputTokens: 1, usd: 0 }),
  };
});

const { evalTriage } = await import('../graph.js');

const sig = (o: Partial<Signal> & { dedupKey: string; severity: Signal['severity'] }): Signal => ({
  type: 'x', entityId: 'e', entityType: 'issue', entityLabel: 'L', evidence: {}, contentHash: 'h', recipients: [], ...o,
});

describe('triage keeps critical signals by construction', () => {
  it('keeps every high-severity signal; the model only prunes lower-severity candidates', async () => {
    const { keptSignals } = await evalTriage([
      sig({ dedupKey: 'overdue:1', severity: 'high' }),       // critical — kept regardless of model
      sig({ dedupKey: 'unestimated:2', severity: 'low' }),    // candidate #1 — model keeps
      sig({ dedupKey: 'unestimated:3', severity: 'low' }),    // candidate #2 — model drops
    ]);
    const keys = (keptSignals ?? []).map((s) => s.dedupKey);
    expect(keys).toContain('overdue:1');
    expect(keys).toContain('unestimated:2');
    expect(keys).not.toContain('unestimated:3');
  });

  it('keeps all signals without calling the model when every signal is high-severity', async () => {
    const { keptSignals } = await evalTriage([
      sig({ dedupKey: 'overdue:1', severity: 'high' }),
      sig({ dedupKey: 'stale_in_progress:2', severity: 'high' }),
    ]);
    const keys = (keptSignals ?? []).map((s) => s.dedupKey).sort();
    expect(keys).toEqual(['overdue:1', 'stale_in_progress:2']);
  });
});
