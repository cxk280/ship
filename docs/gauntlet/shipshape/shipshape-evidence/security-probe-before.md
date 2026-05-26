# ShipShape Security Probe Report

Target: `http://127.0.0.1:3400`
Started: 2026-05-23T15:35:45.131Z
Completed: 2026-05-23T15:35:49.743Z

## Summary

- Checks: 9/14 passed, 4 failed, 1 skipped
- Findings: 14
- By severity: `{"high":11,"medium":1,"critical":2}`

## Findings

### HIGH: Global CSP allows inline scripts

- Category: `manual-review`
- Status: `open`
- Description: Inline scripts weaken XSS defenses because injected script blocks can execute when other controls fail.
- Reproduction steps:
  - GET http://127.0.0.1:3400/health
  - Inspect the Content-Security-Policy response header
- Evidence:

```json
{
  "csp": "default-src 'self';script-src 'self' 'unsafe-inline';style-src 'self' 'unsafe-inline';img-src 'self' data: blob: https:;connect-src 'self' wss: ws:;font-src 'self' data:;object-src 'none';frame-src 'none';base-uri 'self';form-action 'self';frame-ancestors 'self';script-src-attr 'none';upgrade-insecure-requests"
}
```

### MEDIUM: Document title accepts raw HTML event-handler payload

- Category: `input-sanitization`
- Status: `open`
- Description: React escaping mitigates normal rendering, but storing raw script-like titles increases downstream XSS risk in future renderers, exports, logs, and notifications.
- Reproduction steps:
  - Login as dev@ship.local
  - POST http://127.0.0.1:3400/api/documents with title <img src=x onerror=alert('shipshape')>
  - Observe the raw payload returned and stored as the document title
- Evidence:

```json
{
  "status": 201,
  "id": "5ae189bb-f7c9-4fae-9155-6a1fd0ea0a36",
  "title": "<img src=x onerror=alert('shipshape')>"
}
```

### CRITICAL: High/Critical dependency vulnerability: fast-xml-parser

- Category: `dependencies`
- Status: `open`
- Description: fast-xml-parser has an entity encoding bypass via regex injection in DOCTYPE entity names
- Reproduction steps:
  - pnpm audit --json --prod
- Evidence:

```json
{
  "name": "fast-xml-parser",
  "severity": "critical",
  "title": "fast-xml-parser has an entity encoding bypass via regex injection in DOCTYPE entity names",
  "url": "https://github.com/advisories/GHSA-m7jm-9gc2-mpf2",
  "range": ">=5.0.0 <5.3.5",
  "featureImpact": "unknown or transitive application feature"
}
```

### HIGH: High/Critical dependency vulnerability: fast-xml-parser

- Category: `dependencies`
- Status: `open`
- Description: fast-xml-parser affected by DoS through entity expansion in DOCTYPE (no expansion limit)
- Reproduction steps:
  - pnpm audit --json --prod
- Evidence:

```json
{
  "name": "fast-xml-parser",
  "severity": "high",
  "title": "fast-xml-parser affected by DoS through entity expansion in DOCTYPE (no expansion limit)",
  "url": "https://github.com/advisories/GHSA-jmr7-xgp7-cmfj",
  "range": ">=5.0.0 <5.3.6",
  "featureImpact": "unknown or transitive application feature"
}
```

### HIGH: High/Critical dependency vulnerability: hono

- Category: `dependencies`
- Status: `open`
- Description: Hono vulnerable to arbitrary file access via serveStatic vulnerability 
- Reproduction steps:
  - pnpm audit --json --prod
- Evidence:

```json
{
  "name": "hono",
  "severity": "high",
  "title": "Hono vulnerable to arbitrary file access via serveStatic vulnerability ",
  "url": "https://github.com/advisories/GHSA-q5qw-h33p-qvwr",
  "range": "<4.12.4",
  "featureImpact": "unknown or transitive application feature"
}
```

### HIGH: High/Critical dependency vulnerability: @hono/node-server

- Category: `dependencies`
- Status: `open`
- Description: @hono/node-server has authorization bypass for protected static paths via encoded slashes in Serve Static Middleware
- Reproduction steps:
  - pnpm audit --json --prod
- Evidence:

```json
{
  "name": "@hono/node-server",
  "severity": "high",
  "title": "@hono/node-server has authorization bypass for protected static paths via encoded slashes in Serve Static Middleware",
  "url": "https://github.com/advisories/GHSA-wc8c-qw6v-h7f6",
  "range": "<1.19.10",
  "featureImpact": "unknown or transitive application feature"
}
```

### HIGH: High/Critical dependency vulnerability: express-rate-limit

- Category: `dependencies`
- Status: `open`
- Description: express-rate-limit: IPv4-mapped IPv6 addresses bypass per-client rate limiting on servers with dual-stack network
- Reproduction steps:
  - pnpm audit --json --prod
- Evidence:

```json
{
  "name": "express-rate-limit",
  "severity": "high",
  "title": "express-rate-limit: IPv4-mapped IPv6 addresses bypass per-client rate limiting on servers with dual-stack network",
  "url": "https://github.com/advisories/GHSA-46wh-pxpv-q5gq",
  "range": ">=8.2.0 <8.2.2",
  "featureImpact": "API authentication, routing, and database access"
}
```

### HIGH: High/Critical dependency vulnerability: fast-xml-parser

- Category: `dependencies`
- Status: `open`
- Description: fast-xml-parser affected by numeric entity expansion bypassing all entity expansion limits (incomplete fix for CVE-2026-26278)
- Reproduction steps:
  - pnpm audit --json --prod
- Evidence:

```json
{
  "name": "fast-xml-parser",
  "severity": "high",
  "title": "fast-xml-parser affected by numeric entity expansion bypassing all entity expansion limits (incomplete fix for CVE-2026-26278)",
  "url": "https://github.com/advisories/GHSA-8gc5-j5rx-235r",
  "range": ">=5.0.0 <5.5.6",
  "featureImpact": "unknown or transitive application feature"
}
```

### HIGH: High/Critical dependency vulnerability: path-to-regexp

- Category: `dependencies`
- Status: `open`
- Description: path-to-regexp vulnerable to Regular Expression Denial of Service via multiple route parameters
- Reproduction steps:
  - pnpm audit --json --prod
- Evidence:

```json
{
  "name": "path-to-regexp",
  "severity": "high",
  "title": "path-to-regexp vulnerable to Regular Expression Denial of Service via multiple route parameters",
  "url": "https://github.com/advisories/GHSA-37ch-88jc-xwx2",
  "range": "<0.1.13",
  "featureImpact": "unknown or transitive application feature"
}
```

### HIGH: High/Critical dependency vulnerability: path-to-regexp

- Category: `dependencies`
- Status: `open`
- Description: path-to-regexp vulnerable to Denial of Service via sequential optional groups
- Reproduction steps:
  - pnpm audit --json --prod
- Evidence:

```json
{
  "name": "path-to-regexp",
  "severity": "high",
  "title": "path-to-regexp vulnerable to Denial of Service via sequential optional groups",
  "url": "https://github.com/advisories/GHSA-j3q9-mxjg-w52f",
  "range": ">=8.0.0 <8.4.0",
  "featureImpact": "unknown or transitive application feature"
}
```

### HIGH: High/Critical dependency vulnerability: fast-uri

- Category: `dependencies`
- Status: `open`
- Description: fast-uri vulnerable to path traversal via percent-encoded dot segments
- Reproduction steps:
  - pnpm audit --json --prod
- Evidence:

```json
{
  "name": "fast-uri",
  "severity": "high",
  "title": "fast-uri vulnerable to path traversal via percent-encoded dot segments",
  "url": "https://github.com/advisories/GHSA-q3j6-qgpj-74h6",
  "range": "<=3.1.0",
  "featureImpact": "unknown or transitive application feature"
}
```

### HIGH: High/Critical dependency vulnerability: fast-uri

- Category: `dependencies`
- Status: `open`
- Description: fast-uri vulnerable to host confusion via percent-encoded authority delimiters
- Reproduction steps:
  - pnpm audit --json --prod
- Evidence:

```json
{
  "name": "fast-uri",
  "severity": "high",
  "title": "fast-uri vulnerable to host confusion via percent-encoded authority delimiters",
  "url": "https://github.com/advisories/GHSA-v39h-62p7-jpjc",
  "range": "<=3.1.1",
  "featureImpact": "unknown or transitive application feature"
}
```

### HIGH: Unexpected WebSocket message type is silently accepted

- Category: `websocket-validation`
- Status: `open`
- Description: The collaboration server should explicitly reject protocol message types outside the supported sync and awareness messages.
- Reproduction steps:
  - Login as dev@ship.local
  - Open WebSocket ws://127.0.0.1:3400/collaboration/wiki:5ae189bb-f7c9-4fae-9155-6a1fd0ea0a36 with the session cookie
  - Send a single-byte message with varuint type 99
  - Observe that the connection remains open instead of being rejected
- Evidence:

```json
{
  "closed": false,
  "readyState": 1
}
```

### CRITICAL: Malformed WebSocket message can crash the API process

- Category: `websocket-validation`
- Status: `open`
- Description: Malformed collaboration protocol input should be handled locally and close the offending connection without destabilizing the API.
- Reproduction steps:
  - Login as dev@ship.local
  - Open WebSocket ws://127.0.0.1:3400/collaboration/wiki:5ae189bb-f7c9-4fae-9155-6a1fd0ea0a36 with the session cookie
  - Send an empty binary message
  - Check whether the connection closes and /health still responds
- Evidence:

```json
{
  "malformedResult": {
    "closed": true,
    "code": 1006,
    "reason": "",
    "readyState": 3
  },
  "healthStatus": 0,
  "healthBody": {
    "error": "fetch failed"
  }
}
```

## Checks

| Category | Check | Status |
|---|---|---|
| manual-review | CSP script-src does not allow unsafe-inline | fail |
| manual-review | CORS does not use wildcard credentials | pass |
| auth-session | Unauthenticated auth/me access | pass |
| auth-session | Admin login | pass |
| auth-session | Session token entropy format | pass |
| auth-session | Member privilege escalation to super-admin route | pass |
| input-sanitization | Stored XSS title payload rejected or sanitized | fail |
| input-sanitization | Excessively long document title rejected | pass |
| input-sanitization | SQL injection title payload does not cause server error | pass |
| dependencies | Dependency vulnerability audit parsed | pass |
| websocket-validation | Unauthenticated collaboration WebSocket rejected | pass |
| websocket-validation | Unexpected collaboration message type rejected | fail |
| websocket-validation | Malformed empty collaboration message rejected without process crash | fail |
| websocket-validation | Oversized collaboration message rejected | skip |

