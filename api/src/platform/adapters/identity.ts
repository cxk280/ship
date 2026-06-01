/**
 * Concrete IdentityPort — reads the internal users table.
 *
 * Lives under platform/adapters (NOT under platform/api/v1), so it may import the
 * internal db client. The composition root injects it into the v1 router.
 */
import { pool } from '../../db/client.js';
import type { IdentityPort, PublicUser } from '../api/v1/ports.js';

export const identityAdapter: IdentityPort = {
  async getUser(userId: string): Promise<PublicUser | null> {
    const r = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [userId]);
    return (r.rows[0] as PublicUser) ?? null;
  },
};
