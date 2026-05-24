import { Router, Request, Response } from 'express';
import { authMiddleware, superAdminMiddleware } from '../middleware/auth.js';
import { runSecurityProbe } from '../services/securityProbe.js';

const router = Router();

// All security-probe routes require an authenticated super-admin.
router.use(authMiddleware, superAdminMiddleware);

// Prevent overlapping probe runs (each run opens WebSockets, creates docs, and
// shells out to the dependency audit — one at a time is plenty for an admin tool).
let running = false;

/**
 * Resolve the app's OWN origin to probe. Never user-supplied (no SSRF):
 * prefer Railway's injected public domain, else derive from the request host.
 */
function resolveSelfOrigin(req: Request): string {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.SHIP_SECURITY_BASE_URL) return process.env.SHIP_SECURITY_BASE_URL;
  const proto = req.protocol || 'http';
  const host = req.get('host') || `localhost:${process.env.PORT || 3000}`;
  return `${proto}://${host}`;
}

// POST /api/security-probe/run — run the full probe against this app's own origin.
router.post('/run', async (req: Request, res: Response): Promise<void> => {
  if (running) {
    res.status(409).json({ error: 'A security probe run is already in progress. Try again shortly.' });
    return;
  }
  running = true;
  const target = resolveSelfOrigin(req);
  try {
    const report = await runSecurityProbe({
      baseUrl: target,
      adminEmail: process.env.SHIP_SECURITY_EMAIL,
      adminPassword: process.env.SHIP_SECURITY_PASSWORD,
      memberEmail: process.env.SHIP_SECURITY_MEMBER_EMAIL,
      memberPassword: process.env.SHIP_SECURITY_MEMBER_PASSWORD,
    });
    res.json(report);
  } catch (err) {
    console.error('Security probe run failed:', err);
    res.status(500).json({ error: 'Security probe failed to run', detail: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
});

export default router;
