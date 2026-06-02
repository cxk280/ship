# Ship ↔ GitHub bridge

A **deployable** integration linking Ship issues and GitHub. It imports **only
`@ship/sdk`** (the public SDK) + the GitHub REST API via `fetch` (no Octokit) — no
`api/src` internals. It consumes Ship exactly as a third-party developer would:
an OAuth token + the public `/api/v1` API + signed webhooks verified with
`@ship/sdk`'s `verifyWebhook`.

```
Ship issue.* ──(signed webhook)──▶ bridge ──▶ GitHub issue   (mirror, idempotent via marker)
GitHub PR/issue ──(signed webhook)──▶ bridge ──▶ Ship document  (records the PR↔issue link)
```

## What it does

**Ship → GitHub.** Subscribes to Ship `issue.created` / `issue.status_changed`
(configurable via `SHIP_EVENTS`). On each event it upserts a GitHub issue in
`GITHUB_REPO`, carrying an embedded marker `<!-- ship:issue:<id> -->` so the
mirror is **idempotent** (a second event updates the same GitHub issue rather than
creating a duplicate). When the Ship issue reaches `done`/`cancelled`, the GitHub
issue is closed; otherwise it's (re)opened.

**GitHub → Ship (the PR↔issue link).** Exposes `POST /webhooks/github`. It verifies
the GitHub `X-Hub-Signature-256` HMAC, then — for `pull_request` and `issues`
events that reference a Ship issue (via `ship#<id>`, e.g. "Closes ship#<id>", or
the embedded marker) — records the link as a Ship **document** (a `wiki` note with
structured `properties`: the GitHub URL, action, PR number, and the referenced
Ship issue id).

## SDK / public-API surface used

| Use | SDK surface | HTTP |
| --- | --- | --- |
| Ship auth | `ShipClient.deviceLogin` / `ShipClient` (client_credentials) | `POST /oauth/device/code`, `POST /oauth/token` |
| Ship subscribe | `client.webhooks.list()/.create()/.delete()` | `GET/POST/DELETE /api/v1/webhooks` |
| Verify Ship deliveries | `verifyWebhook(headers, rawBody, secret)` | — |
| Record PR↔issue link | `client.documents.create(...)` | `POST /api/v1/documents` |
| GitHub | plain `fetch` | `GET /search/issues`, `POST/PATCH /repos/{repo}/issues` |

## Limitations (honest scoping)

The public Ship API exposes issues **read + create** and documents **create**, but
**not** issue mutation (PATCH) or issue comments. So GitHub → Ship records the link
as a **new Ship document** rather than changing the Ship issue's status or
appending a comment to it. If/when the public API gains `PATCH /issues/{id}` or a
comments endpoint, swap `documents.create` in `bridge.ts → linkGitHubEventToShip`
for a direct issue update — no internal imports required. This is intentional: the
bridge does not reach into `api/src`.

## Environment

| Var | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `4100` | HTTP port |
| `PUBLIC_URL` | for auto-subscribe | — | Public base URL (no trailing path). Empty → skip Ship auto-subscribe |
| `SHIP_BASE_URL` | no | `http://localhost:3000` | Ship API origin |
| `SHIP_CLIENT_ID` | yes | `ship_app_cli` | OAuth client id |
| `SHIP_CLIENT_SECRET` | no | — | Set → `client_credentials`; unset → device flow |
| `SHIP_SCOPES` | no | `issues:read issues:write documents:write webhooks:manage` | Device-flow scopes |
| `SHIP_EVENTS` | no | `issue.created,issue.status_changed` | Ship events to mirror |
| `SHIP_WEBHOOK_SECRET` | no | — | Verify an externally-managed subscription |
| `GITHUB_TOKEN` | yes | — | PAT with Issues read+write |
| `GITHUB_REPO` | yes | — | `owner/repo` for mirrored issues |
| `GITHUB_WEBHOOK_SECRET` | yes (for GH→Ship) | — | Shared secret for `X-Hub-Signature-256` |
| `GITHUB_API_BASE` | no | `https://api.github.com` | Override for GHE |

No secrets are committed — configure via env (`.env.example` provided).

## Deploy / run

```bash
# Build the SDK once, then this package:
pnpm install
pnpm build:shared && pnpm --filter @ship/sdk build
pnpm --filter @ship/github-integration build

# Configure:
cp integrations/github/.env.example integrations/github/.env
# edit integrations/github/.env  (GITHUB_TOKEN, GITHUB_REPO, GITHUB_WEBHOOK_SECRET, Ship auth)

# Expose the port publicly:
ngrok http 4100           # → set PUBLIC_URL to the https URL it prints

# Register the GitHub webhook (repo → Settings → Webhooks → Add webhook):
#   Payload URL:  <PUBLIC_URL>/webhooks/github
#   Content type: application/json
#   Secret:       <GITHUB_WEBHOOK_SECRET>
#   Events:       "Pull requests" and "Issues"

# Start:
pnpm --filter @ship/github-integration start
```

On startup the bridge authenticates to Ship, ensures the Ship → GitHub
subscriptions (pointing at `<PUBLIC_URL>/webhooks/ship`), and begins serving both
webhook endpoints. For unattended deploys (Railway/Render/Fly), use
`client_credentials` (`SHIP_CLIENT_SECRET`) so there's no interactive approval.

## Try it

1. Create or move a Ship issue → a GitHub issue appears in `GITHUB_REPO` with the
   marker; moving it to `done` closes the GitHub issue.
2. Open a GitHub PR whose body says `Closes ship#<the-ship-issue-id>` → a linked
   note document appears in Ship.

## Dev (no build)

```bash
pnpm --filter @ship/github-integration dev    # tsx src/server.ts
```

## Tests

```bash
pnpm --filter @ship/github-integration test
```

Covers marker/reference parsing, GitHub HMAC verification, idempotent mirroring
(create vs update vs close), the PR→Ship link, and both route handlers (Ship and
GitHub signatures) with fake clients — no live Ship/GitHub needed.
