# Plugforge Platform Architecture

## Module Layout

```
api/src/platform/
  composition.ts        Single wiring point — builds all concrete impls and mounts /api/v1
  errors.ts             ApiError class + request-id middleware + public error handler
  types.ts              Express.Request augmentation (requestId, platformAuth)
  cursor.ts             Opaque Base64-encoded keyset cursor encode/decode
  apps/
    routes.ts           /api/oauth/apps — session-authenticated app registration bootstrap
  oauth/
    service.ts          Pure grant logic: auth-code+PKCE, refresh rotation, client-credentials, device
    bearer.ts           Bearer-token middleware: validates token hash, populates req.platformAuth
    crypto.ts           PKCE verifier/challenge, token generation, bcrypt client-secret hashing
    store.ts            OAuth persistence: apps, auth codes, access tokens, refresh tokens, device codes
    routes.ts           /oauth/authorize, /oauth/token, /oauth/device/code, /oauth/device/verify
    session.ts          Consent-session helpers (state nonce + PKCE roundtrip state)
    errors.ts           OAuthError (RFC error codes) distinct from public ApiError
    consent-page.ts     HTML consent form renderer
  scopes/
    registry.ts         ScopeRegistry — scopes as data (OCP); seven scopes registered at module load
  ratelimit/
    limiter.ts          IRateLimiter interface + InMemoryTokenBucketLimiter (DIP seam)
    middleware.ts       Per-token and per-app dual-bucket rate-limit middleware; injects headers
  webhooks/
    events.ts           EventRegistry — typed EventType set with Zod payload schemas (8 event types)
    event-bus.ts        IEventBus interface + InMemoryEventBus; generates idempotency keys
    deliverer.ts        IWebhookDeliverer interface + QueueWebhookDeliverer (retry/DLQ state machine)
    signer.ts           computeSignature / signPayload — Stripe-style HMAC-SHA256 timestamp header
    store.ts            webhook_subscriptions, webhook_events, webhook_deliveries persistence
    clock.ts            Clock interface + systemClock + TestClock (deterministic time for tests)
    url-guard.ts        SSRF guard: blocks private-IP targets with DNS-resolve-and-pin
  api/v1/
    router.ts           Public /api/v1 router — own middleware chain, no internal leakage
    ports.ts            Domain ports: IdentityPort, DocumentsPort, WebhooksPort (DIP boundary)
    route-meta.ts       PublicRouteMetaRegistry — every route declares scope + pagination
    schemas.ts          Zod schemas for all request/response bodies (source for OpenAPI gen)
    me.ts               GET /me handler
    documents.ts        GET /documents, GET /documents/:id, POST /documents
    webhooks.ts         POST/GET/DELETE /webhooks/subscriptions, GET/POST deliveries + replay
  openapi/
    registry.ts         Zod-to-OpenAPI 3.1 generator; reads schemas.ts + registers all paths
    load-routes.ts      Side-effect import that registers all route paths into OpenAPI registry
    write-static.ts     Writes docs/openapi.json at build time
  adapters/
    documents.ts        DocumentsPort impl — bridges documentsDomain + publishes domain events
    webhooks.ts         WebhooksPort impl — wraps webhook store + eventBus.replay()
    identity.ts         IdentityPort impl — reads users table

sdk/src/
  index.ts              Public barrel: exports ShipClient, DocumentsClient, ShipError, token stores,
                        auth helpers, webhook verifier, and all types
  client.ts             ShipClient — resource clients as properties (ISP); deviceLogin static helper
  http.ts               Http — fetch wrapper with 401-refresh loop and structured error mapping
  errors.ts             ShipError discriminated-union (kind: auth|rate_limit|not_found|validation|server|network)
  token-store.ts        ITokenStore interface + InMemoryTokenStore + FileTokenStore
  types.ts              Shared TypeScript types: ShipUser, ShipDocument, Page, etc.
  resources/
    documents.ts        DocumentsClient — list, get, create, iterate (async-iterator pagination)
  auth/
    device.ts           runDeviceLogin — Device Authorization Grant polling loop for CLI
  webhooks/
    verify.ts           verifyWebhook, computeSignature, parseSignatureHeader (HMAC-SHA256, replay guard)
```

---

## SOLID Rationale

**Single Responsibility (SRP).** Each module owns exactly one concern. The `signer.ts` (`api/src/platform/webhooks/signer.ts`) does only HMAC computation — it has no knowledge of HTTP, retries, or subscriptions. The `deliverer.ts` owns the retry/DLQ state machine but delegates signing entirely to `signer.ts`. The `bearerAuth` middleware (`api/src/platform/oauth/bearer.ts`) does only token validation and request decoration; it never touches domain data directly.

**Open/Closed Principle (OCP).** `ScopeRegistry` in `api/src/platform/scopes/registry.ts` is the canonical example: scopes are *data*, not code. Adding a new scope requires a single `register()` call at the bottom of the file. The `requireScope` authorization middleware reads the registry — it is never edited to add a new scope. The same pattern holds for `EventRegistry` in `api/src/platform/webhooks/events.ts`: a new event type is a new entry in `EVENT_TYPES` and `SCHEMA_BY_TYPE`.

**Liskov Substitution Principle (LSP).** `InMemoryTokenBucketLimiter` is a drop-in for any Redis/Upstash-backed `IRateLimiter` (`api/src/platform/ratelimit/limiter.ts`). `InMemoryEventBus` is a drop-in for a BullMQ-backed bus that implements the same `IEventBus` interface (`api/src/platform/webhooks/event-bus.ts`). `QueueWebhookDeliverer` is replaceable by an SQS-backed impl behind `IWebhookDeliverer`. The `TestClock` (`clock.ts`) substitutes for `systemClock` in tests without changing any caller.

**Interface Segregation Principle (ISP).** The SDK's resource clients are segregated: a consumer that only needs documents uses only `DocumentsClient` and never sees webhook or sprint types (`sdk/src/resources/documents.ts`). The public-edge ports in `api/src/platform/api/v1/ports.ts` define three narrow interfaces (`IdentityPort`, `DocumentsPort`, `WebhooksPort`) instead of one fat "platform service" — a handler that needs only identity is not forced to depend on the webhook interface.

**Dependency Inversion Principle (DIP).** The public `/api/v1` router (`api/src/platform/api/v1/router.ts`) depends *only* on the port interfaces defined in `ports.ts`, never on concrete domain services or database code. All concrete collaborators arrive via the `PlatformDeps` object injected by `buildPlatform()` in `api/src/platform/composition.ts`. Concrete implementations (`bearerAuth`, `InMemoryEventBus`, `QueueWebhookDeliverer`, `InMemoryTokenBucketLimiter`, adapter instances) are constructed once at the composition root and never imported directly by `v1/` files — the boundary lint (`scripts/check-api-boundary.mjs`) enforces this at CI time.

---

## Composition Root

`api/src/platform/composition.ts` is the single file allowed to know both the public ports and the concrete collaborators.

```
buildPlatform()                                      [composition.ts]
  │
  ├── InMemoryTokenBucketLimiter(120, 2)    perToken  [ratelimit/limiter.ts]
  ├── InMemoryTokenBucketLimiter(600, 10)   perApp    [ratelimit/limiter.ts]
  │
  ├── QueueWebhookDeliverer({              deliverer  [webhooks/deliverer.ts]
  │     clock:     systemClock,                       [webhooks/clock.ts]
  │     transport: fetchTransport(),                  [webhooks/deliverer.ts]
  │     jitter:    () => rand(0..1000)                (prod only, 0 in test)
  │   })
  │
  ├── InMemoryEventBus({ deliverer, clock })  bus     [webhooks/event-bus.ts]
  │
  ├── PlatformDeps {
  │     bearerAuth:  bearerAuth                       [oauth/bearer.ts]
  │     rateLimit:   createRateLimitMiddleware(…)     [ratelimit/middleware.ts]
  │     identity:    identityAdapter                  [adapters/identity.ts]
  │     documents:   createDocumentsAdapter(bus)      [adapters/documents.ts]
  │     webhooks:    createWebhooksAdapter(bus)       [adapters/webhooks.ts]
  │   }
  │
  └── createV1Router(deps)  ──►  v1Router             [api/v1/router.ts]
```

**In-memory test wiring (sibling diagram).** Test files that need the full router but not real domain I/O substitute:

```
noopBus           (IEventBus — swallows publishes)   [webhooks/__tests__/test-doubles.ts]
stubWebhooks      (WebhooksPort — returns canned data)
TestClock         (Clock — time only moves via advance())
scriptedTransport (Transport — returns programmed status sequence)
```
These doubles are wired directly in the test instead of calling `buildPlatform()`, keeping unit tests free of database and real-time I/O.

---

## Public/Internal Boundary

The boundary is a **one-way door**: files under `api/src/platform/api/v1/` may import only within `api/src/platform/`. Files under `integrations/` may import only `@ship/sdk`. The lint rule in `scripts/check-api-boundary.mjs` walks the import graph and exits non-zero on any violation. The test `api/src/platform/__tests__/boundary.test.ts` runs the same check inside vitest, so it fails as part of `pnpm test`.

```
  Browser / CLI / Agent
         │  Bearer token
         ▼
┌─────────────────────────────────────────────────────────┐
│  /api/v1 router  (platform/api/v1/router.ts)            │
│                                                         │
│  requestId ──► bearerAuth ──► rateLimit ──► [route]     │
│                                    │                    │
│                          requireScope(scope)            │
│                                    │                    │
│                             ┌──────▼──────┐             │
│              audit / webhook│  handler    │             │
│              publish only   │  (ports)   │             │
│              at this edge   └──────┬──────┘             │
└──────────────────────────────────│─────────────────────┘
                                   │  calls port interfaces only
                                   ▼
                    ┌──────────────────────────────┐
                    │  adapters/  (concrete impls)  │
                    │  adapters/documents.ts        │
                    │  adapters/webhooks.ts         │
                    │  adapters/identity.ts         │
                    └──────────────┬───────────────┘
                                   │  imports allowed
                                   ▼
                    ┌──────────────────────────────┐
                    │  domain/  +  db/             │
                    │  (internal, not in platform/) │
                    │                              │
                    │  Same domain services used   │
                    │  by internal /api/* routes   │
                    └──────────────────────────────┘
```

Internal `/api/*` routes call domain services directly (session auth, no scope check, no rate-limit headers). Public `/api/v1/*` routes call the *same* domain services via adapters, but auth, scope, rate-limit, audit, and webhook publication attach only at the public edge. A request going to the internal API and one going to the public API reach the same `documentsDomain.create()` call — the difference is every layer of middleware that wraps it.

---

## OAuth Flows

### Authorization Code + PKCE (web apps)

```
Client                    /oauth/authorize              /oauth/token
  │                              │                           │
  │── GET /oauth/authorize ──────►                           │
  │   code_challenge, method=S256│                           │
  │   client_id, redirect_uri    │                           │
  │                              │                           │
  │                    [show consent page]                   │
  │                              │                           │
  │── POST /oauth/authorize ─────►                           │
  │   (user approves)            │                           │
  │                    issueAuthorizationCode()              │
  │                    stores: code_challenge in DB          │
  │◄── 302 ?code=<auth_code> ────│                           │
  │                              │                           │
  │── POST /oauth/token ─────────────────────────────────────►
  │   grant_type=authorization_code                          │
  │   code_verifier (raw secret)                             │
  │                                            sha256(verifier)==challenge?
  │                                            [oauth/service.ts:exchangeAuthorizationCode]
  │                                            ← PKCE verified here
  │                                            consumeAuthCodeAndMintTokens()
  │◄── { access_token, refresh_token } ────────────────────── │
```

A wrong `code_verifier` returns `invalid_grant` immediately — this negative case is enforced in `api/src/platform/oauth/__tests__/oauth-service.test.ts`.

### Device Authorization Grant (CLI — RFC 8628)

```
CLI                   /oauth/device/code      /oauth/device/verify     /oauth/token (poll)
  │                          │                        │                        │
  │── POST /oauth/device/code►                        │                        │
  │   client_id, scope       │                        │                        │
  │                  startDeviceAuthorization()       │                        │
  │                  stores device_code_hash,         │                        │
  │                  user_code in DB                  │                        │
  │◄── { device_code, user_code, verification_uri } ──│                        │
  │                          │                        │                        │
  │  [print user_code to     │   User visits URL      │                        │
  │   terminal, open browser]│── GET+POST /oauth/device/verify ──────────────►│
  │                          │   user approves        │                        │
  │                          │                [status → 'approved', user_id set]│
  │                          │                        │                        │
  │─────────────── poll POST /oauth/token ──────────────────────────────────── ►
  │   grant_type=device_code │                        │    pollDeviceToken()    │
  │   (every interval_sec)   │                        │    slow_down if < 5s   │
  │                          │                        │    authorization_pending│
  │                          │                        │    until approved      │
  │◄────────────── { access_token, refresh_token } ──────────────────────────── │
```

### Refresh Token Rotation + Theft Detection

Refresh tokens rotate on every use. If a *consumed* refresh token is presented again, `refresh()` in `api/src/platform/oauth/service.ts` calls `store.revokeRefreshFamily(row.family_id)` and returns `invalid_grant`. The entire token family is invalidated, forcing re-authentication. The atomic `rotateRefreshToken()` database call holds a row lock so a racing duplicate cannot create an orphaned token.

---

## Webhook Pipeline

```
Domain write (e.g. documentsDomain.create)
    │ fires via adapter
    ▼
adapters/documents.ts → eventBus.publish({ type:'document.created', ... })
    │
    ▼  [IEventBus — event-bus.ts]
    ├── store.insertEvent(…)          ← idempotency_key = randomUUID() ← generated HERE
    ├── store.getMatchingSubscriptions(event.type, workspaceId)
    └── for each subscription:
          store.insertDelivery({ …, idempotencyKey })
          deliverer.enqueue(job)
              │
              ▼  [IWebhookDeliverer — deliverer.ts]
              attempt(job, n=1)
                ├── signPayload(secret, body, tSec)  ← signature computed HERE [signer.ts]
                │     Ship-Signature: t=<unix>,v1=<hex-hmac-sha256>
                ├── transport.POST(targetUrl, { Ship-Signature, Idempotency-Key, body })
                │                                       ↑ idempotency_key passed through
                ├── 2xx → updateDelivery(status='delivered')  ← delivery log
                ├── 5xx/timeout/408/429 → transient:
                │     delay = RETRY_DELAYS_MS[n-1]  (1s, 4s, 16s, 60s, 300s, 1800s)
                │     clock.schedule(attempt(job, n+1), delay)
                └── 4xx (non-429) or n >= 6 → status='dead'  ← dead-letter queue
```

**Replay.** `InMemoryEventBus.replay(deliveryId)` creates a *new* delivery row for the same subscription, carrying the *original* `idempotency_key` so subscribers can deduplicate. The new delivery is enqueued through the same `deliverer.enqueue()` path — signature is re-computed fresh with the current timestamp, but the body and idempotency key are identical to the original.

---

## SDK Surface

All exports are from `sdk/src/index.ts`. The SDK has zero runtime npm dependencies (uses `node:crypto` and native `fetch`).

| Export | Kind | Stability |
|---|---|---|
| `ShipClient` | Entry point; `documents` resource client as property; `me()`; `static deviceLogin()` | stable |
| `DocumentsClient` | `list()`, `get()`, `create()`, `iterate()` (async-iterator, cursors internal) | stable |
| `ShipError` | Discriminated union on `kind`: `auth`, `rate_limit`, `not_found`, `validation`, `server`, `network` | stable |
| `ITokenStore` | Interface; `InMemoryTokenStore`, `FileTokenStore` implementations | stable |
| `runDeviceLogin` | Device Authorization Grant polling loop — used by `ShipClient.deviceLogin()` | stable |
| `verifyWebhook` | `(headers, rawBody, secret, toleranceSec?) => boolean` — Stripe-style HMAC+timestamp | stable |
| `computeSignature` | Low-level HMAC helper (testing / custom integrations) | pre-1.0 |
| `parseSignatureHeader` | Parses `t=…,v1=…` header string | pre-1.0 |
| Type exports (`ShipUser`, `ShipDocument`, `Page`, etc.) | TypeScript-only | stable |

**Async-iterator pagination** (`DocumentsClient.iterate()`) walks all pages transparently; the consumer writes `for await (const doc of client.documents.iterate())` and never handles cursors. Raw `list()` is also exposed for callers that want one page at a time.

---

## Agent-as-Citizen

> **Status: PLANNED — NOT YET IMPLEMENTED.** Epic 7 (the agent rewire) has no code on master. There is no `AGENT_USE_SDK` feature flag and no agent-via-SDK path today. The diagrams below describe the planned design only.

**Before (current state on master, direct-domain path):**

```
Agent (FleetGraph)
    │  direct TypeScript import
    ▼
api/src/services/*  (domain services)
    │  direct DB call
    ▼
PostgreSQL
```

The agent bypasses auth, scope checks, rate limiting, and audit entirely. It is a privileged insider. This is the only path that exists today.

**After (planned — Epic 7, NOT YET IMPLEMENTED):**

```
Agent (FleetGraph)
    │  client_credentials grant (first-party M2M OAuth app)
    │  (planned: agent app seeded via a future migration)
    ▼
ShipClient (@ship/sdk)
    │  Bearer token in Authorization header
    ▼
/api/v1 router  (same public edge as any third-party)
    │  bearerAuth → rateLimit → requireScope
    ▼
adapters/  →  domain services
    │
    ▼
PostgreSQL

      ↓ side-effect at public edge
  audit log row: { app, scope, route, status }
```

The planned design makes the agent a first-party OAuth application using `client_credentials` (RFC 6749 §4.4) — appropriate for machine-to-machine where no user-delegation is needed. The intent is to gate the rewire behind a feature flag so Part 2 tests pass with the flag on or off, and to seed the agent's OAuth app via a dedicated migration. **None of this is built yet; the rewire is not on master.** (Note: migration `041_plugforge_grader_app.sql` seeds the read-only `ship_app_grader` app for graders — it does NOT seed an agent app.)

---

## Failure Modes

**Token store corrupted.** All token hashes are stored in PostgreSQL (`oauth_access_tokens`, `oauth_refresh_tokens`). If rows are truncated or corrupted, bearer middleware returns `401 token_invalid` for all existing sessions; clients re-authenticate via their refresh token or re-run the OAuth flow. No in-memory state is lost on server restart — the DB is the sole token store. Corrupted `oauth_apps` would deactivate all apps; the app `is_active` flag is checked on every request.

**Signing secret rotated mid-flight.** A webhook delivery that was enqueued before secret rotation carries the old signing secret in the `DeliveryJob` struct (taken from the subscription row at enqueue time). A retry, however, reads the subscription fresh from the database for each delivery row — the `signingSecret` field in the enqueued job is fixed at enqueue time. If a secret is rotated in the portal, in-flight retry attempts will use the old secret; the subscriber may reject those. This is an acceptable window: the PRD treats secret rotation as a deliberate operator action, and subscribers should use a tolerance window or accept both old and new secrets briefly. A full production fix would be to re-read the secret from the DB on each retry attempt — noted as a known limitation.

**Queue deliverer crashes mid-batch.** The `QueueWebhookDeliverer` is in-process (no persistent queue). If the process crashes after a delivery row is inserted but before the attempt completes, the delivery row stays in `status='pending'` with no scheduled next attempt. A future restart-recovery sweep (not yet implemented) would requeue `pending` rows older than N seconds. Until then, the at-least-once guarantee holds only within a single process lifetime. The `idempotency_key` on every delivery ensures that if a subscriber *did* receive the delivery before the crash, a replay will carry the same key and a well-behaved subscriber can deduplicate.

**OpenAPI generator throws at boot.** The `getV1OpenApiDocument()` call in `openapi/registry.ts` runs lazily on the first request to `/api/v1/openapi.json`. If `@asteasolutions/zod-to-openapi` throws (e.g., a duplicate schema key or an unresolvable `$ref`), the Express error handler returns a `500 server_error` ApiError shape — the server does not crash. The static `docs/openapi.json` (written at build time by `openapi/write-static.ts`) remains available as a fallback. The fitness test in `api/src/platform/__tests__/openapi-fitness.test.ts` runs the generator under vitest and would catch schema errors before they reach production.
