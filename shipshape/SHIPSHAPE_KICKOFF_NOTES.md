# ShipShape Kickoff Notes

Date read: May 18, 2026  
Source: `/Users/christopherking/Desktop/Gauntlet/ShipShape — Kickoff.pdf`  
Purpose: Durable working memory for the ShipShape audit and implementation sprint. Use with `GFA Week 4 - ShipShape.pdf`.

Source precedence: if `ShipShape - Kickoff.pdf` and `GFA Week 4 - ShipShape.pdf` contradict one another, follow the Kickoff PDF.

## Core Mandate

ShipShape is about inheriting a production TypeScript system, understanding it deeply, measuring its health, diagnosing weaknesses, and improving it with proof.

The defining skill being tested is senior-engineer codebase inheritance:

- orient in an unfamiliar system,
- read before changing,
- measure before optimizing,
- document reasoning,
- prove impact under reproducible conditions.

The core principle is:

```text
read > write
```

Reading code is not preparation for the work. Reading code is the work.

## Target System

Repository: `US-Department-of-the-Treasury/ship`

Product: Ship, a Treasury project management tool combining:

- documentation,
- issues,
- sprints/weeks,
- project/program planning,
- real-time collaboration.

Stack:

- monorepo with pnpm workspaces,
- React, Vite, Tailwind frontend,
- TipTap + Yjs editor,
- Express + Node backend,
- PostgreSQL database,
- WebSocket + Yjs CRDT real-time sync,
- Playwright E2E tests,
- Docker and Terraform infrastructure.

Load-bearing architecture decision:

- "Everything is a document."
- Docs, issues, projects, and sprints/weeks share a unified document model.

## Week Structure

Two phases, one bar:

1. Phase 1: The Audit, 36 hours.
   - Diagnosis.
   - Written report with baseline measurements for all seven categories.
   - Include tools, methodology, raw data, and ranked findings.
   - Do not fix anything during the audit.
   - Incomplete audit is an automatic fail.

2. Phase 2: Implementation, 4.5 days.
   - Treatment.
   - Measurable improvement in every category.
   - Not "pick three"; all seven categories must improve.
   - Every improvement needs before/after benchmarks under identical conditions.
   - Tests must still pass.
   - Root cause must be documented.

## Seven Categories And Improvement Gates

1. Type Safety
   - Audit: `any`, `as`, non-null assertions, TS directives, strict mode.
   - Gate: eliminate 25% of type-safety violations.
   - Proper narrowing required; replacing `any` with `unknown` without real narrowing does not count.

2. Bundle Size
   - Audit: treemap, chunks, code splitting, dead dependencies.
   - Gate: 15% total bundle reduction, or 20% reduction in initial load through code splitting.

3. API Response Time
   - Audit: P50, P95, P99 under concurrent load.
   - Gate: 20% P95 reduction on at least two endpoints under identical conditions.

4. Database Queries
   - Audit: N+1, indexes, query count, `EXPLAIN ANALYZE`.
   - Gate: 20% fewer queries on one user flow, or 50% improvement on the slowest query.

5. Test Coverage
   - Audit: Playwright coverage, gaps, flakes, runtime.
   - Gate: add three meaningful tests for untested critical paths, or fix three flaky tests with root cause analysis.

6. Runtime Errors
   - Audit: boundaries, network failure, malformed input, edge cases.
   - Gate: fix three error-handling gaps; at least one must involve a real user-facing data-loss or confusion scenario.

7. Accessibility
   - Audit: Lighthouse, axe, WCAG 2.1 AA, keyboard.
   - Gate: +10 Lighthouse points on the worst page, or fix all Critical/Serious violations on the three most important pages.

## Rules Of Engagement

1. Before/after proof is mandatory.
   - Reproducible measurement.
   - Identical conditions.
   - Required for every category.

2. Tests must still pass.
   - If a change breaks a test, either fix the test with justification or revert the change.

3. Document reasoning.
   - What changed.
   - Why the original was suboptimal.
   - Why the new approach is better.
   - What tradeoffs were made.

4. No cosmetic changes.
   - Renames, reformatting, and comments do not count unless they directly support measurable improvement.

5. Commit discipline matters.
   - Labeled branches.
   - Descriptive commits.
   - Logical separation of changes.
   - Git history will be read.

6. Depth over breadth.
   - Targeted, well-documented fixes beat scattered superficial fixes.

Operational slogan:

```text
Proof over promises.
```

## Orientation Checklist Emphasis

Hour 0-4 orientation is mandatory before measuring:

1. Repository overview.
   - Clone and run.
   - Document setup gaps.
   - Read every file in `docs/`.
   - Read `shared/` end to end.
   - Diagram `web/`, `api/`, and `shared/`.

2. Data model.
   - Map schema and relationships.
   - Understand the unified document table.
   - Understand `document_type`.
   - Understand linking, parent-child relationships, and project membership.
   - Understand how these relationships are queried at runtime.

3. Request flow.
   - Trace one user action end to end.
   - Suggested example: create issue.
   - Follow React component to API route to database query and back.
   - Identify middleware order, side effects, and short-circuit points.
   - Understand auth and unauthenticated request behavior.

4. Real-time collaboration.
   - How the WebSocket is established and authenticated.
   - Presence and cursor messages.
   - Yjs CRDT sync.
   - What happens when two users edit the same field.
   - Where and when Yjs state is persisted.
   - Source of truth on reconnect.

5. TypeScript patterns.
   - TS version and config.
   - Strict mode and package overrides.
   - Examples of generics, discriminated unions, utility types, and type guards.
   - Unknown patterns should become discovery candidates.

6. Tests and infrastructure.
   - Playwright structure and fixtures.
   - Test database setup and reset.
   - Test runtime and pass/fail count.
   - Dockerfile and docker-compose services.
   - Terraform/cloud expectations.
   - CI/CD gates and cadence.

7. Synthesis.
   - Three strongest architecture decisions.
   - Three weakest points.
   - What breaks at 10x.
   - What to tell a new engineer first.

## Discovery Requirement

Find three things in the codebase that were new or notable.

For each:

- name the thing,
- cite file path and line range,
- explain what it does and why it matters,
- describe how to apply the knowledge in a future project.

Keep a running notes file all week.

The point is not just the metric moved by some percentage. The point is what will be remembered and reused in the next job.

## Submission Checklist

Final deliverables:

- forked GitHub repo with improvements on clearly labeled branches,
- setup guide in README,
- audit report with baselines for all seven categories,
- methodology, tools, and raw data,
- improvement docs per category:
  - before measurement,
  - root cause,
  - fix,
  - after measurement,
  - reproducibility proof,
- discovery write-up with three things learned,
- 3-5 minute demo video walking through findings and before/after proof,
- AI cost analysis and reflection,
- deployed improved app,
- social post on X or LinkedIn with key findings tagging `@GauntletAI`.

## Grading Weights

- Measurable improvement: 40%.
- Technical depth: 25%.
- TypeScript quality: 15%.
- Documentation quality: 10%.
- Commit discipline: 10%.

Roughly half the grade is "can you prove it."

Measurement and writing are not the boring parts of the week. They are the week.

## Practical Working Rules For This Repo

- Treat `SHIPSHAPE_AUDIT_REPORT.md`, `SHIPSHAPE_ORIENTATION.md`, this file, and the Week 4 PDF as the working compass.
- During implementation, each category needs a clear before baseline from the audit and an after measurement run under comparable conditions.
- Favor fixes that attack root causes already found in the audit.
- Avoid speculative refactors, broad rewrites, or aesthetic cleanup unless tied directly to a measured category target.
- Keep raw evidence paths or commands for every measurement so the final docs and demo can reproduce the work.
