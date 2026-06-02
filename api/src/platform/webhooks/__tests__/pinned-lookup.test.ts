/**
 * Regression test for the production SSRF DNS-pinning bug: Node 18+/20 enables
 * autoSelectFamily by default, so http(s).request calls the custom `lookup` with
 * `{ all: true }` and expects an ARRAY. The old inline lookup always returned the
 * 3-arg (address, family) tuple, which made Node throw "Invalid IP address:
 * undefined" — webhooks never left the deployed (NODE_ENV=production) server.
 */
import { describe, it, expect } from 'vitest';
import { makePinnedLookup } from '../deliverer.js';

describe('makePinnedLookup (production DNS pinning)', () => {
  it('returns an ARRAY when called with { all: true } (Node autoSelectFamily path)', () => {
    const lookup = makePinnedLookup('203.0.113.7', 4);
    let err: unknown = 'unset';
    let addr: unknown;
    lookup('example.com', { all: true }, (e, a) => {
      err = e;
      addr = a;
    });
    expect(err).toBeNull();
    expect(addr).toEqual([{ address: '203.0.113.7', family: 4 }]);
  });

  it('returns the (address, family) tuple when called without all', () => {
    const lookup = makePinnedLookup('203.0.113.7', 6);
    let addr: unknown;
    let fam: number | undefined;
    lookup('example.com', {}, (_e, a, f) => {
      addr = a;
      fam = f;
    });
    expect(addr).toBe('203.0.113.7');
    expect(fam).toBe(6);
  });
});
