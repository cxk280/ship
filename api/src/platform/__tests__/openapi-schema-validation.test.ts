/**
 * OpenAPI 3.1 *specification* conformance — complements openapi-fitness.test.ts.
 *
 * openapi-fitness.test.ts is our hand-written structural checker (refs resolve,
 * spec↔route parity, per-route contract). It only knows about the rules we
 * thought to encode. This test instead validates the generated document against
 * the OFFICIAL OpenAPI 3.1 meta-schema published by the OpenAPI Initiative
 * (https://spec.openapis.org/oas/3.1/schema/*), bundled by
 * @seriousme/openapi-schema-validator and checked with Ajv (JSON Schema
 * 2020-12 dialect). If the generator ever emits something that is structurally
 * legal-looking but not actually valid OpenAPI 3.1, this catches it where a
 * custom checker would not.
 */
import { describe, it, expect } from 'vitest';
import { Validator } from '@seriousme/openapi-schema-validator';
import '../openapi/load-routes.js'; // force route + path registration
import { getV1OpenApiDocument } from '../openapi/registry.js';

/** Render Ajv errors into a readable, assertion-friendly message. */
function formatErrors(errors: unknown): string {
  if (typeof errors === 'string') return errors;
  if (Array.isArray(errors)) {
    return errors
      .map((e) => {
        const err = e as { instancePath?: string; message?: string; params?: unknown };
        return `  ${err.instancePath || '(root)'} ${err.message ?? ''} ${JSON.stringify(err.params ?? {})}`;
      })
      .join('\n');
  }
  return JSON.stringify(errors);
}

describe('OpenAPI 3.1 official-schema conformance', () => {
  const doc = getV1OpenApiDocument() as unknown as Record<string, unknown>;
  // strict:false keeps Ajv from rejecting the official meta-schema's own
  // vocabulary keywords; conformance checking is unaffected.
  const validator = new Validator({ strict: false });

  it('validates against the official OpenAPI 3.1 meta-schema', async () => {
    const result = await validator.validate(doc);
    expect(
      result.valid,
      result.valid ? '' : `Generated spec is not valid OpenAPI 3.1:\n${formatErrors(result.errors)}`,
    ).toBe(true);
  });

  it('the validator resolved the document as a 3.1 specification', async () => {
    // validate() must run first so the validator detects the version from the
    // document's `openapi` field; assert we were checked against 3.1 (not 3.0).
    await validator.validate(doc);
    expect(validator.version).toBe('3.1');
    expect(Validator.supportedVersions.has('3.1')).toBe(true);
  });
});
