# Ship → Slack bridge

A **deployable** integration that subscribes to Ship webhooks and posts formatted
messages to a Slack channel. It imports **only `@ship/sdk`** (the public SDK) — no
`api/src` internals — so it consumes the platform exactly as a third-party
developer would: an OAuth token + the public webhook API + signed deliveries
verified with `@ship/sdk`'s `verifyWebhook`.

```
Ship  ──(signed webhook: document.created / issue.created)──▶  this server  ──▶  Slack Incoming Webhook
```

## What it does

On startup the server:

1. **Authenticates to Ship** — `client_credentials` if `SHIP_CLIENT_SECRET` is set,
   otherwise the RFC 8628 **Device Authorization Grant** (prints a code to approve in
   a browser on first run; the token is persisted so restarts don't re-prompt).
2. **Ensures webhook subscriptions** for the configured events, pointing at its own
   public URL (`PUBLIC_URL` + `/webhooks/ship`). Idempotent — it won't create
   duplicates. The one-time `signing_secret` returned by `webhooks.create()` is
   cached locally so deliveries can be verified.
3. **Receives + verifies deliveries** — reads the raw body, verifies the
   `Ship-Signature` HMAC with `verifyWebhook`, then posts to Slack
   (e.g. "📄 New document created: *Title*").

## SDK / public-API surface used

| Use | SDK surface | HTTP |
| --- | --- | --- |
| Auth | `ShipClient.deviceLogin` / `ShipClient` (client_credentials) | `POST /oauth/device/code`, `POST /oauth/token` |
| Subscribe | `client.webhooks.list()` / `.create()` / `.delete()` | `GET/POST/DELETE /api/v1/webhooks` |
| Verify deliveries | `verifyWebhook(headers, rawBody, secret)` | — (HMAC SHA-256 over `t.rawBody`) |

## Environment

| Var | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `4000` | HTTP port the bridge listens on |
| `PUBLIC_URL` | for auto-subscribe | — | Public base URL Ship delivers to (no trailing path). Empty → skip auto-subscribe |
| `SHIP_BASE_URL` | no | `http://localhost:3000` | Ship API origin |
| `SHIP_CLIENT_ID` | yes | `ship_app_cli` | OAuth client id |
| `SHIP_CLIENT_SECRET` | no | — | Set → `client_credentials`; unset → device flow |
| `SHIP_SCOPES` | no | `documents:read webhooks:manage` | Scopes for device flow |
| `SHIP_EVENTS` | no | `document.created,issue.created` | Comma-separated events to subscribe to |
| `SLACK_WEBHOOK_URL` | no | — | Slack Incoming Webhook URL; if unset, messages are logged |
| `SHIP_WEBHOOK_SECRET` | no | — | Verify an externally-managed subscription (when `PUBLIC_URL` is empty) |
| `SHIP_TOKEN_FILE` | no | `~/.ship/slack-bridge.json` | Where the device token is cached |
| `SHIP_WEBHOOK_SECRET_FILE` | no | `~/.ship/slack-bridge-secret.json` | Where signing secrets are cached |

No secrets are committed — configure everything via env (`.env.example` provided).

## Deploy / run

```bash
# From the repo root — build the SDK once, then this package:
pnpm install
pnpm build:shared && pnpm --filter @ship/sdk build
pnpm --filter @ship/slack-integration build

# Configure:
cp integrations/slack/.env.example integrations/slack/.env
# edit integrations/slack/.env

# Expose the port publicly (pick one):
ngrok http 4000           # → set PUBLIC_URL to the https URL it prints
# cloudflared tunnel --url http://localhost:4000

# Get a Slack Incoming Webhook URL:
#   Slack → Apps → "Incoming Webhooks" → Add to a channel → copy the URL into SLACK_WEBHOOK_URL.

# Start (loads env from your shell / process manager):
pnpm --filter @ship/slack-integration start
```

On a platform like Railway/Render/Fly: set the env vars in the dashboard, set
`PUBLIC_URL` to the service's public URL, and use `client_credentials`
(`SHIP_CLIENT_SECRET`) so there's no interactive device approval. The start
command is `node dist/server.js` (`pnpm start`).

## Dev (no build)

```bash
pnpm --filter @ship/slack-integration dev    # tsx src/server.ts
```

## Tests

```bash
pnpm --filter @ship/slack-integration test
```

Covers signature verification (valid/tampered/expired/wrong-secret), event
formatting (`document.created`, `issue.created`, `issue.assigned`), and the
idempotent subscription logic with a fake Ship client.

## Notes & limitations

- Slack delivery uses a plain **Incoming Webhook URL** (one channel per URL). Add
  more channels by running additional instances with different `SLACK_WEBHOOK_URL`s.
- Each Ship subscription has its own signing secret; the handler verifies a
  delivery against any configured secret.
- The signing-secret cache is keyed by target URL — change `PUBLIC_URL` and the
  bridge recreates subscriptions to obtain fresh secrets.
