/**
 * SDK ↔ OpenAPI parity (PRD Testing Scenario 4): "walk every spec method and
 * assert the SDK exposes a typed call for it." Lives in the api package so it
 * runs in CI (test_integration) and uses the in-process generated spec.
 *
 * The @ship/sdk is hand-written for type quality, so parity is enforced by this
 * fitness test rather than codegen: a declared mapping ties every public /api/v1
 * operation to the SDK method that invokes it, checked in BOTH directions —
 * a new route without an SDK method fails forward; a stale SDK mapping fails
 * reverse. Either way, drift fails the build.
 */
import { describe, it, expect } from 'vitest';
import '../openapi/load-routes.js'; // force route + path registration
import { getV1OpenApiDocument } from '../openapi/registry.js';
import { ShipClient } from '@ship/sdk';

const doc = getV1OpenApiDocument() as unknown as {
  paths: Record<string, Record<string, unknown>>;
};

// A client instance to introspect the resource-method surface (no network).
const client = new ShipClient({ baseUrl: 'http://localhost:1', token: 'introspect' });

// Operations that are part of the API but intentionally have no SDK resource
// method (the spec-serving endpoint is consumed by tooling, not the SDK).
const EXCLUDED = new Set<string>(['GET /openapi.json']);

// Every documented public operation → the typed SDK call that invokes it.
const SPEC_TO_SDK: Record<string, unknown> = {
  'GET /me': client.me,
  'GET /documents': client.documents.list,
  'POST /documents': client.documents.create,
  'GET /documents/{id}': client.documents.get,
  'GET /issues': client.issues.list,
  'POST /issues': client.issues.create,
  'GET /issues/{id}': client.issues.get,
  'GET /sprints': client.sprints.list,
  'GET /sprints/{id}': client.sprints.get,
  'POST /webhooks': client.webhooks.create,
  'GET /webhooks': client.webhooks.list,
  'DELETE /webhooks/{id}': client.webhooks.delete,
  'GET /webhooks/deliveries': client.webhooks.deliveries,
  'POST /webhooks/deliveries/{id}/replay': client.webhooks.replay,
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function specOperations(): string[] {
  const ops: string[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const m of HTTP_METHODS) {
      if (item[m]) {
        const key = `${m.toUpperCase()} ${path}`;
        if (!EXCLUDED.has(key)) ops.push(key);
      }
    }
  }
  return ops;
}

describe('SDK ↔ OpenAPI spec parity (Testing Scenario 4)', () => {
  it('has at least the core documented operations', () => {
    expect(specOperations().length).toBeGreaterThanOrEqual(10);
  });

  it('every documented operation has a typed SDK method (forward parity)', () => {
    for (const op of specOperations()) {
      expect(typeof SPEC_TO_SDK[op], `spec operation "${op}" must map to an SDK method`).toBe('function');
    }
  });

  it('no SDK mapping points at a non-existent operation (reverse parity / stale drift)', () => {
    const ops = new Set(specOperations());
    for (const key of Object.keys(SPEC_TO_SDK)) {
      expect(ops.has(key), `SDK maps "${key}" but the spec has no such operation`).toBe(true);
    }
  });
});
