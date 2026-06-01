/**
 * Lightweight Ship-session resolver for the OAuth consent surface.
 *
 * The /oauth/authorize and device-verification pages authenticate a *Ship user*
 * (session cookie) — distinct from the bearer auth that guards /api/v1. Returns
 * null instead of throwing so the route can redirect an anonymous user to login.
 */
import type { Request } from 'express';
import { pool } from '../../db/client.js';
import { SESSION_TIMEOUT_MS, ABSOLUTE_SESSION_TIMEOUT_MS } from '@ship/shared';

export interface SessionUser {
  userId: string;
  workspaceId: string;
}

export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const sessionId = req.cookies?.session_id;
  if (!sessionId) return null;

  const r = await pool.query(
    'SELECT user_id, workspace_id, last_activity, created_at FROM sessions WHERE id = $1',
    [sessionId],
  );
  const s = r.rows[0];
  if (!s) return null;

  const now = Date.now();
  if (now - new Date(s.created_at).getTime() > ABSOLUTE_SESSION_TIMEOUT_MS) return null;
  if (now - new Date(s.last_activity).getTime() > SESSION_TIMEOUT_MS) return null;

  return { userId: s.user_id, workspaceId: s.workspace_id };
}
