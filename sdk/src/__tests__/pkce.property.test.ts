/**
 * Property-based tests for PKCE (RFC 7636) helpers.
 *
 * Verifies that every generated PKCE pair satisfies the S256 spec:
 * correct challenge derivation, verifier format/length constraints, and
 * uniqueness across many samples.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { createHash } from 'node:crypto';
import { generatePkce, base64url } from '../auth/pkce.js';

const NUM_RUNS = 200;

// RFC 7636 §4.1 — verifier must match [A-Za-z0-9\-._~]{43,128}
// generatePkce uses base64url(randomBytes(32)) which is URL-safe alpha-numeric + _-
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

describe('generatePkce — property tests', () => {
  it('S256: codeChallenge === base64url(sha256(codeVerifier)) for every generated pair', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkce();
        const expected = base64url(
          createHash('sha256').update(codeVerifier).digest(),
        );
        return codeChallenge === expected && codeChallengeMethod === 'S256';
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('verifier length is 43–128 characters (RFC 7636 §4.1)', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const { codeVerifier } = generatePkce();
        return codeVerifier.length >= 43 && codeVerifier.length <= 128;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('verifier matches [A-Za-z0-9_-]+ (URL-safe base64url alphabet)', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const { codeVerifier } = generatePkce();
        return VERIFIER_PATTERN.test(codeVerifier);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('codeChallengeMethod is always S256', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        return generatePkce().codeChallengeMethod === 'S256';
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('uniqueness: many successive calls produce distinct verifiers (no collisions)', () => {
    // Generate 200 verifiers and assert they are all distinct.
    const verifiers = Array.from({ length: NUM_RUNS }, () => generatePkce().codeVerifier);
    const unique = new Set(verifiers);
    expect(unique.size).toBe(NUM_RUNS);
  });
});
