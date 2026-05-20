#!/usr/bin/env node
const baseUrl = process.env.SHIPSHAPE_BASE_URL || 'http://localhost:3000';
const concurrency = Number(process.env.SHIPSHAPE_CONCURRENCY || 50);
const durationMs = Number(process.env.SHIPSHAPE_DURATION_MS || 5000);

const endpoints = [
  '/api/documents?type=wiki&summary=true',
  '/api/team/accountability-grid-v3',
];

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function cookieHeaderFrom(headers) {
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);

  return raw
    .flatMap(value => value.split(/,(?=[^;]+?=)/))
    .map(value => value.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function authenticate() {
  const csrfResponse = await fetch(`${baseUrl}/api/csrf-token`);
  if (!csrfResponse.ok) {
    throw new Error(`CSRF request failed: ${csrfResponse.status}`);
  }
  const csrfCookie = cookieHeaderFrom(csrfResponse.headers);
  const { token } = await csrfResponse.json();

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cookie': csrfCookie,
      'x-csrf-token': token,
    },
    body: JSON.stringify({
      email: process.env.SHIPSHAPE_EMAIL || 'dev@ship.local',
      password: process.env.SHIPSHAPE_PASSWORD || 'admin123',
    }),
  });

  if (!loginResponse.ok) {
    const text = await loginResponse.text();
    throw new Error(`Login failed: ${loginResponse.status} ${text}`);
  }

  return [csrfCookie, cookieHeaderFrom(loginResponse.headers)].filter(Boolean).join('; ');
}

async function measureEndpoint(endpoint, cookie) {
  const warmupResponse = await fetch(`${baseUrl}${endpoint}`, {
    headers: { cookie },
  });
  if (!warmupResponse.ok) {
    const text = await warmupResponse.text();
    throw new Error(`Warmup failed for ${endpoint}: ${warmupResponse.status} ${text}`);
  }
  await warmupResponse.arrayBuffer();

  const latencies = [];
  let errors = 0;
  let non2xx = 0;
  let requests = 0;
  let stop = false;

  setTimeout(() => {
    stop = true;
  }, durationMs);

  async function worker() {
    while (!stop) {
      const started = performance.now();
      try {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          headers: { cookie },
        });
        const elapsed = performance.now() - started;
        requests += 1;
        latencies.push(elapsed);
        if (!response.ok) non2xx += 1;
        await response.arrayBuffer();
      } catch {
        errors += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    endpoint,
    concurrency,
    durationMs,
    requests,
    errors,
    non2xx,
    p50: Math.round(percentile(latencies, 50)),
    p95: Math.round(percentile(latencies, 95)),
    p99: Math.round(percentile(latencies, 99)),
  };
}

const cookie = await authenticate();
const results = [];
for (const endpoint of endpoints) {
  results.push(await measureEndpoint(endpoint, cookie));
}

console.log(JSON.stringify({ baseUrl, results }, null, 2));
