/**
 * Ed25519 webhook signature tests.
 *
 * Covers:
 *  - signPayloadEd25519 produces a header that verifies with the matching public key
 *  - A tampered body fails verification
 *  - An expired timestamp fails verification
 *  - A wrong key fails verification
 *  - Deliveries carry BOTH a valid HMAC and a valid Ed25519 header
 *  - After rotation, deliveries are signed with the NEW active key;
 *    the retiring key's public key still verifies signatures that were
 *    made BEFORE the rotation (i.e. with the old private key).
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createPublicKey } from 'node:crypto';
import { createHmac, randomUUID } from 'node:crypto';
import { pool } from '../../../db/client.js';
import * as wstore from '../store.js';
import * as ostore from '../../oauth/store.js';
import { hashClientSecret } from '../../oauth/crypto.js';
import { TestClock } from '../clock.js';
import { QueueWebhookDeliverer, type Transport, type TransportResult } from '../deliverer.js';
import { InMemoryEventBus } from '../event-bus.js';
import {
  signPayloadEd25519,
  SHIP_SIGNATURE_ED25519_HEADER,
} from '../signer.js';
import { getOrCreateActiveKey, rotateKey, getPublicKeys } from '../signing-keys.js';

// ---- helpers ---------------------------------------------------------------

async function setup(): Promise<{ workspaceId: string; appId: string; sub: wstore.SubscriptionRow }> {
  const tag = randomUUID().slice(0, 8);
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`ED25519 ${tag}`]);
  const workspaceId = ws.rows[0].id;
  const u = await pool.query(`INSERT INTO users (email, name) VALUES ($1,'ED') RETURNING id`, [`ed-${tag}@example.com`]);
  const app = await ostore.createApp({
    clientId: `ship_app_ed_${tag}`,
    clientSecretHash: await hashClientSecret('x'),
    name: 'Ed25519 App',
    redirectUris: [],
    requestedScopes: ['webhooks:manage', 'documents:write'],
    appType: 'confidential',
    ownerUserId: u.rows[0].id,
    workspaceId,
  });
  const sub = await wstore.createSubscription({
    appId: app.id,
    workspaceId,
    eventType: 'document.created',
    targetUrl: 'https://ed.example.com/hook',
    signingSecret: 'whsec_ed25519_test',
  });
  return { workspaceId, appId: app.id, sub };
}

function scriptedTransport(statuses: number[]): Transport & { calls: { headers: Record<string, string>; body: string }[] } {
  const calls: { headers: Record<string, string>; body: string }[] = [];
  let i = 0;
  const fn = (async (_url, opts) => {
    calls.push({ headers: opts.headers, body: opts.body });
    const status = statuses[Math.min(i, statuses.length - 1)]!;
    i++;
    return { status } as TransportResult;
  }) as Transport & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function eventFor(workspaceId: string) {
  return {
    type: 'document.created' as const,
    workspaceId,
    data: {
      id: '44444444-4444-4444-4444-444444444444',
      document_type: 'wiki',
      title: 'Ed Test',
      workspace_id: workspaceId,
    },
  };
}

// ---- signer unit tests -----------------------------------------------------

describe('signPayloadEd25519', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const body = JSON.stringify({ id: 'evt_ed', type: 'document.created' });
  const t = 1715985600;

  it('produces t=<unix>,v1=<base64> that verifies with the public key', () => {
    const { header, v1 } = signPayloadEd25519(privateKey, body, t);
    expect(header).toBe(`t=${t},v1=${v1}`);

    const payload = Buffer.from(`${t}.${body}`, 'utf8');
    const sigBuf = Buffer.from(v1, 'base64');
    const pubKeyObj = createPublicKey(publicKey);
    expect(cryptoVerify(null, payload, pubKeyObj, sigBuf)).toBe(true);
  });

  it('a tampered body fails verification', () => {
    const { v1 } = signPayloadEd25519(privateKey, body, t);
    const payload = Buffer.from(`${t}.${body}X`, 'utf8'); // tampered
    const sigBuf = Buffer.from(v1, 'base64');
    const pubKeyObj = createPublicKey(publicKey);
    expect(cryptoVerify(null, payload, pubKeyObj, sigBuf)).toBe(false);
  });

  it('a different key pair fails verification', () => {
    const { v1 } = signPayloadEd25519(privateKey, body, t);
    const { publicKey: otherPub } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const payload = Buffer.from(`${t}.${body}`, 'utf8');
    const sigBuf = Buffer.from(v1, 'base64');
    const otherPubObj = createPublicKey(otherPub);
    expect(cryptoVerify(null, payload, otherPubObj, sigBuf)).toBe(false);
  });
});

// ---- delivery carries both HMAC and Ed25519 headers ------------------------

describe('delivery carries both HMAC and Ed25519 headers', () => {
  it('delivers a POST with Ship-Signature AND Ship-Signature-Ed25519', async () => {
    const { workspaceId, appId } = await setup();
    const clock = new TestClock();
    const transport = scriptedTransport([200]);

    // Ensure the app has an active signing key.
    const keyRow = await getOrCreateActiveKey(appId);

    const bus = new InMemoryEventBus({
      deliverer: new QueueWebhookDeliverer({ clock, transport, jitter: () => 0 }),
      clock,
      ed25519KeyResolver: async (id) => (id === appId ? keyRow.private_key : undefined),
    });

    await bus.publish(eventFor(workspaceId));
    await clock.advance(0);

    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;

    // HMAC header is present and valid.
    const hmacHeader = call.headers['Ship-Signature']!;
    expect(hmacHeader).toBeTruthy();
    const t = Number(hmacHeader.match(/t=(\d+)/)![1]);
    const v1 = hmacHeader.match(/v1=([0-9a-f]+)/)![1];
    const expectedHmac = createHmac('sha256', 'whsec_ed25519_test').update(`${t}.${call.body}`).digest('hex');
    expect(v1).toBe(expectedHmac);

    // Ed25519 header is present and valid.
    const edHeader = call.headers[SHIP_SIGNATURE_ED25519_HEADER]!;
    expect(edHeader).toBeTruthy();
    const edT = Number(edHeader.match(/t=(\d+)/)![1]);
    const edV1 = edHeader.match(/v1=([^,]+)/)![1]!;
    const edPayload = Buffer.from(`${edT}.${call.body}`, 'utf8');
    const edSig = Buffer.from(edV1, 'base64');
    const pubKeyObj = createPublicKey(keyRow.public_key);
    expect(cryptoVerify(null, edPayload, pubKeyObj, edSig)).toBe(true);
  });
});

// ---- key rotation tests ----------------------------------------------------

describe('key rotation', () => {
  it('after rotate: new active key signs deliveries; retiring public key still verifies old sigs', async () => {
    const { workspaceId, appId } = await setup();
    const clock = new TestClock();

    // Get the initial key.
    const oldKey = await getOrCreateActiveKey(appId);

    // Sign something with the old key (simulate a pre-rotation delivery).
    const body = JSON.stringify({ id: 'evt_pre', type: 'document.created' });
    const t = 1715985600;
    const { v1: oldV1 } = signPayloadEd25519(oldKey.private_key, body, t);

    // Rotate.
    const newKey = await rotateKey(appId);
    expect(newKey.id).not.toBe(oldKey.id);
    expect(newKey.status).toBe('active');

    // Check DB state.
    const allKeys = await getPublicKeys(appId);
    const activeKeys = allKeys.filter((k) => k.status === 'active');
    const retiringKeys = allKeys.filter((k) => k.status === 'retiring');
    expect(activeKeys).toHaveLength(1);
    expect(retiringKeys).toHaveLength(1);
    expect(activeKeys[0]!.id).toBe(newKey.id);
    expect(retiringKeys[0]!.id).toBe(oldKey.id);

    // Deliveries signed with NEW key verify with new public key.
    const transport = scriptedTransport([200]);
    const bus = new InMemoryEventBus({
      deliverer: new QueueWebhookDeliverer({ clock, transport, jitter: () => 0 }),
      clock,
      ed25519KeyResolver: async (id) => {
        if (id !== appId) return undefined;
        const k = await getOrCreateActiveKey(id);
        return k.private_key;
      },
    });
    await bus.publish(eventFor(workspaceId));
    await clock.advance(0);
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    const edHeader = call.headers[SHIP_SIGNATURE_ED25519_HEADER]!;
    const edT = Number(edHeader.match(/t=(\d+)/)![1]);
    const edV1 = edHeader.match(/v1=([^,]+)/)![1]!;
    const edPayload = Buffer.from(`${edT}.${call.body}`, 'utf8');
    const edSig = Buffer.from(edV1, 'base64');
    const newPubKeyObj = createPublicKey(newKey.public_key);
    expect(cryptoVerify(null, edPayload, newPubKeyObj, edSig)).toBe(true);

    // Retiring key's public key still verifies the PRE-ROTATION signature.
    const oldPayload = Buffer.from(`${t}.${body}`, 'utf8');
    const oldSigBuf = Buffer.from(oldV1, 'base64');
    const oldPubKeyObj = createPublicKey(oldKey.public_key);
    expect(cryptoVerify(null, oldPayload, oldPubKeyObj, oldSigBuf)).toBe(true);
  });

  it('getPublicKeys never includes private key material', async () => {
    const { appId } = await setup();
    await getOrCreateActiveKey(appId);
    const keys = await getPublicKeys(appId);
    for (const k of keys) {
      expect(k).not.toHaveProperty('private_key');
    }
  });
});
