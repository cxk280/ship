# ShipShape Security Probe Report

Target: `http://127.0.0.1:3000`
Started: 2026-05-24T16:25:22.932Z
Completed: 2026-05-24T16:25:26.706Z

## Summary

- Checks: 16/16 passed, 0 failed, 0 skipped
- Findings: 0
- By severity: `{}`

## Findings

No findings.
## Checks

| Category | Check | Status |
|---|---|---|
| manual-review | CSP script-src does not allow unsafe-inline | pass |
| manual-review | CORS does not use wildcard credentials | pass |
| auth-session | Unauthenticated auth/me access | pass |
| auth-session | Admin login | pass |
| auth-session | Session token entropy format | pass |
| auth-session | Member privilege escalation to super-admin route | pass |
| input-sanitization | Stored XSS title payload rejected or sanitized | pass |
| input-sanitization | Stored XSS content payload rejected or sanitized | pass |
| input-sanitization | Reflected XSS search query is not echoed raw | pass |
| input-sanitization | Excessively long document title rejected | pass |
| input-sanitization | SQL injection title payload does not cause server error | pass |
| dependencies | Dependency vulnerability audit parsed | pass |
| websocket-validation | Unauthenticated collaboration WebSocket rejected | pass |
| websocket-validation | Unexpected collaboration message type rejected | pass |
| websocket-validation | Malformed empty collaboration message rejected without process crash | pass |
| websocket-validation | Oversized collaboration message rejected | pass |

