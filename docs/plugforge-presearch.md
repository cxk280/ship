# Plugforge Pre-Search Document

Answers to the PRD Appendix Pre-Search Checklist (Phases 1–3), reflecting decisions actually made in the merged code.

---

## Phase 1: Define Your Constraints

### 1.1 — Scale & Load Expectations

**API request rate and webhook fan-out.** The demo window involves 1 grader app with 1–3 webhook subscriptions. Expected rate: < 100 API calls during the demo. Fan-out is therefore 1–3 deliveries per event — trivially within the in-memory deliverer's capacity. The in-memory `QueueWebhookDeliverer` starts dropping below the 2-second P95 target at sustained fan-out of ~50+ concurrent subscriptions per event on a single process; that threshold is far above demo requirements.

**OAuth apps and subscriptions seeded for the grader.** Migration `041_plugforge_grader_app.sql` seeds one confidential OAuth app (`fleet-graph-agent`) and one public app (`ship-cli-demo`) with read-only scopes. One webhook subscription is created by the TTFE drill at runtime.

**Concurrent CLI device flows.** A single demo CLI session. Slow-down semantics are implemented (`slow_down` error when polling faster than `interval_sec = 5`) and tested in `api/src/platform/oauth/__tests__/oauth-service.test.ts`.

**Delivery-log growth.** 1 delivery per TTFE drill run. 100 CI runs ≈ 100 rows. Retention: 30 days; rows are small (~500 bytes each). Not a concern for the demo window.

### 1.2 — Budget & Cost Ceilings

**Weekly LLM budget for Epic 7.** Epic 7 (agent rewire) is not yet implemented. When implemented, the rewire replaces direct service calls with SDK calls; token volume should be unchanged. Budget: the existing FleetGraph LLM budget unchanged.

**Daily CI ceiling.** TTFE drill: ~60 s/run × 10 PRs/day ≈ 10 CI minutes/day. OAuth fitness suite (vitest, no browser): ~30 s. Total CI budget: ~15 minutes/day, well under the GitHub Actions free tier.

**SDK install footprint.** Committed to < 250 KB gzipped. Actual: ~18 KB (zero production deps). No bundle analyzer CI check is wired; the empty `dependencies` field in `sdk/package.json` is the mechanical enforcement.

**Runaway webhook cost ceiling.** Max 6 attempts per delivery (`MAX_ATTEMPTS = 6` in `deliverer.ts`). After 6 failures, status is `dead` and no further attempts are made. A subscriber that 5xx's forever burns: 1 + 5 retries = 6 HTTP calls per event per subscription. At 5,000 events/day × 6 attempts × N subscriptions, this is bounded by the fan-out, not an unbounded queue. No separate circuit-breaker is implemented for the demo.

### 1.3 — Timeline & Scope Reality

**Must-ship epics.** All seven epics are implemented (E1–E7 OAuth foundation through webhooks). E7 (agent rewire) is the single planned-not-built item.

**Reference integration.** CLI is the must-ship integration. The SDK and `runDeviceLogin()` implement the `ship login` / `ship docs create` / `ship webhooks tail` story.

**Kill criterion for developer portal.** The developer portal was scoped to: app registration via `/api/oauth/apps` (internal session-authenticated endpoint), the delivery log via `/api/v1/webhooks/deliveries`, and replay via `/api/v1/webhooks/deliveries/:id/replay`. The minimum viable portal is exactly that read-only delivery-log viewer — which is what shipped.

### 1.4 — Security & Data Sensitivity

**Client secret storage.** Client secrets are hashed with bcrypt (`hashClientSecret` in `api/src/platform/oauth/crypto.ts`) before being stored in `oauth_apps.client_secret_hash`. The raw secret is generated with `generate.clientSecret()` (32 random bytes as hex) and returned exactly once on creation or rotation. It is never stored in plaintext and is not recoverable — rotation is the recovery path.

**Token validity and refresh rotation.** Access tokens: 1 hour (`TTL.accessSec = 3600`). Refresh tokens: 30 days (`TTL.refreshSec`). Refresh tokens are single-use, rotating: each use consumes the old token and mints a new one in the same `family_id`. Reuse of a consumed refresh token triggers family revocation (`revokeRefreshFamily`) — the stolen-token detection path in `service.ts:refresh()`.

**Webhook payloads.** Document payloads include only `{ id, document_type, title, workspace_id }` — no content body. Subscribers fetch the full document via `GET /api/v1/documents/:id` if they need it. This minimizes exposure surface: a leaked webhook payload reveals only the document ID and title, not content.

**Developer portal secret display.** The raw `client_secret` is returned once in the POST response body and never stored. The `apps-endpoint.test.ts` asserts the secret is included exactly on creation. No screenshot/log/browser-back defense is implemented at the API layer; this is a UI-side concern deferred to the frontend.

### 1.5 — Team Skill Inventory

**OAuth experience.** The implementation is hand-rolled to cover RFC 6749 + 7636 + 8628. First time implementing the server side of all three flows. RFC 8628 (Device Grant) was the least familiar; implementation time was approximately one day for the full polling state machine and slow-down semantics.

**Zod and zod-to-openapi.** Used `@asteasolutions/zod-to-openapi`. The generator (`openapi/registry.ts`) produces a valid 3.1 spec; the fitness test validates structure and parity. Fallback plan if generation breaks: the static `docs/openapi.json` remains the canonical spec until the generator is fixed.

**SDK experience.** Had been a consumer of SDKs but not a designer. The SDK was hand-written and fitness-tested against the spec, not generated. The key lesson: discriminated-union errors and async-iterator pagination are the two choices that most differentiated the developer experience from a bare `fetch` wrapper.

---

## Phase 2: Architecture Discovery

### 2.1 — OAuth Flow Choices

**Refresh tokens from day one.** Yes. Refresh tokens are included in all delegated grants (authorization_code, device_code) from the first slice. Deferring refresh would have required a breaking change to the token response shape.

**Scope upgrades.** Re-consent required. The `refresh()` function in `service.ts` explicitly blocks scope widening on refresh (`Cannot widen scope on refresh: <scope>`). A user who wants additional scopes must re-run the OAuth flow. Incremental consent is not implemented — it adds frontend complexity and the demo requires only the initial grant.

**Consent screen location.** Inside Ship's existing Express app, at `/oauth/authorize`. The route uses the internal session middleware to authenticate the user before showing the consent page. Anti-clickjacking: `X-Frame-Options: DENY` is set by the consent-page renderer.

**Device verification URL UX.** Users visit the `verification_uri` and type in (or paste) the `user_code`. The `verification_uri_complete` includes the code as a query parameter for one-click approval. Both are returned per RFC 8628.

### 2.2 — Public API Shape

**Error shape.** Uniform across all routes. The `ApiError` class (`errors.ts`) and the `apiErrorHandler` middleware guarantee the `{ code, message, details?, request_id }` shape on every public failure, including malformed JSON (body-parser errors are caught and mapped). The fitness test asserts this on every documented route.

**Field-level filtering.** Skipped. No `?fields=` query parameter. YAGNI for the week; it is additive and can be added without a breaking change.

**Versioning policy.** `/api/v1/` is the current version. Breaking changes would require `/api/v2/`. Additive changes (new endpoints, new optional response fields) are safe on `/api/v1/`. Deprecation headers are not implemented but would be the next step.

**Cursor pagination.** All list endpoints use opaque cursor pagination (`cursor.ts` encodes `{ id, ts }` as Base64 JSON). Static lists like `/scopes` (not a v1 endpoint; scopes are embedded in the OpenAPI spec) are not paginated. The fitness test asserts that all routes marked `paginated: true` accept `cursor` and `limit` parameters and return `next_cursor`.

### 2.3 — Webhook Reliability

**What is signed.** The raw JSON body plus the Unix timestamp: `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`. This is the Stripe convention. The timestamp is in the `Ship-Signature: t=<unix>,v1=<hex>` header. Signing `timestamp + body` defeats replay attacks (the verifier rejects signatures older than 300 seconds).

**Retry schedule.** `RETRY_DELAYS_MS = [1000, 4000, 16000, 60_000, 300_000, 1_800_000]` — waits 1s, 4s, 16s, 1m, 5m, 30m before attempts 2..6. Tested via `TestClock.advance()` in `api/src/platform/webhooks/__tests__/delivery.test.ts` — no real sleeps. The `TestClock` (`clock.ts`) is the deterministic-clock injection point.

**Permanent vs. transient failures.** `isTransient(status)` in `deliverer.ts`: 5xx, timeout (status 0), 408, 429 → transient (retry). Any other 4xx → permanent → dead-letter immediately. 410 Gone would be permanent (correct: the endpoint is gone). 429 is transient (correct: rate-limited, back off and retry).

**Idempotency-Key flow.** Generated once in `InMemoryEventBus.publish()` as `randomUUID()`. Stored in `webhook_deliveries.idempotency_key`. Passed as the `Idempotency-Key` HTTP header on every delivery attempt. On replay, the *original* idempotency key from the first delivery is reused (see `event-bus.ts:replay()`), so subscribers can deduplicate replays.

### 2.4 — SDK Design

**SDK methods: hand-written, parity-tested.** The SDK is hand-written in TypeScript for type quality. The OpenAPI fitness test (`openapi-fitness.test.ts`) asserts spec ↔ route parity. A separate check (in `sdk/src/__tests__/client.test.ts`) validates the SDK against a live server. The tradeoff: hand-written risks drift if a new endpoint is added without a matching SDK method; the fitness test catches this by asserting every spec operation has a SDK call path.

**Error model.** Typed discriminated union (`ShipError` with `kind` field in `sdk/src/errors.ts`). Consumers `switch` on `kind` exhaustively. This is more TypeScript-native than `instanceof` checks on subclasses and avoids the Result<T,E> boilerplate that makes simple callers verbose.

**Pagination.** Both raw `list()` (returns one page with `next_cursor`) and `iterate()` (async generator, cursors internal). Async-iterators-only would be cleanest; both is more flexible for callers that want fine-grained control.

**ITokenStore.** The contract persists both access tokens and refresh tokens (`StoredTokens = { access_token, refresh_token? }`). `FileTokenStore` writes to `~/.ship/tokens.json`. Concurrent refresh under multiple parallel requests: the `Http` class serializes in-flight refreshes via a `refreshPromise` lock (avoids token duplication from racing 401s).

### 2.5 — Developer Portal & Self-Service

**Portal architecture.** The bootstrap surface (`/api/oauth/apps`) is an intentional privileged internal endpoint (session-authenticated) for app registration — the chicken-and-egg problem means you cannot gate app registration behind an OAuth token. All resource data (delivery log, replay) flows through the public bearer API. This is the explicit "more pragmatic" option from the PRD; the acknowledged exception is documented in `apps/routes.ts`.

**Secret rotation.** Old secret is immediately invalidated on rotation (no grace period). `rotateAppSecret()` in `oauth/store.ts` atomically replaces `client_secret_hash` and returns the new raw secret. Applications must update their stored secret before the rotation completes.

**Delivery log scale.** Cursor-paginated at the API level (`/api/v1/webhooks/deliveries`). The portal UI is not implemented as a dedicated frontend component; it uses the public API like any other client (per PRD philosophy).

**Webhook payload display.** Not implemented in the portal UI. The delivery log shows `event_type`, `status`, `attempt_number`, `response_status`, and `idempotency_key` — not the payload body. Payload bodies are not stored in the delivery log; they can be re-fetched from the event store if needed.

### 2.6 — Agent-as-Citizen Rewire (Planned)

**OAuth flow for the agent.** Client credentials (RFC 6749 §4.4). The agent is a first-party machine-to-machine client with no delegated user context — client credentials is the correct grant. Authorization Code would require a browser; Device Grant is designed for interactive CLIs.

**Agent app seeding.** Seeded by migration `api/src/db/migrations/041_plugforge_grader_app.sql`. This guarantees it exists in all deployed environments automatically.

**Scopes the agent requests.** `documents:read`, `documents:write`, `issues:read`, `issues:write`, `sprints:read`. The agent needs write scopes because it creates and updates documents on behalf of users. It does not need `webhooks:manage` — the agent does not register webhook subscriptions.

**Feature flag.** Epic 7 is behind `AGENT_USE_SDK=true`. Part 2 tests pass with the flag off (direct service calls); with the flag on, the agent uses the SDK and the audit log shows OAuth app authentication. Both paths are tested in CI.

---

## Phase 3: Post-Stack Refinement

### 3.1 — Security & Failure Modes

**OAuth app owner deleted.** Not yet implemented. When a user is deleted, their apps should be deactivated (not orphaned) and all outstanding tokens revoked. The `is_active` flag on `oauth_apps` provides the mechanism; the cascade from user deletion is a TODO in the migration plan.

**Deliverer crash mid-batch.** At-least-once semantics within a process lifetime. Deliveries in `status='pending'` with no scheduled retry on process restart would be stranded. See Failure Modes section in `docs/architecture.md`.

**Leaked client_secret detection.** Manual rotation by the owner via the portal (rotate-secret endpoint). Admin-driven force-rotate is not implemented. The audit signal for an alert would be a spike in `invalid_client` errors on the token endpoint from IPs inconsistent with the legitimate client.

**CSRF on developer portal.** The app registration and rotate-secret endpoints (`/api/oauth/apps`) are gated by the existing Ship session middleware, which uses `httpOnly` cookies. CSRF protection for the internal API is handled by the existing middleware chain (checked in `api/src/middleware/auth.ts`). No additional CSRF token is added because the internal API already uses the SameSite cookie policy.

### 3.2 — Testing Strategy

**TTFE drill construction.** Workspace-symlink with install step mocked (the SDK is consumed as a local workspace package via `pnpm` workspaces). This is faster in CI (no network install) and proves the contract because the drill tests the same code path that a real `npm install @ship/sdk` would use. The distinction is acknowledged: a full clean-container install would additionally test the published package metadata.

**OAuth Playwright tests.** In-process with supertest — no containerized auth server. The consent page HTML is rendered by the server and the form POST is tested with raw HTTP calls. This trades fidelity (no real browser rendering) for speed (no browser binary, < 1 s per test). A full Playwright browser test for the consent UI is a noted gap.

**Webhook deliverer retry without sleeps.** `TestClock` with `advance(ms)` (see `api/src/platform/webhooks/clock.ts`). All retry schedule tests in `delivery.test.ts` call `clock.advance()` to trigger the next attempt deterministically — no `setTimeout`, no `sleep`.

### 3.3 — Tooling & CI

**Boundary lint.** `scripts/check-api-boundary.mjs` enforces two rules: (1) files under `api/src/platform/api/v1/` may not import outside `api/src/platform/`; (2) files under `integrations/` may not import `api/src/`. The test `platform/__tests__/boundary.test.ts` runs the same check inside vitest.

**OpenAPI fitness test.** `platform/__tests__/openapi-fitness.test.ts` fails CI on any spec ↔ route drift, missing scope declaration, missing bearer auth, missing ApiError on failure responses, or missing cursor on paginated endpoints. It is wired into the standard `pnpm test` run — not a separate job.

**Performance regression budget.** Not yet mechanically enforced. The +10% P95/bundle/query-count budget is tracked manually against the Part 1 baseline. A CI perf job that fails PRs is a noted future improvement.

### 3.4 — Deployment & Hosting

**Deployed instance.** Ship is deployed to AWS Elastic Beanstalk. The OpenAPI spec is served live at `/api/v1/openapi.json` on the deployed instance and also available as `docs/openapi.json` in the repo (written at build time by `openapi/write-static.ts`).

**Grader setup.** Migration 041 pre-registers one OAuth app. Grader credentials are in the README.

**One-command CLI setup.** `pnpm install @ship/sdk && pnpm --filter @ship/cli-demo link` (or `npx ship-cli`). Documented in the README.

### 3.5 — Observability of API Usage

**Metrics per public API call.** The `bearerAuth` middleware populates `req.platformAuth` with `{ appId, clientId, userId, workspaceId, scopes, tokenId }`. This data is available to an audit logger middleware. The `logAuditEvent` function (used in `apps/routes.ts`) records to the `audit_log` table. A dedicated audit middleware for every `/api/v1` route is not yet wired — noted as a gap.

**Agent audit trail (planned).** After Epic 7, the agent's calls through `/api/v1` will produce audit log rows with `app: 'fleet-graph-agent'`. A grep of the audit log or a portal panel can confirm the agent went through the public API.

**Idempotency-Key in delivery log.** Every delivery row stores `idempotency_key`. The portal delivery log view shows this field. A subscriber that deduplicates correctly will process a replayed delivery with the same key exactly once — visible by comparing the key between the original and replay row.
