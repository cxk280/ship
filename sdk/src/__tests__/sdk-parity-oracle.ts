/**
 * The generated shadow-SDK parity *oracle* (Plugforge B2).
 *
 * This module is the test-only generator that turns the committed OpenAPI
 * contract (`docs/openapi.json`) into a canonical, machine-comparable
 * description of every operation it declares — a "shadow SDK". The shadow is
 * the source of truth; the hand-written `@ship/sdk` is diffed against it
 * operation-by-operation in `sdk-parity-oracle.test.ts`.
 *
 * It is deliberately kept out of the published package (zero runtime deps in
 * `@ship/sdk` is preserved — this file imports nothing at runtime beyond Node
 * built-ins, and is excluded from the build via the `*.test.ts`-adjacent
 * `__tests__` exclusion + tsconfig `src/**\/*.test.ts` rule; the companion
 * `.test.ts` is the only entry point and is test-only).
 *
 * How it differs from the A6 fitness test (`api/.../sdk-spec-parity.test.ts`):
 *   - A6 maps each spec op-key to an SDK *function reference* and only checks
 *     that a function exists in both directions (coarse: "is there a method?").
 *   - B2 derives the verb, path template, path params, query params and
 *     request-body expectation FROM the spec, then OBSERVES the real HTTP call
 *     the SDK actually issues (by stubbing fetch) and asserts the observed
 *     {verb, path-template, params} match the spec's. It catches a method that
 *     exists but targets the wrong verb/path/param — which A6 cannot see.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// --- OpenAPI subset we read -------------------------------------------------

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
}

interface OpenApiOperation {
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: unknown;
  security?: Array<Record<string, string[]>>;
}

interface OpenApiDocument {
  openapi: string;
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = Uppercase<(typeof HTTP_METHODS)[number]>;

/**
 * A canonical, normalized operation derived from the spec — the "shadow".
 * `key` ("GET /documents/{id}") is the stable identity used for diffing.
 */
export interface ShadowOperation {
  key: string;
  operationId: string;
  method: HttpMethod;
  /** Path template with `{param}` placeholders, e.g. `/documents/{id}`. */
  path: string;
  pathParams: string[];
  /** Query parameter names the spec declares (sorted). */
  queryParams: string[];
  /** True if the spec declares a requestBody for this operation. */
  hasRequestBody: boolean;
  /** Security scheme names required (e.g. `bearerAuth`); empty if public. */
  scopes: string[];
}

/** Resolve the committed contract relative to this file (repo `docs/openapi.json`). */
export function openApiContractPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // sdk/src/__tests__
  return resolve(here, '..', '..', '..', 'docs', 'openapi.json');
}

/** Read + parse the committed static spec. Throws if missing/invalid (an implicit staleness check). */
export function loadContract(path = openApiContractPath()): OpenApiDocument {
  const raw = readFileSync(path, 'utf8');
  const doc = JSON.parse(raw) as OpenApiDocument;
  if (!doc.paths || typeof doc.paths !== 'object') {
    throw new Error(`openapi.json at ${path} has no paths object`);
  }
  return doc;
}

/**
 * Synthesize a stable operationId when the spec omits one. The Ship spec does
 * not declare operationIds, so we derive a deterministic identity from the
 * verb + path that is human-readable in failure messages.
 */
function synthOperationId(method: HttpMethod, path: string): string {
  return `${method.toLowerCase()}_${path
    .replace(/^\//, '')
    .replace(/\{(\w+)\}/g, 'by_$1')
    .replace(/[/-]/g, '_')}`;
}

const PATH_PARAM_RE = /\{(\w+)\}/g;

function pathTemplateParams(path: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = PATH_PARAM_RE.exec(path))) out.push(m[1]!);
  return out;
}

/** Operations excluded from SDK parity: the spec-serving endpoint is tooling-only. */
export const EXCLUDED_KEYS = new Set<string>(['GET /openapi.json']);

/**
 * Generate the shadow SDK: one canonical {@link ShadowOperation} per spec
 * operation. This is the oracle's left-hand side.
 */
export function generateShadow(doc: OpenApiDocument): ShadowOperation[] {
  const ops: ShadowOperation[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (!op) continue;
      const method = m.toUpperCase() as HttpMethod;
      const key = `${method} ${path}`;
      if (EXCLUDED_KEYS.has(key)) continue;

      const params = op.parameters ?? [];
      const declaredPathParams = params.filter((p) => p.in === 'path').map((p) => p.name);
      // Path-template params must always be declared; cross-check both views.
      const templateParams = pathTemplateParams(path);

      ops.push({
        key,
        operationId: op.operationId ?? synthOperationId(method, path),
        method,
        path,
        pathParams: [...new Set([...declaredPathParams, ...templateParams])].sort(),
        queryParams: params.filter((p) => p.in === 'query').map((p) => p.name).sort(),
        hasRequestBody: op.requestBody !== undefined,
        scopes: (op.security ?? []).flatMap((s) => Object.keys(s)).sort(),
      });
    }
  }
  return ops.sort((a, b) => a.key.localeCompare(b.key));
}

// --- Observing the real SDK -------------------------------------------------

/** What the SDK actually did on the wire for one probed method. */
export interface ObservedCall {
  method: HttpMethod;
  /** Concrete path the SDK requested, e.g. `/documents/SENTINEL_ID` (no query). */
  rawPath: string;
  /** Path normalized back to a `{param}` template using the sentinels we injected. */
  pathTemplate: string;
  /** Query param names the SDK set (sorted). */
  queryParams: string[];
  /** Whether the SDK sent a request body. */
  hasRequestBody: boolean;
  /** Whether the SDK attached an Authorization bearer header. */
  sentBearer: boolean;
}

/** Sentinel values injected into SDK calls so we can reverse-map concrete paths to templates. */
export const SENTINELS: Record<string, string> = {
  id: 'SENTINEL_ID',
};

/** The API base every observed URL is expected to sit under. */
export const API_BASE = '/api/v1';

/**
 * Reverse a concrete request path (e.g. `/documents/SENTINEL_ID`) back into a
 * `{param}` template by substituting known sentinels. Unknown path segments are
 * left intact (so a mismatch surfaces as a diff rather than being masked).
 */
function templatize(rawPath: string): string {
  let t = rawPath;
  for (const [param, sentinel] of Object.entries(SENTINELS)) {
    t = t.split(encodeURIComponent(sentinel)).join(`{${param}}`).split(sentinel).join(`{${param}}`);
  }
  return t;
}

/**
 * Parse a single captured fetch call into an {@link ObservedCall}. `baseUrl`
 * is the origin the probe ShipClient was constructed with.
 */
export function parseFetchCall(
  url: string,
  init: RequestInit | undefined,
  baseUrl: string,
): ObservedCall {
  const u = new URL(url);
  const expectedPrefix = `${baseUrl.replace(/\/$/, '')}${API_BASE}`;
  const full = `${u.origin}${u.pathname}`;
  if (!full.startsWith(expectedPrefix)) {
    throw new Error(`SDK requested ${full}, expected it under ${expectedPrefix}`);
  }
  const rawPath = full.slice(expectedPrefix.length) || '/';
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return {
    method: (init?.method ?? 'GET').toUpperCase() as HttpMethod,
    rawPath,
    pathTemplate: templatize(rawPath),
    queryParams: [...u.searchParams.keys()].sort(),
    hasRequestBody: init?.body !== undefined && init?.body !== null,
    sentBearer: typeof headers.Authorization === 'string' && headers.Authorization.startsWith('Bearer '),
  };
}
