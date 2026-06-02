/**
 * DPoP — Demonstrating Proof of Possession (RFC 9449).
 *
 * A DPoP proof is a compact JWS (header.payload.signature) the client signs with
 * a private key it holds. The matching public JWK travels in the JWS header. By
 * binding an access token to the JWK SHA-256 thumbprint (`jkt`, RFC 7638), the
 * server makes a stolen token useless: every protected request must carry a fresh
 * proof signed by the same key.
 *
 * Verification here is pure `node:crypto` — no JOSE library, no new runtime deps.
 * Supported proof algorithms: ES256 (EC P-256) and EdDSA (Ed25519).
 *
 * What this module deliberately does NOT do: persist replay state. The caller
 * owns `jti` replay protection (a short-lived store), because storage strategy is
 * a deployment concern. This module returns the parsed/verified claims so the
 * caller can enforce freshness + replay.
 */
import crypto from 'crypto';

export const DPOP_ALGS = ['ES256', 'EdDSA'] as const;
export type DpopAlg = (typeof DPOP_ALGS)[number];

/** A JWK public key as it appears in the DPoP proof header (`jwk`). */
export interface DpopJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  [k: string]: unknown;
}

export interface DpopProofClaims {
  /** JWK thumbprint (RFC 7638) of the proof's public key — what the token binds to. */
  jkt: string;
  /** HTTP method the proof is bound to (uppercase). */
  htm: string;
  /** HTTP target URI the proof is bound to (no query/fragment). */
  htu: string;
  /** Unique proof identifier — caller enforces single-use replay protection. */
  jti: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Optional access-token hash binding (base64url SHA-256 of the token). */
  ath?: string;
}

export class DpopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DpopError';
  }
}

function b64uToBuf(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function b64uDecodeJson(s: string): unknown {
  return JSON.parse(b64uToBuf(s).toString('utf8'));
}

/**
 * RFC 7638 JWK thumbprint: SHA-256 over the canonical (lexicographically-ordered,
 * whitespace-free) JSON of the REQUIRED members only, base64url-encoded.
 *  - EC:  {"crv","kty","x","y"}
 *  - OKP: {"crv","kty","x"}
 */
export function jwkThumbprint(jwk: DpopJwk): string {
  let canonical: Record<string, string>;
  if (jwk.kty === 'EC') {
    if (!jwk.crv || !jwk.x || !jwk.y) throw new DpopError('EC JWK missing crv/x/y');
    canonical = { crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y };
  } else if (jwk.kty === 'OKP') {
    if (!jwk.crv || !jwk.x) throw new DpopError('OKP JWK missing crv/x');
    canonical = { crv: jwk.crv, kty: 'OKP', x: jwk.x };
  } else {
    throw new DpopError(`Unsupported JWK kty: ${jwk.kty}`);
  }
  // Object key insertion order above is already lexicographic; JSON.stringify with
  // no spaces yields the RFC 7638 canonical form.
  const json = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(json).digest('base64url');
}

function importPublicKey(jwk: DpopJwk, alg: DpopAlg): crypto.KeyObject {
  if (alg === 'ES256') {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
      throw new DpopError('ES256 requires an EC P-256 key');
    }
  } else if (alg === 'EdDSA') {
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
      throw new DpopError('EdDSA requires an OKP Ed25519 key');
    }
  }
  try {
    return crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
  } catch {
    throw new DpopError('Invalid JWK public key');
  }
}

/**
 * Verify the JWS signature of a DPoP proof against the embedded JWK.
 * Returns true on a valid signature.
 */
function verifyJws(signingInput: string, sigB64u: string, key: crypto.KeyObject, alg: DpopAlg): boolean {
  const sig = b64uToBuf(sigB64u);
  if (alg === 'ES256') {
    // ES256 JWS signatures are raw r||s (64 bytes). node:crypto wants DER unless
    // we pass dsaEncoding 'ieee-p1363'.
    if (sig.length !== 64) return false;
    return crypto.verify(
      'sha256',
      Buffer.from(signingInput),
      { key, dsaEncoding: 'ieee-p1363' },
      sig,
    );
  }
  // EdDSA (Ed25519): algorithm is null; the key type implies the hash.
  return crypto.verify(null, Buffer.from(signingInput), key, sig);
}

export interface VerifyDpopOptions {
  /** The compact JWS from the `DPoP` request header. */
  proof: string;
  /** Expected HTTP method (the request method). */
  htm: string;
  /** Expected HTTP target URI (scheme://host/path — query/fragment ignored). */
  htu: string;
  /** Max allowed age of the proof in seconds. Default 300 (5 min). */
  maxAgeSec?: number;
  /** Optional: require `ath` to equal base64url(SHA-256(accessToken)). */
  accessToken?: string;
  /** Current time (epoch ms) — injectable for tests. */
  now?: number;
}

const DEFAULT_MAX_AGE_SEC = 300;
/** Allow small positive clock skew on iat. */
const CLOCK_SKEW_SEC = 30;

/**
 * Parse and fully verify a DPoP proof JWT per RFC 9449 §4.3:
 *  - header: typ === "dpop+jwt", supported alg, well-formed embedded jwk
 *  - signature verifies against that jwk
 *  - htm / htu match the request
 *  - iat is recent (within maxAge, small skew tolerance)
 *  - ath (if required) matches the bound access token
 *
 * Throws {@link DpopError} on any failure. On success returns the claims,
 * including the JWK thumbprint (`jkt`). The caller still must enforce `jti`
 * single-use replay protection.
 */
export function verifyDpopProof(opts: VerifyDpopOptions): DpopProofClaims {
  const parts = opts.proof.split('.');
  if (parts.length !== 3) throw new DpopError('Malformed DPoP proof (expected 3 JWS parts)');
  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const sigB64 = parts[2]!;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64uDecodeJson(headerB64) as Record<string, unknown>;
    payload = b64uDecodeJson(payloadB64) as Record<string, unknown>;
  } catch {
    throw new DpopError('DPoP proof header/payload is not valid base64url JSON');
  }

  if (header.typ !== 'dpop+jwt') throw new DpopError('DPoP proof typ must be "dpop+jwt"');
  const alg = header.alg;
  if (typeof alg !== 'string' || !DPOP_ALGS.includes(alg as DpopAlg)) {
    throw new DpopError(`Unsupported DPoP alg: ${String(alg)}`);
  }
  const jwk = header.jwk as DpopJwk | undefined;
  if (!jwk || typeof jwk !== 'object') throw new DpopError('DPoP proof header missing jwk');
  // A public JWK must not carry private material.
  if ('d' in jwk) throw new DpopError('DPoP jwk must not contain a private key');

  const key = importPublicKey(jwk, alg as DpopAlg);
  const signingInput = `${headerB64}.${payloadB64}`;
  if (!verifyJws(signingInput, sigB64, key, alg as DpopAlg)) {
    throw new DpopError('DPoP proof signature verification failed');
  }

  const jkt = jwkThumbprint(jwk);

  const htm = payload.htm;
  const htu = payload.htu;
  const jti = payload.jti;
  const iat = payload.iat;
  if (typeof htm !== 'string' || htm.toUpperCase() !== opts.htm.toUpperCase()) {
    throw new DpopError('DPoP htm mismatch');
  }
  if (typeof htu !== 'string' || !htuMatches(htu, opts.htu)) {
    throw new DpopError('DPoP htu mismatch');
  }
  if (typeof jti !== 'string' || jti.length === 0) {
    throw new DpopError('DPoP proof missing jti');
  }
  if (typeof iat !== 'number') {
    throw new DpopError('DPoP proof missing iat');
  }

  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const maxAge = opts.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
  if (iat > nowSec + CLOCK_SKEW_SEC) throw new DpopError('DPoP proof iat is in the future');
  if (iat < nowSec - maxAge) throw new DpopError('DPoP proof is stale');

  let ath: string | undefined;
  if (typeof payload.ath === 'string') ath = payload.ath;
  if (opts.accessToken !== undefined) {
    const expected = crypto.createHash('sha256').update(opts.accessToken).digest('base64url');
    if (ath !== expected) throw new DpopError('DPoP ath does not match the access token');
  }

  return { jkt, htm: htm.toUpperCase(), htu, jti, iat, ath };
}

/**
 * htu comparison per RFC 9449: compare scheme + authority + path, ignoring query
 * and fragment. Normalizes a default port away so https://h:443/p === https://h/p.
 */
function htuMatches(claimed: string, expected: string): boolean {
  try {
    const a = new URL(claimed);
    const b = new URL(expected);
    return (
      a.protocol === b.protocol &&
      stripDefaultPort(a) === stripDefaultPort(b) &&
      a.pathname === b.pathname
    );
  } catch {
    return false;
  }
}

function stripDefaultPort(u: URL): string {
  const isDefault =
    (u.protocol === 'https:' && (u.port === '' || u.port === '443')) ||
    (u.protocol === 'http:' && (u.port === '' || u.port === '80'));
  return isDefault ? u.hostname : `${u.hostname}:${u.port}`;
}
