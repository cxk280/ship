// Pure dedup + adaptive-suppression decision. Kept dependency-free (no graph/LLM/DB imports) so
// the deterministic eval layer can import it without pulling in LangChain.
import type { Signal } from './types.js';
import type { KnownFinding } from './state.js';

/**
 * Drop a signal if its type has been dismissed >= threshold times (adaptive suppression), or if a
 * prior finding exists that is dismissed / still-snoozed / unchanged. Survivors are "novel".
 */
export function filterNovel(
  signals: Signal[],
  knownFindings: KnownFinding[],
  dismissals: Record<string, number>,
  opts?: { now?: number; suppressThreshold?: number },
): Signal[] {
  const known = new Map(knownFindings.map((k) => [k.dedupKey, k]));
  const now = opts?.now ?? Date.now();
  const suppressThreshold = opts?.suppressThreshold ?? Number(process.env.FLEETGRAPH_DISMISS_SUPPRESS_THRESHOLD ?? 3);
  return signals.filter((sig) => {
    if ((dismissals[sig.type] ?? 0) >= suppressThreshold) return false; // adaptive suppression
    const prior = known.get(sig.dedupKey);
    if (!prior) return true;                          // never seen
    if (prior.status === 'dismissed') return false;   // permanently suppressed
    if (prior.status === 'snoozed') {
      return prior.snoozeUntil ? new Date(prior.snoozeUntil).getTime() < now : false;
    }
    return prior.contentHash !== sig.contentHash;     // open/acted: re-surface only on material change
  });
}
