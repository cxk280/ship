# AI Cost Analysis — Plugforge Platform

## Headline Discipline

The platform itself does zero AI work. The LLM is invoked only on user-initiated agent turns, exactly as in Part 2 (FleetGraph). Adding the public API, OAuth layer, webhooks, and SDK does not add any LLM calls. Cost scales with agent activity, not with platform traffic or webhook fan-out.

---

## Production Cost Projections

Numbers taken from the PRD's baseline. Infrastructure costs (Elastic Beanstalk + RDS) are not broken out here; only variable costs driven by the platform layer are shown.

| Tier | API calls/day | Webhook deliveries/day | Agent LLM calls/day | Est. infrastructure cost/month |
|---|---|---|---|---|
| 100 users | ~20,000 | ~5,000 | ~50 | $2–8 |
| 1,000 users | ~200,000 | ~50,000 | ~500 | $15–50 |
| 10,000 users | ~2,000,000 | ~500,000 | ~5,000 | $80–250 |
| 100,000 users | ~20,000,000 | ~5,000,000 | ~50,000 | $500–1,500 |

LLM cost is attributable to the agent app's user-driven sessions, not the platform itself. At $0.003/1k tokens (Sonnet-class) and ~2k tokens/turn, 50 agent turns/day at 100 users = ~$0.30/day LLM spend — negligible relative to infrastructure.

### Explicit Assumptions

**Webhook fan-out ratio.** Assumed 0.25 deliveries per API write call (1-in-4 writes triggers a subscribed event, with an average of 1 matching subscription per event type at the 100-user tier, rising toward 2–3 subscriptions per event at the 10k+ tier as more apps install). At 100 users with 200 writes/user/day, that is 200 × 100 × 0.25 = 5,000 deliveries/day, matching the PRD table. The in-memory deliverer comfortably handles this volume within the 2-second P95 target; fan-out above ~10 subscriptions per event at 10k users would warrant a BullMQ or SQS-backed deliverer.

**Agent active rate.** Assumed 5% of users use agent features on a given day (50 out of 1,000 at the 1k-user tier), with an average of 10 agent turns per active user per day. This gives 500 LLM calls/day at the 1k-user tier, consistent with the PRD table. The rewire (Epic 7, planned) routes those calls through the public API — it does not change token volume, only the authentication path.

**Storage retention.** Delivery log rows (`webhook_deliveries`) are retained for 30 days. Each row is approximately 500 bytes (UUIDs, status string, timestamps, response_excerpt capped at 500 bytes). At 5,000 deliveries/day for 100 users: 5,000 × 500 bytes × 30 days ≈ 75 MB/month — negligible on Postgres. At 5,000,000 deliveries/day for 100k users: 75 GB/month, at which point partitioning by month and archiving to S3 is warranted. Audit log rows (`audit_log`) are retained for 90 days; each row is ~300 bytes. At 20,000 API calls/day × 300 bytes × 90 days ≈ 540 MB for 100 users; 540 GB for 100k users.

---

## Development and Testing Costs

**CI minutes for the TTFE drill.** The Time-to-First-Event drill is run via `pnpm drill:ttfe` (root script, which delegates to `pnpm --filter @ship/cli drill ttfe`). The drill starts a local Ship server, performs the `ship login` device flow, creates a document through the SDK, and waits for a verified signed webhook. Measured at approximately 45–60 seconds per run locally. **CI wiring is planned but not yet in place** — no job runs the drill automatically on every PR today. When wired, at ~10 PRs/day that would be ~10 minutes of CI compute/day; at GitHub Actions pricing ($0.008/minute for ubuntu-latest), <$0.10/day — budget ~$2/week.

**OAuth Playwright tests.** The auth-code + PKCE flow test (`api/src/platform/oauth/__tests__/token-endpoint.test.ts`) runs in-process with supertest — no real browser launch. A full Playwright browser-driven test for the consent UI would add ~20 seconds per run; that test is not yet included in the CI suite.

**OpenAPI spec generation and validation overhead.** The `openapi-fitness.test.ts` suite calls `getV1OpenApiDocument()` once and runs all assertions synchronously. Measured at ~200 ms per vitest run. Negligible.

**Delivery-log storage during demo.** The TTFE drill creates 1 event → 1 delivery per run. At ~100 drill runs (demo week), that is 100 rows ≈ 50 KB. The drill registers a single webhook subscription at runtime, so fan-out is always 1. Total storage for demo volume: unmeasurably small.

**LLM spend during Epic 7 agent rewire (planned, not yet implemented).** The planned rewire replaces direct domain service calls with SDK calls. It should not change token volume — agent prompts and responses are identical. Recommended when built: record `usage.input_tokens + usage.output_tokens` from the Anthropic SDK before and after the planned feature-flag flip on the same 10-turn test session. A >5% change is a signal that the rewire inadvertently changed prompt context.

**SDK install footprint.** The SDK (`sdk/`) has zero production npm dependencies (uses `node:crypto` and native fetch). Measured bundle size: ~18 KB minified + gzipped — well under the 250 KB PRD budget. Enforced by the package.json `dependencies` field (empty).
