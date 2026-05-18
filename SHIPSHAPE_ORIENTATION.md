# ShipShape Codebase Orientation

Date: May 18, 2026  
Commit inspected: `076a183`  
Phase: Before You Start / Codebase Orientation  
Scope: Understand the system before auditing. No product-code changes.

## 1. First Contact

### Local Setup Notes

Commands used during orientation:

```bash
npx pnpm@10.27.0 install
npx pnpm@10.27.0 --filter @ship/shared build
npx pnpm@10.27.0 type-check
npx pnpm@10.27.0 --filter @ship/web build
```

Observed setup details:

- `pnpm` was not initially on PATH.
- `corepack prepare pnpm@10.27.0 --activate` failed with a signature key mismatch, so `npx pnpm@10.27.0 ...` was used.
- `api` and `web` resolve `@ship/shared` through `shared/dist`; build `shared` first when type errors mention missing `@ship/shared`.
- `npx pnpm@10.27.0 type-check` passed after dependencies were installed and `shared` was built.
- `npx pnpm@10.27.0 --filter @ship/web build` passed.
- I did not start long-running dev servers during this orientation note pass. The next setup validation step is to run `pnpm dev` or `pnpm docker:up` and log in with the README demo account.

### Documentation Reviewed

The `docs/` folder establishes the intended architecture and product model:

- `application-architecture.md`: monorepo, Express API, React/Vite frontend, PostgreSQL, raw SQL, TanStack Query, TipTap/Yjs, server-as-truth.
- `unified-document-model.md` and `document-model-conventions.md`: everything is a document; type-specific behavior lives in JSONB `properties`; cross-document relationships use `document_associations`.
- `ship-philosophy.md`, `accountability-philosophy.md`, `performance-management.md`, and `week-documentation-philosophy.md`: Ship is plan/accountability driven, not just an issue tracker.
- `claude-reference/*`: developer reference for architecture, API, security, testing, gotchas, anti-patterns, and workflow.
- `shadow-env-testing.md`, `DEPLOYMENT*.md`, Dockerfiles, and Terraform docs describe local/shadow/prod operating paths.

### Package Relationship

```text
shared/
  exports domain types and constants
       |
       v
api/ --------------------> PostgreSQL
  Express routes              documents table
  auth/session middleware     associations/history/files/sessions
  WebSocket/Yjs persistence
       ^
       |
web/
  React pages/components
  TanStack Query hooks
  TipTap/Yjs editor
```

`shared` is the compile-time contract between frontend and backend. `api` writes and reads PostgreSQL. `web` consumes REST endpoints and connects to WebSocket collaboration rooms.

## 2. Data Model

### Core Tables

- `workspaces`: workspace boundary and sprint start date.
- `users`: global identity, auth fields, super-admin flag, last workspace.
- `workspace_memberships`: authorization membership and role per workspace.
- `sessions`: browser sessions with inactivity and absolute timeout.
- `api_tokens`: programmatic bearer-token access.
- `documents`: unified content table for wiki, issue, program, project, sprint, person, weekly plan, weekly retro, standup, and weekly review.
- `document_associations`: relationship junction table for program/project/sprint/parent links.
- `document_history`: audit trail for field/content changes.
- `files`, `document_links`, `comments`, `audit_logs`: attachments, backlinks, inline comments, and compliance logs.

### Unified Document Model

The `documents` table is the load-bearing model. It stores:

- `document_type` enum as discriminator.
- TipTap JSON backup content in `content`.
- collaborative binary state in `yjs_state`.
- hierarchy via `parent_id`.
- type-specific JSONB fields in `properties`.
- `ticket_number` for issue display IDs.
- visibility, archive/delete, conversion, and status timestamp fields.

This design makes every entity linkable/editable as a document, but it pushes complexity into:

- property extraction and type narrowing,
- query filters over JSONB,
- association joins,
- visibility checks,
- route-level transformation between DB rows and typed API responses.

### Relationship Model

Relationships are mostly not direct columns anymore:

- parent/child issue hierarchy can use `parent_id` and/or `document_associations`.
- program/project/sprint membership uses `document_associations`.
- `belongs_to` arrays are the frontend/API shape for association display.
- utility functions in `api/src/utils/document-crud.ts` batch association reads to avoid N+1 patterns.

## 3. Request Flow: Creating An Issue

User action traced: create issue.

1. UI action starts in `web/src/pages/App.tsx` or `web/src/components/IssuesList.tsx`.
2. `useIssues()` from `web/src/hooks/useIssuesQuery.ts` exposes `createIssue`.
3. `createIssueApi()` posts to `/api/issues` using `apiPost`.
4. `api/src/app.ts` applies global middleware: security headers, rate limiting, CORS, JSON parsing, cookies, session middleware, CSRF for state-changing routes.
5. `/api/issues` routes through `conditionalCsrf` and `issuesRoutes`.
6. `api/src/routes/issues.ts` validates request body with `createIssueSchema`.
7. `authMiddleware` establishes `req.userId`, `req.workspaceId`, and super-admin/API-token context.
8. The issue route opens a transaction and takes a PostgreSQL advisory lock derived from workspace ID to serialize ticket-number generation.
9. It computes `MAX(ticket_number) + 1` for that workspace, inserts a `documents` row with `document_type = 'issue'`, JSONB issue properties, ticket number, and creator.
10. It inserts requested `document_associations`.
11. It commits, fetches display association data, and returns a transformed issue response with `display_id`.
12. The frontend mutation replaces its optimistic issue with the returned server issue and navigates to `/documents/:id` when created from the app shell.

Important observation: issue creation is already transaction-protected for ticket numbers, but the route still has a large type/assertion surface and many DB-row transformations.

## 4. Middleware And Authentication

### Middleware Chain

Primary middleware in `api/src/app.ts`:

- production proxy handling for CloudFront,
- `helmet` security headers and CSP,
- API rate limiting,
- CORS with credentials,
- JSON and URL-encoded body parsers,
- cookie parsing,
- Express session for CSRF token storage,
- `/api/csrf-token`,
- health and Swagger routes,
- conditional CSRF for state-changing routes,
- public feedback routes before protected routes,
- auth, document, issue, project, week, team, admin, file, comments, search, dashboard, accountability, AI, and weekly-plan routers.

### Auth Modes

- Browser auth uses `session_id` cookies backed by the `sessions` table.
- API-token auth uses bearer tokens hashed with SHA-256 and stored in `api_tokens`.
- CAIA/PIV OAuth routes exist for government identity flows.
- Super-admin and workspace role checks are layered on top of session identity.

`authMiddleware` checks bearer token first, then cookie session. Sessions enforce:

- 15-minute inactivity timeout,
- 12-hour absolute timeout,
- database-backed session deletion on expiry.

Unauthenticated protected requests return an error before route logic runs.

## 5. Real-Time Collaboration

### Server

`api/src/collaboration/index.ts` owns WebSocket/Yjs behavior:

- one in-memory `Y.Doc` per room,
- awareness state per room,
- connection and message rate limits,
- session validation from cookies,
- document visibility checks before collaboration access,
- Yjs update handling,
- debounced persistence every 2 seconds after changes.

Room names are `type:uuid`, but persistence maps back to the unified `documents` table by parsing the UUID.

Persistence updates:

- `documents.yjs_state` with binary Yjs state,
- `documents.content` with TipTap JSON backup,
- relevant extracted plan/success criteria/vision/goals into `properties`,
- `document_history` for weekly plan/retro content changes, throttled to avoid excessive logs.

### Client

`web/src/components/Editor.tsx` uses:

- `Y.Doc`,
- `IndexeddbPersistence` for local cached editor content,
- `WebsocketProvider` for server sync,
- awareness for connected users/cursors.

The client handles special close codes:

- access revoked,
- document converted,
- content updated via API,
- cache clear when server rebuilds Yjs state from JSON content.

Two users editing the same document are reconciled by Yjs CRDT updates. The server remains authoritative for persistence and reconnect state.

## 6. TypeScript Patterns

TypeScript config:

- root `tsconfig.json` has `strict: true`, `noUncheckedIndexedAccess`, `noImplicitReturns`, and `noFallthroughCasesInSwitch`.
- `shared` is composite and emits `dist`.
- `api` extends root config and maps `@ship/shared` to `../shared/dist`.
- `web` uses React JSX, bundler module resolution, strict mode, and references `shared`.

Patterns observed:

- discriminated union: `DocumentType`.
- string-literal unions: `IssueState`, `IssuePriority`, `IssueSource`, approval states.
- utility-ish shared interfaces for document properties.
- Zod validation in API routes.
- JSONB compatibility through `[key: string]: unknown` on property interfaces.
- many route-local DB row transformations and type assertions, which will matter during the later Type Safety audit.

## 7. Testing Infrastructure

### Unit/API Tests

- API uses Vitest with Node environment.
- Web uses Vitest with jsdom.
- API route/service tests live near implementation files.

### E2E Tests

Playwright config uses testcontainers:

- each worker gets its own PostgreSQL container,
- each worker gets its own API server,
- each worker gets its own Vite preview server,
- global setup builds API and web once before tests,
- worker count is memory-aware,
- retries are enabled for local/CI flakiness handling.

Important operational note: docs warn against direct noisy E2E execution in agent contexts. For this assignment, we should still collect test baselines, but with controlled workers and captured output.

## 8. Build And Deploy

### Local/Docker

- `docker-compose.local.yml` runs Postgres, API, and web for local development.
- API dev Dockerfile builds `shared` then API, runs migrations/seed, then starts API.
- Web Dockerfile builds `shared` then starts Vite dev server.

### Production Shape

- Production Dockerfile expects prebuilt `shared/dist` and `api/dist`.
- API starts by running migrations, then `dist/index.js`.
- Terraform manages AWS infrastructure.
- The current Terraform docs describe separate environment patterns, modules, CloudFront/S3 frontend, Elastic Beanstalk API, Aurora/Postgres, SSM, security groups, WAF, and CloudFront WebSocket routing.

## 9. Architecture Assessment

### Strongest Decisions

1. Unified document model: strong product fit for docs/issues/projects/weeks sharing content, collaboration, links, history, and permissions.
2. Server-as-truth with local editor cache: pragmatic balance between collaboration, reconnect behavior, and operational simplicity.
3. Isolated E2E test architecture: per-worker database/API/web reduces state leakage and makes failures more meaningful.

### Weakest / Highest-Risk Points

1. Route-layer type/assertion density: request, DB, and response boundaries are where type weakness matters most.
2. Unified JSONB properties: flexible, but risks runtime data-shape drift without central parsing and typed row adapters.
3. Large frontend entry/bundle risk: route/page imports and editor dependencies need bundle measurement before any optimization.

### What I Would Tell A New Engineer First

Ship is not “a wiki plus a tracker.” It is a document-centered accountability system. Learn the `documents` table, `document_associations`, `properties`, visibility rules, and Yjs persistence before touching features.

### What Breaks First At 10x Users

- database query patterns over `documents` and JSONB properties,
- WebSocket memory/connections if many docs stay active,
- route handlers with broad row transformations and assertions,
- frontend initial-load bundle if heavy editor/admin/team surfaces are eagerly loaded,
- audit/history tables if content-change logging grows without retention/index review.

## 10. Discovery Candidates

These are good candidates for the required “3 things learned” deliverable:

1. PostgreSQL advisory locks for per-workspace ticket-number generation in `api/src/routes/issues.ts`.
2. Yjs state plus TipTap JSON backup in one unified `documents` row.
3. Playwright worker isolation with one Postgres container/API server/web preview per worker.

