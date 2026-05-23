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

After the fixes, the current enhanced probe reported `12` findings: `1` Critical, `9` High, and `2` Medium. The closed findings are:

- Global CSP no longer allows inline scripts. The app now emits a per-request nonce in `script-src`, and the admin credentials page applies that nonce to its inline script.
- Unsupported collaboration message types now close with WebSocket code `1003`.
- Malformed collaboration messages now close with WebSocket code `1003` and leave `/health` available.
- Oversized collaboration payloads now close with WebSocket code `1009` without an uncaught process exception.

Remaining open findings:

| Severity | Category | Finding |
|---|---|---|
| Critical | Dependencies | `fast-xml-parser` entity encoding bypass advisory. |
| High | Dependencies | Nine additional production dependency advisories across `fast-xml-parser`, `hono`, `@hono/node-server`, `express-rate-limit`, `path-to-regexp`, and `fast-uri`. |
| Medium | Input sanitization | Document titles accept and store raw HTML event-handler payload text. React escaping reduces immediate rendering risk, but downstream renderers, notifications, exports, and logs could reintroduce XSS exposure. |
| Medium | Input sanitization | Document content accepts and stores raw HTML event-handler payload text. TipTap text-node rendering reduces immediate rendering risk, but exported/previews/search snippets/future renderers could reintroduce XSS exposure. |

## Manual Review Notes

- **CORS/CSP:** CORS is configured with a single supplied origin and credentials, not wildcard credentials. Before the fix CSP allowed inline scripts; after the fix `script-src` uses `'self'` plus a nonce. Inline styles remain allowed for editor compatibility.
- **Secrets handling:** CAIA secrets are stored through Secrets Manager/SSM paths. The inspected admin credentials flow masks the client secret in the UI and logs only length, but it does log issuer URL and client ID. Error responses from credential validation can include upstream error text and should be tightened before production.
- **Rate limiting:** General API rate limiting, stricter login rate limiting, AI-analysis rate limiting, and WebSocket connection/message limits are present. The production dependency audit still flags `express-rate-limit`, so the package should be upgraded even though rate limiting exists.
- **Verbose error leakage:** Most API paths return generic errors. The admin credentials save/test flow can surface validation and issuer-discovery error strings to a super-admin, which is useful operationally but should be reviewed for upstream secret leakage.

## Interpreting Results

Severity follows the project audit rubric:

- **Critical:** direct unauthorized access, data loss/corruption, process crash from malformed input, or a high-confidence critical dependency advisory in production dependencies.
- **High:** important security control bypass, likely exploitable DoS, broad auth/session/CSP weakness, or high-severity production dependency advisory.
- **Medium:** real security hardening gap with mitigation or narrower blast radius.
- **Low:** diagnostic, polish, or future-risk item.

The probe is intentionally conservative. A finding means the behavior is verified or the dependency advisory is present; it does not always mean exploitability is proven in ShipShape's exact deployment path.
