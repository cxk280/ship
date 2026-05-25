// Hybrid trigger model: in-process debounced mutation queue + node-cron sweep.
import cron from 'node-cron';
import { pool } from '../db/client.js';
import { runProactiveForEntity, runCronSweep, runDigest } from './runner.js';

const DEBOUNCE_MS = Number(process.env.FLEETGRAPH_DEBOUNCE_MS ?? 15_000);
const CRON_EXPR = process.env.FLEETGRAPH_CRON ?? '*/5 * * * *';
const DIGEST_CRON = process.env.FLEETGRAPH_DIGEST_CRON ?? '0 13 * * *'; // daily ~1pm UTC
const SWEEP_LOCK_KEY = 778_921; // arbitrary pg advisory-lock id so only one instance sweeps per tick
const DIGEST_LOCK_KEY = 778_922;

const pending = new Map<string, NodeJS.Timeout>();

/** Called from the issue PATCH post-commit hook. Debounced + non-blocking; never throws into the request. */
export function enqueueMutationRun(params: {
  workspaceId: string;
  entityId: string;
  entityType: string;
  changedFields?: string[];
}): void {
  if (process.env.FLEETGRAPH_DISABLED === '1' || process.env.NODE_ENV === 'test') return;
  const key = `${params.workspaceId}:${params.entityId}`;
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pending.delete(key);
    runProactiveForEntity(params).catch((e) => console.error('[FleetGraph] mutation run failed:', e));
  }, DEBOUNCE_MS);
  if (typeof t.unref === 'function') t.unref();
  pending.set(key, t);
}

async function listActiveWorkspaces(): Promise<string[]> {
  const r = await pool.query(
    `SELECT DISTINCT workspace_id FROM documents
     WHERE document_type = 'issue' AND deleted_at IS NULL AND archived_at IS NULL`,
  );
  return r.rows.map((x) => x.workspace_id);
}

let sweeping = false;
async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  const client = await pool.connect();
  let acquired = false;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [SWEEP_LOCK_KEY]);
    acquired = lock.rows[0]?.ok === true;
    if (!acquired) return; // another instance owns this tick
    const workspaces = await listActiveWorkspaces();
    for (const ws of workspaces) {
      await runCronSweep(ws).catch((e) => console.error('[FleetGraph] sweep failed for workspace', ws, e));
    }
  } finally {
    if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [SWEEP_LOCK_KEY]).catch(() => {});
    client.release();
    sweeping = false;
  }
}

let digesting = false;
async function digestSweep(): Promise<void> {
  if (digesting) return;
  digesting = true;
  const client = await pool.connect();
  let acquired = false;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [DIGEST_LOCK_KEY]);
    acquired = lock.rows[0]?.ok === true;
    if (!acquired) return; // another instance owns today's digest
    const workspaces = await listActiveWorkspaces();
    for (const ws of workspaces) {
      await runDigest(ws).catch((e) => console.error('[FleetGraph] digest failed for workspace', ws, e));
    }
  } finally {
    if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [DIGEST_LOCK_KEY]).catch(() => {});
    client.release();
    digesting = false;
  }
}

let started = false;
/** Wire up the proactive triggers. Called once at server startup. */
export function startFleetGraph(): void {
  if (started) return;
  started = true;
  if (process.env.FLEETGRAPH_DISABLED === '1') {
    console.log('[FleetGraph] disabled via FLEETGRAPH_DISABLED=1');
    return;
  }
  // Warm the checkpointer (creates its tables) without blocking startup.
  import('./checkpointer.js').then((m) => m.getCheckpointer()).catch((e) => console.error('[FleetGraph] checkpointer init failed:', e));
  cron.schedule(CRON_EXPR, () => {
    sweep().catch((e) => console.error('[FleetGraph] sweep error:', e));
  });
  cron.schedule(DIGEST_CRON, () => {
    digestSweep().catch((e) => console.error('[FleetGraph] digest error:', e));
  });
  console.log(`[FleetGraph] started (sweep='${CRON_EXPR}', digest='${DIGEST_CRON}', debounce=${DEBOUNCE_MS}ms)`);
}

/** Manual sweep entrypoint (used by tests / the timed latency check). */
export { sweep as runSweepNow };
