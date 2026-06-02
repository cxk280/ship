/**
 * @ship/sdk DPoP helper (RFC 9449) — verifies the generated proof is a valid
 * ES256 JWS with the RFC 7638 thumbprint and the expected bound claims. Uses
 * only node:crypto (no JOSE lib) to independently check the signature.
 */
import { describe, it, expect } from 'vitest';
import { createHash, createVerify, createPublicKey } from 'node:crypto';
import { generateDpopKeyPair, createDpopProof, dpopThumbprint } from '../auth/dpop.js';

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function parse(proof: string) {
  const [h, p, sig] = proof.split('.');
  return {
    header: JSON.parse(b64urlToBuf(h!).toString('utf8')),
    payload: JSON.parse(b64urlToBuf(p!).toString('utf8')),
    signingInput: `${h}.${p}`,
    sig: b64urlToBuf(sig!),
  };
}

describe('createDpopProof', () => {
  it('produces a dpop+jwt with ES256 + embedded public JWK', () => {
    const key = generateDpopKeyPair();
    const proof = createDpopProof(key, 'POST', 'https://ship/oauth/token');
    const { header, payload } = parse(proof);
    expect(header.typ).toBe('dpop+jwt');
    expect(header.alg).toBe('ES256');
    expect(header.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(header.jwk.d).toBeUndefined(); // no private material leaks
    expect(payload.htm).toBe('POST');
    expect(payload.htu).toBe('https://ship/oauth/token');
    expect(typeof payload.jti).toBe('string');
    expect(typeof payload.iat).toBe('number');
  });

  it('signature verifies against the embedded JWK (raw P-1363)', () => {
    const key = generateDpopKeyPair();
    const proof = createDpopProof(key, 'GET', 'https://ship/api/v1/me');
    const { signingInput, sig, header } = parse(proof);
    const pub = createPublicKey({ key: header.jwk, format: 'jwk' });
    const v = createVerify('SHA256');
    v.update(signingInput);
    v.end();
    expect(v.verify({ key: pub, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });

  it('strips query/fragment from htu', () => {
    const key = generateDpopKeyPair();
    const proof = createDpopProof(key, 'GET', 'https://ship/api/v1/me?x=1#frag');
    expect(parse(proof).payload.htu).toBe('https://ship/api/v1/me');
  });

  it('adds an ath binding when an access token is supplied', () => {
    const key = generateDpopKeyPair();
    const token = 'ship_at_abc';
    const proof = createDpopProof(key, 'GET', 'https://ship/api/v1/me', { accessToken: token });
    const expected = createHash('sha256').update(token).digest('base64url');
    expect(parse(proof).payload.ath).toBe(expected);
  });

  it('dpopThumbprint matches an independent RFC 7638 computation', () => {
    const key = generateDpopKeyPair();
    const { x, y } = key.publicJwk;
    const canonical = JSON.stringify({ crv: 'P-256', kty: 'EC', x, y });
    const expected = createHash('sha256').update(canonical).digest('base64url');
    expect(dpopThumbprint(key)).toBe(expected);
  });
});
