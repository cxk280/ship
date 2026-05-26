# ShipShape Discoveries

Audit date: 2026-05-18

## 1. Per-workspace issue numbers need database-level serialization

**What I learned:** Ship generates human-readable issue display IDs from a workspace-local `ticket_number`, but it does not rely on application memory or optimistic retry loops to keep those numbers unique. The issue creation route opens a transaction, derives a lock key from the workspace ID, takes `pg_advisory_xact_lock`, then computes `MAX(ticket_number) + 1` and inserts the issue before committing.

**Where I found it:** `api/src/routes/issues.ts:562-640`

**Why it matters:** Without the transaction-scoped advisory lock, two concurrent issue-create requests in the same workspace could both read the same max ticket number and create duplicate display IDs. The lock scopes serialization to one workspace instead of globally blocking all issue creation, preserving correctness while keeping unrelated workspaces independent.

**How I would apply it in a future project:** For tenant-local counters, invoice numbers, ticket IDs, or other sequence-like values that cannot use a single global database sequence, I would use a transaction-scoped database lock keyed by tenant plus a uniqueness constraint as a backstop. I would also document the lock key derivation and include a concurrency test that fires simultaneous creates for the same tenant.

## 2. Collaborative documents keep both CRDT state and API-readable JSON

**What I learned:** Ship stores collaborative editor content in two synchronized representations on the same `documents` row: binary Yjs state in `yjs_state` and TipTap JSON backup content in `content`. On persistence, the collaboration server converts the Yjs fragment to JSON, extracts structured fields such as plan, success criteria, vision, and goals into `properties`, and updates all three fields together. On load, it prefers existing Yjs state, falls back to JSON conversion for API-created documents, and sends a cache-clear message when a document was freshly rebuilt from JSON.

**Where I found it:** `api/src/collaboration/index.ts:111-175`, `api/src/collaboration/index.ts:195-240`, `api/src/collaboration/index.ts:691-700`

**Why it matters:** This design gives the editor CRDT semantics for offline/reconnect and multi-user editing while still letting REST routes, list views, history, and accountability features read structured document content without needing to speak Yjs. The cache-clear path is especially important because stale IndexedDB state could otherwise merge old local content back into a document that the server rebuilt from JSON.

**How I would apply it in a future project:** When a rich collaborative editor is not the only consumer of document content, I would persist the native collaboration state plus a normalized read model in the same transaction or debounce cycle. I would treat the read model as derived data, make one source of truth explicit, and build reconnect/cache invalidation behavior before relying on offline editing in production.

## 3. Reliable E2E isolation includes infrastructure, ports, and memory budgeting

**What I learned:** Ship's Playwright setup gives each worker its own PostgreSQL container, API server, and Vite preview server, with worker-scoped fixtures and dynamic port ranges. The config also calculates worker count from available memory and uses `vite preview` instead of `vite dev` because multiple dev servers previously caused severe memory pressure.

**Where I found it:** `playwright.config.ts:4-17`, `playwright.config.ts:23-61`, `e2e/fixtures/isolated-env.ts:1-15`, `e2e/fixtures/isolated-env.ts:27-49`, `e2e/fixtures/isolated-env.ts:106-264`

**Why it matters:** E2E failures are much easier to trust when tests do not share a database, API process, browser-facing server, or port assumptions. The memory controls are not incidental; a theoretically isolated setup can still become unusable if every worker starts heavyweight dev infrastructure.

**How I would apply it in a future project:** I would design browser tests around worker-scoped disposable infrastructure from the start: one database per worker, one app/API instance per worker, deterministic port allocation, and a production-like static server where possible. I would also encode resource limits in the test config rather than leaving them as tribal knowledge in a README.
