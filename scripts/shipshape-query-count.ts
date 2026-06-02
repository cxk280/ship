#!/usr/bin/env tsx
import crypto from 'crypto';
import request from 'supertest';
import { createApp } from '../api/src/app.js';
import { pool } from '../api/src/db/client.js';

const sessionId = `shipshape-${crypto.randomBytes(16).toString('hex')}`;
const endpoints = [
  '/api/auth/me',
  '/api/dashboard/my-week',
  '/api/standups/status',
  '/api/accountability/action-items',
];

type QueryRecord = {
  durationMs: number;
  sql: string;
};

const originalQuery = pool.query.bind(pool);
const records: QueryRecord[] = [];

pool.query = (async (...args: Parameters<typeof pool.query>) => {
  const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
  const started = performance.now();
  try {
    return await originalQuery(...args);
  } finally {
    records.push({
      durationMs: performance.now() - started,
      sql: sql.replace(/\s+/g, ' ').trim(),
    });
  }
}) as typeof pool.query;

async function main() {
  const userResult = await originalQuery(
    `SELECT u.id as user_id, wm.workspace_id
     FROM users u
     JOIN workspace_memberships wm ON wm.user_id = u.id
     WHERE u.email = $1
     LIMIT 1`,
    [process.env.SHIPSHAPE_EMAIL || 'dev@ship.local']
  );

  const user = userResult.rows[0];
  if (!user) {
    throw new Error('Seed user dev@ship.local was not found. Run api db:seed first.');
  }

  await originalQuery(
    `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity, created_at)
     VALUES ($1, $2, $3, NOW() + interval '15 minutes', NOW(), NOW())`,
    [sessionId, user.user_id, user.workspace_id]
  );

  const app = createApp('http://localhost:5173');
  const agent = request(app);
  const perEndpoint: Array<{ endpoint: string; status: number; queries: number; slowestMs: number }> = [];

  for (const endpoint of endpoints) {
    const before = records.length;
    const response = await agent.get(endpoint).set('Cookie', `session_id=${sessionId}`);
    const endpointRecords = records.slice(before);
    perEndpoint.push({
      endpoint,
      status: response.status,
      queries: endpointRecords.length,
      slowestMs: Math.round(Math.max(0, ...endpointRecords.map(record => record.durationMs)) * 100) / 100,
    });
  }

  const measuredRecords = records.filter(record => !record.sql.startsWith('INSERT INTO sessions'));
  const slowest = [...measuredRecords].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);

  const baselineQueries = 33;
  // PRD perf budget: per-route query counts must stay within +10% of the Part-1 baseline.
  const ceiling = Math.ceil(baselineQueries * 1.1);
  const totalQueries = perEndpoint.reduce((sum, endpoint) => sum + endpoint.queries, 0);

  console.log(JSON.stringify({
    flow: endpoints,
    totalQueries,
    baselineQueries,
    ceiling,
    targetQueries: 26,
    perEndpoint,
    slowest: slowest.map(record => ({
      durationMs: Math.round(record.durationMs * 100) / 100,
      sql: record.sql.slice(0, 240),
    })),
  }, null, 2));

  if (totalQueries > ceiling) {
    console.error(
      `\n❌ Query-count regression: ${totalQueries} queries exceeds the +10% budget (${ceiling}, baseline ${baselineQueries}).`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\n✓ Query count ${totalQueries} within budget (≤ ${ceiling}).`);
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await originalQuery('DELETE FROM sessions WHERE id = $1', [sessionId]);
    await pool.end();
    process.exit(process.exitCode ?? 0);
  });
