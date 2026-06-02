/**
 * Epic 7 — Platform Citizen feature flag tests.
 *
 * Proves:
 * 1. With PLUGFORGE_AGENT_VIA_SDK unset (OFF), fetchIssuesFlagged delegates to
 *    the direct DB path (fetchIssues from fetch.ts) — no SDK call attempted.
 * 2. With PLUGFORGE_AGENT_VIA_SDK=1 (ON) and a workspace-wide scope, the SDK
 *    path is invoked (fetchIssuesViaSdk from fetch-sdk.ts).
 * 3. With the flag ON but a narrow scope (entityIds), the direct DB path is
 *    used as a fallback (the SDK path doesn't support association filters yet).
 *
 * We test fetch-flagged.ts in isolation by mocking its two collaborators:
 *   - fetch.ts (fetchIssues + isAgentViaSdkEnabled)
 *   - fetch-sdk.ts (fetchIssuesViaSdk)
 *
 * No real HTTP calls or DB queries are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IssueRow, Scope } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-test-epic7';
const MOCK_SDK_ROWS: IssueRow[] = [
  {
    id: 'sdk-doc-1',
    title: 'SDK issue',
    ticketNumber: null,
    state: 'todo',
    priority: 'medium',
    assigneeId: null,
    assigneeName: null,
    estimate: null,
    dueDate: null,
    source: null,
    startedAt: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    lastActivityAt: '2026-06-01T00:00:00.000Z',
    sprintId: null,
    sprintNumber: null,
    projectId: null,
  },
];

const MOCK_DB_ROWS: IssueRow[] = [
  {
    id: 'db-doc-2',
    title: 'DB issue',
    ticketNumber: 42,
    state: 'in_progress',
    priority: 'high',
    assigneeId: 'user-1',
    assigneeName: 'Alice',
    estimate: 3,
    dueDate: null,
    source: 'internal',
    startedAt: null,
    updatedAt: '2026-06-01T00:00:00.000Z',
    lastActivityAt: '2026-06-01T00:00:00.000Z',
    sprintId: null,
    sprintNumber: null,
    projectId: null,
  },
];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock fetch.ts: control both fetchIssues (the DB path) and isAgentViaSdkEnabled
// (the flag). isAgentViaSdkEnabled reads process.env at call time so on/off
// tests in the same process work correctly.
const mockFetchIssues = vi.fn<(workspaceId: string, scope: Scope) => Promise<IssueRow[]>>();
vi.mock('../fetch.js', async (orig) => {
  const actual = await orig<typeof import('../fetch.js')>();
  return {
    ...actual,
    fetchIssues: mockFetchIssues,
    isAgentViaSdkEnabled: () => {
      const v = process.env.PLUGFORGE_AGENT_VIA_SDK;
      return !!v && v !== '0' && v.toLowerCase() !== 'false';
    },
  };
});

// Mock the SDK adapter so no real HTTP calls are made.
const mockFetchIssuesViaSdk = vi.fn<(workspaceId: string, scope: Scope) => Promise<IssueRow[]>>();
vi.mock('../fetch-sdk.js', () => ({
  fetchIssuesViaSdk: mockFetchIssuesViaSdk,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchIssuesFlagged — feature flag routing (Epic 7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchIssues.mockResolvedValue(MOCK_DB_ROWS);
    mockFetchIssuesViaSdk.mockResolvedValue(MOCK_SDK_ROWS);
    // Default: flag OFF
    delete process.env.PLUGFORGE_AGENT_VIA_SDK;
  });

  afterEach(() => {
    delete process.env.PLUGFORGE_AGENT_VIA_SDK;
  });

  it('flag OFF: delegates to the direct DB path (fetchIssues)', async () => {
    // Flag is unset — existing behaviour must be unchanged.
    const { fetchIssuesFlagged } = await import('../fetch-flagged.js');
    const scope: Scope = {};
    const result = await fetchIssuesFlagged(WORKSPACE_ID, scope);

    expect(mockFetchIssues).toHaveBeenCalledOnce();
    expect(mockFetchIssues).toHaveBeenCalledWith(WORKSPACE_ID, scope);
    expect(mockFetchIssuesViaSdk).not.toHaveBeenCalled();
    expect(result).toEqual(MOCK_DB_ROWS);
  });

  it('flag ON + workspace-wide scope: SDK path is invoked with Bearer token data', async () => {
    process.env.PLUGFORGE_AGENT_VIA_SDK = '1';
    const { fetchIssuesFlagged } = await import('../fetch-flagged.js');
    const scope: Scope = {}; // no entityIds / sprint / project — workspace-wide
    const result = await fetchIssuesFlagged(WORKSPACE_ID, scope);

    // The SDK path was taken — agent acts as a first-party platform citizen.
    expect(mockFetchIssuesViaSdk).toHaveBeenCalledOnce();
    expect(mockFetchIssuesViaSdk).toHaveBeenCalledWith(WORKSPACE_ID, scope);
    expect(mockFetchIssues).not.toHaveBeenCalled();
    // The SDK rows flow through unchanged (token-neutral IssueRow shape).
    expect(result).toEqual(MOCK_SDK_ROWS);
  });

  it('flag ON + narrow scope (entityIds): falls back to direct DB path', async () => {
    process.env.PLUGFORGE_AGENT_VIA_SDK = '1';
    const { fetchIssuesFlagged } = await import('../fetch-flagged.js');
    const scope: Scope = { entityIds: ['entity-abc'] }; // narrow scope
    const result = await fetchIssuesFlagged(WORKSPACE_ID, scope);

    // SDK doesn't support entity-scoped queries yet → transparent DB fallback.
    expect(mockFetchIssues).toHaveBeenCalledOnce();
    expect(mockFetchIssues).toHaveBeenCalledWith(WORKSPACE_ID, scope);
    expect(mockFetchIssuesViaSdk).not.toHaveBeenCalled();
    expect(result).toEqual(MOCK_DB_ROWS);
  });

  it('flag ON + sprint scope: falls back to direct DB path', async () => {
    process.env.PLUGFORGE_AGENT_VIA_SDK = '1';
    const { fetchIssuesFlagged } = await import('../fetch-flagged.js');
    const scope: Scope = { sprintId: 'sprint-xyz' };
    await fetchIssuesFlagged(WORKSPACE_ID, scope);

    expect(mockFetchIssues).toHaveBeenCalledOnce();
    expect(mockFetchIssuesViaSdk).not.toHaveBeenCalled();
  });

  it('flag ON + project scope: falls back to direct DB path', async () => {
    process.env.PLUGFORGE_AGENT_VIA_SDK = '1';
    const { fetchIssuesFlagged } = await import('../fetch-flagged.js');
    const scope: Scope = { projectId: 'project-xyz' };
    await fetchIssuesFlagged(WORKSPACE_ID, scope);

    expect(mockFetchIssues).toHaveBeenCalledOnce();
    expect(mockFetchIssuesViaSdk).not.toHaveBeenCalled();
  });

  it('flag value "false" is treated as OFF', async () => {
    process.env.PLUGFORGE_AGENT_VIA_SDK = 'false';
    const { fetchIssuesFlagged } = await import('../fetch-flagged.js');
    const scope: Scope = {};
    await fetchIssuesFlagged(WORKSPACE_ID, scope);

    expect(mockFetchIssues).toHaveBeenCalledOnce();
    expect(mockFetchIssuesViaSdk).not.toHaveBeenCalled();
  });

  it('flag value "0" is treated as OFF', async () => {
    process.env.PLUGFORGE_AGENT_VIA_SDK = '0';
    const { fetchIssuesFlagged } = await import('../fetch-flagged.js');
    const scope: Scope = {};
    await fetchIssuesFlagged(WORKSPACE_ID, scope);

    expect(mockFetchIssues).toHaveBeenCalledOnce();
    expect(mockFetchIssuesViaSdk).not.toHaveBeenCalled();
  });
});
