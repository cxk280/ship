/**
 * Concrete AuditPort — writes a row to audit_logs for every public API call.
 *
 * Lives under platform/adapters, so it MAY import internal modules (db pool,
 * internal audit service). The sealed v1 layer only sees the AuditPort interface.
 *
 * record() is fire-and-forget: the INSERT is issued asynchronously; any error is
 * logged server-side and never propagated to the caller.
 */
import { pool } from '../../db/client.js';
import type { AuditPort, ApiCallAudit } from '../api/v1/ports.js';

export function createAuditAdapter(): AuditPort {
  return {
    record(entry: ApiCallAudit): void {
      // Fire-and-forget: do not await, do not throw.
      setImmediate(() => {
        pool
          .query(
            `INSERT INTO audit_logs
               (workspace_id, actor_user_id, action, resource_type, resource_id, details, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              entry.workspaceId ?? null,
              entry.userId ?? null,
              'api.v1.call',
              'api_route',
              null, // resource_id not applicable for a route-level entry
              JSON.stringify({
                request_id: entry.requestId,
                method: entry.method,
                route: entry.route,
                status: entry.status,
                latency_ms: entry.latencyMs,
                scope: entry.scope,
                app_id: entry.appId,
                client_id: entry.clientId,
              }),
              entry.ip ?? null,
              entry.userAgent ?? null,
            ],
          )
          .catch((err: unknown) => {
            // Audit failures must never surface to callers.
            console.error('[audit] failed to write api.v1.call row:', err);
          });
      });
    },
  };
}
