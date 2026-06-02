/**
 * SDK verifyWebhookEd25519 unit tests.
 *
 * Covers: valid passes, tampered body fails, expired timestamp fails,
 * wrong key fails, missing header fails, case-insensitive header matching.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { verifyWebhookEd25519, SHIP_SIGNATURE_ED25519_HEADER } from '../webhooks/verify.js';

// Generate a deterministic keypair for the suite.
const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const body = JSON.stringify({ type: 'document.created', data: { id: 'doc_ed_1' } });

function makeHeader(t: number, privKey: string, rawBody: string): string {
  const payload = Buffer.from(`${t}.${rawBody}`, 'utf8');
  const sig = cryptoSign(null, payload, privKey);
  return `t=${t},v1=${sig.toString('base64')}`;
}

function headers(t: number, privKey = privateKey, rawBody = body) {
  return { [SHIP_SIGNATURE_ED25519_HEADER]: makeHeader(t, privKey, rawBody) };
}

describe('verifyWebhookEd25519', () => {
  it('accepts a valid, fresh Ed25519 signature', () => {
    const t = Math.floor(Date.now() / 1000);
    expect(verifyWebhookEd25519(headers(t), body, publicKey)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const t = Math.floor(Date.now() / 1000);
    expect(verifyWebhookEd25519(headers(t), body + 'X', publicKey)).toBe(false);
  });

  it('rejects an expired timestamp (older than tolerance)', () => {
    const t = Math.floor(Date.now() / 1000) - 1000;
    expect(verifyWebhookEd25519(headers(t), body, publicKey, 300)).toBe(false);
  });

  it('rejects a future timestamp beyond tolerance', () => {
    const t = Math.floor(Date.now() / 1000) + 1000;
    expect(verifyWebhookEd25519(headers(t), body, publicKey, 300)).toBe(false);
  });

  it('rejects a wrong public key', () => {
    const t = Math.floor(Date.now() / 1000);
    const { publicKey: otherPub } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(verifyWebhookEd25519(headers(t), body, otherPub)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyWebhookEd25519({}, body, publicKey)).toBe(false);
  });

  it('rejects a missing v1 in header', () => {
    const t = Math.floor(Date.now() / 1000);
    expect(verifyWebhookEd25519({ [SHIP_SIGNATURE_ED25519_HEADER]: `t=${t}` }, body, publicKey)).toBe(false);
  });

  it('is case-insensitive on the header name', () => {
    const t = Math.floor(Date.now() / 1000);
    const h = makeHeader(t, privateKey, body);
    expect(verifyWebhookEd25519({ 'ship-signature-ed25519': h }, body, publicKey)).toBe(true);
  });

  it('accepts a custom tolerance window (wider)', () => {
    const t = Math.floor(Date.now() / 1000) - 400; // 400s old
    // With default 300s tolerance: rejected. With 600s: accepted.
    expect(verifyWebhookEd25519(headers(t), body, publicKey, 300)).toBe(false);
    expect(verifyWebhookEd25519(headers(t), body, publicKey, 600)).toBe(true);
  });
});
