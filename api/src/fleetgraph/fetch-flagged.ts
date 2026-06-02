/**
 * Flag-gated issue fetch (Epic 7 — Platform Citizen).
 *
 * This is intentionally a separate module from fetch.ts so the three
 * collaborators (flag check, DB path, SDK path) can be independently mocked
 * in tests without module-binding ordering issues.
 *
 * Control flow:
 *   flag OFF  →  fetchIssues (direct DB, unchanged)
 *   flag ON + workspace-wide scope  →  fetchIssuesViaSdk (SDK → /api/v1)
 *   flag ON + narrow scope  →  fetchIssues (DB fallback; logged)
 *
 * When PLUGFORGE_AGENT_VIA_SDK is ON and the scope is workspace-wide (no
 * entity/sprint/project/program/assignee filter), issues are fetched via the
 * @ship/sdk → /api/v1 path using a client_credentials token for the
 * ship_app_agent app (seeded by migration 043).
 *
 * For narrower scopes (entity IDs, sprint, project, etc.) the SDK path does
 * not yet support the required filters — we fall back to the direct DB query
 * transparently. This is logged so it is observable in production.
 *
 * When the flag is OFF, the direct DB path runs unconditionally (existing
 * behaviour — all existing tests pass with the flag unset).
 */
import { fetchIssues, isAgentViaSdkEnabled } from './fetch.js';
import type { IssueRow, Scope } from './types.js';

export async function fetchIssuesFlagged(workspaceId: string, scope: Scope): Promise<IssueRow[]> {
  if (!isAgentViaSdkEnabled()) {
    return fetchIssues(workspaceId, scope);
  }

  // SDK path only supports workspace-wide queries for now (no association filters).
  const hasNarrowScope = !!(
    (scope.entityIds && scope.entityIds.length > 0) ||
    scope.sprintId ||
    scope.projectId ||
    scope.programId ||
    scope.assigneeId
  );

  if (hasNarrowScope) {
    // Fall back to direct DB for scoped queries — log so it is observable.
    console.debug('[FleetGraph SDK] narrow scope detected — using direct DB path (SDK path is workspace-wide only)');
    return fetchIssues(workspaceId, scope);
  }

  // Lazy import so the SDK dependency is only loaded when the flag is ON.
  // This avoids any startup cost on the OFF path and keeps tests clean when
  // the flag is unset (no real HTTP calls attempted).
  const { fetchIssuesViaSdk } = await import('./fetch-sdk.js');
  return fetchIssuesViaSdk(workspaceId, scope);
}
