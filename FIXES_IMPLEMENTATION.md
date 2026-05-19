# Fixes Implementation

This document tracks fixes implemented from the Phase 1 ShipShape audit. Source precedence: when the Kickoff and Week 4 PDFs conflict, the Kickoff PDF wins.

## Implementation Slice 1

### Stretch Goal Status

Stretch goals are pass criteria for the implementation phase.

| Stretch goal | Status | Evidence / next gate |
| --- | --- | --- |
| Main initial bundle at least 20% smaller and below the Vite warning threshold | Achieved | Main app chunk is now `470.85 kB / 140.59 kB gzip`, down from `2,025.10 KiB / 572.07 KiB gzip`. |
| 100% green API and web unit tests | Achieved for current local suites | API: 28 files / 451 tests passed against local Ship Postgres. Web: 16 files / 151 tests passed. |
| Working API and web coverage reports | Achieved | Added `@vitest/coverage-v8`; API and web coverage commands now generate reports. Added root `test:coverage` and web `test:coverage` scripts. |
| 80% coverage on changed files | Not yet achieved | Coverage tooling now proves the gap. Web overall is `28.45%` statements; API overall is `40.35%` statements. This remains a required follow-up gate, not optional. |
| 20% P95 reduction on `GET /api/team/accountability-grid-v3` and `GET /api/documents?type=wiki` | Implemented work, benchmark proof pending | Added route query narrowing plus targeted indexes. Must rerun the same seeded 50-concurrency benchmark to prove the exact P95 delta. |
| 20% main-page query-count reduction or 50% slowest-query improvement | Implemented work, benchmark proof pending | Batched accountability queries and added expression indexes. Must rerun the query-count and `EXPLAIN` audit to prove the exact delta. |
| 0 Critical/Serious axe violations on target pages | Partial | Removed invalid sidebar tree semantics. Full axe/Lighthouse rerun remains required before this gate is closed. |

### Bundle Size

- Converted most route pages in `web/src/main.tsx` from static imports to `React.lazy` route chunks.
- Added a Suspense fallback around the route tree while keeping the protected app shell static.
- Result: the main app chunk dropped from the audit baseline of `2,025.10 KiB min / 572.07 KiB gzip` to `470.85 kB / 140.59 kB gzip`, below Vite's `500 KiB` warning threshold.
- Remaining work: `PropertyRow` is still a large async chunk (`836.44 kB / 261.85 kB gzip`) and should be tackled in a later bundle pass.

Verification:

- `npx pnpm@10.27.0 --filter @ship/web build` passed.

### Runtime Error Handling

- Added UUID validation to `PATCH /api/documents/:id` in `api/src/routes/documents.ts`.
- Invalid document IDs now return `400` before reaching Postgres instead of producing a server error.
- Added a regression test for `PATCH /api/documents/not-a-uuid`.

Verification:

- `DATABASE_URL=postgres://ship:ship_dev_password@localhost:5433/ship_dev npx pnpm@10.27.0 --filter @ship/api exec vitest run src/routes/documents.test.ts` passed: 20 tests.
- `npx pnpm@10.27.0 --filter @ship/api type-check` passed.

### Test Coverage And Test Health

- Updated stale expectations in `web/src/lib/document-tabs.test.ts` to match the current week-based tab model.
- Updated `DetailsExtension` tests to include required child extensions and the current schema shape.
- Stabilized `useSessionTimeout` tests by resetting CSRF state and returning JSON-like mocked responses.
- Added `@vitest/coverage-v8`, a root `test:coverage` script, and a web `test:coverage` script so both API and web coverage reports can be generated.
- Result: the web unit suite moved from the audit baseline of failing tests to passing.

Verification:

- `npx pnpm@10.27.0 --filter @ship/web test` passed: 16 test files, 151 tests.
- `DATABASE_URL=postgres://ship:ship_dev_password@localhost:5433/ship_dev npx pnpm@10.27.0 --filter @ship/api test` passed: 28 test files, 451 tests.
- `DATABASE_URL=postgres://ship:ship_dev_password@localhost:5433/ship_dev npx pnpm@10.27.0 --filter @ship/api test:coverage` passed and generated API coverage.
- `npx pnpm@10.27.0 --filter @ship/web exec vitest run --coverage` passed and generated web coverage.

### Accessibility

- Removed partial ARIA tree semantics from the document navigation sidebar in `web/src/pages/App.tsx`.
- The sidebar now uses plain list/navigation semantics instead of declaring `tree`/`treeitem` roles without the full keyboard interaction contract.

Verification:

- `npx pnpm@10.27.0 --filter @ship/web type-check` passed.

### Database Query Efficiency

- Batched standup checks in `api/src/services/accountability.ts`.
- Replaced per-sprint standup lookup and last-standup lookup queries with two grouped queries across all active sprint IDs.
- Batched sprint issue counts in `checkSprintAccountability` instead of querying issue count once per sprint.
- Narrowed `GET /api/team/accountability-grid-v3` explicit assignments and inferred issue assignments to the displayed week range (`fromSprint` through `toSprint`) in SQL instead of fetching all workspace rows and filtering in memory.
- Added migration `038_shipshape_performance_indexes.sql` and matching schema indexes for active document lists, sprint-number range queries, weekly plan/retro lookups, and standup accountability lookups.

Verification:

- `npx pnpm@10.27.0 --filter @ship/api type-check` passed.
- `npx pnpm@10.27.0 --filter @ship/web type-check` passed.
- `DATABASE_URL=postgres://ship:ship_dev_password@localhost:5433/ship_dev npx pnpm@10.27.0 --filter @ship/api exec vitest run src/services/accountability.test.ts src/routes/documents.test.ts` passed: 2 files, 33 tests.
- `DATABASE_URL=postgres://ship:ship_dev_password@localhost:5433/ship_dev npx pnpm@10.27.0 --filter @ship/api db:migrate` passed against local Ship Postgres.
- Benchmark proof is still pending for the API/DB stretch-goal deltas.
