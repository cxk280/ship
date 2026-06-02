/**
 * Concrete IdempotencyPort — backed by the `idempotency_keys` table.
 *
 * `begin` atomically claims a (app_id, idempotency_key) slot via
 * INSERT … ON CONFLICT DO NOTHING, then inspects the existing row to decide
 * whether to replay, signal conflict, or reject a mismatched payload.
 *
 * `complete` updates the row to 'completed' with the response status + body.
 *
 * Lives under platform/adapters, so it MAY import internal modules (db pool).
 * The sealed v1 layer only sees the IdempotencyPort interface.
 */
import { pool } from '../../db/client.js';
import type { IdempotencyPort, IdempotencyBeginResult } from '../api/v1/ports.js';

export function createIdempotencyAdapter(): IdempotencyPort {
  return {
    async begin({ appId, key, fingerprint }): Promise<IdempotencyBeginResult> {
      // Try to insert a new in-progress row.  If the key already exists for
      // this app the INSERT is silently skipped (ON CONFLICT DO NOTHING).
      const insert = await pool.query<{ fingerprint: string; status: string; response_status: number | null; response_body: unknown }>(
        `INSERT INTO idempotency_keys (app_id, idempotency_key, fingerprint)
         VALUES ($1, $2, $3)
         ON CONFLICT (app_id, idempotency_key) DO NOTHING
         RETURNING fingerprint, status, response_status, response_body`,
        [appId, key, fingerprint],
      );

      // INSERT succeeded → brand new key.
      if (insert.rowCount && insert.rowCount > 0) {
        return { kind: 'new' };
      }

      // INSERT was a no-op → row already exists; fetch it to decide what to do.
      const existing = await pool.query<{ fingerprint: string; status: string; response_status: number | null; response_body: unknown }>(
        `SELECT fingerprint, status, response_status, response_body
         FROM idempotency_keys
         WHERE app_id = $1 AND idempotency_key = $2`,
        [appId, key],
      );

      const row = existing.rows[0];

      if (!row) {
        // Extremely unlikely race — treat as new and let the handler run.
        return { kind: 'new' };
      }

      if (row.fingerprint !== fingerprint) {
        return { kind: 'mismatch' };
      }

      if (row.status === 'in_progress') {
        return { kind: 'conflict' };
      }

      // status === 'completed'
      return {
        kind: 'replay',
        record: {
          status: row.response_status ?? 200,
          body: row.response_body,
        },
      };
    },

    async complete({ appId, key, status, body }): Promise<void> {
      await pool.query(
        `UPDATE idempotency_keys
         SET status = 'completed',
             response_status = $3,
             response_body = $4
         WHERE app_id = $1 AND idempotency_key = $2`,
        [appId, key, status, JSON.stringify(body)],
      );
    },
  };
}
