/**
 * DPoP (RFC 9449) client helper — zero runtime dependencies (node:crypto only).
 *
 * Generates a DPoP keypair and signs the per-request proof JWTs a sender-
 * constrained Ship token requires. Supports ES256 (EC P-256), the most widely
 * interoperable DPoP algorithm.
 *
 * Usage:
 *   const key = await generateDpopKeyPair();
 *   const proof = await createDpopProof(key, 'POST', 'https://ship/oauth/token');
 *   // send `DPoP: <proof>` alongside the token request; the issued token_type is "DPoP".
 *   const apiProof = await createDpopProof(key, 'GET', 'https://ship/api/v1/me', { accessToken });
 *   // send `Authorization: DPoP <accessToken>` + `DPoP: <apiProof>`.
 */
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from 'crypto';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The public JWK (EC P-256) embedded in every proof, plus the private key to sign with. */
export interface DpopKeyPair {
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  privateKey: KeyObject;
  alg: 'ES256';
}

/** Generate an EC P-256 keypair for DPoP. */
export function generateDpopKeyPair(): DpopKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; y?: string };
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new Error('Failed to export EC P-256 public JWK');
  }
  return { publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, privateKey, alg: 'ES256' };
}

/** RFC 7638 JWK thumbprint (base64url SHA-256) of the keypair's public key. */
export function dpopThumbprint(key: DpopKeyPair): string {
  const canonical = JSON.stringify({ crv: key.publicJwk.crv, kty: key.publicJwk.kty, x: key.publicJwk.x, y: key.publicJwk.y });
  return b64url(createHash('sha256').update(canonical).digest());
}

export interface CreateDpopProofOptions {
  /** Bind the proof to a specific access token via the `ath` claim. */
  accessToken?: string;
  /** Override issued-at (epoch seconds) — for tests. */
  iat?: number;
  /** Override the unique proof id — for tests. */
  jti?: string;
}

/**
 * Create a DPoP proof JWT (compact JWS) for `htm` (HTTP method) + `htu` (target
 * URI). Pass `accessToken` to include the `ath` binding required on resource
 * requests. ES256 signatures are emitted as raw r||s (JWS / IEEE-P1363 form).
 */
export function createDpopProof(
  key: DpopKeyPair,
  htm: string,
  htu: string,
  opts: CreateDpopProofOptions = {},
): string {
  const header = { typ: 'dpop+jwt', alg: key.alg, jwk: key.publicJwk };
  const payload: Record<string, unknown> = {
    jti: opts.jti ?? randomUUID(),
    htm: htm.toUpperCase(),
    htu: stripQuery(htu),
    iat: opts.iat ?? Math.floor(Date.now() / 1000),
  };
  if (opts.accessToken !== undefined) {
    payload.ath = b64url(createHash('sha256').update(opts.accessToken).digest());
  }
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const sign = createSign('SHA256');
  sign.update(signingInput);
  sign.end();
  const sig = sign.sign({ key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

function stripQuery(uri: string): string {
  const q = uri.indexOf('?');
  const h = uri.indexOf('#');
  let end = uri.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return uri.slice(0, end);
}
