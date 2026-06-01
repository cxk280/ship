# Plugforge Per-Epic Write-ups

Format: Before → Fix → After → Proof.

---

## E1 — OAuth + Contract Layer

**Before.** Ship had no OAuth implementation. API access was via session cookies (internal only). There was no concept of OAuth apps, client IDs, scopes, access tokens, or refresh tokens. Any third-party integration would have needed to scrape session cookies — a non-starter.

**Fix.** Implemented RFC 6749 + 7636 + 8628 end-to-end, hand-rolled in TypeScript:
- `api/src/platform/oauth/service.ts` — pure grant functions: `issueAuthorizationCode`, `exchangeAuthorizationCode` (with mandatory PKCE verifier check), `refresh` (rotation + family-revoke theft detection), `clientCredentials`, `startDeviceAuthorization`, `pollDeviceToken` (slow-down semantics).
- `api/src/platform/oauth/store.ts` — PostgreSQL persistence for apps, auth codes, access tokens, refresh tokens, device codes.
- `api/src/platform/oauth/crypto.ts` — PKCE `verifyPkce` (SHA-256 challenge), bcrypt `hashClientSecret`/`verifyClientSecret`, secure random token generation.
- `api/src/platform/scopes/registry.ts` — `ScopeRegistry` with seven scopes registered as data.
- `api/src/db/migrations/040_plugforge_oauth.sql` — all OAuth tables.
- `api/src/db/migrations/041_plugforge_grader_app.sql` — seeds grader + CLI demo apps.
- `api/src/platform/apps/routes.ts` — `/api/oauth/apps` bootstrap endpoint (session-authenticated).
- `api/src/platform/oauth/routes.ts` — `/oauth/authorize`, `/oauth/token`, `/oauth/device/code`, `/oauth/device/verify`.

**After.** A third-party developer can register an OAuth app, send users through the consent screen, exchange an auth code for an access token (with mandatory PKCE), refresh tokens with rotation, and run a CLI through the device flow. Stolen refresh tokens invalidate the entire family. Seven scopes (documents:read/write, issues:read/write, sprints:read/write, webhooks:manage) are registered as data — adding a scope is one line.

**Proof.**
- `api/src/platform/oauth/__tests__/oauth-service.test.ts` — full grant lifecycle: auth-code issuance and exchange, PKCE negative case (wrong verifier → `invalid_grant`), refresh rotation, theft detection (reuse of consumed token → family revoke), client-credentials, device flow (pending → slow_down → approved → tokens).
- `api/src/platform/oauth/__tests__/token-endpoint.test.ts` — HTTP-level token endpoint tests via supertest.
- `api/src/platform/apps/__tests__/apps-endpoint.test.ts` — app registration, secret shown once, rotation.
- `api/src/platform/__tests__/scopes.test.ts` — scope registry data invariants.

---

## E2 — Public API Boundary

**Before.** Ship had a single `/api/*` internal router with session-cookie auth and no versioning. There was no public surface. The internal API response shape (`{ success, data }` / `{ success: false, error }`) was inconsistent with what a public contract demands.

**Fix.**
- `api/src/platform/api/v1/router.ts` — a brand-new Express `Router()` that shares *no* middleware with the internal API. Its pipeline: `requestId → bearerAuth → rateLimit → [resource routes, each declaring scope] → 404 → apiErrorHandler`. Mounted at `/api/v1` in `app.ts` via `buildPlatform()`.
- `api/src/platform/errors.ts` — `ApiError` class with closed code set (`unauthorized`, `forbidden`, `not_found`, `validation_failed`, `rate_limited`, `server_error`), `requestIdMiddleware`, `apiErrorHandler` (guarantees the shape on every failure including malformed JSON and body-parser errors).
- `api/src/platform/api/v1/ports.ts` — `IdentityPort`, `DocumentsPort`, `WebhooksPort` interfaces. The v1 layer depends only on these; no concrete imports from `api/src/` outside `platform/`.
- `api/src/platform/api/v1/route-meta.ts` — `PublicRouteMetaRegistry`: every route self-declares scope + pagination at load time.
- `scripts/check-api-boundary.mjs` — import-graph lint rule, runs in CI and in the vitest suite.

**After.** Every `/api/v1/*` failure returns exactly `{ code, message, details?, request_id }`. The public and internal APIs share domain services but nothing else. A route added to `/api/v1` without declaring a scope fails the fitness test. A file in `platform/api/v1/` that imports from `api/src/` outside `platform/` fails the boundary lint.

**Proof.**
- `api/src/platform/__tests__/boundary.test.ts` — import-graph lint passing (zero violations).
- `api/src/platform/__tests__/errors.test.ts` — ApiError shape on every code path including ZodError, body-parser errors, unhandled exceptions.
- `api/src/platform/__tests__/v1-edge.test.ts` — bearer auth rejection paths (missing token, invalid token, expired token with distinct reason).
- `api/src/platform/__tests__/openapi-fitness.test.ts` — every route declares a scope, every documented operation requires bearer auth, every failure response uses ApiError.

---

## E3 — Documents Resource

**Before.** The internal `/api/documents` routes existed with session auth. There was no public versioned surface for documents, no opaque cursor pagination, and no event publication on write.

**Fix.**
- `api/src/platform/api/v1/documents.ts` — `GET /documents` (cursor-paginated list), `GET /documents/:id`, `POST /documents`. Each route declares its scope via `requireScope(SCOPES.DOCUMENTS_READ / DOCUMENTS_WRITE)`.
- `api/src/platform/adapters/documents.ts` — `DocumentsPort` impl: bridges `documentsDomain` (existing internal service), encodes/decodes opaque cursors, and publishes `document.created` on successful create.
- `api/src/platform/cursor.ts` — `encodeCursor`/`decodeCursor`: Base64-encoded JSON keyset cursor `{ id, ts }`.
- `api/src/platform/api/v1/schemas.ts` — Zod schemas for `PublicDocument`, `DocumentPage`, `CreateDocument`, `ListDocumentsQuery`, etc.

**After.** `GET /api/v1/documents` returns a cursor-paginated list of documents. `POST /api/v1/documents` creates a document and fires `document.created` on the event bus. The same `documentsDomain` code used by the internal UI is invoked — no duplication. Cursor pagination is opaque: consumers pass `next_cursor` back as the `cursor` query parameter; no internal keyset details leak.

**Proof.**
- `api/src/platform/api/v1/__tests__/documents.test.ts` — list (first page, cursor continuation, empty list), get (existing + 404), create (valid + scope rejection), cursor roundtrip.
- `api/src/platform/webhooks/__tests__/delivery.test.ts` — `document.created` event fires and a delivery reaches the subscriber (integrated with the documents adapter).

---

## E4 — OpenAPI / Fitness

**Before.** No OpenAPI spec. No machine-readable description of the public API surface. No automated check for spec drift.

**Fix.**
- `api/src/platform/openapi/registry.ts` — `@asteasolutions/zod-to-openapi` registry. Reads Zod schemas from `api/v1/schemas.ts`, registers all paths (security, parameters, request bodies, response schemas), and generates an OpenAPI 3.1 document at request time via `getV1OpenApiDocument()`.
- `api/src/platform/openapi/load-routes.ts` — side-effect import that registers all route path metadata into the OpenAPI registry (imported at boot and in the fitness test).
- `api/src/platform/openapi/write-static.ts` — script run at build time that writes `docs/openapi.json`.
- `api/src/platform/api/v1/router.ts` — serves `GET /api/v1/openapi.json` without auth (before the bearer gate).
- `api/src/platform/__tests__/openapi-fitness.test.ts` — asserts: valid 3.1 structure, no dangling `$ref`s, every route has a spec entry, every spec entry has a route, every route declares scope, every documented operation requires bearer auth, every failure response is `ApiError`, every paginated endpoint has `cursor`/`limit` params and returns `next_cursor`.

**After.** The spec is generated from code — it cannot drift unless someone removes the fitness test. A new endpoint added without an OpenAPI registration fails the fitness test. A spec entry added without a route implementation also fails. The spec is served live and also available statically at `docs/openapi.json`.

**Proof.**
- `api/src/platform/__tests__/openapi-fitness.test.ts` — all assertions passing (spec validity, parity, per-route contract, pagination invariants).
- `docs/openapi.json` — static copy committed to the repo, generated by `openapi/write-static.ts`.

---

## E5 — SDK

**Before.** No `@ship/sdk` package. Consumers had to hand-craft `fetch` calls against the public API, handle cursors manually, parse error shapes by hand, and implement device-flow polling themselves.

**Fix.**
- `sdk/src/client.ts` — `ShipClient` with `documents` resource client as a property; `me()`; `static deviceLogin()`.
- `sdk/src/resources/documents.ts` — `DocumentsClient`: `list()`, `get()`, `create()`, `iterate()` (async-generator, cursors internal).
- `sdk/src/errors.ts` — `ShipError` discriminated union (`kind: auth|rate_limit|not_found|validation|server|network`).
- `sdk/src/token-store.ts` — `ITokenStore` interface; `InMemoryTokenStore`; `FileTokenStore` (writes to `~/.ship/tokens.json`).
- `sdk/src/auth/device.ts` — `runDeviceLogin`: Device Grant polling loop; calls `onUserCode` callback so CLI can display the code, polls until approved or expired.
- `sdk/src/webhooks/verify.ts` — `verifyWebhook(headers, rawBody, secret, toleranceSec?)`: Stripe-style HMAC-SHA256 + timestamp replay guard; constant-time comparison.
- `sdk/src/http.ts` — `Http`: fetch wrapper with 401-refresh loop (serialized via `refreshPromise` lock), `X-Request-Id` header on every call.
- Zero production npm dependencies.

**After.** `for await (const doc of client.documents.iterate())` walks all pages. `verifyWebhook(...)` is one call. `ShipClient.deviceLogin(...)` handles the full CLI login flow. Errors are discriminated by `kind` for exhaustive switch handling.

**Proof.**
- `sdk/src/__tests__/client.test.ts` — `me()`, `documents.list()`, `documents.create()`, `iterate()` pagination, `ShipError` kind mapping for each status code, 401 refresh loop.
- `sdk/src/__tests__/verify.test.ts` — `verifyWebhook` valid, tampered body, expired timestamp, missing header, wrong secret.

---

## E6 — Rate Limiting

**Before.** No rate limiting on the public API. No `X-RateLimit-*` headers. A single misbehaving client or runaway script could saturate the server.

**Fix.**
- `api/src/platform/ratelimit/limiter.ts` — `IRateLimiter` interface + `InMemoryTokenBucketLimiter`: token bucket with configurable capacity and refill rate; `consume(key, cost)` returns `{ allowed, limit, remaining, resetSec, retryAfterSec }`.
- `api/src/platform/ratelimit/middleware.ts` — `createRateLimitMiddleware({ perToken, perApp })`: dual-bucket middleware. Per-token bucket (120 burst, ~2/s sustained in production) applied first; per-app bucket (600 burst, ~10/s sustained) applied second. Rejected requests get `429 rate_limited` ApiError + `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers. All limits are relaxed to 100k/100k in `NODE_ENV=test` or `E2E_TEST=1`.
- `api/src/platform/composition.ts` — wires both limiters and injects into `PlatformDeps.rateLimit`.

**After.** Every `/api/v1` response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Requests over the per-token or per-app limit receive a `429` with `Retry-After`. Test suites are unaffected by the relaxed test limits.

**Proof.**
- `api/src/platform/ratelimit/__tests__/ratelimit.test.ts` — token-bucket math (burst, refill, sustained rate), `allowed=false` response on exhaustion, header values on both allowed and rejected requests, dual-bucket per-token-then-per-app ordering, test-env relaxation.

---

## E7 — Webhooks

**Before.** Ship had no webhook system. Domain writes did not emit events. There was no subscription model, no delivery pipeline, and no signed delivery mechanism.

**Fix.**
- `api/src/platform/webhooks/events.ts` — `EventRegistry` with 8 typed event types (`document.created/updated/deleted`, `issue.created/assigned/status_changed`, `sprint.started/completed`), each with a Zod payload schema.
- `api/src/platform/webhooks/event-bus.ts` — `IEventBus` + `InMemoryEventBus`: generates `idempotency_key` (UUID), stores event row, matches subscriptions, inserts delivery rows, enqueues to deliverer. `replay()` reuses the original idempotency key.
- `api/src/platform/webhooks/deliverer.ts` — `IWebhookDeliverer` + `QueueWebhookDeliverer`: retry state machine (1s, 4s, 16s, 60s, 300s, 1800s delays), `isTransient` (5xx + 408 + 429), dead-letter after 6 failures, SSRF guard via `url-guard.ts`.
- `api/src/platform/webhooks/signer.ts` — `signPayload(secret, body, tSec)`: `Ship-Signature: t=<unix>,v1=<hex-hmac-sha256>`.
- `api/src/platform/webhooks/clock.ts` — `Clock` interface + `systemClock` + `TestClock` (deterministic, no real sleeps).
- `api/src/platform/webhooks/store.ts` — `webhook_subscriptions`, `webhook_events`, `webhook_deliveries` persistence.
- `api/src/db/migrations/042_plugforge_webhooks.sql` — all webhook tables.
- `api/src/platform/api/v1/webhooks.ts` — `POST /webhooks/subscriptions` (create + return signing secret), `GET /webhooks/subscriptions`, `DELETE /webhooks/subscriptions/:id`, `GET /webhooks/deliveries`, `POST /webhooks/deliveries/:id/replay`. All gated by `webhooks:manage` scope.
- `api/src/platform/adapters/webhooks.ts` — `WebhooksPort` impl connecting the v1 routes to the webhook store and event bus.
- `sdk/src/webhooks/verify.ts` — `verifyWebhook` (subscriber-side SDK helper).

**After.** A `POST /api/v1/documents` triggers `document.created` → matched subscriptions → signed delivery → retry on 5xx → dead-letter after 6 failures → replay with original idempotency key. The TTFE drill (`pnpm drill ttfe`) proves this end-to-end in CI in < 60 seconds.

**Proof.**
- `api/src/platform/webhooks/__tests__/signer.test.ts` — sign/verify roundtrip, tampered body rejected, expired timestamp rejected, cross-check with SDK `computeSignature`.
- `api/src/platform/webhooks/__tests__/delivery.test.ts` — signed delivery arrives with correct header (scenario 5), retry schedule 500×3 then 200 (scenario 6), DLQ after 6 failures + replay with original idempotency key (scenario 7), TestClock determinism.
- `api/src/platform/webhooks/__tests__/events.test.ts` — event registry validation (valid payload passes, invalid payload throws ZodError, unknown event type rejected).
- `api/src/platform/webhooks/__tests__/url-guard.test.ts` — SSRF guard blocks private IPs and `localhost` in production mode.
- `api/src/platform/api/v1/__tests__/webhooks-routes.test.ts` — subscription CRUD, delivery list, replay endpoint, scope enforcement.
- `sdk/src/__tests__/verify.test.ts` — webhook verifier (valid, tampered, expired, missing).

---

## Three Discoveries

### 1. OAuth Device Authorization Grant in TypeScript (RFC 8628)

The Device Grant's slow-down semantics (`slow_down` vs `authorization_pending`) are subtly different from what most tutorials describe. RFC 8628 §3.5 requires that if the client polls before the advertised interval, the server must increase the interval AND return `slow_down`. The `pollDeviceToken` implementation in `api/src/platform/oauth/service.ts` tracks `last_polled_at` and computes `since = now - last_polled_at`; if `since < interval_sec * 1000`, it calls `store.touchDevicePoll(row.id)` (updating the timestamp) and throws `slow_down`. A naive implementation that just checks "is the code pending" would return `authorization_pending` regardless of poll rate, breaking the RFC contract and allowing runaway polling.

### 2. Zod-Driven OpenAPI Generation with Fitness-Test Parity

The insight that changed the design: the OpenAPI spec and the route implementation share the *same* Zod schemas (`api/src/platform/api/v1/schemas.ts`). The generator (`openapi/registry.ts`) reads those schemas; the request handlers validate against them at runtime. The fitness test (`openapi-fitness.test.ts`) asserts that every route in the `publicRoutes` registry has a spec entry and vice versa. This means spec drift is structurally impossible as long as the fitness test runs — you cannot add a route without registering it in both the route-meta registry and the OpenAPI registry, and you cannot add a spec entry without a corresponding route. The fitness test is not just a safety check; it is the spec-generation mechanism's invariant.

### 3. Stripe-Style HMAC + Timestamp Anti-Replay

The `Ship-Signature: t=<unix>,v1=<hex-hmac-sha256>` scheme signs `"${timestamp}.${rawBody}"` rather than just the body. This defeats replay attacks: an intercepted webhook cannot be re-sent after the tolerance window (default 300 seconds) because the timestamp in the header would fail the freshness check in `verifyWebhook`. The cross-check between `signer.ts` (server) and `verify.ts` (SDK) is enforced in `signer.test.ts` — both `computeSignature` implementations must agree byte-for-byte. The constant-time comparison in `timingSafeEqual` prevents timing-oracle attacks on the hex string comparison. The discovery: signing `timestamp.body` (not body alone, not headers) is the minimal scheme that defeats replay, MITM body-swap, and timing attacks in one primitive.

### 4. Async-Iterator Pagination as a Developer-Experience Pattern

`DocumentsClient.iterate()` wraps the cursor loop in an async generator. The consumer writes `for await (const doc of client.documents.iterate())` and never sees a cursor. This was a deliberate choice over returning raw `{ data, next_cursor }` objects. The discovery: async generators are the only pagination pattern that composes naturally with other async iterators (`take`, `filter`, `pipeline`) without forcing the caller to manage state. The raw `list()` method is still exposed for callers that want one page, but `iterate()` is the idiomatic path. This pattern was borrowed from the AWS SDK v3 paginator design; applying it to a hand-written SDK made the TTFE drill's document creation loop three lines instead of fifteen.
