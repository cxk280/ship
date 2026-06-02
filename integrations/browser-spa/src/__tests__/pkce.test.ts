/**
 * Unit tests for the PKCE helpers.
 *
 * vitest runs in Node.js which ships the Web Crypto API (globalThis.crypto)
 * since Node 19+ and as globalThis.crypto since Node 20. For Node 18 we rely
 * on vitest's jsdom / happy-dom environment which polyfills it, or we set up
 * the webcrypto polyfill inline without importing node:crypto directly.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// Web-Crypto polyfill for Node 18 environments that don't expose globalThis.crypto.
beforeAll(async () => {
  if (!globalThis.crypto?.subtle) {
    // Dynamic import avoids a hard node:crypto reference in TypeScript types.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const nodeCrypto = await import('node:crypto' as string);
    // @ts-expect-error polyfill: webcrypto may not be on the type but exists at runtime
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    if (nodeCrypto.webcrypto) globalThis.crypto = nodeCrypto.webcrypto;
  }
});

let generateVerifier: () => string;
let computeChallenge: (v: string) => Promise<string>;
let generatePkce: () => Promise<{ verifier: string; challenge: string; method: 'S256' }>;

describe('PKCE helpers', () => {
  beforeAll(async () => {
    const mod = await import('../pkce.js');
    generateVerifier = mod.generateVerifier;
    computeChallenge = mod.computeChallenge;
    generatePkce = mod.generatePkce;
  });

  it('generateVerifier returns a base64url string of 43 chars', () => {
    const v = generateVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars (ceil(32*4/3) = 43)
    expect(v.length).toBe(43);
  });

  it('generateVerifier produces different values each call', () => {
    expect(generateVerifier()).not.toBe(generateVerifier());
  });

  it('computeChallenge matches a known S256 reference', async () => {
    // RFC 7636 Appendix B test vector:
    //   verifier: dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
    //   challenge: E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await computeChallenge(verifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('challenge is base64url without padding', async () => {
    const { verifier, challenge, method } = await generatePkce();
    expect(method).toBe('S256');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generatePkce yields unique pairs each call', async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});
