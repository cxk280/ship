// Labeled eval scenarios for FleetGraph's deterministic detectors.
// Each case feeds synthetic inputs to the detectors and declares the finding types that SHOULD
// result. `expect: []` is a "stay quiet" case — the agent must produce nothing.
import type { IssueRow } from '../types.js';
import type { WeekRow, PersonRow, SprintProgress, WorkspaceMeta } from '../fetch.js';

export interface EvalCase {
  name: string;
  expect: string[]; // finding types that should be produced; [] = stay quiet
  now: Date;
  issues: IssueRow[];
  team?: PersonRow[];
  weeks?: WeekRow[];
  progress?: SprintProgress[];
  meta?: WorkspaceMeta;
  expectSeverities?: Record<string, string>; // assert a produced signal's severity, e.g. {overdue:'high'}
  expectRecipientsContain?: string[]; // assert these user ids appear among produced recipients
}

const NOW = new Date('2026-03-15T12:00:00Z');
const iso = (daysFromNow: number) => new Date(NOW.getTime() + daysFromNow * 86_400_000).toISOString();
const date = (daysFromNow: number) => iso(daysFromNow).slice(0, 10);

let _id = 0;
function issue(o: Partial<IssueRow> = {}): IssueRow {
  _id += 1;
  return {
    id: `i${_id}`, title: `Issue ${_id}`, ticketNumber: _id,
    state: 'todo', priority: 'medium', assigneeId: 'u1', assigneeName: 'Dana',
    estimate: 3, dueDate: null, source: 'internal',
    startedAt: null, updatedAt: iso(0), lastActivityAt: iso(0),
    sprintId: null, sprintNumber: null, projectId: null, ...o,
  };
}
const person = (o: Partial<PersonRow> & { personId: string; userId: string; name: string }): PersonRow => ({
  role: null, capacityHours: null, reportsTo: null, ...o,
});

export const CASES: EvalCase[] = [
  { name: 'healthy in-progress', expect: [], now: NOW,
    issues: [issue({ state: 'in_progress', lastActivityAt: iso(-1) })] },
  { name: 'overdue open issue', expect: ['overdue'], now: NOW,
    issues: [issue({ state: 'todo', dueDate: date(-3) })] },
  { name: 'unassigned + unestimated', expect: ['unassigned', 'unestimated'], now: NOW,
    issues: [issue({ state: 'todo', assigneeId: null, assigneeName: null, estimate: null })] },
  { name: 'stale in-progress', expect: ['stale_in_progress'], now: NOW,
    issues: [issue({ state: 'in_progress', startedAt: iso(-12), lastActivityAt: iso(-10) })] },
  { name: 'done + past due (quiet)', expect: [], now: NOW,
    issues: [issue({ state: 'done', dueDate: date(-5) })] },
  { name: 'future due date (quiet)', expect: [], now: NOW,
    issues: [issue({ state: 'todo', dueDate: date(5) })] },
  { name: 'capacity overload', expect: ['capacity_overload'], now: NOW,
    team: [person({ personId: 'p1', userId: 'u1', name: 'Dana', capacityHours: 10, reportsTo: 'mgr' }),
           person({ personId: 'p2', userId: 'u2', name: 'Sam', capacityHours: 20 })],
    issues: [issue({ assigneeId: 'u1', estimate: 6, state: 'todo' }),
             issue({ assigneeId: 'u1', estimate: 6, state: 'in_progress', lastActivityAt: iso(0) }),
             issue({ assigneeId: 'u2', estimate: 3, state: 'todo' })] },
  { name: 'capacity ok (quiet)', expect: [], now: NOW,
    team: [person({ personId: 'p1', userId: 'u1', name: 'Dana', capacityHours: 20 })],
    issues: [issue({ assigneeId: 'u1', estimate: 8, state: 'todo' })] },
  { name: 'sprint slip', expect: ['sprint_slip'], now: NOW,
    team: [person({ personId: 'p1', userId: 'u1', name: 'Dana' })],
    weeks: [{ id: 's1', title: 'Week 5', sprintNumber: 5, status: 'active', ownerId: 'p1', confidence: 80 }],
    progress: [{ sprintId: 's1', total: 10, done: 2 }],
    meta: { sprintStartDate: date(-(4 * 7 + 5)), sprintDuration: 7 }, // ~71% elapsed, 20% done
    issues: [] },
  { name: 'sprint on track (quiet)', expect: [], now: NOW,
    team: [person({ personId: 'p1', userId: 'u1', name: 'Dana' })],
    weeks: [{ id: 's2', title: 'Week 5', sprintNumber: 5, status: 'active', ownerId: 'p1', confidence: 60 }],
    progress: [{ sprintId: 's2', total: 10, done: 6 }],
    meta: { sprintStartDate: date(-(4 * 7 + 3)), sprintDuration: 7 }, // ~43% elapsed, 60% done
    issues: [] },

  // --- severity + recipient resolution ---
  { name: 'stale high severity (idle >= 2x threshold)', expect: ['stale_in_progress'], now: NOW,
    expectSeverities: { stale_in_progress: 'high' },
    issues: [issue({ state: 'in_progress', startedAt: iso(-12), lastActivityAt: iso(-8) })] },
  { name: 'overdue is high + notifies assignee', expect: ['overdue'], now: NOW,
    expectSeverities: { overdue: 'high' }, expectRecipientsContain: ['u1'],
    issues: [issue({ assigneeId: 'u1', dueDate: date(-2) })] },
  { name: 'unassigned in-progress is medium', expect: ['unassigned'], now: NOW,
    expectSeverities: { unassigned: 'medium' },
    issues: [issue({ state: 'in_progress', assigneeId: null, assigneeName: null, lastActivityAt: iso(0) })] },
  { name: 'capacity overload is high + notifies person & reports_to', expect: ['capacity_overload'], now: NOW,
    expectSeverities: { capacity_overload: 'high' }, expectRecipientsContain: ['u1', 'mgr'],
    team: [person({ personId: 'p1', userId: 'u1', name: 'Dana', capacityHours: 10, reportsTo: 'mgr' }),
           person({ personId: 'p2', userId: 'u2', name: 'Sam', capacityHours: 40 })],
    issues: [issue({ assigneeId: 'u1', estimate: 10, state: 'todo' }),
             issue({ assigneeId: 'u1', estimate: 8, state: 'in_progress', lastActivityAt: iso(0) })] },
  { name: 'sprint slip notifies owner', expect: ['sprint_slip'], now: NOW,
    expectRecipientsContain: ['u1'],
    team: [person({ personId: 'p1', userId: 'u1', name: 'Dana' })],
    weeks: [{ id: 's3', title: 'Week 5', sprintNumber: 5, status: 'active', ownerId: 'p1', confidence: 50 }],
    progress: [{ sprintId: 's3', total: 8, done: 1 }],
    meta: { sprintStartDate: date(-(4 * 7 + 5)), sprintDuration: 7 },
    issues: [] },
  { name: 'planning sprint not yet active (quiet)', expect: [], now: NOW,
    team: [person({ personId: 'p1', userId: 'u1', name: 'Dana' })],
    weeks: [{ id: 's4', title: 'Week 5', sprintNumber: 5, status: 'planning', ownerId: 'p1', confidence: 90 }],
    progress: [{ sprintId: 's4', total: 10, done: 0 }],
    meta: { sprintStartDate: date(-(4 * 7 + 5)), sprintDuration: 7 },
    issues: [] },
  { name: 'overdue but cancelled (quiet)', expect: [], now: NOW,
    issues: [issue({ state: 'cancelled', dueDate: date(-5) })] },
];
