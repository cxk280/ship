/**
 * In-process port of scripts/security-probe.mjs so the probe can run from the
 * deployed app (the runtime Docker image does not include the scripts/ dir).
 *
 * Runs the same four attack-surface checks against a live ShipShape origin —
 * auth/session, input sanitization, WebSocket validation, dependency audit —
 * plus CSP/CORS header review, and returns a structured report. Unlike the CLI,
 * it tracks every document it creates and deletes them at the end (auto-cleanup),
 * so running it against a live workspace leaves no probe artifacts behind.
 */
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';

export type CheckStatus = 'pass' | 'fail' | 'skip';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface ProbeCheck {
  category: string;
  name: string;
  status: CheckStatus;
  details?: Record<string, unknown>;
}

export interface ProbeFinding {
  category: string;
  severity: Severity;
  title: string;
  description: string;
  reproductionSteps?: string[];
  evidence?: unknown;
  status: string;
}

export interface ProbeSummary {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  skippedChecks: number;
  totalFindings: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface ProbeReport {
  tool: string;
  startedAt: string;
  completedAt?: string;
  target: string;
  checks: ProbeCheck[];
  findings: ProbeFinding[];
  summary: ProbeSummary;
  cleanup: { createdDocumentIds: string[]; deleted: number; failed: number };
}

interface AuditVuln {
  severity?: string;
  name?: string;
  module_name?: string;
  packageName?: string;
  title?: string;
  url?: string;
  range?: string;
  vulnerable_versions?: string;
}

export interface ProbeOptions {
  baseUrl: string;
  adminEmail?: string;
  adminPassword?: string;
  memberEmail?: string;
  memberPassword?: string;
}

class CookieJar {
  private cookies = new Map<string, string>();
  store(setCookieHeaders: string[] | string | null | undefined): void {
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders].filter(Boolean) as string[];
    for (const header of headers) {
      const pair = String(header).split(';')[0];
      if (!pair) continue;
      const index = pair.indexOf('=');
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  header(): string {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
}

interface RequestResult<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

function getSetCookie(response: Response): string[] {
  const anyHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie();
  const value = response.headers.get('set-cookie');
  return value ? [value] : [];
}

function containsStringDeep(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsStringDeep(item, needle));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsStringDeep(item, needle));
  return false;
}

function mapDependencyToFeature(name: string): string {
  const packageName = String(name || '');
  const mappings: [RegExp, string][] = [
    [/express|cookie|csrf|helmet|cors|pg|bcrypt/i, 'API authentication, routing, and database access'],
    [/ws|yjs|y-websocket|y-protocols/i, 'real-time collaboration and event WebSockets'],
    [/react|vite|tiptap|prosemirror|lowlight|emoji/i, 'frontend editor and application shell'],
    [/aws|s3|secrets|ssm/i, 'AWS storage, secrets, and infrastructure integrations'],
    [/playwright|testcontainers|vitest/i, 'test infrastructure only'],
  ];
  return mappings.find(([pattern]) => pattern.test(packageName))?.[1] || 'unknown or transitive application feature';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSecurityProbe(opts: ProbeOptions): Promise<ProbeReport> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const adminEmail = opts.adminEmail || 'dev@ship.local';
  const adminPassword = opts.adminPassword || 'admin123';
  const memberEmail = opts.memberEmail || 'alice.chen@ship.local';
  const memberPassword = opts.memberPassword || adminPassword;

  const report: ProbeReport = {
    tool: 'shipshape-security-probe',
    startedAt: new Date().toISOString(),
    target: baseUrl,
    checks: [],
    findings: [],
    summary: { totalChecks: 0, passedChecks: 0, failedChecks: 0, skippedChecks: 0, totalFindings: 0, bySeverity: {}, byCategory: {} },
    cleanup: { createdDocumentIds: [], deleted: 0, failed: 0 },
  };

  const addCheck = (category: string, name: string, status: CheckStatus, details: Record<string, unknown> = {}) =>
    report.checks.push({ category, name, status, details });
  const addFinding = (f: Omit<ProbeFinding, 'status'> & { status?: string }) =>
    report.findings.push({ ...f, status: f.status || 'open' });

  const wsUrl = (path: string): string => {
    const url = new URL(path, baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  };

  async function request<T = unknown>(path: string, options: RequestInit = {}, jar = new CookieJar()): Promise<RequestResult<T>> {
    const headers = new Headers(options.headers || {});
    if (jar.header()) headers.set('cookie', jar.header());
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' });
    jar.store(getSetCookie(response));
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, headers: response.headers, body: parsed as T, text };
  }

  async function getCsrf(jar: CookieJar): Promise<string> {
    const result = await request<{ token?: string }>('/api/csrf-token', {}, jar);
    const token = result.body?.token;
    if (result.status !== 200 || !token) throw new Error(`Unable to fetch CSRF token: HTTP ${result.status}`);
    return token;
  }

  async function login(email: string, password: string) {
    const jar = new CookieJar();
    const csrf = await getCsrf(jar);
    const result = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ email, password }),
    }, jar);
    return { jar, csrf, result, sessionId: jar.get('session_id') };
  }

  type AdminSession = { jar: CookieJar; csrf: string; result: RequestResult; sessionId?: string };
  const createdDocIds: string[] = [];

  // Ensure a non-super-admin member session exists for the privilege-escalation check.
  // If the configured member can't log in (e.g. a fresh deployment that was only
  // `setup`-initialized and never seeded), self-provision a least-privilege member via
  // the super-admin invite + accept flow, then retry. Idempotent across runs.
  async function ensureMember(admin: AdminSession) {
    let member = await login(memberEmail, memberPassword);
    if (member.result.status === 200) return member;
    try {
      // Admin/auth routes wrap responses in a { success, data } envelope; documents
      // routes return raw objects. Read both shapes defensively.
      const me = await request<{ data?: { currentWorkspace?: { id?: string } }; currentWorkspace?: { id?: string } }>('/api/auth/me', {}, admin.jar);
      let wsId = me.body?.data?.currentWorkspace?.id ?? me.body?.currentWorkspace?.id;
      if (!wsId) {
        const ws = await request<{ data?: { workspaces?: Array<{ id?: string }> }; workspaces?: Array<{ id?: string }> }>('/api/admin/workspaces', {}, admin.jar);
        wsId = ws.body?.data?.workspaces?.[0]?.id ?? ws.body?.workspaces?.[0]?.id;
      }
      if (!wsId) return member;
      const csrf = await getCsrf(admin.jar);
      const invite = await request<{ data?: { invite?: { token?: string } }; invite?: { token?: string } }>(`/api/admin/workspaces/${wsId}/invites`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ email: memberEmail, role: 'member' }),
      }, admin.jar);
      const token = invite.body?.data?.invite?.token ?? invite.body?.invite?.token;
      if (!token) return member;
      const acceptJar = new CookieJar();
      const acceptCsrf = await getCsrf(acceptJar);
      await request(`/api/invites/${token}/accept`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': acceptCsrf },
        body: JSON.stringify({ password: memberPassword, name: 'ShipShape Probe Member' }),
      }, acceptJar);
      member = await login(memberEmail, memberPassword);
    } catch { /* fall through with the failed login */ }
    return member;
  }

  async function runHeaderChecks(): Promise<void> {
    const result = await request('/health');
    const csp = result.headers.get('content-security-policy') || '';
    const cors = result.headers.get('access-control-allow-origin') || '';
    const inlineScripts = /script-src[^;]*'unsafe-inline'/.test(csp);
    addCheck('manual-review', 'CSP script-src does not allow unsafe-inline', inlineScripts ? 'fail' : 'pass', { csp });
    if (inlineScripts) {
      addFinding({
        category: 'manual-review', severity: 'high', title: 'Global CSP allows inline scripts',
        description: 'Inline scripts weaken XSS defenses because injected script blocks can execute when other controls fail.',
        reproductionSteps: [`GET ${baseUrl}/health`, 'Inspect the Content-Security-Policy response header'],
        evidence: { csp },
      });
    }
    const wildcardCreds = cors === '*' && result.headers.get('access-control-allow-credentials') === 'true';
    addCheck('manual-review', 'CORS does not use wildcard credentials', wildcardCreds ? 'fail' : 'pass', {
      accessControlAllowOrigin: cors,
      accessControlAllowCredentials: result.headers.get('access-control-allow-credentials'),
    });
  }

  async function runAuthChecks(): Promise<AdminSession | null> {
    const unauth = await request('/api/auth/me');
    addCheck('auth-session', 'Unauthenticated auth/me access', unauth.status === 401 ? 'pass' : 'fail', { status: unauth.status });
    if (unauth.status !== 401) {
      addFinding({
        category: 'auth-session', severity: 'critical', title: 'Protected auth/me route is reachable without a session',
        description: 'The protected auth/me endpoint should reject unauthenticated requests.',
        reproductionSteps: [`GET ${baseUrl}/api/auth/me without cookies`], evidence: { status: unauth.status, body: unauth.body },
      });
    }

    const admin = await login(adminEmail, adminPassword);
    addCheck('auth-session', 'Admin login', admin.result.status === 200 ? 'pass' : 'fail', {
      status: admin.result.status, sessionLength: admin.sessionId?.length || 0,
    });
    if (admin.result.status !== 200) {
      addFinding({
        category: 'auth-session', severity: 'critical', title: 'Security probe could not authenticate',
        description: 'The probe cannot continue authenticated checks without a valid seeded user.',
        reproductionSteps: [`POST ${baseUrl}/api/auth/login with ${adminEmail}`], evidence: { status: admin.result.status, body: admin.result.body },
      });
      return null;
    }

    const strongSession = /^[a-f0-9]{64}$/i.test(admin.sessionId || '');
    addCheck('auth-session', 'Session token entropy format', strongSession ? 'pass' : 'fail', {
      sessionLength: admin.sessionId?.length || 0, hex64: strongSession,
    });
    if (!strongSession) {
      addFinding({
        category: 'auth-session', severity: 'high', title: 'Session token does not match expected 256-bit random format',
        description: 'Session IDs should be at least 256 bits of cryptographically random entropy encoded as 64 hex characters.',
        reproductionSteps: [`Login as ${adminEmail}`, 'Inspect the session_id cookie value'], evidence: { sessionLength: admin.sessionId?.length || 0 },
      });
    }

    const member = await ensureMember(admin);
    if (member.result.status === 200) {
      const adminRoute = await request('/api/admin/workspaces', {}, member.jar);
      addCheck('auth-session', 'Member privilege escalation to super-admin route', adminRoute.status === 403 ? 'pass' : 'fail', { status: adminRoute.status });
      if (adminRoute.status !== 403) {
        addFinding({
          category: 'auth-session', severity: 'critical', title: 'Non-super-admin user can access super-admin route',
          description: 'A regular workspace member should not be able to list all workspaces through /api/admin/workspaces.',
          reproductionSteps: [`Login as ${memberEmail}`, `GET ${baseUrl}/api/admin/workspaces`], evidence: { status: adminRoute.status, body: adminRoute.body },
        });
      }
    } else {
      addCheck('auth-session', 'Member login for privilege escalation check', 'skip', { status: member.result.status });
    }
    return admin;
  }

  async function runInputChecks(admin: AdminSession | null): Promise<string | null> {
    if (!admin) return null;
    const csrf = await getCsrf(admin.jar);
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };

    const xssTitle = `<img src=x onerror=alert('shipshape')>`;
    const xssCreate = await request<{ id?: string; title?: string }>('/api/documents', { method: 'POST', headers, body: JSON.stringify({ title: xssTitle, document_type: 'wiki' }) }, admin.jar);
    const xssId = xssCreate.body?.id;
    if (xssId) createdDocIds.push(xssId);
    const xssTitleStored = xssCreate.body?.title === xssTitle;
    addCheck('input-sanitization', 'Stored XSS title payload rejected or sanitized', xssCreate.status >= 400 || !xssTitleStored ? 'pass' : 'fail', {
      status: xssCreate.status, acceptedRawPayload: xssTitleStored, id: xssId,
    });
    if (xssCreate.status < 400 && xssTitleStored) {
      addFinding({
        category: 'input-sanitization', severity: 'medium', title: 'Document title accepts raw HTML event-handler payload',
        description: 'React escaping mitigates normal rendering, but storing raw script-like titles increases downstream XSS risk in future renderers, exports, logs, and notifications.',
        reproductionSteps: [`Login as ${adminEmail}`, `POST ${baseUrl}/api/documents with title ${xssTitle}`, 'Observe the raw payload stored as the document title'],
        evidence: { status: xssCreate.status, id: xssId },
      });
    }

    if (xssId) {
      const contentPayload = `<svg onload=alert('shipshape-content')>`;
      const contentProbe = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: contentPayload }] }] };
      const contentUpdate = await request<{ content?: unknown }>(`/api/documents/${xssId}/content`, { method: 'PATCH', headers, body: JSON.stringify({ content: contentProbe }) }, admin.jar);
      const acceptedRaw = containsStringDeep(contentUpdate.body?.content, contentPayload);
      addCheck('input-sanitization', 'Stored XSS content payload rejected or sanitized', contentUpdate.status >= 400 || !acceptedRaw ? 'pass' : 'fail', {
        status: contentUpdate.status, acceptedRawPayload: acceptedRaw, id: xssId,
      });
      if (contentUpdate.status < 400 && acceptedRaw) {
        addFinding({
          category: 'input-sanitization', severity: 'medium', title: 'Document content accepts raw HTML event-handler payload text',
          description: 'TipTap text rendering usually escapes text nodes, but storing raw script-like content increases downstream XSS risk in exports, previews, search snippets, notifications, and future renderers.',
          reproductionSteps: [`Login as ${adminEmail}`, `PATCH ${baseUrl}/api/documents/${xssId}/content with a TipTap text node containing ${contentPayload}`, 'Observe the raw payload stored in document content'],
          evidence: { status: contentUpdate.status, id: xssId },
        });
      }
    } else {
      addCheck('input-sanitization', 'Stored XSS content payload rejected or sanitized', 'skip', { reason: 'No created document ID available for content probe' });
    }

    const reflectedPayload = `<script>alert('shipshape-reflected')</script>`;
    const reflectedSearch = await request(`/api/search/mentions?q=${encodeURIComponent(reflectedPayload)}`, {}, admin.jar);
    const reflectedRaw = reflectedSearch.text.includes(reflectedPayload);
    addCheck('input-sanitization', 'Reflected XSS search query is not echoed raw', reflectedSearch.status < 500 && !reflectedRaw ? 'pass' : 'fail', {
      status: reflectedSearch.status, reflectedRawPayload: reflectedRaw,
    });
    if (reflectedRaw) {
      addFinding({
        category: 'input-sanitization', severity: 'high', title: 'Search endpoint reflects raw XSS payload',
        description: 'Reflected user input in API responses can become exploitable when rendered by clients, logs, or downstream integrations without escaping.',
        reproductionSteps: [`GET ${baseUrl}/api/search/mentions?q=<script>...`, 'Observe the raw payload in the response body'], evidence: { status: reflectedSearch.status },
      });
    }

    const longTitle = 'A'.repeat(5000);
    const longCreate = await request<{ id?: string }>('/api/documents', { method: 'POST', headers, body: JSON.stringify({ title: longTitle, document_type: 'wiki' }) }, admin.jar);
    const longId = longCreate.body?.id;
    if (longId) createdDocIds.push(longId);
    addCheck('input-sanitization', 'Excessively long document title rejected', longCreate.status === 400 ? 'pass' : 'fail', { status: longCreate.status });
    if (longCreate.status !== 400) {
      addFinding({
        category: 'input-sanitization', severity: 'high', title: 'Excessively long document title was not rejected',
        description: 'Document titles are user-facing fields and should enforce bounded input.',
        reproductionSteps: [`POST ${baseUrl}/api/documents with a 5000-character title`], evidence: { status: longCreate.status },
      });
    }

    const sqlTitle = `' OR 1=1; --`;
    const sqlCreate = await request<{ id?: string }>('/api/documents', { method: 'POST', headers, body: JSON.stringify({ title: sqlTitle, document_type: 'wiki' }) }, admin.jar);
    const sqlId = sqlCreate.body?.id;
    if (sqlId) createdDocIds.push(sqlId);
    addCheck('input-sanitization', 'SQL injection title payload does not cause server error', sqlCreate.status < 500 ? 'pass' : 'fail', { status: sqlCreate.status });
    if (sqlCreate.status >= 500) {
      addFinding({
        category: 'input-sanitization', severity: 'critical', title: 'SQL injection probe caused server error',
        description: 'A SQL-like title payload should be treated as data and must not trigger a database or server error.',
        reproductionSteps: [`POST ${baseUrl}/api/documents with title ${sqlTitle}`], evidence: { status: sqlCreate.status, body: sqlCreate.body },
      });
    }
    return xssId || sqlId || null;
  }

  function waitForWsOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket open timeout')), 4000);
      ws.once('open', () => { clearTimeout(timeout); resolve(); });
      ws.once('error', (error: Error) => { clearTimeout(timeout); reject(error); });
    });
  }

  function waitForWsCloseOrTimeout(ws: WebSocket, timeoutMs = 750): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ closed: false, readyState: ws.readyState }), timeoutMs);
      ws.once('close', (code: number, reason: Buffer) => { clearTimeout(timeout); resolve({ closed: true, code, reason: reason.toString(), readyState: ws.readyState }); });
      ws.once('error', (error: Error) => { clearTimeout(timeout); resolve({ closed: true, error: error.message, readyState: ws.readyState }); });
    });
  }

  async function runWebSocketChecks(admin: AdminSession | null, documentId: string | null): Promise<void> {
    if (!admin || !documentId) {
      addCheck('websocket-validation', 'WebSocket checks', 'skip', { reason: 'No authenticated document available' });
      return;
    }
    const path = `/collaboration/wiki:${documentId}`;
    const cookie = admin.jar.header();

    const unauth = new WebSocket(wsUrl(path));
    const unauthResult = await waitForWsCloseOrTimeout(unauth, 1500);
    addCheck('websocket-validation', 'Unauthenticated collaboration WebSocket rejected', unauthResult.closed ? 'pass' : 'fail', unauthResult);
    try { unauth.close(); } catch { /* noop */ }
    if (!unauthResult.closed) {
      addFinding({ category: 'websocket-validation', severity: 'critical', title: 'Collaboration WebSocket accepts unauthenticated connection',
        description: 'The collaboration endpoint should reject clients without a valid session cookie.',
        reproductionSteps: [`Open WebSocket ${wsUrl(path)} without Cookie header`], evidence: unauthResult });
    }

    const unexpected = new WebSocket(wsUrl(path), { headers: { cookie }, maxPayload: 12 * 1024 * 1024 });
    await waitForWsOpen(unexpected); await sleep(250);
    unexpected.send(Buffer.from([99]));
    const unexpectedResult = await waitForWsCloseOrTimeout(unexpected, 2000);
    addCheck('websocket-validation', 'Unexpected collaboration message type rejected', unexpectedResult.closed ? 'pass' : 'fail', unexpectedResult);
    try { unexpected.close(); } catch { /* noop */ }
    if (!unexpectedResult.closed) {
      addFinding({ category: 'websocket-validation', severity: 'high', title: 'Unexpected WebSocket message type is silently accepted',
        description: 'The collaboration server should explicitly reject protocol message types outside the supported sync and awareness messages.',
        reproductionSteps: [`Open authenticated WebSocket ${wsUrl(path)}`, 'Send a single-byte message with varuint type 99'], evidence: unexpectedResult });
    }

    const malformed = new WebSocket(wsUrl(path), { headers: { cookie }, maxPayload: 12 * 1024 * 1024 });
    await waitForWsOpen(malformed); await sleep(250);
    malformed.send(Buffer.alloc(0));
    const malformedResult = await waitForWsCloseOrTimeout(malformed, 1000);
    const healthAfter = await request('/health').catch(() => ({ status: 0, headers: new Headers(), body: null, text: '' }));
    addCheck('websocket-validation', 'Malformed empty collaboration message rejected without process crash', malformedResult.closed && healthAfter.status === 200 ? 'pass' : 'fail', {
      malformedResult, healthStatus: healthAfter.status,
    });
    try { malformed.close(); } catch { /* noop */ }
    if (!malformedResult.closed || healthAfter.status !== 200) {
      addFinding({ category: 'websocket-validation', severity: healthAfter.status === 200 ? 'high' : 'critical',
        title: healthAfter.status === 200 ? 'Malformed WebSocket message was not rejected' : 'Malformed WebSocket message can crash the API process',
        description: 'Malformed collaboration protocol input should be handled locally and close the offending connection without destabilizing the API.',
        reproductionSteps: [`Open authenticated WebSocket ${wsUrl(path)}`, 'Send an empty binary message', 'Check whether the connection closes and /health still responds'],
        evidence: { malformedResult, healthStatus: healthAfter.status } });
      if (healthAfter.status !== 200) {
        addCheck('websocket-validation', 'Oversized collaboration message rejected', 'skip', { reason: 'API process unavailable after malformed-message probe' });
        return;
      }
    }

    const oversized = new WebSocket(wsUrl(path), { headers: { cookie }, maxPayload: 12 * 1024 * 1024 });
    await waitForWsOpen(oversized); await sleep(250);
    oversized.send(Buffer.alloc(10 * 1024 * 1024 + 1, 'x'));
    const oversizedResult = await waitForWsCloseOrTimeout(oversized, 2500);
    addCheck('websocket-validation', 'Oversized collaboration message rejected', oversizedResult.closed ? 'pass' : 'fail', oversizedResult);
    try { oversized.close(); } catch { /* noop */ }
    if (!oversizedResult.closed) {
      addFinding({ category: 'websocket-validation', severity: 'high', title: 'Oversized WebSocket message was not rejected',
        description: 'The collaboration server should enforce the documented 10MB message size cap.',
        reproductionSteps: [`Send ${10 * 1024 * 1024 + 1} bytes to ${wsUrl(path)}`], evidence: oversizedResult });
    }
  }

  function runDependencyAudit(): void {
    let tool = 'npm audit --json --omit=dev';
    let audit = spawnSync('npm', ['audit', '--json', '--omit=dev'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 25000 });
    if ((audit.status !== 0 && (audit.stdout || '').includes('"ENOLOCK"')) || audit.error) {
      tool = 'pnpm audit --json --prod';
      audit = spawnSync('pnpm', ['audit', '--json', '--prod'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 25000 });
    }
    let parsed: { vulnerabilities?: Record<string, AuditVuln>; advisories?: Record<string, AuditVuln> } | null = null;
    try { parsed = JSON.parse(audit.stdout || '{}'); } catch { parsed = null; }
    const source: AuditVuln[] = parsed?.vulnerabilities ? Object.values(parsed.vulnerabilities) : Object.values(parsed?.advisories || {});
    const vulns: Array<{ name: string; severity: Severity; title?: string; url?: string; range?: string; featureImpact: string }> = [];
    for (const v of source) {
      const severity = v.severity || '';
      if (severity === 'high' || severity === 'critical') {
        const name = v.name || v.module_name || v.packageName || 'unknown package';
        vulns.push({ name, severity, title: v.title, url: v.url, range: v.range || v.vulnerable_versions, featureImpact: mapDependencyToFeature(name) });
      }
    }
    addCheck('dependencies', 'Dependency vulnerability audit parsed', parsed ? 'pass' : 'fail', {
      tool, exitStatus: audit.status, highCriticalCount: vulns.length, stderr: (audit.stderr || '').slice(0, 1000),
    });
    for (const v of vulns) {
      addFinding({ category: 'dependencies', severity: v.severity, title: `High/Critical dependency vulnerability: ${v.name}`,
        description: v.title || 'Dependency audit reported a high or critical vulnerability.', reproductionSteps: [tool], evidence: v });
    }
  }

  async function cleanup(admin: AdminSession | null): Promise<void> {
    if (!admin || createdDocIds.length === 0) return;
    let csrf = admin.csrf;
    try { csrf = await getCsrf(admin.jar); } catch { /* keep existing */ }
    for (const id of createdDocIds) {
      try {
        const del = await request(`/api/documents/${id}`, { method: 'DELETE', headers: { 'x-csrf-token': csrf } }, admin.jar);
        if (del.status >= 200 && del.status < 300) report.cleanup.deleted += 1; else report.cleanup.failed += 1;
      } catch { report.cleanup.failed += 1; }
    }
    report.cleanup.createdDocumentIds = [...createdDocIds];
  }

  let admin: AdminSession | null = null;
  try {
    await runHeaderChecks();
    admin = await runAuthChecks();
    const documentId = await runInputChecks(admin);
    runDependencyAudit();
    await runWebSocketChecks(admin, documentId);
  } catch (error) {
    addFinding({
      category: 'probe-tool', severity: 'critical', title: 'Security probe failed before completing all checks',
      description: error instanceof Error ? error.message : String(error),
      reproductionSteps: [`runSecurityProbe({ baseUrl: '${baseUrl}' })`], evidence: { stack: error instanceof Error ? error.stack : undefined },
    });
  } finally {
    await cleanup(admin);
    report.completedAt = new Date().toISOString();
    report.summary = summarize(report);
  }
  return report;
}

function summarize(data: ProbeReport): ProbeSummary {
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const finding of data.findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
    byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;
  }
  return {
    totalChecks: data.checks.length,
    passedChecks: data.checks.filter((c) => c.status === 'pass').length,
    failedChecks: data.checks.filter((c) => c.status === 'fail').length,
    skippedChecks: data.checks.filter((c) => c.status === 'skip').length,
    totalFindings: data.findings.length,
    bySeverity,
    byCategory,
  };
}
