/**
 * Bridge logic — pure-ish functions wired to a GitHubClient + ShipClient.
 *
 * Ship → GitHub:  mirrorShipIssueToGitHub() — upsert a GitHub issue carrying a
 *                 `<!-- ship:issue:<id> -->` marker (idempotent).
 * GitHub → Ship:  linkGitHubEventToShip() — when a GitHub PR/issue references a
 *                 Ship issue, record the link as a Ship document (the public API
 *                 supports document.create; it does NOT support mutating an
 *                 existing issue, so we append a linked note rather than changing
 *                 status — see README "Limitations").
 */
import type { ShipClient } from '@ship/sdk';
import {
  GitHubClient,
  shipMarker,
  parseShipReference,
  type GitHubIssue,
} from './github.js';

// ---- Ship → GitHub ---------------------------------------------------------

/** The Ship webhook envelope data we care about (flat, per the event registry). */
export interface ShipIssueEventData {
  id: string;
  title: string;
  document_type?: string;
  state?: string; // present on issue.status_changed
  workspace_id?: string;
}

export interface MirrorResult {
  action: 'created' | 'updated' | 'skipped';
  githubIssue?: GitHubIssue;
  reason?: string;
}

/** Build the GitHub issue body for a Ship issue (includes the linking marker). */
export function buildGitHubBody(
  data: ShipIssueEventData,
  shipBaseUrl: string,
  eventType: string,
): string {
  const shipUrl = `${shipBaseUrl.replace(/\/$/, '')}/issues/${data.id}`;
  const lines = [
    `Mirrored from Ship issue [\`${data.id}\`](${shipUrl}).`,
    '',
    data.state ? `**Ship state:** \`${data.state}\`` : '',
    `**Last Ship event:** \`${eventType}\``,
    '',
    shipMarker(data.id),
  ].filter((l) => l !== '');
  return lines.join('\n');
}

/**
 * Create or update the GitHub issue mirroring a Ship issue. Idempotent: looks up
 * an existing mirror by the embedded marker. On `issue.status_changed` to a
 * done/cancelled state, the GitHub issue is closed; otherwise reopened.
 */
export async function mirrorShipIssueToGitHub(args: {
  github: GitHubClient;
  data: ShipIssueEventData;
  eventType: string;
  shipBaseUrl: string;
}): Promise<MirrorResult> {
  const { github, data, eventType, shipBaseUrl } = args;
  if (!data.id || !data.title) {
    return { action: 'skipped', reason: 'missing id/title' };
  }

  const body = buildGitHubBody(data, shipBaseUrl, eventType);
  const closedStates = new Set(['done', 'cancelled']);
  const desiredState: 'open' | 'closed' =
    data.state && closedStates.has(data.state) ? 'closed' : 'open';

  const existing = await github.findIssueByShipId(data.id);
  if (existing) {
    const issue = await github.updateIssue(existing.number, {
      title: data.title,
      body,
      state: desiredState,
    });
    return { action: 'updated', githubIssue: issue };
  }

  const issue = await github.createIssue({ title: data.title, body });
  // If the very first event already indicates a closed state, reflect it.
  if (desiredState === 'closed') {
    const closed = await github.updateIssue(issue.number, { state: 'closed' });
    return { action: 'created', githubIssue: closed };
  }
  return { action: 'created', githubIssue: issue };
}

// ---- GitHub → Ship ---------------------------------------------------------

export interface GitHubWebhookPayload {
  action?: string;
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    merged?: boolean;
    state?: string;
  };
  issue?: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state?: string;
  };
  repository?: { full_name?: string };
}

export interface LinkResult {
  action: 'linked' | 'ignored';
  shipIssueId?: string;
  reason?: string;
  documentId?: string;
}

/**
 * Inspect a GitHub `pull_request` / `issues` webhook payload. If it references a
 * Ship issue (via "ship#<id>" or the marker in the title/body), record the link
 * as a Ship document.
 *
 * Why a document and not an issue update? The public Ship API exposes
 * issues:read / issues:write(create) and documents:write, but NOT issue mutation
 * or comments. Creating a linked note is the strongest action the public surface
 * allows. See README "Limitations".
 */
export async function linkGitHubEventToShip(args: {
  ship: ShipClient;
  payload: GitHubWebhookPayload;
  eventName: string; // X-GitHub-Event header (e.g. "pull_request", "issues")
}): Promise<LinkResult> {
  const { ship, payload, eventName } = args;

  const subject = payload.pull_request ?? payload.issue;
  if (!subject) {
    return { action: 'ignored', reason: `no pull_request/issue in ${eventName} event` };
  }

  const shipIssueId =
    parseShipReference(subject.title) ?? parseShipReference(subject.body);
  if (!shipIssueId) {
    return { action: 'ignored', reason: 'no ship#<id> reference found' };
  }

  const isPr = Boolean(payload.pull_request);
  const kind = isPr ? 'PR' : 'issue';
  const action = payload.action ?? 'updated';
  const merged = payload.pull_request?.merged ? ' (merged)' : '';

  const title = `GitHub ${kind} ${action}${merged}: ${subject.title}`;
  const note = ship.documents.create({
    document_type: 'wiki',
    title,
    properties: {
      source: 'github-bridge',
      kind,
      action,
      github_url: subject.html_url,
      github_number: subject.number,
      ship_issue_id: shipIssueId,
      repository: payload.repository?.full_name ?? null,
      merged: payload.pull_request?.merged ?? null,
    },
  });

  const doc = await note;
  return { action: 'linked', shipIssueId, documentId: doc.id };
}
