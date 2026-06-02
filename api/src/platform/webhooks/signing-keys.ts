/**
 * Ed25519 signing-key management for asymmetric webhook signatures.
 *
 * Each OAuth app gets one 'active' keypair used to sign deliveries.
 * During rotation the active key becomes 'retiring' and a new 'active' key is
 * generated. Both keys remain valid for verification during the overlap window
 * so subscribers that cached the old public key continue to work.
 *
 * All key material is stored as PEM strings. Private keys are SERVER-SIDE ONLY
 * and never returned through any public API.
 */
import { generateKeyPairSync } from 'node:crypto';
import { pool } from '../../db/client.js';

export interface SigningKeyRow {
  id: string;
  app_id: string;
  public_key: string;
  private_key: string;
  status: 'active' | 'retiring';
  created_at: string;
}

export interface PublicKeyInfo {
  id: string;
  public_key: string;
  status: 'active' | 'retiring';
  created_at: string;
}

// ---- raw DB helpers -------------------------------------------------------

async function getKeysByAppId(appId: string): Promise<SigningKeyRow[]> {
  const r = await pool.query(
    `SELECT * FROM webhook_signing_keys WHERE app_id = $1 ORDER BY created_at DESC`,
    [appId],
  );
  return r.rows as SigningKeyRow[];
}

async function insertKey(appId: string, publicKey: string, privateKey: string): Promise<SigningKeyRow> {
  const r = await pool.query(
    `INSERT INTO webhook_signing_keys (app_id, public_key, private_key, status)
     VALUES ($1, $2, $3, 'active') RETURNING *`,
    [appId, publicKey, privateKey],
  );
  return r.rows[0] as SigningKeyRow;
}

async function updateKeyStatus(id: string, status: 'active' | 'retiring'): Promise<void> {
  await pool.query(`UPDATE webhook_signing_keys SET status = $2 WHERE id = $1`, [id, status]);
}

// ---- service layer --------------------------------------------------------

/** Generate a fresh Ed25519 keypair and return PEM strings. */
function generateEd25519Pair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/**
 * Get (or lazily create) the active signing key for an app.
 * On first call for a new app this generates and persists an Ed25519 keypair.
 */
export async function getOrCreateActiveKey(appId: string): Promise<SigningKeyRow> {
  const rows = await getKeysByAppId(appId);
  const active = rows.find((r) => r.status === 'active');
  if (active) return active;

  // No active key yet — generate one.
  const { publicKey, privateKey } = generateEd25519Pair();
  return insertKey(appId, publicKey, privateKey);
}

/**
 * Rotate the signing key for an app:
 *   1. Mark the current 'active' key as 'retiring'.
 *   2. Generate and persist a new 'active' key.
 *
 * Returns the new active key. The retiring key stays in the table so its
 * public key can still be used for verification during the overlap window.
 */
export async function rotateKey(appId: string): Promise<SigningKeyRow> {
  const rows = await getKeysByAppId(appId);
  const active = rows.find((r) => r.status === 'active');
  if (active) {
    await updateKeyStatus(active.id, 'retiring');
  }
  const { publicKey, privateKey } = generateEd25519Pair();
  return insertKey(appId, publicKey, privateKey);
}

/**
 * Return all PUBLIC key info (active + retiring) for an app.
 * Private keys are NEVER included.
 */
export async function getPublicKeys(appId: string): Promise<PublicKeyInfo[]> {
  const rows = await getKeysByAppId(appId);
  return rows.map(({ id, public_key, status, created_at }) => ({
    id,
    public_key,
    status,
    created_at,
  }));
}
