# ShipShape Security Probe

`scripts/security-probe.mjs` is a runnable Category 8 audit tool for active security checks against a live ShipShape API. It logs in as seeded users, exercises authenticated REST and WebSocket surfaces, runs a production dependency audit, and writes structured JSON plus Markdown reports with severity, evidence, and reproduction steps.

> **Web UI:** in addition to the CLI, a super-admin web dashboard ships at **`/security-probe`**. It has its own login layer (same ShipShape admin credentials; super-admin required), a one-click "Run Probe" that runs the full probe in-process against the app's own origin, and renders summary stats, per-attack-surface checks, and severity-coded findings. It uses **full-probe + auto-cleanup**: the input-sanitization checks create test documents and the run deletes every document it created before returning. Backend: `api/src/services/securityProbe.ts` + `POST /api/security-probe/run` (`api/src/routes/security-probe.ts`); frontend: `web/src/pages/SecurityProbe.tsx`. Design mocks (dashboard + login) are in Figma — `https://www.figma.com/design/MBqwt47oYEUotGSjufpkSC` — with rendered exports under `shipshape/shipshape-evidence/figma/`.

## What It Checks

The probe covers the eighth audit category from `Shipshape - Security Audit.pdf`:

- **Auth and session management:** unauthenticated protected-route access, seeded admin login, session cookie entropy format, and regular-member access to a super-admin route.
- **WebSocket validation:** unauthenticated collaboration socket rejection, unsupported message type handling, malformed message handling, and oversized payload handling.
- **Input sanitization:** stored document-title XSS payload acceptance, stored document-content XSS payload acceptance, reflected search-query XSS, long-title validation, and SQL-like title handling.
- **Dependency vulnerabilities:** production `npm audit --omit=dev` with `pnpm audit --prod` fallback when npm has no lockfile.
- **Manual-review support:** CSP/CORS header checks are automated; secrets handling, rate limiting, and verbose error leakage are reviewed against source plus probe output.

## How It Works

The probe uses Node `fetch` and a small cookie jar to simulate browser sessions. For mutating requests it fetches `/api/csrf-token` and sends the returned token in `x-csrf-token`, so the checks exercise the same CSRF path as the web client.

For WebSocket checks it uses the `ws` package to connect to `/collaboration/wiki:{documentId}`. The probe sends raw protocol bytes so it can verify behavior for invalid Yjs message types and malformed frames, not only normal client traffic.

For dependency checks it shells out to the package manager audit command and parses high/critical advisories into first-class findings. Each finding includes the package name, severity, advisory title, URL, affected range, and a coarse feature-impact mapping.

The tool exits with code `2` when any high or critical finding remains. This is intentional: the generated report is still written, and CI can treat unresolved high-severity security findings as a failing gate.

## How To Run

Start the API against seeded data, then run:

```bash
pnpm security:probe -- \
  --base-url http://127.0.0.1:3400 \
  --output shipshape/shipshape-evidence/security-probe-after.json \
  --markdown shipshape/shipshape-evidence/security-probe-after.md
```

Useful options:

| Option | Default | Purpose |
|---|---|---|
| `--base-url` | `http://127.0.0.1:3000` | Target API origin. |
| `--email` | `dev@ship.local` | Admin/super-admin seeded user. |
| `--password` | `admin123` | Admin password. |
| `--member-email` | `alice.chen@ship.local` | Regular member seeded user for privilege checks. |
| `--member-password` | same as admin password | Regular member password. |
| `--output` | `shipshape/shipshape-evidence/security-probe-report.json` | JSON report path. |
| `--markdown` | `shipshape/shipshape-evidence/security-probe-report.md` | Markdown report path. |

Equivalent environment variables are supported for the target and credentials:

- `SHIP_SECURITY_BASE_URL`
- `SHIP_SECURITY_EMAIL`
- `SHIP_SECURITY_PASSWORD`
- `SHIP_SECURITY_MEMBER_EMAIL`
- `SHIP_SECURITY_MEMBER_PASSWORD`

## Current Findings

Current before/after evidence is stored in:

- `shipshape/shipshape-evidence/security-probe-before.json`
- `shipshape/shipshape-evidence/security-probe-before.md`
- `shipshape/shipshape-evidence/security-probe-after.json`
- `shipshape/shipshape-evidence/security-probe-after.md`

Before the Category 8 fixes, the probe reported `14` findings: `2` Critical, `11` High, and `1` Medium. The verified issues included global `script-src 'unsafe-inline'`, unsupported WebSocket messages being silently accepted, and malformed collaboration messages crashing the API process.

After the Category 8 fixes, the dependency-advisory remediation, and the stored-XSS + member-provisioning work (2026-05-24), the probe reports **`16/16` checks passing and `0` findings** — locally (CLI) and on the deployed Railway app (web UI). The closed findings are:

- Global CSP no longer allows inline scripts. The app now emits a per-request nonce in `script-src`, and the admin credentials page applies that nonce to its inline script.
- Unsupported collaboration message types now close with WebSocket code `1003`.
- Malformed collaboration messages now close with WebSocket code `1003` and leave `/health` available.
- Oversized collaboration payloads now close with WebSocket code `1009` without an uncaught process exception.
- **All high/critical dependency advisories are resolved** via pinned `pnpm.overrides` in the root `package.json`: `fast-xml-parser ^5.5.6` (closes the critical entity-encoding bypass + DoS advisories under `@aws-sdk`), `hono ^4.12.4`, `@hono/node-server ^1.19.10`, `express-rate-limit ^8.2.2` (also bumped as a direct dep), `fast-uri ^3.1.2`, and path-scoped `express>path-to-regexp 0.1.13` / `router>path-to-regexp ^8.4.0`. `pnpm audit --prod` now reports `0` high/critical (6 moderate + 1 low remain on the editor/websocket/express paths and are below the probe's gating threshold). Build, type-check, and the full unit suite still pass after the upgrade.
- **Both stored-XSS findings are remediated.** `api/src/utils/sanitizeContent.ts` strips HTML tags from document titles and TipTap plain-text nodes on create + content update (code blocks preserved), so script-like payloads are neutralized at input on top of the existing React/TipTap output encoding. The two input-sanitization checks now pass; 465 API tests still pass (no-op on normal text).

No open probe findings remain. (6 moderate + 1 low dependency advisories on editor/websocket/express paths are below the probe's high/critical gate and tracked for a follow-up upgrade.)

Historical open findings (now closed):

| Severity | Category | Finding |
|---|---|---|
| Medium → **Resolved** | Input sanitization | Document titles stored raw HTML event-handler payload text. Now stripped of HTML tags at input by `sanitizeContent.ts` (on top of React/TipTap output encoding). Probe check passes. |
| Medium → **Resolved** | Input sanitization | Document content stored raw HTML in TipTap text nodes. Now stripped at input for plain-text nodes (code blocks preserved). Probe check passes. |

## Remediation Summary

How each class of finding was handled:

| Finding | Status | How it was remediated |
|---|---|---|
| CSP allowed inline scripts (`script-src 'unsafe-inline'`) | **Fixed** | `api/src/app.ts` emits a per-request nonce; `script-src` is now `'self'` + nonce. The one inline-script page (`admin-credentials.ts`) threads the nonce through. Probe check now passes. |
| Malformed/unsupported/oversized WebSocket messages | **Fixed** | `api/src/collaboration/index.ts` wraps decode in try/catch, closes unsupported types with `1003`, malformed with `1003` (process stays up), oversized with `1009`. All 4 WebSocket probe checks pass. |
| CSP blocked the app's own Google Fonts (deployed app) | **Fixed** | `api/src/app.ts` adds `fonts.googleapis.com` to `style-src` and `fonts.gstatic.com` to `font-src`. Verified on the live Railway app (console error gone). |
| 1 Critical + 9 High dependency advisories | **Fixed** | Pinned `pnpm.overrides` in root `package.json`: `fast-xml-parser ^5.5.6`, `hono ^4.12.4`, `@hono/node-server ^1.19.10`, `express-rate-limit ^8.2.2` (also bumped direct), `fast-uri ^3.1.2`, path-scoped `express>path-to-regexp 0.1.13` / `router>path-to-regexp ^8.4.0`. `pnpm audit --prod` → 0 high/critical. Build, type-check, and 622 unit tests still pass. |
| 2 Medium stored-XSS (title/content stored raw) | **Fixed** | `api/src/utils/sanitizeContent.ts` strips HTML tags from document titles and TipTap plain-text nodes on create + content update; code blocks are preserved verbatim (they legitimately contain markup, and TipTap escapes them on render). This neutralizes the payloads at input, on top of the existing output encoding (React text + the `escapeHtml()`-guarded `innerHTML` widgets `CommentDisplay.tsx`/`AIScoringDisplay.tsx`). Both probe input-sanitization checks now pass; 465 API tests still pass (no-op on normal text). |
| Member privilege-escalation check skipped on a setup-only deployment | **Fixed** | The probe now self-provisions a least-privilege member via the super-admin invite+accept flow when direct member login fails, so the check runs (member → 403 on `/api/admin/workspaces`) on any instance instead of skipping. |
| 6 Moderate + 1 Low dependency advisories | **Not addressed** | `markdown-it`, `ajv`, `yaml`, `ws`, `uuid`, `qs` — all transitive on the editor/websocket/express paths and below the probe's high/critical gate. Overriding them carries higher regression risk (editor markdown, query parsing, websocket), so they are tracked for a follow-up upgrade as upstreams patch. |

**Status:** all 16 probe checks pass with 0 findings (CLI and deployed web UI). The only deferred items are 6 moderate + 1 low transitive dependency advisories (below the probe's high/critical gate, on editor/websocket/express paths), tracked for a follow-up upgrade.

## Manual Review Notes

- **CORS/CSP:** CORS is configured with a single supplied origin and credentials, not wildcard credentials. Before the fix CSP allowed inline scripts; after the fix `script-src` uses `'self'` plus a nonce. Inline styles remain allowed for editor compatibility.
- **Secrets handling:** CAIA secrets are stored through Secrets Manager/SSM paths. The inspected admin credentials flow masks the client secret in the UI and logs only length, but it does log issuer URL and client ID. Error responses from credential validation can include upstream error text and should be tightened before production.
- **Rate limiting:** General API rate limiting, stricter login rate limiting, AI-analysis rate limiting, and WebSocket connection/message limits are present. `express-rate-limit` has been upgraded to `^8.2.2`, which closes the IPv4-mapped-IPv6 per-client bypass advisory (`GHSA-46wh-pxpv-q5gq`).
- **Verbose error leakage:** Most API paths return generic errors. The admin credentials save/test flow can surface validation and issuer-discovery error strings to a super-admin, which is useful operationally but should be reviewed for upstream secret leakage.

## Interpreting Results

Severity follows the project audit rubric:

- **Critical:** direct unauthorized access, data loss/corruption, process crash from malformed input, or a high-confidence critical dependency advisory in production dependencies.
- **High:** important security control bypass, likely exploitable DoS, broad auth/session/CSP weakness, or high-severity production dependency advisory.
- **Medium:** real security hardening gap with mitigation or narrower blast radius.
- **Low:** diagnostic, polish, or future-risk item.

The probe is intentionally conservative. A finding means the behavior is verified or the dependency advisory is present; it does not always mean exploitability is proven in ShipShape's exact deployment path.
