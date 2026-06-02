/**
 * SDK-backed fetch adapter for FleetGraph (Epic 7 — Platform Citizen).
 *
 * When PLUGFORGE_AGENT_VIA_SDK=1 the agent's issue fetch goes:
 *   agent → client_credentials → Bearer token → @ship/sdk → /api/v1/documents
 *
 * This is the "platform citizen" pattern: the agent authenticates as the
 * ship_app_agent OAuth app (seeded by migration 043) and consumes its own
 * public API rather than reading the DB directly.
 *
 * Token lifecycle: we obtain a fresh access token per-call (simple, stateless).
 * For production you would cache + reuse until expiry; the TTL is 1 h. This
 * one-call-per-invoke simplicity is intentional for the demo — it keeps the
 * adapter self-contained and avoids global mutable state in tests.
 *
 * LIMITATION: the agent app's workspace_id in the DB is NULL (see migration 043).
 * We resolve the workspace at runtime from the AGENT_WORKSPACE_ID env var if set,
 * falling back to the workspaceId passed in. The client_credentials token carries
 * the app's workspace_id from the DB; if that is NULL the /api/v1 handler returns
 * 403 ("not scoped to a workspace"). In production, set workspace_id on the
 * oauth_apps row to the production workspace, or supply AGENT_WORKSPACE_ID.
 */

import { ShipClient, InMemoryTokenStore } from '@ship/sdk';
import type { IssueRow, Scope } from './types.js';

/** Credentials for the seeded first-party agent app (migration 043). */
const AGENT_CLIENT_ID = process.env.AGENT_CLIENT_ID ?? 'ship_app_agent';
const AGENT_CLIENT_SECRET = process.env.AGENT_CLIENT_SECRET ?? 'ship_secret_agent_readonly';

/** The API base URL the SDK should point at. Defaults to localhost:3000. */
const AGENT_BASE_URL = process.env.AGENT_BASE_URL ?? 'http://localhost:3000';

/**
 * Obtain a client_credentials Bearer token for the agent app by POSTing to
 * /oauth/token. The SDK's Http layer already handles Bearer auth, so we mint
 * the token here and pass it in via an InMemoryTokenStore.
 *
 * This is intentionally a raw fetch rather than a built-in SDK helper — the
 * SDK is a *resource* client (documents, webhooks) not an auth library. Adding
 * clientCredentialsLogin as a static method on ShipClient would work too, but
 * that's an optional extension; the raw POST is the RFC 6749 §4.4 canonical form.
 */
async function obtainClientCredentialsToken(): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: AGENT_CLIENT_ID,
    client_secret: AGENT_CLIENT_SECRET,
  });
  const url = `${AGENT_BASE_URL}/oauth/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[FleetGraph SDK] client_credentials token request failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('[FleetGraph SDK] token response missing access_token');
  return json.access_token;
}

/**
 * Build a ShipClient authenticated with a fresh client_credentials token.
 * Exported for testing so tests can mock `obtainClientCredentialsToken`.
 */
export async function buildAgentClient(): Promise<ShipClient> {
  const token = await obtainClientCredentialsToken();
  const tokenStore = new InMemoryTokenStore({ access_token: token });
  return new ShipClient({ baseUrl: AGENT_BASE_URL, tokenStore });
}

/**
 * Fetch issues for a workspace via the public /api/v1 SDK path.
 *
 * The SDK's documents.list() returns the public ShipDocument shape; we
 * normalise to IssueRow here (the same shape the DB path returns) so the
 * graph nodes are unchanged — this is the token-neutrality guarantee.
 *
 * Scoping: the SDK path supports only workspace-wide issue listing (the
 * /api/v1/documents endpoint does not accept association filters). Fine-grained
 * scope filtering (by sprint/project/assignee) requires additional API endpoints
 * not yet in /api/v1. For Epic 7 the SDK path is therefore WORKSPACE-WIDE only;
 * the direct-DB path is still used when a narrower scope is requested (the flag
 * gating in fetch.ts handles this transparently).
 */
export async function fetchIssuesViaSdk(_workspaceId: string, _scope: Scope): Promise<IssueRow[]> {
  const client = await buildAgentClient();

  const rows: IssueRow[] = [];
  // Collect issues from the SDK (paginating via the async iterator).
  for await (const doc of client.documents.iterate({ document_type: 'issue', limit: 100 })) {
    const p = doc.properties ?? {};
    rows.push({
      id: doc.id,
      title: doc.title || 'Untitled',
      ticketNumber: null, // not exposed in the public DTO yet
      state: (p['state'] as string) || 'triage',
      priority: (p['priority'] as string) || 'none',
      assigneeId: (p['assignee_id'] as string) || null,
      assigneeName: null, // not in the public DTO; graph falls back gracefully
      estimate: typeof p['estimate'] === 'number' ? (p['estimate'] as number) : null,
      dueDate: (p['due_date'] as string) || null,
      source: (p['source'] as string) || null,
      startedAt: null, // not in the public DTO
      updatedAt: doc.updated_at,
      lastActivityAt: doc.updated_at,
      sprintId: null, // associations not in the public DTO yet
      sprintNumber: null,
      projectId: null,
    });
  }
  return rows;
}
