/**
 * Property-based tests for webhook signature verification.
 *
 * Uses fast-check to generate arbitrary inputs and assert invariants that
 * example-based tests can't exhaustively cover: any body/secret combination
 * should round-trip correctly, any mutation of the body or timestamp should
 * invalidate the signature, etc.
 */
import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { verifyWebhook, computeSignature, SHIP_SIGNATURE_HEADER } from '../webhooks/verify.js';

const NUM_RUNS = 200;

/** Build the Ship-Signature header value. */
function makeHeader(t: number, v1: string): Record<string, string> {
  return { [SHIP_SIGNATURE_HEADER]: `t=${t},v1=${v1}` };
}

/** A "fresh" timestamp within the default tolerance window (300s). */
const freshTimestamp = fc.integer({ min: -290, max: 290 }).map(
  (delta) => Math.floor(Date.now() / 1000) + delta,
);

/** Non-empty string arbitrary for secrets. */
const nonEmptyString = fc.string({ minLength: 1, maxLength: 128 });

describe('verifyWebhook — property tests', () => {
  it('round-trip: computeSignature always verifies with verifyWebhook (arbitrary body + secret)', () => {
    fc.assert(
      fc.property(
        fc.string(),       // rawBody — any string including empty
        nonEmptyString,    // secret — non-empty
        freshTimestamp,    // timestamp within tolerance
        (rawBody, secret, t) => {
          const sig = computeSignature(secret, t, rawBody);
          return verifyWebhook(makeHeader(t, sig), rawBody, secret) === true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('tampered body: a single-byte mutation always invalidates the signature', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),  // at least 1 char so we can mutate
        nonEmptyString,
        freshTimestamp,
        fc.nat(),                     // mutation index (mod body length)
        (rawBody, secret, t, mutIdx) => {
          const sig = computeSignature(secret, t, rawBody);
          // Flip one character to a guaranteed different one.
          const idx = mutIdx % rawBody.length;
          const originalCode = rawBody.charCodeAt(idx);
          // XOR with 0x01 always produces a different code point.
          const mutatedCode = originalCode ^ 0x01;
          const mutatedChar = String.fromCharCode(mutatedCode);
          const tamperedBody =
            rawBody.slice(0, idx) + mutatedChar + rawBody.slice(idx + 1);
          // Guard: mutation must actually change the body (always true for XOR 0x01).
          if (tamperedBody === rawBody) return true; // degenerate, skip
          return verifyWebhook(makeHeader(t, sig), tamperedBody, secret) === false;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('replay attack: a valid signature with a stale timestamp is always rejected', () => {
    fc.assert(
      fc.property(
        fc.string(),
        nonEmptyString,
        // tolerance: 10–600s; stale offset is tolerance + 1..+300s beyond tolerance
        fc.integer({ min: 10, max: 600 }),
        fc.integer({ min: 1, max: 300 }),
        (rawBody, secret, tolerance, extra) => {
          const staleT = Math.floor(Date.now() / 1000) - tolerance - extra;
          const sig = computeSignature(secret, staleT, rawBody);
          return verifyWebhook(makeHeader(staleT, sig), rawBody, secret, tolerance) === false;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('missing/garbled v1: verification always fails', () => {
    fc.assert(
      fc.property(
        fc.string(),
        nonEmptyString,
        freshTimestamp,
        // arbitrary garbage for the v1 field
        fc.string({ minLength: 0, maxLength: 64 }),
        (rawBody, secret, t, garbledV1) => {
          const sig = computeSignature(secret, t, rawBody);

          // Case 1: header has no v1= part at all.
          const noV1Header = { [SHIP_SIGNATURE_HEADER]: `t=${t}` };
          if (verifyWebhook(noV1Header, rawBody, secret) !== false) return false;

          // Case 2: garbled v1 — should fail unless it accidentally equals the real sig.
          if (garbledV1 === sig) return true; // skip: accidentally correct
          const garbledHeader = makeHeader(t, garbledV1);
          return verifyWebhook(garbledHeader, rawBody, secret) === false;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
