/**
 * Property-based tests for the opaque cursor codec.
 *
 * Verifies encode→decode round-trip fidelity, determinism, and graceful
 * handling of corrupted/truncated inputs — edge cases that example tests
 * don't exercise exhaustively.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { encodeCursor, decodeCursor, type CursorPosition } from '../../../cursor.js';

const NUM_RUNS = 200;

/** Arbitrary non-empty string (UUID-like ids, ISO timestamps, etc.) */
const nonEmptyString = fc.string({ minLength: 1, maxLength: 128 });

/** Arbitrary CursorPosition with realistic-looking but random id and ts strings. */
const cursorPositionArb: fc.Arbitrary<CursorPosition> = fc.record({
  id: nonEmptyString,
  ts: nonEmptyString,
});

describe('cursor codec — property tests', () => {
  it('encode→decode round-trip: decode(encode(x)) deep-equals x', () => {
    fc.assert(
      fc.property(cursorPositionArb, (pos) => {
        const encoded = encodeCursor(pos);
        const decoded = decodeCursor(encoded);
        return (
          decoded !== null &&
          decoded.id === pos.id &&
          decoded.ts === pos.ts
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('determinism: encoding the same value twice produces the same cursor', () => {
    fc.assert(
      fc.property(cursorPositionArb, (pos) => {
        return encodeCursor(pos) === encodeCursor(pos);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('corrupted input: decoding random strings never throws and returns null or a valid position', () => {
    fc.assert(
      fc.property(fc.string(), (garbage) => {
        let result: CursorPosition | null;
        try {
          result = decodeCursor(garbage);
        } catch {
          // Any thrown exception is a failure — codec must be graceful.
          return false;
        }
        // Result must be null (invalid input) or a valid CursorPosition shape.
        if (result === null) return true;
        return typeof result.id === 'string' && typeof result.ts === 'string';
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('truncated cursor: decoding a prefix of a valid cursor is graceful', () => {
    fc.assert(
      fc.property(
        cursorPositionArb,
        fc.integer({ min: 0, max: 30 }),
        (pos, cutLen) => {
          const full = encodeCursor(pos);
          const truncated = full.slice(0, cutLen);
          let result: CursorPosition | null;
          try {
            result = decodeCursor(truncated);
          } catch {
            return false; // must not throw
          }
          // Either null (corrupt) or a fully valid position — never partial/undefined.
          if (result === null) return true;
          return typeof result.id === 'string' && typeof result.ts === 'string';
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('null/undefined/empty input: decodeCursor always returns null without throwing', () => {
    for (const bad of [null, undefined, '', '   ']) {
      let result: CursorPosition | null;
      try {
        result = decodeCursor(bad);
      } catch {
        throw new Error(`decodeCursor(${JSON.stringify(bad)}) threw unexpectedly`);
      }
      expect(result).toBeNull();
    }
  });

  it('distinct positions produce distinct cursors (injectivity)', () => {
    fc.assert(
      fc.property(
        cursorPositionArb,
        cursorPositionArb,
        (posA, posB) => {
          // Only assert when the positions differ.
          if (posA.id === posB.id && posA.ts === posB.ts) return true;
          return encodeCursor(posA) !== encodeCursor(posB);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
