// Labeled cases for the pure dedup + adaptive-suppression decision (`filterNovel`).
// Each case: incoming signals + prior known findings + dismissal counts → which dedupKeys survive.
import type { Signal } from '../types.js';
import type { KnownFinding } from '../state.js';

const NOW = Date.parse('2026-03-15T12:00:00Z');
const at = (daysFromNow: number) => new Date(NOW + daysFromNow * 86_400_000).toISOString();

function sig(o: Partial<Signal> & { type: string; dedupKey: string }): Signal {
  return {
    severity: 'medium', entityId: 'e1', entityType: 'issue', entityLabel: '#1',
    evidence: {}, contentHash: 'h1', recipients: [], ...o,
  };
}
function known(o: Partial<KnownFinding> & { dedupKey: string; status: string }): KnownFinding {
  return { contentHash: 'h1', snoozeUntil: null, ...o };
}

export interface DedupCase {
  name: string;
  signals: Signal[];
  known: KnownFinding[];
  dismissals?: Record<string, number>;
  now?: number;
  expectNovel: string[]; // dedupKeys expected to survive
}

export const DEDUP_CASES: DedupCase[] = [
  { name: 'never seen → novel',
    signals: [sig({ type: 'overdue', dedupKey: 'overdue:1' })], known: [], expectNovel: ['overdue:1'] },
  { name: 'open + unchanged hash → suppressed',
    signals: [sig({ type: 'overdue', dedupKey: 'overdue:1', contentHash: 'h1' })],
    known: [known({ dedupKey: 'overdue:1', status: 'open', contentHash: 'h1' })], expectNovel: [] },
  { name: 'open + changed hash → re-surfaces (worsened)',
    signals: [sig({ type: 'overdue', dedupKey: 'overdue:1', contentHash: 'h2' })],
    known: [known({ dedupKey: 'overdue:1', status: 'open', contentHash: 'h1' })], expectNovel: ['overdue:1'] },
  { name: 'acted + unchanged → suppressed',
    signals: [sig({ type: 'overdue', dedupKey: 'overdue:1', contentHash: 'h1' })],
    known: [known({ dedupKey: 'overdue:1', status: 'acted', contentHash: 'h1' })], expectNovel: [] },
  { name: 'dismissed → permanently suppressed (even if worsened)',
    signals: [sig({ type: 'overdue', dedupKey: 'overdue:1', contentHash: 'h2' })],
    known: [known({ dedupKey: 'overdue:1', status: 'dismissed', contentHash: 'h1' })], expectNovel: [] },
  { name: 'snoozed not expired → suppressed',
    now: NOW,
    signals: [sig({ type: 'overdue', dedupKey: 'overdue:1', contentHash: 'h2' })],
    known: [known({ dedupKey: 'overdue:1', status: 'snoozed', snoozeUntil: at(2) })], expectNovel: [] },
  { name: 'snoozed expired → re-surfaces',
    now: NOW,
    signals: [sig({ type: 'overdue', dedupKey: 'overdue:1', contentHash: 'h2' })],
    known: [known({ dedupKey: 'overdue:1', status: 'snoozed', snoozeUntil: at(-1) })], expectNovel: ['overdue:1'] },
  { name: 'adaptive suppression at threshold (3 dismissed of type)',
    signals: [sig({ type: 'unestimated', dedupKey: 'unestimated:5' })], known: [],
    dismissals: { unestimated: 3 }, expectNovel: [] },
  { name: 'adaptive suppression below threshold (2 dismissed)',
    signals: [sig({ type: 'unestimated', dedupKey: 'unestimated:5' })], known: [],
    dismissals: { unestimated: 2 }, expectNovel: ['unestimated:5'] },
  { name: 'mixed batch: one suppressed, one novel',
    signals: [sig({ type: 'overdue', dedupKey: 'overdue:1', contentHash: 'h1' }),
              sig({ type: 'stale_in_progress', dedupKey: 'stale_in_progress:2' })],
    known: [known({ dedupKey: 'overdue:1', status: 'open', contentHash: 'h1' })],
    expectNovel: ['stale_in_progress:2'] },
];
