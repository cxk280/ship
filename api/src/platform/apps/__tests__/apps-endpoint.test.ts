/**
 * OAuth app registration endpoint (MVP gate #1): an authenticated user can
 * create an app, gets a client_id + a raw client_secret shown EXACTLY ONCE
 * (only the bcrypt hash is stored), and can rotate the secret.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { pool } from '../../../db/client.js';
import { createAppsRouter } from '../routes.js';

let token: string;

function testApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/oauth/apps', createAppsRouter());
  return a;
}

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('Apps Test WS') RETURNING id`);
  const workspaceId = ws.rows[0].id;
  const u = await pool.query(
    `INSERT INTO users (email, name) VALUES ('apps-test@example.com', 'Apps Tester') RETURNING id`,
  );
  const userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'admin')`,
    [workspaceId, userId],
  );
  // Internal API token so authMiddleware authenticates the test caller.
  token = `ship_${crypto.randomBytes(16).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix)
     VALUES ($1,$2,'apps-test',$3,$4)`,
    [userId, workspaceId, crypto.createHash('sha256').update(token).digest('hex'), token.slice(0, 12)],
  );
});

describe('POST /api/oauth/apps', () => {
  it('registers an app and shows the raw client_secret exactly once', async () => {
    const res = await request(testApp())
      .post('/api/oauth/apps')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'My Integration',
        redirect_uris: ['https://example.com/cb'],
        requested_scopes: ['documents:read'],
        app_type: 'confidential',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.client_id).toMatch(/^ship_app_/);
    expect(res.body.data.client_secret).toMatch(/^ship_secret_/);
    expect(res.body.data.warning).toContain('not be shown again');

    // The raw secret is NOT stored — only a bcrypt hash.
    const row = await pool.query('SELECT client_secret_hash FROM oauth_apps WHERE client_id = $1', [
      res.body.data.client_id,
    ]);
    expect(row.rows[0].client_secret_hash).toMatch(/^\$2[aby]\$/); // bcrypt
    expect(row.rows[0].client_secret_hash).not.toContain(res.body.data.client_secret);
  });

  it('rejects an unknown scope', async () => {
    const res = await request(testApp())
      .post('/api/oauth/apps')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad', requested_scopes: ['documents:delete'] });
    expect(res.status).toBe(400);
  });

  it('rotates the secret (new value shown once)', async () => {
    const created = await request(testApp())
      .post('/api/oauth/apps')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Rotate Me', requested_scopes: ['documents:read'] });
    const id = created.body.data.id;
    const first = created.body.data.client_secret;

    const rotated = await request(testApp())
      .post(`/api/oauth/apps/${id}/rotate-secret`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.client_secret).toMatch(/^ship_secret_/);
    expect(rotated.body.data.client_secret).not.toBe(first);
  });

  it('requires authentication', async () => {
    const res = await request(testApp()).post('/api/oauth/apps').send({ name: 'x' });
    expect(res.status).toBe(401);
  });
});
