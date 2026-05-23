# Agent Persona UAT Fixes

Purpose: this file records fixes made in the main implementation thread in response to complaints raised by personas from `./shipshape/USERS.md`.

No persona UAT has been started yet.

## Operating Rules

- Persona testers report complaints only. They do not change code, data, configuration, tests, or documentation other than their complaint report.
- Human personas MUST use the application through the browser just like real end users.
- Fixes are made in the main thread only.
- Every persona complaint that leads to a change must be documented here.
- After each fix, the same persona must be re-run against the same scenario, browser, viewport, and starting conditions until that persona has no remaining complaints for that scenario.
- A fix is not closed until the re-run result is recorded.

## Fix Log Template

```markdown
## Fix YYYY-MM-DD-N

- Persona:
- Scenario:
- Original complaint:
- Severity: Blocker | High | Medium | Low
- Root cause:
- Files changed:
- Fix summary:
- Verification performed:
- Re-run result:
- Remaining complaints:
- Status: Open | Fixed, awaiting re-run | Closed
```

## Fix Log

## Fix 2026-05-20-1

- Persona: Program Executive Sponsor
- Scenario: Log in through the browser, review the cross-program dashboard, open Programs, and drill into the Ship Core program.
- Original complaint: The action-items modal reopened after dismissal during navigation, blocking clicks into program details and forcing the user to keep clearing the same personal task prompt.
- Severity: High
- Root cause: The auto-open behavior only tracked dismissal in React component state. Route/query changes could satisfy the pending-items condition again during the same browser session, causing the modal overlay to reappear.
- Files changed: `web/src/pages/App.tsx`
- Fix summary: Added a session-scoped dismissal flag for the action-items modal and wired the modal close handler through it, so a user who dismisses the prompt is not blocked again in the same browser session.
- Verification performed: Pending re-run.
- Re-run result: Pending.
- Remaining complaints: Pending.
- Status: Fixed, awaiting re-run
