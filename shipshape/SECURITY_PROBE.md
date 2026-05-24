# ShipShape Security Probe

`scripts/security-probe.mjs` is a runnable Category 8 audit tool for active security checks against a live ShipShape API. It logs in as seeded users, exercises authenticated REST and WebSocket surfaces, runs a production dependency audit, and writes structured JSON plus Markdown reports with severity, evidence, and reproduction steps.

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

After the Category 8 fixes **and** the dependency-advisory remediation (2026-05-24), the probe reports `2` findings, both `Medium`, with `14/16` checks passing and **`0` Critical/High/dependency findings**. The closed findings are:

- Global CSP no longer allows inline scripts. The app now emits a per-request nonce in `script-src`, and the admin credentials page applies that nonce to its inline script.
- Unsupported collaboration message types now close with WebSocket code `1003`.
- Malformed collaboration messages now close with WebSocket code `1003` and leave `/health` available.
- Oversized collaboration payloads now close with WebSocket code `1009` without an uncaught process exception.
- **All high/critical dependency advisories are resolved** via pinned `pnpm.overrides` in the root `package.json`: `fast-xml-parser ^5.5.6` (closes the critical entity-encoding bypass + DoS advisories under `@aws-sdk`), `hono ^4.12.4`, `@hono/node-server ^1.19.10`, `express-rate-limit ^8.2.2` (also bumped as a direct dep), `fast-uri ^3.1.2`, and path-scoped `express>path-to-regexp 0.1.13` / `router>path-to-regexp ^8.4.0`. `pnpm audit --prod` now reports `0` high/critical (6 moderate + 1 low remain on the editor/websocket/express paths and are below the probe's gating threshold). Build, type-check, and the full unit suite still pass after the upgrade.

Remaining open findings:

| Severity | Category | Finding |
|---|---|---|
| Medium | Input sanitization | Document titles store raw HTML event-handler payload text. **Verified mitigated at output:** all render paths escape — React text rendering, TipTap text nodes, and the two manual `innerHTML` widgets (`CommentDisplay.tsx`, `AIScoringDisplay.tsx`) route every user value through an `escapeHtml()` helper. Input is intentionally stored verbatim to preserve fidelity (titles legitimately contain `<`, `>`); the correct control is output encoding, which is present and audited. |
| Medium | Input sanitization | Document content stores raw HTML event-handler payload text in TipTap text nodes, which render as escaped text (not HTML). Same verified output-encoding mitigation as above; sanitizing stored text would corrupt legitimate content (code blocks, math, comparisons) and is the wrong layer. |

## Remediation Summary

How each class of finding was handled:

| Finding | Status | How it was remediated |
|---|---|---|
| CSP allowed inline scripts (`script-src 'unsafe-inline'`) | **Fixed** | `api/src/app.ts` emits a per-request nonce; `script-src` is now `'self'` + nonce. The one inline-script page (`admin-credentials.ts`) threads the nonce through. Probe check now passes. |
| Malformed/unsupported/oversized WebSocket messages | **Fixed** | `api/src/collaboration/index.ts` wraps decode in try/catch, closes unsupported types with `1003`, malformed with `1003` (process stays up), oversized with `1009`. All 4 WebSocket probe checks pass. |
| CSP blocked the app's own Google Fonts (deployed app) | **Fixed** | `api/src/app.ts` adds `fonts.googleapis.com` to `style-src` and `fonts.gstatic.com` to `font-src`. Verified on the live Railway app (console error gone). |
| 1 Critical + 9 High dependency advisories | **Fixed** | Pinned `pnpm.overrides` in root `package.json`: `fast-xml-parser ^5.5.6`, `hono ^4.12.4`, `@hono/node-server ^1.19.10`, `express-rate-limit ^8.2.2` (also bumped direct), `fast-uri ^3.1.2`, path-scoped `express>path-to-regexp 0.1.13` / `router>path-to-regexp ^8.4.0`. `pnpm audit --prod` → 0 high/critical. Build, type-check, and 622 unit tests still pass. |
| 2 Medium stored-XSS (title/content stored raw) | **Mitigated, not code-changed** | Deliberately **not** remediated by input sanitization — that would corrupt legitimate content (`<`, `>`, code). Instead verified the correct control (output encoding) is present at every sink: React text, TipTap text nodes, and the two manual `innerHTML` widgets (`CommentDisplay.tsx`, `AIScoringDisplay.tsx`) all escape via `escapeHtml()`. The probe still reports these 2 as "fail" because it checks input storage, not output exploitability. |
| 6 Moderate + 1 Low dependency advisories | **Not addressed** | `markdown-it`, `ajv`, `yaml`, `ws`, `uuid`, `qs` — all transitive on the editor/websocket/express paths and below the probe's high/critical gate. Overriding them carries higher regression risk (editor markdown, query parsing, websocket), so they are tracked for a follow-up upgrade as upstreams patch. |

**Not fully closed:** the 2 medium stored-XSS findings remain "fail" in the probe (mitigated at output, not at input — see rationale above), and 6 moderate + 1 low dependency advisories are intentionally deferred. Everything Critical/High is remediated.

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
