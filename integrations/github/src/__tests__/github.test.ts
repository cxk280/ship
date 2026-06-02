/**
 * Unit tests for marker/reference parsing and the GitHub signature verifier.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { shipMarker, parseShipMarker, parseShipReference } from '../github.js';
import { verifyGitHubSignature } from '../github-verify.js';

describe('markers', () => {
  it('round-trips a marker', () => {
    const id = 'a1b2c3d4-0000-1111-2222-333344445555';
    expect(parseShipMarker(shipMarker(id))).toBe(id);
  });

  it('returns null when no marker present', () => {
    expect(parseShipMarker('no marker here')).toBeNull();
    expect(parseShipMarker(null)).toBeNull();
  });

  it('parses ship#<id> references', () => {
    expect(parseShipReference('Closes ship#abc-123 in this PR')).toBe('abc-123');
    expect(parseShipReference('Fixes ship#42')).toBe('42');
    expect(parseShipReference('no reference')).toBeNull();
  });

  it('prefers an embedded marker over a ship# reference', () => {
    const id = 'marker-wins-id';
    const text = `Closes ship#other ${shipMarker(id)}`;
    expect(parseShipReference(text)).toBe(id);
  });
});

describe('verifyGitHubSignature', () => {
  const secret = 'gh_webhook_secret';
  const body = JSON.stringify({ action: 'opened', number: 7 });
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a correct signature', () => {
    expect(verifyGitHubSignature({ 'x-hub-signature-256': sig }, body, secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyGitHubSignature({ 'x-hub-signature-256': sig }, body + 'x', secret)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(verifyGitHubSignature({ 'x-hub-signature-256': sig }, body, 'wrong')).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifyGitHubSignature({}, body, secret)).toBe(false);
    expect(verifyGitHubSignature({ 'x-hub-signature-256': 'md5=abc' }, body, secret)).toBe(false);
  });
});
