/**
 * OpenAPI fitness tests — the single best defense against spec drift (PRD).
 *
 * Asserts the generated 3.1 spec is structurally valid AND in 1:1 parity with the
 * route registry, and that every route declares (a) an OpenAPI entry, (b) a scope
 * (or an explicit exemption), (c) the ApiError shape on failure, (d) cursor
 * pagination if it is a list endpoint.
 */
import { describe, it, expect } from 'vitest';
import '../openapi/load-routes.js'; // force route + path registration
import { getV1OpenApiDocument } from '../openapi/registry.js';
import { publicRoutes } from '../api/v1/route-meta.js';

const doc = getV1OpenApiDocument() as unknown as {
  openapi: string;
  info: { title: string; version: string };
  servers: { url: string }[];
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  paths: Record<string, Record<string, OperationObject>>;
};

interface OperationObject {
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ name: string; in: string }>;
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

/** Recursively collect all $ref strings in the doc. */
function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

/** Routes that exist but are NOT part of the documented surface (the spec itself). */
const NON_DOCUMENTED = new Set(['/openapi.json']);

describe('OpenAPI 3.1 spec validity', () => {
  it('declares openapi 3.1.0 with info, servers, and bearer security scheme', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBe('1.0.0');
    expect(doc.servers.some((s) => s.url === '/api/v1')).toBe(true);
    expect(doc.components.securitySchemes.bearerAuth).toBeDefined();
    expect(doc.components.schemas.ApiError).toBeDefined();
  });

  it('has no dangling $refs (every ref resolves to a defined component)', () => {
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const m = ref.match(/^#\/components\/schemas\/(.+)$/);
      expect(m, `unexpected ref form: ${ref}`).toBeTruthy();
      expect(doc.components.schemas[m![1]!], `dangling ref: ${ref}`).toBeDefined();
    }
  });

  it('every operation has at least one response', () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        expect(Object.keys(op.responses).length, `${method} ${path}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('spec ↔ route parity (100%)', () => {
  const documentedRoutes = publicRoutes.list().filter((r) => !NON_DOCUMENTED.has(r.path));

  it('every registered route has a matching OpenAPI operation', () => {
    for (const r of documentedRoutes) {
      const op = doc.paths[r.path]?.[r.method];
      expect(op, `missing OpenAPI entry for ${r.method.toUpperCase()} ${r.path}`).toBeDefined();
    }
  });

  it('every OpenAPI operation has a registered route (no undocumented spec entries)', () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const method of Object.keys(methods)) {
        const found = publicRoutes.find(method as never, path);
        expect(found, `spec has ${method.toUpperCase()} ${path} but no route metadata`).toBeDefined();
      }
    }
  });
});

describe('per-route contract', () => {
  const documentedRoutes = publicRoutes.list().filter((r) => !NON_DOCUMENTED.has(r.path));

  it('every route declares a scope OR opts out explicitly (scope === null)', () => {
    for (const r of publicRoutes.list()) {
      // `scope` is either a non-empty string or explicitly null — never undefined.
      expect(r.scope === null || (typeof r.scope === 'string' && r.scope.length > 0)).toBe(true);
    }
  });

  it('every documented operation carries the ApiError shape on a failure path', () => {
    for (const r of documentedRoutes) {
      const op = doc.paths[r.path]![r.method]!;
      const failureCodes = Object.keys(op.responses).filter((c) => Number(c) >= 400);
      expect(failureCodes.length, `${r.method} ${r.path} has no failure responses`).toBeGreaterThan(0);
      const refsApiError = failureCodes.some((c) => {
        const schema = op.responses[c]?.content?.['application/json']?.schema as { $ref?: string } | undefined;
        return schema?.$ref === '#/components/schemas/ApiError';
      });
      expect(refsApiError, `${r.method} ${r.path} failure responses must use ApiError`).toBe(true);
    }
  });

  it('every scoped operation requires bearer auth', () => {
    for (const r of documentedRoutes) {
      const op = doc.paths[r.path]![r.method]!;
      expect(op.security?.some((s) => 'bearerAuth' in s), `${r.method} ${r.path} must require bearerAuth`).toBe(true);
    }
  });

  it('every list (paginated) endpoint exposes a cursor and returns next_cursor', () => {
    for (const r of documentedRoutes.filter((x) => x.paginated)) {
      const op = doc.paths[r.path]![r.method]!;
      const params = (op.parameters ?? []).map((p) => p.name);
      expect(params, `${r.method} ${r.path} should accept a cursor`).toContain('cursor');
      expect(params, `${r.method} ${r.path} should accept a limit`).toContain('limit');
      const okSchema = op.responses['200']?.content?.['application/json']?.schema as { $ref?: string } | undefined;
      const refName = okSchema?.$ref?.split('/').pop();
      const resolved = refName ? (doc.components.schemas[refName] as { properties?: Record<string, unknown> }) : undefined;
      expect(resolved?.properties && 'next_cursor' in resolved.properties, `${r.path} 200 must return next_cursor`).toBe(true);
    }
  });
});
