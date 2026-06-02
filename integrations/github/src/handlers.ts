/**
 * HTTP handlers for the GitHub bridge.
 *
 *   POST /webhooks/ship    — signed Ship webhook → mirror to GitHub
 *   POST /webhooks/github  — signed GitHub webhook → link back to a Ship issue
 *
 * Both read the RAW body (Buffer) so HMAC verification uses the exact bytes.
 */
import type { Request, Response } from 'express';
import { verifyWebhook } from '@ship/sdk';
import type { ShipClient } from '@ship/sdk';
import { GitHubClient } from './github.js';
import { verifyGitHubSignature } from './github-verify.js';
import {
  mirrorShipIssueToGitHub,
  linkGitHubEventToShip,
  type ShipIssueEventData,
  type GitHubWebhookPayload,
} from './bridge.js';

export interface HandlerDeps {
  ship: ShipClient;
  github: GitHubClient;
  shipBaseUrl: string;
  /** Candidate Ship signing secrets (one per subscription). */
  shipSigningSecrets: string[];
  /** GitHub webhook shared secret. */
  githubWebhookSecret: string;
}

function rawBody(req: Request): string {
  return Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
}

/** Ship → GitHub. */
export async function handleShipWebhook(req: Request, res: Response, deps: HandlerDeps): Promise<void> {
  const body = rawBody(req);
  const secrets = [...deps.shipSigningSecrets, process.env.SHIP_WEBHOOK_SECRET ?? ''].filter(Boolean);

  if (secrets.length === 0) {
    console.warn('[github] no Ship signing secret configured — skipping verification');
  } else {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const valid = secrets.some((s) => verifyWebhook(headers, body, s));
    if (!valid) {
      res.status(400).json({ error: 'invalid_signature' });
      return;
    }
  }

  let event: { type?: string; data?: ShipIssueEventData };
  try {
    event = JSON.parse(body);
  } catch {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }

  const type = event.type ?? '';
  const data = event.data;
  const isIssueEvent =
    type.startsWith('issue.') ||
    (type.startsWith('document.') && data?.document_type === 'issue');

  if (!isIssueEvent || !data) {
    res.status(200).json({ ok: true, handled: false });
    return;
  }

  try {
    const result = await mirrorShipIssueToGitHub({
      github: deps.github,
      data,
      eventType: type,
      shipBaseUrl: deps.shipBaseUrl,
    });
    res.status(200).json({
      ok: true,
      handled: result.action !== 'skipped',
      action: result.action,
      reason: result.reason,
      github_number: result.githubIssue?.number,
      github_url: result.githubIssue?.html_url,
    });
  } catch (err) {
    console.error('[github] mirror failed:', err);
    res.status(502).json({ error: 'github_mirror_failed' });
  }
}

/** GitHub → Ship. */
export async function handleGitHubWebhook(req: Request, res: Response, deps: HandlerDeps): Promise<void> {
  const body = rawBody(req);
  const headers = req.headers as Record<string, string | string[] | undefined>;

  if (!deps.githubWebhookSecret) {
    console.warn('[github] GITHUB_WEBHOOK_SECRET not set — skipping verification');
  } else if (!verifyGitHubSignature(headers, body, deps.githubWebhookSecret)) {
    res.status(400).json({ error: 'invalid_signature' });
    return;
  }

  const eventName = (headers['x-github-event'] as string | undefined) ?? '';
  // GitHub sends a ping when a webhook is first registered.
  if (eventName === 'ping') {
    res.status(200).json({ ok: true, pong: true });
    return;
  }

  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(body) as GitHubWebhookPayload;
  } catch {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }

  if (eventName !== 'pull_request' && eventName !== 'issues') {
    res.status(200).json({ ok: true, handled: false, reason: `ignored event ${eventName}` });
    return;
  }

  try {
    const result = await linkGitHubEventToShip({ ship: deps.ship, payload, eventName });
    res.status(200).json({ ok: true, handled: result.action === 'linked', ...result });
  } catch (err) {
    console.error('[github] link failed:', err);
    res.status(502).json({ error: 'ship_link_failed' });
  }
}
