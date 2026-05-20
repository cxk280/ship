# ShipShape Week 4 Audit Report

Audit date: 2026-05-18

Scope rule: this report is diagnosis only. No product-code fixes were made while collecting these baselines.

## Measurement Summary

The Week 4 audit requires each category to describe the tools, commands, and methodology used before presenting baseline numbers. Each category below includes a detailed `Methodology` section; this table is the quick map.

| Category | How It Was Measured |
|---|---|
| Type Safety | TypeScript config review, monorepo `type-check`, and a TypeScript compiler-API scan of `web/src`, `api/src`, and `shared/src` for `any`, assertions, non-null assertions, TS directives, untyped params, and missing return types. |
| Bundle Size | Production Vite build output, `web/dist/assets` chunk counts/sizes, gzip sizes, `vite-bundle-visualizer` raw/sourcemap data, dependency attribution, and import-path review. |
| API Response Time | Seeded local Postgres benchmark database, authenticated local API session, `autocannon` at 10/25/50 concurrency, and a Node HTTP latency harness for exact P50/P95/P99. |
| Database Query Efficiency | PostgreSQL statement-duration logging around marked user flows, parsed `docker logs`, representative `EXPLAIN (ANALYZE, BUFFERS)`, and index review. |
| Test Coverage and Quality | Test script/config review, static and runtime test inventory, API and web Vitest runs, Playwright test listing, skip/focus scans, and API coverage command attempt. |
| Runtime Error and Edge Cases | Local API/web servers against seeded data, Playwright-driven browser probes, console/page/request/server-log capture, malformed input tests, offline/reconnect checks, concurrency checks, and static error-boundary review. |
| Accessibility Compliance | `@axe-core/playwright` scans, Lighthouse accessibility audits, keyboard smoke testing, and source/test review for ARIA, focus, and keyboard patterns. |

## 1. Type Safety

### Methodology

- Reviewed root and package TypeScript configs: `tsconfig.json`, `web/tsconfig.json`, `api/tsconfig.json`, and `shared/tsconfig.json`.
- Ran the monorepo type check with `npx pnpm@10.27.0 type-check`.
- Scanned `web/src`, `api/src`, and `shared/src` with the TypeScript compiler API, excluding `node_modules`, `dist`, `build`, and declaration files.
- Counted:
  - explicit `any` via `AnyKeyword`
  - type assertions via `as` expressions and angle-bracket type assertions
  - non-null assertions via `NonNullExpression`
  - `@ts-ignore` / `@ts-expect-error` comments
  - untyped parameters
  - functions without explicit return types
- Ranked violation-dense files by the core audit violations: `any + as + non-null assertions + TS suppression directives`.

### Baseline Metrics

Strict mode status: **enabled** in root, web, API, and shared TypeScript configs.

Strict-mode error count: **0**. `npx pnpm@10.27.0 type-check` completed successfully across `shared`, `web`, and `api`.

| Package | Files Scanned | Explicit `any` | Type Assertions `as` | Non-null `!` | TS Directives | Untyped Params | Missing Return Types |
|---|---:|---:|---:|---:|---:|---:|---:|
| `web` | 197 | 33 | 372 | 33 | 1 | 1,163 | 3,203 |
| `api` | 108 | 227 | 317 | 296 | 0 | 280 | 1,239 |
| `shared` | 8 | 0 | 2 | 0 | 0 | 0 | 0 |
| **Total** | **313** | **260** | **691** | **329** | **1** | **1,443** | **4,442** |

### Top Violation-Dense Production Files

| Rank | File | Package | `any` | `as` | `!` | Directives | Core Total | Why It Matters |
|---:|---|---|---:|---:|---:|---:|---:|---|
| 1 | `api/src/routes/weeks.ts` | API | 11 | 26 | 48 | 0 | 85 | High-volume route module with broad week, plan, review, standup, and accountability behavior. Unsafe request/session assumptions and row-shape casts can affect critical workflows. |
| 2 | `api/src/routes/projects.ts` | API | 15 | 10 | 26 | 0 | 51 | Project routes transform JSONB document rows into project/sprint/retro responses. Assertions hide mismatches between database properties and API response contracts. |
| 3 | `api/src/routes/issues.ts` | API | 4 | 8 | 37 | 0 | 49 | Issue creation and mutation are central product flows. Non-null assertions on auth/workspace/route params increase risk of runtime failures around permissions and state transitions. |
| 4 | `web/src/pages/UnifiedDocumentPage.tsx` | Web | 0 | 36 | 1 | 0 | 37 | Converts generic document responses into type-specific UI models. Heavy casting means backend contract drift can surface as incorrect UI state instead of compile-time errors. |
| 5 | `api/src/db/seed.ts` | API | 0 | 0 | 35 | 0 | 35 | Seed data is not production runtime code, but it underpins benchmark/test realism. Non-null assumptions can make setup brittle and mask data-shape problems. |

### Additional High-Signal Observations

- `shared/src` is strong: no `any`, no non-null assertions, and only two type assertions. The shared package is the right place to centralize stronger API/domain contracts.
- API carries most explicit unsafety: **87.3% of all explicit `any`** and **90.0% of all non-null assertions** are in `api/src`.
- Web has fewer explicit `any` usages, but many assertions around document normalization and UI model conversion. This suggests the frontend is compensating for broad or under-specified API response types.
- The single TS directive is in `web/src/components/icons/uswds/Icon.test.tsx`, where `@ts-expect-error` intentionally tests an invalid icon name. Severity is low because the directive is localized to a negative test.
- Untyped parameters and missing return types are very high, especially in React callbacks and route handlers. Some are contextually typed and not inherently unsafe, but the scale makes it harder to distinguish intentional inference from accidental API boundary looseness.

### Severity and Impact Ranking

1. **Critical: API route unsafety around authenticated request context and database row shapes.** `weeks.ts`, `projects.ts`, and `issues.ts` combine route params, session-derived fields, JSONB properties, and SQL aliases with casts/non-null assertions. These are high-blast-radius paths.
2. **High: frontend document normalization relies on assertions instead of discriminated contracts.** `UnifiedDocumentPage.tsx` casts generic document fields into multiple domain-specific shapes, weakening compile-time protection across document types.
3. **Medium: explicit `any` is concentrated in tests and route helper transformations.** Test-only usages lower runtime risk, but they weaken test correctness when mocks drift from real contracts.
4. **Medium: missing explicit return types reduce reviewability at API boundaries.** Inference is useful internally, but exported route helpers and response builders should make contracts visible.
5. **Low: TS suppression usage is minimal.** The only source-level suppression found is an intentional negative test.

### Improvement Opportunities For Phase 2

- Prioritize production API hotspots: reduce core violations in `api/src/routes/weeks.ts`, `api/src/routes/issues.ts`, and `api/src/routes/projects.ts`.
- Replace repeated `req.userId!` / `req.workspaceId!` usage with a typed authenticated request helper or middleware contract.
- Define row/response types for high-traffic SQL queries and JSONB property extraction rather than casting `row: any`.
- Move common document response shapes into `shared/src` so web and API compile against the same discriminated contracts.
- For exceeding the benchmark later: target at least a **40% reduction** in production core violations in the top three API route files, exceeding the required 25% overall violation reduction while staying focused on the highest-risk code.

## 2. Bundle Size

### Methodology

- Built the production frontend with `npx pnpm@10.27.0 --filter @ship/web build`.
- Recorded Vite's emitted chunk table and gzip sizes from the production build output.
- Counted generated JavaScript and CSS chunks in `web/dist/assets`.
- Generated bundle visualizer raw data with `vite-bundle-visualizer`:
  - `npx pnpm@10.27.0 dlx vite-bundle-visualizer --template raw-data --output /tmp/ship-bundle-stats.json --open false`
  - `npx pnpm@10.27.0 dlx vite-bundle-visualizer --template raw-data --sourcemap --output /tmp/ship-bundle-stats-sourcemap.json --open false`
- Aggregated the sourcemap visualizer output by package to identify the largest dependency contributors.
- Cross-referenced `web/package.json` dependencies against static and dynamic imports in `web/src`, excluding test files.
- Reviewed frontend entry points and route imports in `web/src/main.tsx`, editor imports in `web/src/components/Editor.tsx`, and icon loading in `web/src/components/icons/uswds/Icon.tsx`.

### Baseline Metrics

| Metric | Baseline |
|---|---:|
| Total `web/dist` output size | **3,351.53 KiB** |
| Total `web/dist/assets` size | **2,262.65 KiB** |
| Total JavaScript size | **2,197.70 KiB** minified / **668.41 KiB** gzip |
| Initial JS + CSS size | **2,090.05 KiB** minified / **584.59 KiB** gzip |
| Number of JS chunks | **261** |
| Number of JS + CSS chunks | **262** |
| Largest chunk | `assets/index-C2vAyoQ1.js` - **2,025.10 KiB** minified / **572.07 KiB** gzip |
| Largest CSS asset | `assets/index-DJeYp5na.css` - **64.95 KiB** minified / **12.52 KiB** gzip |

Vite emitted a large-chunk warning for the main bundle:

> Some chunks are larger than 500 kB after minification. Consider using dynamic import() to code-split the application or manualChunks to improve chunking.

The build also emitted two ineffective dynamic import warnings:

- `web/src/services/upload.ts` is dynamically imported by `SlashCommands.tsx`, but also statically imported by `FileAttachment.tsx` and `ImageUpload.tsx`.
- `web/src/components/editor/FileAttachment.tsx` is dynamically imported by `SlashCommands.tsx`, but also statically imported by `Editor.tsx`.

### Largest Generated Chunks

| Rank | Chunk | Minified Size | Gzip Size |
|---:|---|---:|---:|
| 1 | `assets/index-C2vAyoQ1.js` | 2,025.10 KiB | 572.07 KiB |
| 2 | `assets/index-DJeYp5na.css` | 64.95 KiB | 12.52 KiB |
| 3 | `assets/ProgramWeeksTab-BzbUWlt4.js` | 16.37 KiB | 5.38 KiB |
| 4 | `assets/WeekReviewTab-DmxN07T1.js` | 12.35 KiB | 3.57 KiB |
| 5 | `assets/StandupFeed-BjJLDai5.js` | 9.42 KiB | 2.81 KiB |

### Top Dependency Contributors

Sourcemap-based visualizer attribution by rendered size:

| Rank | Dependency | Rendered Size | Why It Matters |
|---:|---|---:|---|
| 1 | `emoji-picker-react` | 260.4 KiB | Imported by `EmojiPicker.tsx`, which is reachable through project sidebar UI and currently lands in the main bundle path. |
| 2 | `highlight.js` | 166.6 KiB | Pulled in by `lowlight` / TipTap code block support in `Editor.tsx`; this is editor-only weight. |
| 3 | `react-dom` | 129.1 KiB | Core runtime dependency; expected, but it makes the lack of route splitting more expensive. |
| 4 | `prosemirror-view` | 94.0 KiB | Editor-only dependency included in the initial application bundle. |
| 5 | `@uswds/uswds` SVG modules | 92.6 KiB | Icons are lazy-loaded into many tiny chunks, but the generated icon module registry still creates many output chunks. |
| 6 | `yjs` | 65.7 KiB | Collaboration dependency used by the editor; currently part of the initial main route bundle. |
| 7 | `@tiptap/core` | 64.8 KiB | Editor-only dependency included before the user necessarily opens a document editor. |

The editor stack is the largest combined concern. `Editor.tsx` imports TipTap, ProseMirror, Yjs, `y-websocket`, `y-indexeddb`, `lowlight`, and table/task/mention extensions. Because `UnifiedDocumentPage`, `PersonEditorPage`, and multiple document tab components statically import `UnifiedEditor` or `Editor`, this weight is pulled into the main chunk.

### Unused Dependency Cross-Reference

The import scan found these `web/package.json` production dependencies with **0 non-test imports** from `web/src`:

| Dependency | Observation |
|---|---|
| `@tanstack/query-sync-storage-persister` | Not imported directly. Query persistence uses `@tanstack/react-query-persist-client`; this may be transitive-only or removable. |
| `@uswds/uswds` | Not imported by package name because icons are loaded by absolute Vite glob path from `node_modules/@uswds/uswds/dist/img/usa-icons/*.svg`. This is used, not truly unused. |

Everything else in `web/package.json` has at least one production import. Some dependencies have low import counts but large impact:

- `emoji-picker-react`: one production import, large visualizer footprint.
- `lowlight`: one production import, pulls `highlight.js` language data.
- `@dnd-kit/*`: limited to board/org-chart interactions, but included through statically imported pages.
- `@tanstack/react-query-devtools`: imported and rendered in `main.tsx` even in the production build path.

### Code Splitting Assessment

Code splitting is present but incomplete.

What is already split:

- USWDS SVG icons are lazy-loaded through `import.meta.glob` in `web/src/components/icons/uswds/Icon.tsx`, producing many small icon chunks.
- Some document tab components are separate async chunks, such as `ProgramWeeksTab`, `WeekReviewTab`, and `StandupFeed`.

What is not split:

- `web/src/main.tsx` statically imports almost every page component: dashboard, docs, issues, projects, programs, admin, team, settings, feedback, setup, and the unified document page.
- The heavy collaborative editor dependency graph is pulled into the main bundle through static imports from `UnifiedDocumentPage`, `PersonEditorPage`, and tab components.
- Admin/team-only surfaces, including `OrgChartPage` and drag-and-drop dependencies, are loaded as part of the main route graph.
- React Query Devtools are present in the production entry path.
- The `SlashCommands.tsx` dynamic imports do not split `upload.ts` or `FileAttachment.tsx` because those modules are also statically imported elsewhere.

### Severity and Impact Ranking

1. **Critical: the main application chunk is too large for initial load.** `index-C2vAyoQ1.js` is **2,025.10 KiB** minified and **572.07 KiB** gzip, exceeding Vite's 500 KiB warning threshold by roughly 4x. This directly affects first-load performance.
2. **High: route-level code splitting is mostly absent.** Static page imports in `main.tsx` mean users pay for admin, team, project, document, setup, and feedback surfaces before route demand justifies them.
3. **High: editor/collaboration dependencies are eager.** TipTap, ProseMirror, Yjs, lowlight/highlight.js, and upload/editor extensions are a large specialized dependency set that should be deferred until editor routes need them.
4. **Medium: production includes developer tooling entry code.** `ReactQueryDevtools` is imported and rendered from `main.tsx`; even if internally optimized, it should not sit on the production critical path.
5. **Medium: current dynamic imports create false confidence.** Vite reports that two dynamic imports in `SlashCommands.tsx` cannot create separate chunks because the same modules are statically imported.
6. **Low: generated icon chunk count is high but not the main bottleneck.** The USWDS icon strategy creates many tiny chunks, but the total attributed rendered size is much smaller than the editor and main-route dependency problem.

### Improvement Opportunities For Phase 2

- Convert route components in `web/src/main.tsx` to `React.lazy` / `Suspense` so initial load only includes the shell and the active route.
- Lazy-load `UnifiedDocumentPage`, `PersonEditorPage`, `Editor`, and editor-only components so TipTap/ProseMirror/Yjs/highlight.js are deferred until document editing is needed.
- Gate `ReactQueryDevtools` behind development-only dynamic import or remove it from production builds.
- Lazy-load `EmojiPickerPopover` where the project sidebar opens the picker, since `emoji-picker-react` is the largest single visualizer-attributed dependency.
- Rework ineffective dynamic imports in `SlashCommands.tsx` after editor splitting so upload/file attachment code either consistently lives in the editor chunk or is genuinely deferred.
- For exceeding the benchmark later: target the alternative assignment goal of at least a **20% reduction in initial page-load bundle** via code splitting. A successful first pass should move editor and non-current routes out of `index-C2vAyoQ1.js`.

## 3. API Response Time

### Methodology

- Ran PostgreSQL 16 from `docker-compose.local.yml` on `localhost:5433`.
- Applied migrations and normal seed data:
  - `DATABASE_URL=postgres://ship:ship_dev_password@127.0.0.1:5433/ship_dev npx pnpm@10.27.0 --filter @ship/api db:migrate`
  - `DATABASE_URL=postgres://ship:ship_dev_password@127.0.0.1:5433/ship_dev npx pnpm@10.27.0 --filter @ship/api db:seed`
- Added audit-only benchmark rows directly in the local database to satisfy the assignment data-volume floor. These rows are marked with `properties.audit_seed = true`; no product code was changed.
- Verified benchmark data volume:

| Data Type | Count |
|---|---:|
| Total documents | 526 |
| Issues | 104 |
| Users | 20 |
| Sprint/week documents | 35 |
| Audit-only benchmark documents | 269 |

- Started the API locally with rate limits raised through the app's existing test flag:
  - `DATABASE_URL=postgres://ship:ship_dev_password@127.0.0.1:5433/ship_dev NODE_ENV=development E2E_TEST=1 PORT=3000 CORS_ORIGIN=http://localhost:5173 npx pnpm@10.27.0 --filter @ship/api dev`
- Authenticated once as `dev@ship.local` / `admin123`, fetched a CSRF token, and reused the session cookies for all benchmarks.
- Chose five endpoints by tracing common frontend requests from hooks/contexts and route usage:
  - My Week dashboard load: `GET /api/dashboard/my-week`
  - Wiki/document sidebar load: `GET /api/documents?type=wiki`
  - Issues list load: `GET /api/issues`
  - Projects list load: `GET /api/projects`
  - Team accountability grid: `GET /api/team/accountability-grid-v3`
- Ran `autocannon` for each endpoint at 10, 25, and 50 concurrent connections for 5 seconds, writing raw JSON to `/tmp/ship-api-benchmarks`.
- Because `autocannon` JSON reports `p90`, `p97.5`, and `p99` but not `p95`, I also ran a small Node HTTP harness over the same endpoints/concurrency settings to collect individual request latencies and compute exact P50/P95/P99. All reported rows below had `0` non-2xx responses and `0` request errors.

### Baseline Response Times

#### 10 Concurrent Connections

| Endpoint | Requests | P50 | P95 | P99 |
|---|---:|---:|---:|---:|
| `GET /api/dashboard/my-week` | 252 | 169ms | 478ms | 538ms |
| `GET /api/documents?type=wiki` | 301 | 153ms | 324ms | 342ms |
| `GET /api/issues` | 311 | 152ms | 275ms | 322ms |
| `GET /api/projects` | 482 | 94ms | 198ms | 313ms |
| `GET /api/team/accountability-grid-v3` | 256 | 192ms | 326ms | 375ms |

#### 25 Concurrent Connections

| Endpoint | Requests | P50 | P95 | P99 |
|---|---:|---:|---:|---:|
| `GET /api/dashboard/my-week` | 299 | 445ms | 621ms | 699ms |
| `GET /api/documents?type=wiki` | 311 | 422ms | 668ms | 787ms |
| `GET /api/issues` | 328 | 399ms | 564ms | 604ms |
| `GET /api/projects` | 554 | 215ms | 362ms | 404ms |
| `GET /api/team/accountability-grid-v3` | 274 | 447ms | 660ms | 751ms |

#### 50 Concurrent Connections

| Endpoint | Requests | P50 | P95 | P99 |
|---|---:|---:|---:|---:|
| `GET /api/dashboard/my-week` | 368 | 717ms | 879ms | 995ms |
| `GET /api/documents?type=wiki` | 327 | 772ms | 1,210ms | 1,272ms |
| `GET /api/issues` | 363 | 702ms | 970ms | 1,023ms |
| `GET /api/projects` | 517 | 494ms | 683ms | 753ms |
| `GET /api/team/accountability-grid-v3` | 250 | 1,072ms | 1,818ms | 1,907ms |

### Endpoint Findings

- `GET /api/team/accountability-grid-v3` is the slowest endpoint under load: **1,818ms P95** and **1,907ms P99** at 50 concurrency. The route builds a multi-week, multi-person accountability grid and performs several broad workspace queries: people, programs, explicit sprint assignments, inferred issue assignments, weekly plans, and weekly retros. It then does significant in-memory grouping across people and week ranges.
- `GET /api/documents?type=wiki` is the second-slowest at 50 concurrency: **1,210ms P95**. It returns the full wiki document list for the workspace, ordered by `position` and `created_at`, and maps each row to flatten JSONB `properties`. With 500+ documents, this becomes a large response payload and list transform.
- `GET /api/issues` reaches **970ms P95** at 50 concurrency. The route filters `documents` by `document_type = 'issue'`, joins assignee/person data through JSONB `properties`, sorts by JSONB priority and `updated_at`, then batch-loads belongs-to associations for every returned issue.
- `GET /api/dashboard/my-week` reaches **879ms P95** at 50 concurrency. The route is personalized but query-heavy: person lookup, workspace config, weekly plan, weekly retro, previous retro, standups, and project allocations are fetched separately.
- `GET /api/projects` is the fastest of the five but still reaches **683ms P95** at 50 concurrency. The project list query computes inferred status and counts sprints/issues via subqueries for each project row.

### Severity and Impact Ranking

1. **Critical: team accountability grid is the largest response-time risk.** It is an admin/manager workflow endpoint with the highest 50-concurrency P95/P99 and broad in-memory aggregation. It will likely degrade fastest as people, weeks, plans, retros, and issue assignments grow.
2. **High: document list endpoint scales with full workspace document count.** The current sidebar/list pattern fetches all wiki rows for the workspace. Payload size and row transforms grow directly with document volume.
3. **High: issue list combines JSONB filtering/sorting, joins, and association hydration.** The endpoint is central to the product and approaches 1s P95 at 50 concurrency on only 104 issues.
4. **Medium: dashboard My Week performs many small sequential reads.** It is user-facing and common on initial navigation; the risk is latency accumulation rather than a single obviously expensive query.
5. **Medium: project list uses per-row subqueries for counts and inferred status.** Current seed volume is small enough that it remains fastest, but the query shape has obvious growth risk as project count rises.

### Improvement Opportunities For Phase 2

- Optimize `GET /api/team/accountability-grid-v3` first: collapse broad queries where possible, limit the returned week/person scope, and consider precomputed or indexed accountability status data.
- Add pagination or tree-windowing to `GET /api/documents?type=wiki` so the app does not fetch every wiki document for initial navigation.
- Review indexes for JSONB access patterns used by `issues`, `weekly_plan`, `weekly_retro`, `standup`, and accountability-grid queries.
- Replace per-row project list subqueries with grouped aggregate joins or precomputed counts.
- For exceeding the benchmark later: target at least a **20% P95 reduction** on `GET /api/team/accountability-grid-v3` and `GET /api/documents?type=wiki`, using the same seeded database and 50-concurrency benchmark settings.

## 4. Database Query Efficiency

### Methodology

- Used the same local benchmark database from the API response-time audit:
  - PostgreSQL 16 via `docker-compose.local.yml`
  - 526 documents, 104 issues, 20 users, and 35 sprint documents
- Enabled PostgreSQL statement-duration logging for the audit:
  - `ALTER SYSTEM SET log_min_duration_statement = 0;`
  - `ALTER SYSTEM SET log_statement = 'none';`
  - `SELECT pg_reload_conf();`
- Started the API with the same benchmark configuration used for Category 3.
- Authenticated once as `dev@ship.local` and reused the session cookie.
- Wrapped each user flow with SQL marker statements like `select 'FLOW_START:main_page'` and `select 'FLOW_END:main_page'`.
- Captured Postgres logs with `docker logs --since ... ship-postgres-1`.
- Parsed the logs between markers and counted one application-level SQL execution per extended-protocol `execute` record. Parse/bind/execute internals were not counted as separate application queries.
- Ran `EXPLAIN (ANALYZE, BUFFERS)` on representative slow query shapes for document listing, issue listing, and search.
- Reviewed existing indexes from `pg_indexes` for `documents`, `document_associations`, `document_links`, `comments`, `sessions`, and `workspace_memberships`.

Raw evidence files:

- Flow query logs: `/tmp/ship-query-logs/all-flows.log`
- Parsed query summary: `/tmp/ship-query-logs/query-summary.json`
- Representative EXPLAIN output: `/tmp/ship-query-logs/explain-selected.txt`

### Baseline Metrics

| User Flow | Requests Included | Total Queries | Slowest Query | N+1 Detected? |
|---|---|---:|---:|---|
| Load main page | `auth/me`, `dashboard/my-week`, `standups/status`, `accountability/action-items` | 33 | 6.276ms | No classic row-level N+1 |
| View a document | document metadata, content, backlinks, comments, context | 22 | 7.574ms | No classic row-level N+1 |
| List issues | `GET /api/issues` | 5 | 2.341ms | No |
| Load sprint board | sprint detail, sprint issues, standups, review | 21 | 3.400ms | No classic row-level N+1 |
| Search content | mention search and learning search | 9 | 5.857ms | No |

### Slowest Query Shapes

| Flow | Slowest Query Shape | Observation |
|---|---|---|
| Load main page | `SELECT DISTINCT ON (project_id) ...` from accountability action-item inference | Main page cost is dominated by accountability inference, not by the basic auth/session check. |
| View a document | Backlinks query joining `document_links`, linked documents, program associations, and program documents | The document view fan-out is mostly caused by multiple independent panels: metadata, content, backlinks, comments, and context. |
| List issues | Issue list query over `documents`, JSONB properties, assignee user, and person document joins | The route avoids association N+1 by batch-fetching belongs-to associations, but still sorts by JSONB-derived priority. |
| Load sprint board | Sprint review/detail query with program/owner metadata and nested lookup expressions | The flow issues repeated auth/admin checks across separate sprint-tab endpoints. |
| Search content | Learning search query with `ILIKE`, tag checks, associations, and content preview | Search uses broad text matching and JSONB tag checks; no trigram/full-text index is present. |

### EXPLAIN Findings

Representative `EXPLAIN (ANALYZE, BUFFERS)` results on the seeded benchmark database:

| Query Shape | Plan Highlight | Execution Time |
|---|---|---:|
| Wiki document list | Sequential scan on `documents`, then quicksort by `position, created_at` | 0.786ms |
| Issue list | Bitmap index scan on `idx_documents_document_type`, joins to users/person docs, then JSONB priority sort | 1.031ms |
| Mention/title search | Sequential scan on `documents`, `ILIKE '%a%'`, top-N heapsort | 1.838ms |

Current row counts are still small enough that raw SQL execution times are low in isolation. The higher API response times in Category 3 come from repeated queries, JSON serialization, response payload size, in-memory aggregation, and multiple route calls per user flow.

### Index Review

Useful existing indexes:

- `idx_documents_active` on `(workspace_id, document_type)` for active documents.
- `idx_documents_properties` GIN index on `properties`.
- `idx_documents_person_user_id` expression index for person lookup by `properties->>'user_id'`.
- `idx_document_associations_document_type` and `idx_document_associations_related_type` for association lookups.
- `idx_document_links_source` and `idx_document_links_target` for backlinks/forward links.
- Unique workspace membership index on `(workspace_id, user_id)`.

Missing or weak index coverage:

- Ordering for document lists is not covered by a composite index like `(workspace_id, document_type, position, created_at)` for active rows.
- Case-insensitive title search with `ILIKE '%query%'` cannot use a normal btree index; there is no trigram or full-text index.
- JSONB scalar casts used frequently in filters/sorts are not covered by targeted expression indexes, for example:
  - `(properties->>'assignee_id')`
  - `(properties->>'sprint_number')::int`
  - `(properties->>'week_number')::int`
  - `(properties->>'project_id')`
  - `(properties->>'author_id')`
- Project list counts are computed with correlated subqueries per project row.

### Severity and Impact Ranking

1. **Critical: main page query count is high before the user does anything.** The audited main-page sequence executed **33 SQL queries**, with repeated session updates, repeated workspace sprint config reads, and accountability inference queries. This compounds with the frontend initial-load bundle issue.
2. **High: accountability and sprint-board flows perform broad inference at request time.** These flows are currently correct for small data, but they derive status from many document rows, JSONB properties, associations, plans, and retros every time.
3. **High: search is not using a search-appropriate index.** `ILIKE '%a%'` and JSONB tag scans are acceptable for a small workspace but will become expensive at larger document counts.
4. **Medium: document view is split into many small endpoint queries.** The individual SQL is fast, but the view flow executes **22 queries** across five requests before collaboration/editor traffic starts.
5. **Medium: issue list is batch-aware but still JSONB-heavy.** The route avoids an association N+1, which is good, but filtering/sorting on JSONB properties remains a scale risk.
6. **Low: auth/session overhead is repeated on every request.** This is expected for session validation, but multi-request page flows make it visible: each protected endpoint runs a session lookup and session activity update.

### Improvement Opportunities For Phase 2

- Reduce the main page query count by combining dashboard/accountability data fetches or caching stable workspace config within the request path.
- Add targeted expression indexes for high-traffic JSONB fields used in filters and joins.
- Add a search-specific index strategy for document title/content search, likely `pg_trgm` for title `ILIKE` or a proper full-text search vector.
- Replace correlated project count subqueries with grouped aggregate joins.
- Consider a consolidated document-view endpoint for metadata/content/backlinks/comments/context if latency matters more than independent panel caching.
- For exceeding the benchmark later: target a **20% reduction in total query count** for the main page flow, from 33 queries to 26 or fewer, or a 50% improvement in the slowest query shape after adding the right index.

## Category 5: Test Coverage and Quality

### Methodology

- Reviewed root, API, web, and Playwright test scripts/configuration.
- Counted test files and static test declarations across `api/src`, `web/src`, and `e2e`.
- Searched test files for intentional skips, focused tests, fixmes, and conditional skip markers.
- Ran API tests first with the default root command, then reran against an isolated local test database because the default command expected Postgres on port 5432.
- Ran web Vitest twice to distinguish deterministic failures from one-off flake.
- Listed Playwright tests with `PLAYWRIGHT_WORKERS=1 npx pnpm@10.27.0 exec playwright test --list`; the full browser suite was inventoried but not executed because the repo's Playwright config documents the per-worker container/browser memory cost and prior local memory blow-up risk.
- Attempted API coverage with `npx pnpm@10.27.0 --filter @ship/api test:coverage`.

Raw evidence files:

- Root/API default failure log: `/tmp/ship-pnpm-test-run1.log`
- Corrected API test log: `/tmp/ship-api-test-run-audit1.log`
- Web test logs: `/tmp/ship-web-test-run-audit1.log`, `/tmp/ship-web-test-run-audit2.log`
- Playwright inventory: `/tmp/ship-e2e-list-audit.log`
- API coverage attempt: `/tmp/ship-api-coverage-audit.log`

### Test Inventory

| Area | Files | Executable Tests | Notes |
|---|---:|---:|---|
| API Vitest | 28 | 451 | Runtime count from Vitest; static declaration scan found 449 because parameterized tests expand at runtime. |
| Web Vitest | 16 | 151 | Runtime count from Vitest. |
| Playwright E2E | 71 | 869 | Count from `playwright test --list`. |
| Total | 115 | 1,471 | Inventory only; full E2E suite was not executed in this audit pass. |

No explicit `test.skip`, `it.skip`, `describe.skip`, `skipIf`, `runIf`, `.only`, or `.fixme` markers were found in test files. The initial "skipped" API output was caused by setup failure before tests ran, not by intentional skips.

### Runtime Results

| Command | Result | Runtime | Details |
|---|---|---:|---|
| `npx pnpm@10.27.0 test` | Failed | 68s | Root script only runs `@ship/api`; default env tried `localhost:5432`, but local Ship Postgres is exposed on `5433`. Vitest reported 28 failed suites and 451 skipped tests because `api/src/test/setup.ts` could not connect. |
| `DATABASE_URL=.../ship_test_audit npx pnpm@10.27.0 --filter @ship/api test` | Passed | 74s | 28 files passed, 451 tests passed. |
| `npx pnpm@10.27.0 --filter @ship/web test` | Failed | 35s | 3 files failed, 13 tests failed, 138 passed. |
| Web rerun | Failed | 32s | Same 3 failing files and 13 failing tests, indicating deterministic failures rather than flake. |
| `PLAYWRIGHT_WORKERS=1 npx pnpm@10.27.0 exec playwright test --list` | Passed | 22s | Listed 869 tests in 71 files; did not execute browsers. |
| `npx pnpm@10.27.0 --filter @ship/api test:coverage` | Failed | 4s | Coverage could not start: missing `@vitest/coverage-v8`. |

### Failing Web Tests

| File | Failed Tests | Failure Pattern |
|---|---:|---|
| `web/src/lib/document-tabs.test.ts` | 9 | Tests still expect `sprints` tab behavior, while implementation appears to have renamed or shifted sprint concepts to `weeks`. Also default-tab expectations no longer match implementation. |
| `web/src/hooks/useSessionTimeout.test.ts` | 1 | Inactivity timer dismissal test expects `onTimeout` not to be called, but it is called once. This may be either a stale timing expectation or a real session-timeout behavior regression. |
| `web/src/components/editor/DetailsExtension.test.ts` | 3 | Tests expect `content: 'block+'`; implementation now uses `detailsSummary detailsContent`, and editor-context tests fail because the schema lacks those node types in the test setup. |

### Coverage Status

- API coverage is configured in `api/vitest.config.ts` with provider `v8`, but the required `@vitest/coverage-v8` dependency is missing, so no coverage percentage is currently available from the checked-in script.
- Web Vitest has no coverage configuration and no `test:coverage` script.
- Playwright is configured for retries, traces on first retry, screenshots on failure, HTML reporting, and a custom progress reporter, but coverage collection is not configured for E2E.
- Current repository state therefore cannot answer "what percent is covered?" without first fixing coverage tooling.

### Critical Flow Coverage

Covered well:

- API route behavior for auth, documents, document visibility, issues, workspaces, weeks, standups, backlinks, files, project retros, sprint reviews, search, reports-to, API tokens, history, and association regression.
- Domain utilities for business days, issue-link transformation, hypothesis/plan extraction, accountability, and activity.
- Web unit tests for session timeout, selection persistence, editor attachments/images/mentions/table of contents/details, icons, dashboard/accountability helpers, scroll fade, and document tabs.
- E2E inventory covers auth, authorization, workspaces, documents, issues, week flows, team mode, accessibility, file attachments, search, security, session timeout, race conditions, and editor interactions.

Coverage gaps and weak signals:

- The root `test` script does not run web tests or E2E tests, so a green root test run would miss the currently failing web suite.
- Coverage reporting is nonfunctional for API and absent for web, which makes quality tracking subjective.
- Full Playwright execution was not part of this pass; browser-level regressions remain unverified.
- Several failing web tests look like stale tests after product vocabulary/behavior changes (`sprints` to `weeks`, details extension schema), which lowers trust in the suite until expectations are reconciled.
- API tests require a correctly configured database URL but the default root command gives an opaque all-suite setup failure when Postgres is not on port 5432.

### Severity and Impact Ranking

1. **Critical: web unit tests are currently red.** Two consecutive runs failed the same 13 tests, so the suite cannot be used as a release gate until either product behavior or test expectations are corrected.
2. **High: coverage reporting is broken.** `test:coverage` is checked in but exits immediately because `@vitest/coverage-v8` is missing; web coverage is not configured at all.
3. **High: root `pnpm test` is incomplete.** It only runs API Vitest, so it would not catch the current web failures.
4. **Medium: API test setup is environment-fragile.** The suite passes with a correct `DATABASE_URL`, but the default local command failed every suite when Postgres was not available on port 5432.
5. **Medium: E2E breadth is strong but execution cost is high.** The project has 869 Playwright tests with isolated containers, retries, traces, and screenshots, but this makes routine full-suite execution expensive.
6. **Low: no intentional skipped/focused tests were found.** This is a positive signal; the main issues are execution wiring and stale/broken expectations rather than suppressed tests.

### Improvement Opportunities For Phase 2

- Fix or update the 13 failing web tests first, then make web tests part of the default quality gate.
- Add `@vitest/coverage-v8` and define minimum coverage thresholds for API; add equivalent web coverage config and script.
- Change the root `test` script to run API and web unit tests, with a separate explicit command for full E2E.
- Add a documented test database setup path, for example `DATABASE_URL=postgres://ship:ship_dev_password@127.0.0.1:5433/ship_test` plus migration/reset guidance.
- Consider a lighter E2E smoke subset for regular local/CI gating, reserving the 869-test browser suite for scheduled or pre-release runs.
- For exceeding the benchmark later: target **100% green API and web unit tests from the root command**, plus working API/Web coverage reports with enforced thresholds, including **80% coverage on changed files**.

## Category 6: Runtime Error and Edge Case Handling

### Methodology

- Started the local API and web servers against the seeded benchmark database:
  - API: `DATABASE_URL=postgres://ship:ship_dev_password@127.0.0.1:5433/ship_dev NODE_ENV=development E2E_TEST=1 PORT=3000 CORS_ORIGIN=http://localhost:5173 npx pnpm@10.27.0 --filter @ship/api dev`
  - Web: `npx pnpm@10.27.0 --filter @ship/web dev --host 127.0.0.1 --port 5173`
- Installed the missing Playwright Chromium binary with `npx pnpm@10.27.0 exec playwright install chromium` so browser automation could run locally.
- Drove the app in Chromium with Playwright, captured browser console errors, page errors, failed requests, and 4xx/5xx responses.
- Tested normal login/document navigation, editor offline/reconnect, malformed input, concurrent title edits, and delayed document-list loading.
- Reviewed frontend error boundaries, global query/mutation error handling, API route catch blocks, and process-level unhandled error hooks.

Raw evidence files:

- Browser runtime audit: `/tmp/ship-cat6-runtime-audit3.json`
- Earlier modal-blocking repros: `/tmp/ship-cat6-runtime-audit.json`, `/tmp/ship-cat6-runtime-audit2.json`
- API/server log: `/tmp/ship-cat6-api.log`
- Vite/web log: `/tmp/ship-cat6-web.log`

### Baseline Metrics

| Metric | Baseline |
|---|---|
| Console errors during normal login/navigation | 1 error: `/api/auth/me` returns 401 before login completes, logged by the browser as a failed resource. |
| Console errors during edge-case probes | 7 total errors, including expected 400s, one 500, one offline fetch failure, and `BacklinksPanel` logging `Error fetching backlinks`. |
| Browser page errors | 0 observed. |
| Failed browser requests | 1 observed during intentional offline mode: `GET /api/documents/:id/backlinks` failed with `net::ERR_INTERNET_DISCONNECTED`. |
| Server unhandled promise rejections | 0 observed in logs during the audit run. |
| Process-level unhandled rejection handlers | None found in `api/src` or `web/src`. |
| Network disconnect recovery | Partial. Editor content survived offline edit, reconnect, and reload; secondary panels logged errors during offline mode. |
| Error boundary coverage | Partial. `AppLayout` wraps only `<Outlet />`; `Editor` wraps `EditorContent`; no top-level boundary around providers/public routes/sidebar/modal shell. |
| Silent or confusing failures identified | 4 concrete gaps listed below. |

### Runtime Observations

Normal usage:

- Login succeeded and redirected to `/docs`.
- The browser logged one 401 for `/api/auth/me` before login. This is expected control flow, but it still appears as a console error in DevTools.
- When the seeded user had an accountability item due, `ActionItemsModal` auto-opened and blocked interactions until dismissed. This reproduced twice: once blocking the `New document` button and once blocking editor clicks after direct document navigation.

Network disconnect and collaboration:

- Created an audit wiki document through the authenticated API, opened it in the editor, typed online text, then set Chromium offline.
- The editor sync badge changed to **Offline**.
- Text typed while offline remained visible locally.
- After reconnect, the sync badge returned to **Saved**.
- After page reload, the offline text was still present. This is a good signal for Yjs/IndexedDB editor recovery.
- During offline mode, `BacklinksPanel` polled `/api/documents/:id/backlinks`, failed with `net::ERR_INTERNET_DISCONNECTED`, logged `Error fetching backlinks`, and set a panel error. The editor survived, but not all surrounding panels recover quietly.

Malformed input:

| Probe | Result | Observation |
|---|---:|---|
| `POST /api/documents` with empty title | 400 | Correctly rejected with Zod `too_small`. |
| `POST /api/documents` with 300-character title | 400 | Correctly rejected with Zod `too_big` over 255 chars. |
| `POST /api/documents` with `<script>alert("xss")</script>` title | 201 | Accepted and stored raw script-like title. React rendering should escape this, but the API does not normalize or reject hostile-looking titles. |
| `PATCH /api/documents/not-a-uuid` | 500 | Server logged PostgreSQL `invalid input syntax for type uuid`; this should be a 400 or 404, not an internal error. |
| `POST /api/issues` with empty title, invalid state, invalid priority | 400 | Correctly rejected with detailed validation errors. |

Concurrent edge case:

- Two browser pages wrote different titles to the same document nearly simultaneously.
- Final title after reload was the second writer's value: `User B ...`.
- This is understandable last-write-wins behavior for scalar metadata, but the UI provides no conflict indicator or "updated elsewhere" notice. Editor body content uses Yjs CRDTs; document title metadata does not.

Slow network:

- A Playwright route delayed `GET /api/documents?type=wiki` by 5 seconds.
- The `/documents` page body text was empty at both 1 second and 6.5 seconds in the captured run.
- This suggests a missing or fragile loading/error state on that page path under delayed document-list loading. It should be reproduced manually before implementation, but it is a strong audit signal because there was no page error and no useful visible fallback.

### Static Error-Handling Review

Positive patterns:

- `web/src/components/ui/ErrorBoundary.tsx` provides a reusable fallback with a retry button and logs component stacks.
- `web/src/pages/App.tsx` wraps route outlet content in `ErrorBoundary` at lines 541-544.
- `web/src/components/Editor.tsx` wraps `EditorContent` in `ErrorBoundary` at lines 980-982.
- `web/src/lib/queryClient.ts` centralizes TanStack Query and mutation error logging; mutation errors can surface as toast notifications through `MutationErrorToast`.
- API routes consistently use `try/catch` blocks and return JSON errors for many expected validation failures.
- Collaboration code logs persistence/load failures instead of crashing the process.

Weak patterns:

- There is no top-level React error boundary around `BrowserRouter`, providers, `ProtectedRoute`, `PublicRoute`, `SuperAdminRoute`, login/setup/public pages, sidebars, command palette, modals, or the upload warning shell.
- API error handling is duplicated in route handlers rather than centralized through Express error middleware, which makes response semantics inconsistent.
- Static search found **330** route/middleware `status(500)` or `console.error` error sites, indicating broad catch-and-log handling but also a lot of repeated generic `Internal server error` paths.
- No `process.on('unhandledRejection')` or `process.on('uncaughtException')` handler was found. Startup errors are caught in `api/src/index.ts`, but runtime unhandled errors would rely on Node defaults.
- Several frontend catches intentionally suppress detail, especially around optional UI checks and local persistence/cache paths.

### Missing Error Boundaries

Priority locations:

- `web/src/main.tsx`: no root-level boundary around providers/router. Provider initialization, auth setup, query persistence, or route guard crashes can blank the app before `AppLayout` renders.
- `web/src/pages/Login.tsx`, `Setup.tsx`, `InviteAccept.tsx`, and public feedback routes: public routes are outside the `AppLayout` outlet boundary.
- `web/src/pages/App.tsx` sidebars and shell UI: sidebar trees, command palette, project setup wizard, upload navigation warning, and action-items modal are outside the `<Outlet />` boundary.
- `web/src/components/ActionItemsModal.tsx`: auto-opens on login and can block core workflows; modal failures or hangs have high user-facing impact.
- Editor side panels such as `BacklinksPanel`: polling failures are handled locally, but repeated offline polling produces console errors and panel-level failure state.

### Silent Failures and Reproduction Steps

1. **Accountability modal blocks immediate work after login.**
   - Repro: log in as `dev@ship.local` when an accountability item is due, then try clicking `New document` or navigate directly to a document and click the editor.
   - Observed: modal overlay intercepts clicks until dismissed. E2E tests know about this via `localStorage.setItem('ship:disableActionItemsModal', 'true')`, which is a sign the modal is operationally disruptive.

2. **Invalid document UUID returns 500.**
   - Repro: authenticated `PATCH /api/documents/not-a-uuid` with a JSON body.
   - Observed: response is 500 and server logs PostgreSQL `22P02 invalid input syntax for type uuid`.
   - Expected: route-level validation should return 400 before hitting PostgreSQL, or a clean 404 if the ID is syntactically valid but missing.

3. **Offline editor recovery works, but surrounding panels make noise.**
   - Repro: open a document, go offline, keep editing, then reconnect.
   - Observed: editor content survives, but backlinks polling logs a failed fetch and exposes a secondary error state.
   - Expected: offline-aware panels should pause polling or show a quiet offline state.

4. **Slow document-list load can produce a blank page.**
   - Repro: delay `GET /api/documents?type=wiki` by 5 seconds and open `/documents`.
   - Observed: captured body text was empty at 1 second and 6.5 seconds.
   - Expected: a skeleton, loading message, or route-level fallback should remain visible.

5. **Concurrent title edits have no conflict feedback.**
   - Repro: open the same document in two pages and change the title in both nearly simultaneously.
   - Observed: final title is last writer wins, with no notification to the first editor.
   - Expected: if scalar metadata is server-authoritative, the UI should at least surface that the title changed elsewhere.

### Severity and Impact Ranking

1. **Critical: invalid UUIDs can become server 500s.** This is a correctness and observability issue: malformed client input should not look like an internal server failure.
2. **High: root error boundary coverage is incomplete.** Route content is protected, but provider/auth/public-route/sidebar/modal failures can still blank or block the app outside the existing boundary.
3. **High: accountability modal can block core interactions immediately after login.** This is user-facing confusion and already requires a test-only localStorage bypass.
4. **Medium: offline editor recovery is only partially graceful.** Core document text survives, but surrounding panels still emit console errors and user-visible local error states.
5. **Medium: slow-loading document lists have weak visible fallback behavior.** A blank screen during slow network is indistinguishable from a broken app.
6. **Low: hostile-looking document titles are accepted raw.** React escaping likely prevents direct XSS in normal rendering, and E2E security tests cover XSS paths, but accepting raw script-like titles creates avoidable downstream risk for exports, logs, emails, or future rendering changes.
7. **Low: no process-level unhandled error hooks.** No unhandled rejection occurred during the audit run, but adding handlers would improve diagnostics and shutdown behavior.

### Improvement Opportunities For Phase 2

- Add route parameter validation for UUID path params before database calls, starting with `PATCH /api/documents/:id`.
- Add a top-level React error boundary around the provider/router tree, and add smaller boundaries around sidebars/modals that sit outside the route outlet.
- Make `ActionItemsModal` less disruptive: avoid auto-opening over direct document routes, delay until after first interaction, or make the banner the primary entry point.
- Pause or suppress low-value polling errors while `navigator.onLine === false`, especially in `BacklinksPanel`.
- Ensure `/documents` and other list pages show a stable skeleton or loading/error state under delayed API responses.
- Consider normalizing or rejecting script-like title input at the API boundary, even if React escaping currently makes it safe.

## Category 7: Accessibility Compliance

### Methodology

- Started the local API and web servers against the seeded benchmark database.
- Ran automated accessibility scans with `@axe-core/playwright` on representative routes:
  - `/login`
  - `/docs`
  - `/documents/:id`
  - `/issues`
  - `/projects`
  - `/programs`
  - `/team`
  - `/my-week`
- Ran Lighthouse accessibility audits with `npx lighthouse@12.6.1 --only-categories=accessibility`. Authenticated pages used the current session cookies via `--extra-headers`.
- Performed a keyboard smoke test for login focus order, app-shell tab order, skip-link behavior, and command palette shortcut behavior.
- Reviewed existing accessibility E2E coverage and source references for ARIA/keyboard/focus patterns.

Raw evidence files:

- Axe and keyboard results: `/tmp/ship-cat7-axe-keyboard.json`
- Lighthouse reports: `/tmp/ship-cat7-lighthouse/*.json`
- Auth cookie/header used for Lighthouse: `/tmp/ship-cat7-cookie-header.txt`
- API/server log: `/tmp/ship-cat7-api.log`
- Vite/web log: `/tmp/ship-cat7-web.log`

### Lighthouse Scores

| Page | Lighthouse Accessibility Score |
|---|---:|
| Login | 100 |
| Docs | 91 |
| Issues | 100 |
| Projects | 100 |
| Team allocation | 100 |
| My Week | 95 |

Lighthouse flagged the Docs page for the same ARIA tree/list structure issues that axe reported. My Week lost points for color contrast. Lighthouse did not flag all issues found by axe, so axe is the more useful baseline for implementation prioritization.

### Axe Results

| Page | Violations | Critical | Serious | Moderate | Minor |
|---|---:|---:|---:|---:|---:|
| Login | 2 | 0 | 0 | 2 | 0 |
| Docs list | 2 | 1 | 1 | 0 | 0 |
| Document editor | 4 | 2 | 1 | 1 | 0 |
| Issues | 1 | 0 | 0 | 0 | 1 |
| Projects | 2 | 0 | 1 | 0 | 1 |
| Programs | 1 | 0 | 0 | 0 | 1 |
| Team | 1 | 0 | 1 | 0 | 0 |
| My Week | 1 | 0 | 1 | 0 | 0 |
| **Total** | **14** | **3** | **5** | **3** | **3** |

Critical/Serious total: **8 violations** across the scanned pages.

### Top Violations

| Impact | Rule | Location / Source Clue | Finding |
|---|---|---|---|
| Critical | `aria-required-children` | `web/src/pages/App.tsx`, document tree `ul[aria-label="Workspace documents"]` | Tree/list structure has required child role violations. |
| Critical | `aria-allowed-attr` | `web/src/components/Editor.tsx` / `web/src/index.css`, `.tiptap-wrapper > div` | TipTap editor DOM uses an ARIA attribute unsupported for that element/role combination. |
| Critical | `aria-required-children` | Document editor sidebar/tree `ul` | Editor view repeats the tree/list structural violation. |
| Serious | `listitem` | `web/src/pages/App.tsx`, workspace document list | A `<li>` is not contained in a valid list parent from axe's computed accessibility tree. |
| Serious | `listitem` | Document editor view | Same list containment problem appears when a document is open. |
| Serious | `color-contrast` | `web/src/pages/Projects.tsx`, `bg-accent/20 text-accent`; filter count badge | 16 contrast failures on project status/count badges. |
| Serious | `color-contrast` | `web/src/pages/TeamMode.tsx`, `.text-accent.font-medium.text-xs` | Team allocation has an accent text contrast failure. |
| Serious | `color-contrast` | `web/src/pages/MyWeekPage.tsx`, `bg-accent/20 text-accent`, `text-muted/50` | 24 contrast failures, mostly weak muted timestamps and current-week badge styling. |
| Moderate | `landmark-one-main` / `region` | `web/src/pages/Login.tsx` | Login page content is not wrapped in a `main` landmark; multiple content regions sit outside landmarks. |
| Minor | `empty-table-header` | `web/src/components/SelectableList.tsx` consumers | Selection column header has `aria-label`, but axe still flags the empty `<th>` text. |

### Keyboard Navigation

Baseline: **Partial**.

Findings:

- Login keyboard smoke was noisy because React Query Devtools' button became an early focus target in development. This may not affect production, but it affects local accessibility testing and tab-order confidence.
- The skip-link check did not land on `#main-content`; after pressing Enter, focus was observed on an `INPUT` rather than the main landmark.
- App-shell tab order reaches major controls: sort combobox, list/tree view buttons, New Document, filter tabs, document links, delete buttons, and add sub-document buttons.
- The first 30 app-shell tab stops were heavily consumed by repeated document row controls. This is keyboard-accessible, but inefficient for large document lists.
- The command palette shortcut check (`Meta+K`) did not open a detected command-palette dialog in the automated pass.

Existing positive signals:

- There are dedicated accessibility E2E files (`e2e/accessibility.spec.ts`, `e2e/accessibility-remediation.spec.ts`) covering axe checks, login keyboard flow, main-app keyboard flow, alert announcement, and label checks.
- Many icon-only controls have `aria-label`s, and components such as `SelectableList`, `KanbanBoard`, `SessionTimeoutModal`, `ContextMenu`, and `CommandPalette` include explicit ARIA/focus handling.
- `web/src/index.css` defines global focus-visible styling.

Screen reader note:

- A manual VoiceOver/NVDA pass was not completed in this audit run. Axe landmark/role failures are still strong screen-reader risk indicators, especially the tree/list structure and missing login landmarks.

### Color Contrast

Baseline color contrast failures: **41 affected nodes** from axe.

Breakdown:

- Projects: 16 nodes, primarily `bg-accent/20 text-accent` badges and planned filter count.
- Team: 1 node, accent-colored small text in Team Mode.
- My Week: 24 nodes, primarily `text-muted/50` timestamps and `bg-accent/20 text-accent` current-week badge.

The recurring issue is not isolated to one page. The accent and muted opacity combinations are reused across the app and can fail WCAG 2.1 AA when rendered on the dark background.

### Missing ARIA Labels or Roles

The dominant issue is not missing labels on icon buttons; it is invalid or incomplete ARIA structure:

- `web/src/pages/App.tsx`: document tree uses `role="tree"` but contains descendants that do not satisfy axe's required `treeitem` child expectations.
- `web/src/components/Editor.tsx` / TipTap DOM: unsupported ARIA attribute on `.tiptap-wrapper > div`.
- `web/src/pages/Login.tsx`: no `main` landmark around login content.
- `SelectableList` table selection headers: empty `<th>` pattern is still flagged even with `aria-label`.
- Document editor view: heading order jumps to `h3`, which weakens screen-reader document structure.

### Severity and Impact Ranking

1. **Critical: document tree ARIA structure is invalid.** This affects the main Docs experience and the document editor context. Screen-reader users may get a broken tree/list model.
2. **Critical: editor DOM has unsupported ARIA usage.** The editor is the core product surface, so invalid ARIA on TipTap content has high blast radius.
3. **High: color contrast fails across key work pages.** Projects, Team, and My Week all have Serious contrast violations, especially on accent badges and muted small text.
4. **High: login page lacks proper landmarks.** The login page scored 100 in Lighthouse but axe still found landmark problems; first-contact accessibility should be structurally clean.
5. **Medium: keyboard navigation is available but inefficient.** Large document lists create long tab sequences, and the skip-link behavior did not verify cleanly in the automated pass.
6. **Medium: command palette shortcut did not open in the smoke test.** This may be test-environment sensitivity, but it should be manually verified because command palette access is a major power-user workflow.
7. **Low: empty selection table headers are repeated.** This is lower impact than the tree/editor issues but appears on Issues, Projects, and Programs.

### Improvement Opportunities For Phase 2

- Fix document tree semantics by ensuring every `role="tree"` has valid `treeitem` children and that nested groups use the correct ARIA pattern.
- Remove or correct unsupported ARIA attributes on the TipTap wrapper/editor content.
- Replace failing `text-accent`, `bg-accent/20`, and `text-muted/50` combinations with WCAG AA-safe tokens for dark backgrounds.
- Add a `main` landmark to public auth/setup pages, starting with Login.
- Rework selection table headers so the selection column has accessible text without triggering empty-header violations.
- Verify skip-link focus and command palette shortcut behavior manually, then add regression tests if either is broken.
- For exceeding the benchmark later: target **0 Critical/Serious axe violations** on Login, Docs, Document Editor, Projects, Team, and My Week, plus Lighthouse accessibility scores of **100** on Docs and My Week.

## Implementation Evidence Addendum

The audit baselines above remain the historical findings. Implementation progress and current verification are tracked in `FIXES_IMPLEMENTATION.md`.

Current closed stretch gates:

- API latency: seeded 50-concurrency benchmark improved wiki document listing from `1,210ms` P95 to `198ms` P95 and team accountability grid from `1,818ms` P95 to `119ms` P95.
- Database query efficiency: the audited main-page flow now measures `25` SQL queries versus the `33` baseline and `26` stretch target.
- Accessibility: the new stretch axe spec passes with 0 Critical/Serious violations across Login, Docs, Document Editor, Projects, Team, and My Week after fixing Team and My Week current-week contrast failures.

Current closed coverage gate:

- Changed-file coverage is now enforced by `test:coverage:changed`, which runs API and web coverage and then checks changed executable lines against an 80% overall threshold. Current post-commit result: `344/384` changed executable unit lines covered, `89.58%` overall. Team, My Week, and heatmap visual contrast changes are verified by the Playwright axe stretch spec rather than unit coverage.
- The remaining low overall package-coverage risk is controlled by `scripts/check-coverage-ratchet.mjs`, also wired into `test:coverage:changed`. The ratchet fails if API or web package coverage drops below the current baseline floor while future work raises the floor over time.
