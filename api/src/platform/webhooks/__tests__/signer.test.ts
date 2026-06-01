/**
 * Webhook signer unit suite — positive, negative, replay, tamper (PRD).
 * The convention (`${t}.${rawBody}` HMAC-SHA256, hex) is identical to the SDK's
 * verifyWebhook; here we verify it independently with crypto.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { signPayload, computeSignature } from '../signer.js';

const SECRET = 'whsec_unit';
const body = JSON.stringify({ id: 'evt_1', type: 'document.created', created: 1715985600, data: {} });

function independentHmac(secret: string, t: number, raw: string): string {
  return createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
}

describe('signPayload', () => {
  it('produces t=<unix>,v1=<hex> matching an independent HMAC (positive)', () => {
    const t = 1715985600;
    const { header, v1 } = signPayload(SECRET, body, t);
    expect(header).toBe(`t=${t},v1=${v1}`);
    expect(v1).toBe(independentHmac(SECRET, t, body));
  });

  it('a different secret yields a different signature (negative)', () => {
    const t = 1715985600;
    expect(computeSignature(SECRET, t, body)).not.toBe(computeSignature('other', t, body));
  });

  it('a tampered body yields a different signature (tamper)', () => {
    const t = 1715985600;
    const good = computeSignature(SECRET, t, body);
    const tampered = computeSignature(SECRET, t, body + ' ');
    expect(tampered).not.toBe(good);
  });

  it('a different timestamp yields a different signature (replay binding)', () => {
    const good = computeSignature(SECRET, 1715985600, body);
    const later = computeSignature(SECRET, 1715985601, body);
    expect(later).not.toBe(good);
  });
});
