# ShipShape AI Cost Analysis

Review date: 2026-05-23

## Spend

Exact dollar spend is **not recoverable from the repository** because no token ledger, provider billing export, or per-session usage record was checked in during the project. That is a submission weakness: the Kickoff asks for spend plus reflection, and the spend portion should have been tracked from the start.

What can be stated from the repo evidence:

| Cost Source | Repo Evidence | Dollar Amount |
|---|---|---:|
| AI assistant work through Codex/OpenAI | Conversation happened outside the repo; no usage export is checked in. | Unknown |
| Third-party AI APIs in the app | No CAIA/AWS Bedrock credentials were configured during the local audit/probe runs; logs repeatedly show `CAIA not configured`. | $0 verified from local runs |
| Security probe/dependency audit | Local Node/PNPM commands only. | $0 |
| Lighthouse/axe/Vitest/Playwright local verification | Local tooling only. | $0 |

For final submission, attach the actual provider billing export or a manual ledger with model, input tokens, output tokens, and price per run. Without that, this file is a reflection artifact, not complete cost proof.

## How AI Was Used

AI was useful for codebase comprehension and audit organization:

- Turning the assignment PDFs into checklists and grading gates.
- Navigating unfamiliar TypeScript/React/Express/Yjs code paths quickly.
- Drafting audit sections, severity language, and before/after evidence summaries.
- Designing a security probe workflow that exercised auth/session, WebSocket, input, dependency, and header surfaces.
- Reviewing the submission against the assignment text and surfacing packaging gaps.

AI was less useful where exact local state mattered:

- It could not know whether a public deployment, demo video, or social post existed unless those URLs were supplied or committed.
- It could not truthfully invent billing data after the fact.
- It needed local command output to avoid stale claims about test counts, coverage, and probe findings.
- It could suggest benchmarks, but the grade depended on actual before/after measurements under controlled conditions.

## Addendum — 2026-05-24 (Claude Code / Opus 4.7)

A second AI tool was used for the final pass: **Claude Code (Opus 4.7)** drove an independent adversarial re-grade of the Codex output, then implemented and verified the remediations — accessibility regressions, the CSP/font defect, dependency-advisory overrides, the `/api/projects` query rewrite, the stored-XSS input sanitization, and a deployed Security Probe web UI (with auto-cleanup + member self-provisioning) that now reports 16/16 checks. Effectiveness notes for this pass:

- **High value:** catching a real ARIA regression that broke an existing E2E test, proving the "0 axe violations" claim false against the *running* app (vs. the repo), and writing reproducible measurement scripts (`shipshape-type-violations.ts`, `shipshape-axe-scan.mjs`) so claims are verifiable with one command rather than trusted from prose.
- **Where it needed grounding:** every probe/test/deploy claim was re-checked against live command output and the deployed app (e.g. the prod 16/16 was confirmed in the browser, not assumed); the model also surfaced and self-corrected a regression where new probe code temporarily broke the type-safety gate.
- **Cost:** still not captured as a token/dollar ledger (same gap as the Codex pass) — the lesson below stands for both tools.

## What I Would Do Differently

1. Start a `shipshape/AI_USAGE_LEDGER.csv` on day one with timestamp, tool/model, task, input/output token counts, and estimated cost.
2. Keep raw machine-readable evidence for every benchmark and coverage run under `shipshape/shipshape-evidence/`.
3. Record external artifact URLs as soon as they exist: deployed app, demo video, and social post.
4. Treat AI-generated audit prose as a draft only; every metric should be backed by a local command log, JSON report, or screenshot.
