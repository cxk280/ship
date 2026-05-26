#!/usr/bin/env node
import { createRequire } from 'module';

const require = createRequire(new URL('../api/package.json', import.meta.url));
const pg = require('pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const targetWikiCount = Number(process.env.SHIPSHAPE_WIKI_COUNT || 550);
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl });

try {
  const workspaceResult = await pool.query(
    `SELECT id FROM workspaces ORDER BY created_at LIMIT 1`
  );
  const workspaceId = workspaceResult.rows[0]?.id;
  if (!workspaceId) {
    throw new Error('No workspace found. Run db:seed first.');
  }

  const userResult = await pool.query(
    `SELECT id FROM users WHERE email = 'dev@ship.local' LIMIT 1`
  );
  const userId = userResult.rows[0]?.id ?? null;

  const existingResult = await pool.query(
    `SELECT COUNT(*)::int as count
     FROM documents
     WHERE workspace_id = $1
       AND document_type = 'wiki'
       AND deleted_at IS NULL
       AND archived_at IS NULL`,
    [workspaceId]
  );
  const existingWikiCount = existingResult.rows[0]?.count ?? 0;
  const rowsToAdd = Math.max(0, targetWikiCount - existingWikiCount);

  if (rowsToAdd > 0) {
    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, parent_id, position, created_by, properties, content)
       SELECT
         $1,
         'wiki',
         'Audit Benchmark Wiki ' || gs,
         NULL,
         gs,
         $2,
         jsonb_build_object(
           'audit_seed', true,
           'owner', 'ShipShape',
           'tags', jsonb_build_array('benchmark', 'wiki', 'navigation'),
           'large_field', repeat('payload ', 35)
         ),
         jsonb_build_object(
           'type', 'doc',
           'content', jsonb_build_array(
             jsonb_build_object(
               'type', 'paragraph',
               'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', repeat('Benchmark content ', 20)))
             )
           )
         )
       FROM generate_series(1, $3) gs`,
      [workspaceId, userId, rowsToAdd]
    );
  }

  const finalResult = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE document_type = 'wiki')::int as wiki_count,
       COUNT(*) FILTER (WHERE document_type = 'issue')::int as issue_count,
       COUNT(*) FILTER (WHERE document_type = 'sprint')::int as sprint_count,
       COUNT(*) FILTER (WHERE document_type = 'person')::int as person_count
     FROM documents
     WHERE workspace_id = $1
       AND deleted_at IS NULL
       AND archived_at IS NULL`,
    [workspaceId]
  );

  console.log(JSON.stringify({
    workspaceId,
    targetWikiCount,
    rowsAdded: rowsToAdd,
    ...finalResult.rows[0],
  }, null, 2));
} finally {
  await pool.end();
}
