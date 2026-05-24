# ShipShape Security Probe Report

Target: `http://127.0.0.1:3000`
Started: 2026-05-24T14:34:13.917Z
Completed: 2026-05-24T14:34:17.194Z

## Summary

- Checks: 14/16 passed, 2 failed, 0 skipped
- Findings: 2
- By severity: `{"medium":2}`

## Findings

### MEDIUM: Document title accepts raw HTML event-handler payload

- Category: `input-sanitization`
- Status: `open`
- Description: React escaping mitigates normal rendering, but storing raw script-like titles increases downstream XSS risk in future renderers, exports, logs, and notifications.
- Reproduction steps:
  - Login as dev@ship.local
  - POST http://127.0.0.1:3000/api/documents with title <img src=x onerror=alert('shipshape')>
  - Observe the raw payload returned and stored as the document title
- Evidence:

```json
{
  "status": 201,
  "id": "159f24f0-13fa-4205-be53-5074e71d68d2",
  "title": "<img src=x onerror=alert('shipshape')>"
}
```

### MEDIUM: Document content accepts raw HTML event-handler payload text

- Category: `input-sanitization`
- Status: `open`
- Description: TipTap text rendering usually escapes text nodes, but storing raw script-like content increases downstream XSS risk in exports, previews, search snippets, notifications, and future renderers.
- Reproduction steps:
  - Login as dev@ship.local
  - PATCH http://127.0.0.1:3000/api/documents/159f24f0-13fa-4205-be53-5074e71d68d2/content with a TipTap text node containing <svg onload=alert('shipshape-content')>
  - Observe the raw payload returned and stored in document content
- Evidence:

```json
{
  "status": 200,
  "id": "159f24f0-13fa-4205-be53-5074e71d68d2",
  "content": {
    "type": "doc",
    "content": [
      {
        "type": "paragraph",
        "content": [
          {
            "text": "<svg onload=alert('shipshape-content')>",
            "type": "text"
          }
        ]
      }
    ]
  }
}
```

## Checks

| Category | Check | Status |
|---|---|---|
| manual-review | CSP script-src does not allow unsafe-inline | pass |
| manual-review | CORS does not use wildcard credentials | pass |
| auth-session | Unauthenticated auth/me access | pass |
| auth-session | Admin login | pass |
| auth-session | Session token entropy format | pass |
| auth-session | Member privilege escalation to super-admin route | pass |
| input-sanitization | Stored XSS title payload rejected or sanitized | fail |
| input-sanitization | Stored XSS content payload rejected or sanitized | fail |
| input-sanitization | Reflected XSS search query is not echoed raw | pass |
| input-sanitization | Excessively long document title rejected | pass |
| input-sanitization | SQL injection title payload does not cause server error | pass |
| dependencies | Dependency vulnerability audit parsed | pass |
| websocket-validation | Unauthenticated collaboration WebSocket rejected | pass |
| websocket-validation | Unexpected collaboration message type rejected | pass |
| websocket-validation | Malformed empty collaboration message rejected without process crash | pass |
| websocket-validation | Oversized collaboration message rejected | pass |

