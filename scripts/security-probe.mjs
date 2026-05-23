#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';

const args = parseArgs(process.argv.slice(2));
const baseUrl = stripTrailingSlash(args['base-url'] || process.env.SHIP_SECURITY_BASE_URL || 'http://127.0.0.1:3000');
const adminEmail = args.email || process.env.SHIP_SECURITY_EMAIL || 'dev@ship.local';
const adminPassword = args.password || process.env.SHIP_SECURITY_PASSWORD || 'admin123';
const memberEmail = args['member-email'] || process.env.SHIP_SECURITY_MEMBER_EMAIL || 'alice.chen@ship.local';
const memberPassword = args['member-password'] || process.env.SHIP_SECURITY_MEMBER_PASSWORD || adminPassword;
const outputJson = resolve(args.output || 'shipshape/shipshape-evidence/security-probe-report.json');
const outputMarkdown = resolve(args.markdown || 'shipshape/shipshape-evidence/security-probe-report.md');

const report = {
  tool: 'shipshape-security-probe',
  startedAt: new Date().toISOString(),
  target: baseUrl,
  findings: [],
  checks: [],
  summary: {},
};

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function wsUrl(path) {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(setCookieHeaders) {
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders].filter(Boolean);
    for (const header of headers) {
      const [pair] = String(header).split(';');
      const index = pair.indexOf('=');
      if (index > 0) {
        this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
    }
  }

  header() {
    return Array.from(this.cookies.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
  }

  get(name) {
    return this.cookies.get(name);
  }
}

function getSetCookie(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const value = response.headers.get('set-cookie');
  return value ? [value] : [];
}

async function request(path, options = {}, jar = new CookieJar()) {
  const headers = new Headers(options.headers || {});
  if (jar.header()) headers.set('cookie', jar.header());
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    redirect: 'manual',
  });
  jar.store(getSetCookie(response));

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, status: response.status, headers: response.headers, body, text };
}

function addCheck(category, name, status, details = {}) {
  report.checks.push({ category, name, status, details });
}

function addFinding({ category, severity, title, description, reproductionSteps, evidence, status = 'open' }) {
  report.findings.push({ category, severity, title, description, reproductionSteps, evidence, status });
}

function containsStringDeep(value, needle) {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsStringDeep(item, needle));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsStringDeep(item, needle));
  }
  return false;
}

async function getCsrf(jar) {
  const result = await request('/api/csrf-token', {}, jar);
  if (result.status !== 200 || !result.body?.token) {
    throw new Error(`Unable to fetch CSRF token: HTTP ${result.status}`);
  }
  return result.body.token;
}

async function login(email, password) {
  const jar = new CookieJar();
  const csrf = await getCsrf(jar);
  const result = await request('/api/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({ email, password }),
  }, jar);
  return { jar, csrf, result, sessionId: jar.get('session_id') };
}

async function runAuthChecks() {
  const unauth = await request('/api/auth/me');
  addCheck('auth-session', 'Unauthenticated auth/me access', unauth.status === 401 ? 'pass' : 'fail', {
    status: unauth.status,
    body: unauth.body,
  });
  if (unauth.status !== 401) {
    addFinding({
      category: 'auth-session',
      severity: 'critical',
      title: 'Protected auth/me route is reachable without a session',
      description: 'The protected auth/me endpoint should reject unauthenticated requests.',
      reproductionSteps: [`GET ${baseUrl}/api/auth/me without cookies`],
      evidence: { status: unauth.status, body: unauth.body },
    });
  }

  const admin = await login(adminEmail, adminPassword);
  addCheck('auth-session', 'Admin login', admin.result.status === 200 ? 'pass' : 'fail', {
    status: admin.result.status,
    sessionLength: admin.sessionId?.length || 0,
  });
  if (admin.result.status !== 200) {
    addFinding({
      category: 'auth-session',
      severity: 'critical',
      title: 'Security probe could not authenticate',
      description: 'The probe cannot continue authenticated checks without a valid seeded user.',
      reproductionSteps: [`POST ${baseUrl}/api/auth/login with ${adminEmail}`],
      evidence: { status: admin.result.status, body: admin.result.body },
    });
    return null;
  }

  const strongSession = /^[a-f0-9]{64}$/i.test(admin.sessionId || '');
  addCheck('auth-session', 'Session token entropy format', strongSession ? 'pass' : 'fail', {
    sessionLength: admin.sessionId?.length || 0,
    hex64: strongSession,
  });
  if (!strongSession) {
    addFinding({
      category: 'auth-session',
      severity: 'high',
      title: 'Session token does not match expected 256-bit random format',
      description: 'Session IDs should be at least 256 bits of cryptographically random entropy encoded as 64 hex characters.',
      reproductionSteps: [`Login as ${adminEmail}`, 'Inspect the session_id cookie value'],
      evidence: { sessionLength: admin.sessionId?.length || 0 },
    });
  }

  const member = await login(memberEmail, memberPassword);
  if (member.result.status === 200) {
    const adminRoute = await request('/api/admin/workspaces', {}, member.jar);
    addCheck('auth-session', 'Member privilege escalation to super-admin route', adminRoute.status === 403 ? 'pass' : 'fail', {
      status: adminRoute.status,
      body: adminRoute.body,
    });
    if (adminRoute.status !== 403) {
      addFinding({
        category: 'auth-session',
        severity: 'critical',
        title: 'Non-super-admin user can access super-admin route',
        description: 'A regular workspace member should not be able to list all workspaces through /api/admin/workspaces.',
        reproductionSteps: [`Login as ${memberEmail}`, `GET ${baseUrl}/api/admin/workspaces`],
        evidence: { status: adminRoute.status, body: adminRoute.body },
      });
    }
  } else {
    addCheck('auth-session', 'Member login for privilege escalation check', 'skip', {
      status: member.result.status,
      body: member.result.body,
    });
  }

  return admin;
}

async function runInputChecks(admin) {
  if (!admin) return null;
  const csrf = await getCsrf(admin.jar);
  const xssTitle = `<img src=x onerror=alert('shipshape')>`;
  const xssCreate = await request('/api/documents', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({ title: xssTitle, document_type: 'wiki' }),
  }, admin.jar);
  addCheck('input-sanitization', 'Stored XSS title payload rejected or sanitized', xssCreate.status >= 400 || xssCreate.body?.title !== xssTitle ? 'pass' : 'fail', {
    status: xssCreate.status,
    acceptedRawPayload: xssCreate.body?.title === xssTitle,
    id: xssCreate.body?.id,
  });
  if (xssCreate.status < 400 && xssCreate.body?.title === xssTitle) {
    addFinding({
      category: 'input-sanitization',
      severity: 'medium',
      title: 'Document title accepts raw HTML event-handler payload',
      description: 'React escaping mitigates normal rendering, but storing raw script-like titles increases downstream XSS risk in future renderers, exports, logs, and notifications.',
      reproductionSteps: [
        `Login as ${adminEmail}`,
        `POST ${baseUrl}/api/documents with title ${xssTitle}`,
        'Observe the raw payload returned and stored as the document title',
      ],
      evidence: { status: xssCreate.status, id: xssCreate.body?.id, title: xssCreate.body?.title },
    });
  }

  if (xssCreate.body?.id) {
    const contentPayload = `<svg onload=alert('shipshape-content')>`;
    const contentProbe = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: contentPayload }],
        },
      ],
    };
    const contentUpdate = await request(`/api/documents/${xssCreate.body.id}/content`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ content: contentProbe }),
    }, admin.jar);
    const acceptedRawContentPayload = containsStringDeep(contentUpdate.body?.content, contentPayload);
    addCheck('input-sanitization', 'Stored XSS content payload rejected or sanitized', contentUpdate.status >= 400 || !acceptedRawContentPayload ? 'pass' : 'fail', {
      status: contentUpdate.status,
      acceptedRawPayload: acceptedRawContentPayload,
      id: xssCreate.body.id,
    });
    if (contentUpdate.status < 400 && acceptedRawContentPayload) {
      addFinding({
        category: 'input-sanitization',
        severity: 'medium',
        title: 'Document content accepts raw HTML event-handler payload text',
        description: 'TipTap text rendering usually escapes text nodes, but storing raw script-like content increases downstream XSS risk in exports, previews, search snippets, notifications, and future renderers.',
        reproductionSteps: [
          `Login as ${adminEmail}`,
          `PATCH ${baseUrl}/api/documents/${xssCreate.body.id}/content with a TipTap text node containing ${contentPayload}`,
          'Observe the raw payload returned and stored in document content',
        ],
        evidence: { status: contentUpdate.status, id: xssCreate.body.id, content: contentUpdate.body?.content },
      });
    }
  } else {
    addCheck('input-sanitization', 'Stored XSS content payload rejected or sanitized', 'skip', {
      reason: 'No created document ID available for content probe',
    });
  }

  const reflectedPayload = `<script>alert('shipshape-reflected')</script>`;
  const reflectedSearch = await request(`/api/search/mentions?q=${encodeURIComponent(reflectedPayload)}`, {}, admin.jar);
  const reflectedRawPayload = reflectedSearch.text.includes(reflectedPayload);
  addCheck('input-sanitization', 'Reflected XSS search query is not echoed raw', reflectedSearch.status < 500 && !reflectedRawPayload ? 'pass' : 'fail', {
    status: reflectedSearch.status,
    reflectedRawPayload,
  });
  if (reflectedRawPayload) {
    addFinding({
      category: 'input-sanitization',
      severity: 'high',
      title: 'Search endpoint reflects raw XSS payload',
      description: 'Reflected user input in API responses can become exploitable when rendered by clients, logs, or downstream integrations without escaping.',
      reproductionSteps: [
        `Login as ${adminEmail}`,
        `GET ${baseUrl}/api/search/mentions?q=${encodeURIComponent(reflectedPayload)}`,
        'Observe the raw payload in the response body',
      ],
      evidence: { status: reflectedSearch.status, response: reflectedSearch.body },
    });
  }

  const longTitle = 'A'.repeat(5000);
  const longCreate = await request('/api/documents', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({ title: longTitle, document_type: 'wiki' }),
  }, admin.jar);
  addCheck('input-sanitization', 'Excessively long document title rejected', longCreate.status === 400 ? 'pass' : 'fail', {
    status: longCreate.status,
    body: longCreate.body,
  });
  if (longCreate.status !== 400) {
    addFinding({
      category: 'input-sanitization',
      severity: 'high',
      title: 'Excessively long document title was not rejected',
      description: 'Document titles are user-facing fields and should enforce bounded input.',
      reproductionSteps: [`POST ${baseUrl}/api/documents with a 5000-character title`],
      evidence: { status: longCreate.status },
    });
  }

  const sqlTitle = `' OR 1=1; --`;
  const sqlCreate = await request('/api/documents', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({ title: sqlTitle, document_type: 'wiki' }),
  }, admin.jar);
  addCheck('input-sanitization', 'SQL injection title payload does not cause server error', sqlCreate.status < 500 ? 'pass' : 'fail', {
    status: sqlCreate.status,
    id: sqlCreate.body?.id,
  });
  if (sqlCreate.status >= 500) {
    addFinding({
      category: 'input-sanitization',
      severity: 'critical',
      title: 'SQL injection probe caused server error',
      description: 'A SQL-like title payload should be treated as data and must not trigger a database or server error.',
      reproductionSteps: [`POST ${baseUrl}/api/documents with title ${sqlTitle}`],
      evidence: { status: sqlCreate.status, body: sqlCreate.body },
    });
  }

  return xssCreate.body?.id || sqlCreate.body?.id || null;
}

function waitForWsOpen(ws) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket open timeout')), 4000);
    ws.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForWsCloseOrTimeout(ws, timeoutMs = 750) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ closed: false, readyState: ws.readyState }), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timeout);
      resolve({ closed: true, code, reason: reason.toString(), readyState: ws.readyState });
    });
    ws.once('error', (error) => {
      clearTimeout(timeout);
      resolve({ closed: true, error: error.message, readyState: ws.readyState });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWebSocketChecks(admin, documentId) {
  if (!admin || !documentId) {
    addCheck('websocket-validation', 'WebSocket checks', 'skip', { reason: 'No authenticated document available' });
    return;
  }

  const unauth = new WebSocket(wsUrl(`/collaboration/wiki:${documentId}`));
  const unauthResult = await waitForWsCloseOrTimeout(unauth, 1500);
  addCheck('websocket-validation', 'Unauthenticated collaboration WebSocket rejected', unauthResult.closed ? 'pass' : 'fail', unauthResult);
  if (!unauthResult.closed) {
    addFinding({
      category: 'websocket-validation',
      severity: 'critical',
      title: 'Collaboration WebSocket accepts unauthenticated connection',
      description: 'The collaboration endpoint should reject clients without a valid session cookie.',
      reproductionSteps: [`Open WebSocket ${wsUrl(`/collaboration/wiki:${documentId}`)} without Cookie header`],
      evidence: unauthResult,
    });
    unauth.close();
  }

  const unexpected = new WebSocket(wsUrl(`/collaboration/wiki:${documentId}`), {
    headers: { cookie: admin.jar.header() },
    maxPayload: 12 * 1024 * 1024,
  });
  await waitForWsOpen(unexpected);
  await sleep(250);
  unexpected.send(Buffer.from([99]));
  const unexpectedResult = await waitForWsCloseOrTimeout(unexpected, 2000);
  addCheck('websocket-validation', 'Unexpected collaboration message type rejected', unexpectedResult.closed ? 'pass' : 'fail', unexpectedResult);
  if (!unexpectedResult.closed) {
    addFinding({
      category: 'websocket-validation',
      severity: 'high',
      title: 'Unexpected WebSocket message type is silently accepted',
      description: 'The collaboration server should explicitly reject protocol message types outside the supported sync and awareness messages.',
      reproductionSteps: [
        `Login as ${adminEmail}`,
        `Open WebSocket ${wsUrl(`/collaboration/wiki:${documentId}`)} with the session cookie`,
        'Send a single-byte message with varuint type 99',
        'Observe that the connection remains open instead of being rejected',
      ],
      evidence: unexpectedResult,
    });
    unexpected.close();
  }

  const malformed = new WebSocket(wsUrl(`/collaboration/wiki:${documentId}`), {
    headers: { cookie: admin.jar.header() },
    maxPayload: 12 * 1024 * 1024,
  });
  await waitForWsOpen(malformed);
  await sleep(250);
  malformed.send(Buffer.alloc(0));
  const malformedResult = await waitForWsCloseOrTimeout(malformed, 1000);
  const healthAfterMalformed = await request('/health').catch((error) => ({ status: 0, body: { error: error.message } }));
  addCheck('websocket-validation', 'Malformed empty collaboration message rejected without process crash', malformedResult.closed && healthAfterMalformed.status === 200 ? 'pass' : 'fail', {
    malformedResult,
    healthStatus: healthAfterMalformed.status,
    healthBody: healthAfterMalformed.body,
  });
  if (!malformedResult.closed || healthAfterMalformed.status !== 200) {
    addFinding({
      category: 'websocket-validation',
      severity: healthAfterMalformed.status === 200 ? 'high' : 'critical',
      title: healthAfterMalformed.status === 200 ? 'Malformed WebSocket message was not rejected' : 'Malformed WebSocket message can crash the API process',
      description: 'Malformed collaboration protocol input should be handled locally and close the offending connection without destabilizing the API.',
      reproductionSteps: [
        `Login as ${adminEmail}`,
        `Open WebSocket ${wsUrl(`/collaboration/wiki:${documentId}`)} with the session cookie`,
        'Send an empty binary message',
        'Check whether the connection closes and /health still responds',
      ],
      evidence: { malformedResult, healthStatus: healthAfterMalformed.status, healthBody: healthAfterMalformed.body },
    });
    malformed.close();
    if (healthAfterMalformed.status !== 200) {
      addCheck('websocket-validation', 'Oversized collaboration message rejected', 'skip', {
        reason: 'API process was unavailable after malformed-message probe',
      });
      return;
    }
  }

  const oversized = new WebSocket(wsUrl(`/collaboration/wiki:${documentId}`), {
    headers: { cookie: admin.jar.header() },
    maxPayload: 12 * 1024 * 1024,
  });
  await waitForWsOpen(oversized);
  await sleep(250);
  oversized.send(Buffer.alloc(10 * 1024 * 1024 + 1, 'x'));
  const oversizedResult = await waitForWsCloseOrTimeout(oversized, 2500);
  addCheck('websocket-validation', 'Oversized collaboration message rejected', oversizedResult.closed ? 'pass' : 'fail', oversizedResult);
  if (!oversizedResult.closed) {
    addFinding({
      category: 'websocket-validation',
      severity: 'high',
      title: 'Oversized WebSocket message was not rejected',
      description: 'The collaboration server should enforce the documented 10MB message size cap.',
      reproductionSteps: [`Send ${10 * 1024 * 1024 + 1} bytes to ${wsUrl(`/collaboration/wiki:${documentId}`)}`],
      evidence: oversizedResult,
    });
    oversized.close();
  }
}

async function runDependencyAudit() {
  let tool = 'npm audit --json --omit=dev';
  let audit = spawnSync('npm', ['audit', '--json', '--omit=dev'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (audit.status !== 0 && audit.stdout.includes('"ENOLOCK"')) {
    tool = 'pnpm audit --json --prod';
    audit = spawnSync('pnpm', ['audit', '--json', '--prod'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  let parsed = null;
  try {
    parsed = JSON.parse(audit.stdout || '{}');
  } catch {
    parsed = null;
  }

  const vulnerabilities = [];
  const source = parsed?.vulnerabilities ? Object.values(parsed.vulnerabilities) : Object.values(parsed?.advisories || {});
  for (const vuln of source) {
    const severity = vuln.severity || vuln.cvss?.score;
    if (severity === 'high' || severity === 'critical') {
      vulnerabilities.push({
        name: vuln.name || vuln.module_name || vuln.packageName,
        severity,
        via: vuln.via,
        title: vuln.title,
        url: vuln.url,
        range: vuln.range || vuln.vulnerable_versions,
        fixAvailable: vuln.fixAvailable,
        featureImpact: mapDependencyToFeature(vuln.name || vuln.module_name || vuln.packageName),
      });
    }
  }

  addCheck('dependencies', 'Dependency vulnerability audit parsed', parsed ? 'pass' : 'fail', {
    tool,
    exitStatus: audit.status,
    highCriticalCount: vulnerabilities.length,
    stderr: audit.stderr?.slice(0, 2000),
  });

  for (const vuln of vulnerabilities) {
    addFinding({
      category: 'dependencies',
      severity: vuln.severity,
      title: `High/Critical dependency vulnerability: ${vuln.name || 'unknown package'}`,
      description: vuln.title || 'Dependency audit reported a high or critical vulnerability.',
      reproductionSteps: [tool],
      evidence: vuln,
    });
  }
}

function mapDependencyToFeature(name) {
  const packageName = String(name || '');
  const mappings = [
    [/express|cookie|csrf|helmet|cors|pg|bcrypt/i, 'API authentication, routing, and database access'],
    [/ws|yjs|y-websocket|y-protocols/i, 'real-time collaboration and event WebSockets'],
    [/react|vite|tiptap|prosemirror|lowlight|emoji/i, 'frontend editor and application shell'],
    [/aws|s3|secrets|ssm/i, 'AWS storage, secrets, and infrastructure integrations'],
    [/playwright|testcontainers|vitest/i, 'test infrastructure only'],
  ];
  return mappings.find(([pattern]) => pattern.test(packageName))?.[1] || 'unknown or transitive application feature';
}

async function runHeaderChecks() {
  const result = await request('/health');
  const csp = result.headers.get('content-security-policy') || '';
  const cors = result.headers.get('access-control-allow-origin') || '';
  addCheck('manual-review', 'CSP script-src does not allow unsafe-inline', !/script-src[^;]*'unsafe-inline'/.test(csp) ? 'pass' : 'fail', { csp });
  if (/script-src[^;]*'unsafe-inline'/.test(csp)) {
    addFinding({
      category: 'manual-review',
      severity: 'high',
      title: 'Global CSP allows inline scripts',
      description: 'Inline scripts weaken XSS defenses because injected script blocks can execute when other controls fail.',
      reproductionSteps: [`GET ${baseUrl}/health`, 'Inspect the Content-Security-Policy response header'],
      evidence: { csp },
    });
  }

  addCheck('manual-review', 'CORS does not use wildcard credentials', !(cors === '*' && result.headers.get('access-control-allow-credentials') === 'true') ? 'pass' : 'fail', {
    accessControlAllowOrigin: cors,
    accessControlAllowCredentials: result.headers.get('access-control-allow-credentials'),
  });
}

async function main() {
  try {
    await runHeaderChecks();
    const admin = await runAuthChecks();
    const documentId = await runInputChecks(admin);
    await runDependencyAudit();
    await runWebSocketChecks(admin, documentId);
  } catch (error) {
    addFinding({
      category: 'probe-tool',
      severity: 'critical',
      title: 'Security probe failed before completing all checks',
      description: error instanceof Error ? error.message : String(error),
      reproductionSteps: [`node scripts/security-probe.mjs --base-url ${baseUrl}`],
      evidence: { stack: error instanceof Error ? error.stack : undefined },
    });
  } finally {
    report.completedAt = new Date().toISOString();
    report.summary = summarize(report);
    mkdirSync(dirname(outputJson), { recursive: true });
    writeFileSync(outputJson, JSON.stringify(report, null, 2));
    writeFileSync(outputMarkdown, toMarkdown(report));
    console.log(`Security probe complete: ${report.summary.totalFindings} findings (${JSON.stringify(report.summary.bySeverity)})`);
    console.log(`JSON report: ${outputJson}`);
    console.log(`Markdown report: ${outputMarkdown}`);
    process.exitCode = report.findings.some((finding) => ['critical', 'high'].includes(finding.severity)) ? 2 : 0;
  }
}

function summarize(data) {
  const bySeverity = {};
  const byCategory = {};
  for (const finding of data.findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
    byCategory[finding.category] = (byCategory[finding.category] || 0) + 1;
  }
  return {
    totalChecks: data.checks.length,
    passedChecks: data.checks.filter((check) => check.status === 'pass').length,
    failedChecks: data.checks.filter((check) => check.status === 'fail').length,
    skippedChecks: data.checks.filter((check) => check.status === 'skip').length,
    totalFindings: data.findings.length,
    bySeverity,
    byCategory,
  };
}

function toMarkdown(data) {
  const lines = [
    '# ShipShape Security Probe Report',
    '',
    `Target: \`${data.target}\``,
    `Started: ${data.startedAt}`,
    `Completed: ${data.completedAt}`,
    '',
    '## Summary',
    '',
    `- Checks: ${data.summary.passedChecks}/${data.summary.totalChecks} passed, ${data.summary.failedChecks} failed, ${data.summary.skippedChecks} skipped`,
    `- Findings: ${data.summary.totalFindings}`,
    `- By severity: \`${JSON.stringify(data.summary.bySeverity)}\``,
    '',
    '## Findings',
    '',
  ];

  if (data.findings.length === 0) {
    lines.push('No findings.');
  } else {
    for (const finding of data.findings) {
      lines.push(`### ${finding.severity.toUpperCase()}: ${finding.title}`);
      lines.push('');
      lines.push(`- Category: \`${finding.category}\``);
      lines.push(`- Status: \`${finding.status}\``);
      lines.push(`- Description: ${finding.description}`);
      lines.push('- Reproduction steps:');
      for (const step of finding.reproductionSteps || []) lines.push(`  - ${step}`);
      lines.push('- Evidence:');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(finding.evidence, null, 2));
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('## Checks');
  lines.push('');
  lines.push('| Category | Check | Status |');
  lines.push('|---|---|---|');
  for (const check of data.checks) {
    lines.push(`| ${check.category} | ${check.name.replace(/\|/g, '\\|')} | ${check.status} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

main();
