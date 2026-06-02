/**
 * Ship ↔ GitHub bridge server (deployable).
 *
 *   Ship → GitHub: subscribes to Ship issue events and mirrors each Ship issue to
 *                  a GitHub issue (idempotent via an embedded marker).
 *   GitHub → Ship: receives signed GitHub pull_request/issues webhooks and, when a
 *                  PR/issue references a Ship issue ("ship#<id>" or the marker),
 *                  records the link as a Ship document.
 *
 * Configuration (env) — see README and .env.example:
 *   PORT, PUBLIC_URL, SHIP_BASE_URL, SHIP_CLIENT_ID[/SECRET], SHIP_EVENTS,
 *   GITHUB_TOKEN, GITHUB_REPO, GITHUB_WEBHOOK_SECRET, SHIP_WEBHOOK_SECRET (opt).
 */
import express from 'express';
import { GitHubClient } from './github.js';
import { ensureSubscriptions } from './subscribe.js';
import {
  handleShipWebhook,
  handleGitHubWebhook,
  type HandlerDeps,
} from './handlers.js';
import {
  PORT,
  PUBLIC_URL,
  SHIP_BASE_URL,
  SHIP_EVENTS,
  SHIP_WEBHOOK_PATH,
  GITHUB_WEBHOOK_PATH,
  GITHUB_TOKEN,
  GITHUB_REPO,
  GITHUB_WEBHOOK_SECRET,
  GITHUB_API_BASE,
  secretFile,
  makeShipClient,
} from './config.js';
import type { ShipClient } from '@ship/sdk';

/**
 * Mutable handler deps. `ship`/`shipSigningSecrets` are filled in by bootstrap();
 * the express routes close over this object so they see the populated values.
 */
export interface MutableDeps {
  ship: ShipClient | null;
  github: GitHubClient;
  shipBaseUrl: string;
  shipSigningSecrets: string[];
  githubWebhookSecret: string;
}

export function createApp(deps: MutableDeps): express.Express {
  const app = express();

  const asHandlerDeps = (): HandlerDeps => {
    if (!deps.ship) throw new Error('Ship client not initialized');
    return {
      ship: deps.ship,
      github: deps.github,
      shipBaseUrl: deps.shipBaseUrl,
      shipSigningSecrets: deps.shipSigningSecrets,
      githubWebhookSecret: deps.githubWebhookSecret,
    };
  };

  app.post(SHIP_WEBHOOK_PATH, express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    handleShipWebhook(req, res, asHandlerDeps()).catch((err: unknown) => {
      console.error('[github] unhandled error (ship):', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  });

  app.post(GITHUB_WEBHOOK_PATH, express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
    handleGitHubWebhook(req, res, asHandlerDeps()).catch((err: unknown) => {
      console.error('[github] unhandled error (github):', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  return app;
}

/** Authenticate to Ship and ensure subscriptions; populate `deps` in place. */
export async function bootstrap(deps: MutableDeps): Promise<void> {
  console.log('[github-bridge] Authenticating to Ship…');
  deps.ship = await makeShipClient();

  if (!PUBLIC_URL) {
    console.warn(
      '[github-bridge] PUBLIC_URL not set — skipping Ship auto-subscription. ' +
        'Set SHIP_WEBHOOK_SECRET to verify deliveries from a manually-created subscription.',
    );
    return;
  }

  const targetUrl = `${PUBLIC_URL.replace(/\/$/, '')}${SHIP_WEBHOOK_PATH}`;
  console.log(`[github-bridge] Ensuring Ship subscriptions → ${targetUrl}  (${SHIP_EVENTS.join(', ')})`);
  const result = await ensureSubscriptions({
    client: deps.ship,
    targetUrl,
    events: SHIP_EVENTS,
    secretFile,
  });
  deps.shipSigningSecrets = Object.values(result.secrets);
  if (result.created.length) console.log(`  created: ${result.created.join(', ')}`);
  if (result.reused.length) console.log(`  reused:  ${result.reused.join(', ')}`);
}

const isMain =
  process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');

if (isMain) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.error('[github-bridge] GITHUB_TOKEN and GITHUB_REPO are required.');
    process.exit(1);
  }

  const deps: MutableDeps = {
    ship: null,
    github: new GitHubClient({ token: GITHUB_TOKEN, repo: GITHUB_REPO, apiBase: GITHUB_API_BASE }),
    shipBaseUrl: SHIP_BASE_URL,
    shipSigningSecrets: [],
    githubWebhookSecret: GITHUB_WEBHOOK_SECRET,
  };

  const app = createApp(deps);
  app.listen(PORT, () => {
    console.log(`[github-bridge] Listening on http://localhost:${PORT}`);
    console.log(`  Ship webhook:   POST ${SHIP_WEBHOOK_PATH}`);
    console.log(`  GitHub webhook: POST ${GITHUB_WEBHOOK_PATH}`);
    if (!GITHUB_WEBHOOK_SECRET) {
      console.warn('  Warning: GITHUB_WEBHOOK_SECRET not set — GitHub deliveries will not be verified');
    }
    bootstrap(deps).catch((err: unknown) => {
      console.error('[github-bridge] bootstrap failed:', err);
      console.error('  The server is still listening; fix auth/PUBLIC_URL and restart to subscribe.');
    });
  });
}
