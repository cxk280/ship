import { describe, it, expect } from 'vitest';
import { verifyWebhook, computeSignature, SHIP_SIGNATURE_HEADER } from '../webhooks/verify.js';

const SECRET = 'whsec_test';
const body = JSON.stringify({ type: 'document.created', data: { id: 'doc_1' } });

function header(t: number, v1: string) {
  return { [SHIP_SIGNATURE_HEADER]: `t=${t},v1=${v1}` };
}

describe('verifyWebhook', () => {
  it('accepts a valid, fresh signature', () => {
    const t = Math.floor(Date.now() / 1000);
    const sig = computeSignature(SECRET, t, body);
    expect(verifyWebhook(header(t, sig), body, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const t = Math.floor(Date.now() / 1000);
    const sig = computeSignature(SECRET, t, body);
    expect(verifyWebhook(header(t, sig), body + 'X', SECRET)).toBe(false);
  });

  it('rejects an expired timestamp (older than tolerance)', () => {
    const t = Math.floor(Date.now() / 1000) - 1000;
    const sig = computeSignature(SECRET, t, body);
    expect(verifyWebhook(header(t, sig), body, SECRET, 300)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const t = Math.floor(Date.now() / 1000);
    const sig = computeSignature('other', t, body);
    expect(verifyWebhook(header(t, sig), body, SECRET)).toBe(false);
  });

  it('rejects a missing v1 / missing header', () => {
    const t = Math.floor(Date.now() / 1000);
    expect(verifyWebhook({ [SHIP_SIGNATURE_HEADER]: `t=${t}` }, body, SECRET)).toBe(false);
    expect(verifyWebhook({}, body, SECRET)).toBe(false);
  });

  it('is case-insensitive on the header name', () => {
    const t = Math.floor(Date.now() / 1000);
    const sig = computeSignature(SECRET, t, body);
    expect(verifyWebhook({ 'ship-signature': `t=${t},v1=${sig}` }, body, SECRET)).toBe(true);
  });
});
