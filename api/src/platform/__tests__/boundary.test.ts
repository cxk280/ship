/**
 * Fitness test: the public/internal one-way-door boundary holds.
 *
 * Runs the same checker as scripts/check-api-boundary.mjs so a cross-import from
 * the public edge into internal handlers — or from integrations/ into api/src —
 * fails CI, not just a local lint run.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain ESM script, no type declarations
import { findBoundaryViolations } from '../../../../scripts/check-api-boundary.mjs';

describe('API boundary (one-way door)', () => {
  it('has no public→internal or integrations→api cross-imports', () => {
    const violations = findBoundaryViolations();
    expect(
      violations,
      `Boundary violations:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });
});
