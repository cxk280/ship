/**
 * B2 — generated shadow-SDK parity oracle (vs the committed OpenAPI spec).
 *
 * Pipeline: spec (`docs/openapi.json`) → shadow (canonical ops) → diff against
 * the REAL `@ship/sdk` by observing the HTTP call each typed method issues.
 *
 * This DEEPENS the A6 fitness test. A6 (`api/src/platform/__tests__/sdk-spec-parity.test.ts`)
 * proves a typed method *exists* for every spec op (function-reference presence,
 * both directions). B2 proves each method *targets the right operation*: it
 * derives verb + path-template + path-params + query-params + body-expectation
 * from the spec, then drives the live SDK (fetch stubbed) and asserts the
 * observed wire call matches. Failure modes B2 now catches that A6 cannot:
 *   1. Spec adds an operation the SDK doesn't cover  → no probe / unprobed op.
 *   2. SDK targets a verb/path the spec doesn't declare → observed op-key has
 *      no shadow match (SDK drifting ahead / wrong).
 *   3. SDK hits the right path with the WRONG verb     → verb mismatch.
 *   4. SDK sends/omits a body contrary to the spec     → body mismatch.
 *   5. SDK sets a query param the spec never declares   → query drift.
 *   6. A required path param is missing from the path template → param drift.
 *
 * Zero-runtime-deps invariant: this test imports the SDK from source and uses
 * only Node built-ins + vitest (dev-only). Nothing here ships in @ship/sdk.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ShipClient } from '../client.js';
import {
  loadContract,
  generateShadow,
  parseFetchCall,
  SENTINELS,
  type ShadowOperation,
  type ObservedCall,
} from './sdk-parity-oracle.js';

// --- Spec → shadow ----------------------------------------------------------

const shadow = generateShadow(loadContract());
const shadowByKey = new Map<string, ShadowOperation>(shadow.map((o) => [o.key, o]));

// --- Probe the REAL SDK -----------------------------------------------------

const BASE_URL = 'https://oracle.test';

/**
 * A probe invokes ONE real SDK method with sentinel arguments. Each probe is
 * keyed by the spec op-key it is meant to exercise; the diff verifies that the
 * SDK actually hit that operation. The registry is the single bridge between
 * SDK methods and operations (mirroring how A6 maps spec→method), but here we
 * observe the resulting HTTP call rather than just asserting `typeof fn`.
 */
type Probe = (client: ShipClient) => Promise<unknown>;

const PROBES: Record<string, Probe> = {
  'GET /me': (c) => c.me(),
  'GET /documents': (c) => c.documents.list({ limit: 10, cursor: 'x', document_type: 'wiki' }),
  'POST /documents': (c) => c.documents.create({ title: 't', document_type: 'wiki' }),
  'GET /documents/{id}': (c) => c.documents.get(SENTINELS.id!),
  'GET /issues': (c) => c.issues.list({ limit: 10, cursor: 'x', state: 'todo', priority: 'high', assignee_id: 'a' }),
  'POST /issues': (c) => c.issues.create({ title: 't' }),
  'GET /issues/{id}': (c) => c.issues.get(SENTINELS.id!),
  'GET /sprints': (c) => c.sprints.list({ limit: 10, cursor: 'x', status: 'active' }),
  'GET /sprints/{id}': (c) => c.sprints.get(SENTINELS.id!),
  'POST /webhooks': (c) => c.webhooks.create({ event: 'document.created', target_url: 'https://h.test' }),
  'GET /webhooks': (c) => c.webhooks.list(),
  'DELETE /webhooks/{id}': (c) => c.webhooks.delete(SENTINELS.id!),
  'GET /webhooks/deliveries': (c) => c.webhooks.deliveries(),
  'POST /webhooks/deliveries/{id}/replay': (c) => c.webhooks.replay(SENTINELS.id!),
};

/** Drive a probe with a stubbed fetch and capture the single HTTP call it made. */
async function observe(probe: Probe): Promise<ObservedCall> {
  // A permissive JSON response so any method shape resolves without throwing.
  const body = { data: [], next_cursor: null, id: SENTINELS.id, signing_secret: 's' };
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);

  const client = new ShipClient({ baseUrl: BASE_URL, token: 'oracle_token' });
  await probe(client);

  expect(fetchMock.mock.calls.length, 'probe should issue exactly one request').toBe(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  return parseFetchCall(String(url), init, BASE_URL);
}

afterEach(() => vi.unstubAllGlobals());

// --- Oracle assertions ------------------------------------------------------

describe('B2 shadow-SDK parity oracle: spec → shadow → real SDK', () => {
  it('the shadow covers the full documented surface (sanity floor)', () => {
    expect(shadow.length).toBeGreaterThanOrEqual(10);
  });

  it('every spec operation has exactly one SDK probe (no spec op left uncovered)', () => {
    const shadowKeys = new Set(shadow.map((o) => o.key));
    const probeKeys = new Set(Object.keys(PROBES));
    // Forward: spec op without a probe == SDK lagging the spec.
    for (const key of shadowKeys) {
      expect(probeKeys.has(key), `spec operation "${key}" has no SDK probe — SDK is lagging the spec`).toBe(true);
    }
    // Reverse: probe for an op the spec doesn't declare == stale/wrong probe.
    for (const key of probeKeys) {
      expect(shadowKeys.has(key), `probe "${key}" maps to an operation the spec does not declare`).toBe(true);
    }
  });

  // Per-operation oracle: drive the live SDK and diff the observed call against
  // the shadow derived from the spec. One test case per documented operation.
  for (const op of shadow) {
    describe(op.key, () => {
      it(`SDK targets ${op.method} ${op.path} matching the spec`, async () => {
        const probe = PROBES[op.key];
        expect(probe, `no probe registered for ${op.key}`).toBeTypeOf('function');
        const observed = await observe(probe!);

        // (1) Verb parity — right path, wrong method must fail.
        expect(observed.method, `${op.key}: SDK used verb ${observed.method}, spec declares ${op.method}`).toBe(op.method);

        // (2) Path-template parity — the SDK must hit the spec's path template,
        // with required path params substituted (sentinels reverse-mapped).
        expect(
          observed.pathTemplate,
          `${op.key}: SDK requested path "${observed.pathTemplate}" (raw "${observed.rawPath}"), spec path is "${op.path}"`,
        ).toBe(op.path);

        // (3) Path-param parity — every {param} the spec declares must appear in
        // the realized path (i.e. the SDK actually accepted + substituted it).
        for (const p of op.pathParams) {
          expect(
            observed.pathTemplate.includes(`{${p}}`),
            `${op.key}: spec requires path param "${p}" but SDK path "${observed.pathTemplate}" omits it`,
          ).toBe(true);
        }

        // (4) Request-body parity — POST/PUT/PATCH with a spec body must send a
        // body; an op without a spec body must not (GET/DELETE drift guard).
        expect(
          observed.hasRequestBody,
          `${op.key}: spec ${op.hasRequestBody ? 'declares' : 'declares no'} requestBody but SDK ${observed.hasRequestBody ? 'sent' : 'sent no'} body`,
        ).toBe(op.hasRequestBody);

        // (5) Query-param parity — the SDK must not set a query param the spec
        // never declares. (We over-supply params in the probe so the SDK can
        // surface its full query surface; any extra is drift.)
        const declared = new Set(op.queryParams);
        for (const q of observed.queryParams) {
          expect(
            declared.has(q),
            `${op.key}: SDK sent query param "${q}" not declared by the spec (declared: ${op.queryParams.join(', ') || 'none'})`,
          ).toBe(true);
        }

        // (6) Auth parity — every scoped (bearerAuth) op must carry the bearer.
        if (op.scopes.includes('bearerAuth')) {
          expect(observed.sentBearer, `${op.key}: spec requires bearerAuth but SDK sent no bearer token`).toBe(true);
        }
      });
    });
  }

  it('reverse oracle: every realized SDK call resolves to a declared shadow op (no drift-ahead)', async () => {
    for (const [key, probe] of Object.entries(PROBES)) {
      const observed = await observe(probe);
      const observedKey = `${observed.method} ${observed.pathTemplate}`;
      const match = shadowByKey.get(observedKey);
      expect(
        match,
        `SDK probe "${key}" issued ${observedKey}, which is not a documented operation (SDK drifting ahead of the spec)`,
      ).toBeDefined();
    }
  });
});
